/**
 * The release pipeline (spine AD-26 Check): the workflow parses, every `uses:` is pinned to a
 * full SHA and the permissions are least-privilege; the checksum script; `install.sh` against a
 * stub `curl` first on PATH (no network: a bad checksum fails, no hash tool fails, the
 * architecture map, a partial download runs nothing); the formula render.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { core } from "@vtc/engine";
import { writeChecksums } from "../scripts/release-checksums.js";
import {
  binaryName,
  checksumDirectory,
  formatSha256Sums,
  INSTALLER_PLACEHOLDERS,
  parseSha256Sums,
  RELEASE_TARGETS,
  releaseAssetName,
  releaseVersion,
  renderFormula,
  renderInstaller,
  sha256File,
} from "../scripts/release-lib.js";
import { FORMULA_TEMPLATE, INSTALLER, renderReleaseFiles } from "../scripts/release-render.js";
import { cleanupDirs, PRODUCT_ROOT, tempDir } from "./helpers.js";

afterEach(cleanupDirs);

const WORKFLOW = join(PRODUCT_ROOT, ".github/workflows/release.yml");
const H2_TODO = "sign + notarize once the owner has an Apple Developer ID";

interface Step {
  readonly uses?: string;
  readonly run?: string;
  readonly if?: string;
  readonly with?: Readonly<Record<string, unknown>>;
}
interface Job {
  readonly needs?: string | readonly string[];
  readonly if?: string | boolean;
  readonly permissions?: Readonly<Record<string, string>>;
  readonly steps: readonly Step[];
  readonly environment?: string;
}
interface Workflow {
  readonly on: Readonly<Record<string, unknown>>;
  readonly permissions: Readonly<Record<string, string>>;
  readonly env: Readonly<Record<string, string>>;
  readonly jobs: Readonly<Record<string, Job>>;
}

const workflow = (): Workflow => core.parseYaml(readFileSync(WORKFLOW, "utf8")) as Workflow;
const needsOf = (job: Job): string[] =>
  job.needs === undefined ? [] : typeof job.needs === "string" ? [job.needs] : [...job.needs];

describe("the release workflow (AD-26 rules 1-3)", () => {
  it("triggers on a v* tag and a manual dry run only", () => {
    const wf = workflow();
    expect(Object.keys(wf.on).sort()).toEqual(["push", "workflow_dispatch"]);
    expect(wf.on.push).toEqual({ tags: ["v*"] });
    expect(readFileSync(WORKFLOW, "utf8")).not.toMatch(/^\s*pull_request(_target)?\s*:/m);
  });

  it("pins every action to a full commit SHA", () => {
    const uses = Object.values(workflow().jobs).flatMap((job) =>
      job.steps.flatMap((s) => (s.uses === undefined ? [] : [s.uses])),
    );
    expect(uses.length).toBeGreaterThan(10);
    for (const ref of uses) expect(ref).toMatch(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[0-9a-f]{40}$/);
  });

  it("is read-only except for the publish job, which gets exactly what it needs", () => {
    const wf = workflow();
    expect(wf.permissions).toEqual({ contents: "read" });
    for (const [name, job] of Object.entries(wf.jobs)) {
      if (name === "publish") {
        expect(job.permissions).toEqual({
          contents: "write",
          "id-token": "write",
          attestations: "write",
        });
      } else {
        expect(job.permissions, name).toEqual({ contents: "read" });
      }
    }
  });

  it("checks out without credentials and restores no cache", () => {
    for (const job of Object.values(workflow().jobs)) {
      for (const step of job.steps) {
        if (step.uses?.startsWith("actions/checkout@") === true)
          expect(step.with?.["persist-credentials"]).toBe(false);
        if (step.uses?.startsWith("actions/setup-node@") === true)
          expect(step.with?.cache).toBeUndefined();
        expect(step.uses ?? "").not.toMatch(/^actions\/cache@/);
      }
    }
  });

  it("verifies with Bun 1.4.3, a frozen lockfile and pnpm verify, and checks the tag", () => {
    const wf = workflow();
    expect(wf.env.BUN_VERSION).toBe("1.4.3");
    const runs = wf.jobs.verify?.steps.map((s) => s.run ?? "").join("\n") ?? "";
    expect(runs).toContain("pnpm install --frozen-lockfile");
    expect(runs).toMatch(/^pnpm verify$/m);
    expect(runs).toContain("packages/cli/src/version.ts");
    const setupBun = Object.values(wf.jobs).flatMap((j) =>
      j.steps.filter((s) => s.uses?.startsWith("oven-sh/setup-bun@") === true),
    );
    for (const step of setupBun) expect(step.with?.["bun-version"]).toBe("${{ env.BUN_VERSION }}");
  });

  it("compiles every target, smoke-tests each on a native runner, then packages", () => {
    const wf = workflow();
    const build = wf.jobs.build?.steps.map((s) => s.run ?? "").join("\n") ?? "";
    for (const target of RELEASE_TARGETS) expect(build).toContain(`${target.os}-${target.arch}`);
    expect(needsOf(wf.jobs.smoke as Job)).toContain("build");
    const text = readFileSync(WORKFLOW, "utf8");
    for (const target of RELEASE_TARGETS)
      expect(text).toContain(`target: ${target.os}-${target.arch}, runner:`);
  });

  it("signs (skipped until H-2) before the checksums, and checksums before publishing", () => {
    const wf = workflow();
    expect(wf.jobs["sign-macos"]?.if).toBe("${{ false }}");
    expect(readFileSync(WORKFLOW, "utf8")).toContain(`TODO(H-2): ${H2_TODO}`);
    expect(needsOf(wf.jobs.package as Job)).toContain("sign-macos");
    expect(String(wf.jobs.package?.if)).toContain("needs.sign-macos.result == 'skipped'");
    const pkg = wf.jobs.package?.steps.map((s) => s.run ?? "").join("\n") ?? "";
    expect(pkg).toContain("release-checksums.ts release");
    expect(pkg).toContain("release-render.ts");
    expect(pkg).toContain("sha256sum -c SHA256SUMS");
    expect(needsOf(wf.jobs.publish as Job)).toContain("package");
  });

  it("publishes on tags only: attests every asset, drafts, then publishes", () => {
    const publish = workflow().jobs.publish as Job;
    expect(publish.if).toBe("${{ github.event_name == 'push' && github.ref_type == 'tag' }}");
    const attest = publish.steps.find((s) => s.uses?.startsWith("actions/attest@") === true);
    expect(attest?.with?.["subject-path"]).toBe("release/*");
    const run = publish.steps.map((s) => s.run ?? "").join("\n");
    expect(run).toMatch(/gh release create "\$TAG" --draft --verify-tag/);
    expect(run.indexOf("--draft=false")).toBeGreaterThan(run.indexOf("--draft --verify-tag"));
    // the job that holds the write token runs no repository code
    expect(publish.steps.some((s) => s.uses?.startsWith("actions/checkout@") === true)).toBe(false);
  });

  it("carries the H-2 todo in the release docs", () => {
    expect(readFileSync(join(PRODUCT_ROOT, "packaging/README.md"), "utf8")).toContain(H2_TODO);
  });
});

const HEX = (c: string): string => c.repeat(64);

describe("release names and SHA256SUMS", () => {
  it("names assets vtc-<ver>-<os>-<arch> (.zip for Windows)", () => {
    expect(RELEASE_TARGETS.map((t) => releaseAssetName("v1.2.3", t))).toEqual([
      "vtc-1.2.3-darwin-arm64.tar.gz",
      "vtc-1.2.3-darwin-x64.tar.gz",
      "vtc-1.2.3-linux-x64.tar.gz",
      "vtc-1.2.3-linux-arm64.tar.gz",
      "vtc-1.2.3-windows-x64.zip",
    ]);
    expect(binaryName({ os: "windows" })).toBe("vtc.exe");
    expect(() => releaseVersion("latest")).toThrow(/not a release version/);
  });

  it("writes sorted LF lines with two spaces, and parses them back", () => {
    const text = formatSha256Sums([
      { name: "vtc.rb", sha256: HEX("b") },
      { name: "SHA-like.txt", sha256: HEX("c") },
      { name: "install.sh", sha256: HEX("a") },
    ]);
    expect(text).toBe(`${HEX("c")}  SHA-like.txt\n${HEX("a")}  install.sh\n${HEX("b")}  vtc.rb\n`);
    expect(text).not.toContain("\r");
    expect([...parseSha256Sums(text).keys()]).toEqual(["SHA-like.txt", "install.sh", "vtc.rb"]);
    expect(() => formatSha256Sums([{ name: "a/b", sha256: HEX("a") }])).toThrow(/plain file/);
    expect(() => formatSha256Sums([{ name: "x", sha256: HEX("A") }])).toThrow(/SHA-256/);
    expect(() => parseSha256Sums(`${HEX("a")} x\n`)).toThrow(/malformed/);
  });

  it("checksums a directory so the system tool accepts it", () => {
    const dir = tempDir("vtc-sums-");
    writeFileSync(join(dir, "b.tar.gz"), "bee");
    writeFileSync(join(dir, "a.zip"), "ay");
    writeFileSync(join(dir, "SHA256SUMS"), "stale");
    const path = writeChecksums(dir);
    const text = readFileSync(path, "utf8");
    expect(text).toBe(checksumDirectory(dir));
    expect(
      text
        .split("\n")
        .filter(Boolean)
        .map((l) => l.slice(66)),
    ).toEqual(["a.zip", "b.tar.gz"]);
    expect(parseSha256Sums(text).get("a.zip")).toBe(sha256File(join(dir, "a.zip")));
    const [tool, ...toolArgs] = hashTool() ?? [];
    if (tool !== undefined) {
      const check = spawnSync(tool, [...toolArgs, "-c", "SHA256SUMS"], {
        cwd: dir,
        encoding: "utf8",
      });
      expect(check.status, check.stderr).toBe(0);
    }
  });
});

const which = (name: string): string | null => {
  const found = spawnSync("/bin/sh", ["-c", `command -v ${name}`], { encoding: "utf8" });
  return found.status === 0 ? found.stdout.trim() : null;
};

const hashTool = (): string[] | null =>
  which("sha256sum") !== null
    ? ["sha256sum"]
    : which("shasum") !== null
      ? ["shasum", "-a", "256"]
      : null;

describe("the Homebrew formula", () => {
  const sums = (version: string): string =>
    formatSha256Sums(
      RELEASE_TARGETS.map((t, i) => ({
        name: releaseAssetName(version, t),
        sha256: HEX("0123456789"[i] ?? "f"),
      })),
    );

  it("renders the four macOS and Linux assets with their SHA-256", () => {
    const rb = renderFormula(readFileSync(FORMULA_TEMPLATE, "utf8"), {
      version: "1.2.3",
      repo: "acme/vtc",
      sums: sums("1.2.3"),
    });
    expect(rb).not.toContain("{{");
    expect(rb).toContain('version "1.2.3"');
    RELEASE_TARGETS.forEach((t, i) => {
      if (t.os === "windows") {
        expect(rb).not.toContain("windows");
        return;
      }
      expect(rb).toContain(
        `url "https://github.com/acme/vtc/releases/download/v1.2.3/${releaseAssetName("1.2.3", t)}"\n      sha256 "${HEX("0123456789"[i] ?? "f")}"`,
      );
    });
    // the test block exercises the binary, not only --version
    expect(rb).toMatch(/test do[\s\S]*engine --mcp/);
    if (which("ruby") !== null) {
      const dir = tempDir("vtc-rb-");
      writeFileSync(join(dir, "vtc.rb"), rb);
      const syntax = spawnSync("ruby", ["-c", join(dir, "vtc.rb")], { encoding: "utf8" });
      expect(syntax.status, syntax.stderr).toBe(0);
    }
  });

  it("refuses to render without every platform's checksum or with a bad repo", () => {
    const template = readFileSync(FORMULA_TEMPLATE, "utf8");
    const partial = sums("1.2.3").split("\n").slice(1).join("\n");
    expect(() =>
      renderFormula(template, { version: "1.2.3", repo: "acme/vtc", sums: partial }),
    ).toThrow(/no entry for vtc-1.2.3-darwin-arm64.tar.gz/);
    expect(() =>
      renderFormula(template, { version: "1.2.3", repo: "acme", sums: sums("1.2.3") }),
    ).toThrow(/owner/);
  });

  it("renders the formula and the installer into the release directory", () => {
    const dir = tempDir("vtc-render-");
    writeFileSync(join(dir, "SHA256SUMS"), sums("2.0.0"));
    renderReleaseFiles({
      version: "v2.0.0",
      repo: "acme/vtc",
      sums: join(dir, "SHA256SUMS"),
      out: dir,
    });
    expect(readFileSync(join(dir, "vtc.rb"), "utf8")).toContain('version "2.0.0"');
    const installer = readFileSync(join(dir, "install.sh"), "utf8");
    expect(installer).toContain('repo="${VTC_REPO:-acme/vtc}"');
    expect(installer).toContain('version="${VTC_VERSION:-2.0.0}"');
    for (const placeholder of Object.values(INSTALLER_PLACEHOLDERS))
      expect(installer).not.toContain(placeholder);
  });
});

// --------------------------------------------------------------- install.sh

interface Machine {
  readonly os: string;
  readonly arch: string;
  readonly translated?: "0" | "1";
}

const TOOLS = ["sh", "mktemp", "rm", "awk", "tar", "gzip", "mkdir", "chmod", "cp", "mv", "cat"];

/**
 * A sandboxed PATH: stub `curl` (serves files from `fixtures`, logs every argv), `uname` and
 * `sysctl`; links to the real tools the installer needs; the hash tools only when `hash`.
 */
const installerEnv = (
  fixtures: string,
  machine: Machine,
  hash: boolean,
): { path: string; log: string } => {
  const root = tempDir("vtc-inst-");
  const bin = join(root, "bin");
  mkdirSync(bin);
  const log = join(root, "curl.log");
  const stub = (name: string, body: string): void => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  stub(
    "curl",
    [
      `echo "$*" >> '${log}'`,
      'out=""; url=""',
      'while [ "$#" -gt 0 ]; do',
      '  case "$1" in -o) out="$2"; shift 2 ;; *) url="$1"; shift ;; esac',
      "done",
      `src='${fixtures}'/"\${url##*/}"`,
      '[ -f "$src" ] || exit 22',
      'cp "$src" "$out"',
    ].join("\n"),
  );
  stub("uname", `case "$1" in -s) echo '${machine.os}' ;; -m) echo '${machine.arch}' ;; esac`);
  stub("sysctl", `echo '${machine.translated ?? "0"}'`);
  const tools = [...TOOLS, ...(hash ? ["sha256sum", "shasum", "perl"] : [])];
  for (const tool of tools) {
    const real = which(tool);
    if (real !== null) symlinkSync(real, join(bin, tool));
  }
  return { path: bin, log };
};

const VERSION = "1.2.3";
const REPO = "acme/vtc";

/** One release's assets: a tar.gz per non-Windows target holding a fake `vtc`, and SHA256SUMS. */
const releaseFixtures = (mutate?: (sums: string) => string): string => {
  const dir = tempDir("vtc-rel-");
  const stage = tempDir("vtc-stage-");
  for (const target of RELEASE_TARGETS) {
    if (target.os === "windows") continue;
    writeFileSync(
      join(stage, "vtc"),
      `#!/bin/sh\necho "vtc ${VERSION} ${target.os}-${target.arch}"\n`,
    );
    chmodSync(join(stage, "vtc"), 0o755);
    const made = spawnSync("tar", [
      "-C",
      stage,
      "-czf",
      join(dir, releaseAssetName(VERSION, target)),
      "vtc",
    ]);
    expect(made.status).toBe(0);
  }
  const sums = checksumDirectory(dir);
  writeFileSync(join(dir, "SHA256SUMS"), mutate === undefined ? sums : mutate(sums));
  return dir;
};

const runInstaller = (options: {
  readonly fixtures: string;
  readonly machine?: Machine;
  readonly hash?: boolean;
  readonly script?: string;
  readonly env?: Readonly<Record<string, string>>;
}): {
  status: number | null;
  stdout: string;
  stderr: string;
  installDir: string;
  requested: string[];
} => {
  const { path, log } = installerEnv(
    options.fixtures,
    options.machine ?? { os: "Linux", arch: "x86_64" },
    options.hash ?? true,
  );
  const home = tempDir("vtc-home-");
  const installDir = join(home, "bin-target");
  const result = spawnSync(join(path, "sh"), [options.script ?? INSTALLER], {
    encoding: "utf8",
    env: {
      PATH: path,
      HOME: home,
      VTC_INSTALL_DIR: installDir,
      VTC_REPO: REPO,
      VTC_VERSION: VERSION,
      ...options.env,
    },
    timeout: 30_000,
  });
  const requested = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    installDir,
    requested,
  };
};

describe("packaging/install.sh (AD-26 rule 4)", () => {
  it("downloads over https, verifies the checksum and installs atomically", () => {
    const run = runInstaller({ fixtures: releaseFixtures() });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("Checksum verified");
    expect(readdirSync(run.installDir)).toEqual(["vtc"]);
    const installed = spawnSync(join(run.installDir, "vtc"), { encoding: "utf8" });
    expect(installed.stdout.trim()).toBe(`vtc ${VERSION} linux-x64`);
    const base = `https://github.com/${REPO}/releases/download/v${VERSION}`;
    expect(run.requested.map((line) => line.replace(/ -o \S+ /, " -o <out> "))).toEqual([
      `--proto =https --tlsv1.2 -fsSL -o <out> ${base}/vtc-${VERSION}-linux-x64.tar.gz`,
      `--proto =https --tlsv1.2 -fsSL -o <out> ${base}/SHA256SUMS`,
    ]);
  });

  it("fails on a checksum mismatch and installs nothing", () => {
    const fixtures = releaseFixtures((sums) =>
      sums.replace(/^[0-9a-f]{64}(?= {2}vtc-1\.2\.3-linux-x64)/m, HEX("0")),
    );
    const run = runInstaller({ fixtures });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/checksum mismatch for vtc-1\.2\.3-linux-x64\.tar\.gz/);
    expect(existsSync(run.installDir)).toBe(false);
  });

  it("fails when SHA256SUMS does not list the asset", () => {
    const fixtures = releaseFixtures((sums) =>
      sums
        .split("\n")
        .filter((l) => !l.includes("linux-x64"))
        .join("\n"),
    );
    const run = runInstaller({ fixtures });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/SHA256SUMS lists no vtc-1\.2\.3-linux-x64\.tar\.gz/);
    expect(existsSync(run.installDir)).toBe(false);
  });

  it("fails closed without sha256sum or shasum, before downloading anything", () => {
    const run = runInstaller({ fixtures: releaseFixtures(), hash: false });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/neither sha256sum nor shasum is installed/);
    expect(run.requested).toEqual([]);
    expect(existsSync(run.installDir)).toBe(false);
  });

  it.each([
    [{ os: "Darwin", arch: "arm64" }, "darwin-arm64"],
    [{ os: "Darwin", arch: "x86_64", translated: "1" }, "darwin-arm64"],
    [{ os: "Darwin", arch: "x86_64", translated: "0" }, "darwin-x64"],
    [{ os: "Linux", arch: "x86_64" }, "linux-x64"],
    [{ os: "Linux", arch: "amd64" }, "linux-x64"],
    [{ os: "Linux", arch: "aarch64" }, "linux-arm64"],
    [{ os: "Linux", arch: "arm64" }, "linux-arm64"],
  ] as const)("maps %j to %s", (machine, target) => {
    const run = runInstaller({ fixtures: releaseFixtures(), machine });
    expect(run.status, run.stderr).toBe(0);
    expect(run.requested[0]).toContain(`/vtc-${VERSION}-${target}.tar.gz`);
  });

  it.each([
    [{ os: "Linux", arch: "i686" }, /no vtc build for linux on i686/],
    [{ os: "FreeBSD", arch: "amd64" }, /no vtc build for FreeBSD/],
    [{ os: "MINGW64_NT-10.0", arch: "x86_64" }, /on Windows, download/],
  ] as const)("refuses %j", (machine, message) => {
    const run = runInstaller({ fixtures: releaseFixtures(), machine });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(message);
    expect(run.requested).toEqual([]);
  });

  it("needs a repository and version unless rendered by a release", () => {
    const fixtures = releaseFixtures();
    const bare = runInstaller({ fixtures, env: { VTC_REPO: "", VTC_VERSION: "" } });
    expect(bare.status).toBe(1);
    expect(bare.stderr).toMatch(/set VTC_REPO/);
    const dir = tempDir("vtc-rendered-");
    const rendered = join(dir, "install.sh");
    writeFileSync(
      rendered,
      renderInstaller(readFileSync(INSTALLER, "utf8"), { version: VERSION, repo: REPO }),
    );
    const run = runInstaller({
      fixtures,
      script: rendered,
      env: { VTC_REPO: "", VTC_VERSION: "" },
    });
    expect(run.status, run.stderr).toBe(0);
    expect(readdirSync(run.installDir)).toEqual(["vtc"]);
  });

  it("runs nothing when the download stopped early (main is called on the last line)", () => {
    const text = readFileSync(INSTALLER, "utf8");
    expect(text.trimEnd().split("\n").at(-1)).toBe('main "$@"');
    const dir = tempDir("vtc-partial-");
    for (const cut of [0.3, 0.6, 0.95]) {
      const lines = text.trimEnd().split("\n");
      const partial = join(dir, `partial-${String(cut)}.sh`);
      writeFileSync(partial, `${lines.slice(0, Math.floor(lines.length * cut)).join("\n")}\n`);
      const run = runInstaller({ fixtures: releaseFixtures(), script: partial });
      expect(run.requested).toEqual([]);
      expect(existsSync(run.installDir)).toBe(false);
    }
  });

  it("is POSIX sh: no sudo, no shell-rc edits", () => {
    const text = readFileSync(INSTALLER, "utf8");
    expect(text.split("\n")[0]).toBe("#!/bin/sh");
    const code = text
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("#"))
      .join("\n");
    expect(code).not.toMatch(/\bsudo\b/);
    expect(code).not.toMatch(/\.(bashrc|zshrc|profile|bash_profile)\b/);
    expect(code).not.toMatch(/\[\[|^\s*(function|local)\s/m);
  });
});
