/**
 * The owner's first real run (v0.1.0/v0.2.0, a Codex Lead, quick_fix), cli findings (spine §5
 * readings 264 and 265):
 * - `vtc install claude-code` wrapped the user's statusline without asking, against H-10: it is
 *   opt-in now (`--statusline`, asked at the terminal), `--no-statusline` undoes it, never twice;
 * - `vtc doctor` and the install preview printed hundreds of sandbox deny rules on one line: a
 *   count and at most five examples, `--verbose` for all;
 * - `vtc status` printed "Budget: $2.59 of $0.00" before any feature had a budget;
 * - the Codex plugin registered as "version 0.1.0" under vtc 0.2.0;
 * - `.vtc/` in `.gitignore` kept `.vtc/project.yaml` and `.vtc/gates.yml` out of git.
 * Synthetic data only; no real host binary, no real home.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ADAPTER_FACTORIES } from "@vtc/adapters";
import {
  statuslineTeeCommand,
  type HostAdapter,
  type InstallRequest,
  type StatusResult,
} from "@vtc/shared";
import { budgetLine, formatStatus } from "../src/commands/control.js";
import { createDoctorCommand } from "../src/commands/doctor.js";
import { command as init } from "../src/commands/init.js";
import {
  createInstallCommand,
  defaultInstallDeps,
  settingsOutline,
  type InstallDeps,
} from "../src/commands/install.js";
import { checkSessionSandbox, DOCTOR_EXAMPLES } from "../src/doctor-checks.js";
import type { Exec } from "../src/process.js";
import {
  CLAUDE_LOCAL_SETTINGS,
  claudeSessionSandboxOf,
  sandboxScopeOf,
  sessionSandboxSettings,
  type SessionSandboxEnv,
  type SessionSandboxReport,
} from "../src/session-sandbox.js";
import { VERSION } from "../src/version.js";
import { ignoredVtcConfig } from "../src/vtc-config-ignore.js";
import {
  capture,
  cleanupDirs,
  compiledPlugins,
  git,
  initRepo,
  PRODUCT_ROOT,
  tempDir,
  tempHome,
  writePluginTrees,
} from "./helpers.js";

afterEach(cleanupDirs);

/** A repo whose ignore rules are its own: the user's global excludes file is not consulted. */
const hermeticRepo = (): string => {
  const repo = initRepo();
  git(repo, "config", "core.excludesFile", "/dev/null");
  return repo;
};

/** A user home with nothing read from the real one. */
const sandboxEnv = (homeDir: string): SessionSandboxEnv => ({
  userSettings: join(homeDir, ".claude", "settings.json"),
  homeDir,
  platform: "darwin",
  pathEnv: "/usr/bin",
  exists: () => true,
});

const fakeAdapter = (): HostAdapter & { requests: InstallRequest[] } => {
  const requests: InstallRequest[] = [];
  return {
    requests,
    host: "claude-code",
    install: (r: InstallRequest) => {
      requests.push(r);
      return Promise.resolve({ written: [], notes: [] });
    },
    dispose: () => Promise.resolve(),
  } as unknown as HostAdapter & { requests: InstallRequest[] };
};

const installDeps = (
  over: Partial<InstallDeps> & { confirm: InstallDeps["confirm"] },
  homeDir: string,
): (() => InstallDeps) => {
  return () => ({
    ...defaultInstallDeps(),
    home: () => homeDir,
    codexHome: (home) => `${home}/.codex`,
    pluginDir: (host) => `/plugins/${host}`,
    platform: "darwin",
    timerHost: () => {
      throw new Error("the real launchd or systemd is never touched in tests");
    },
    sessionSandboxEnv: () => sandboxEnv(homeDir),
    ...over,
  });
};

describe("vtc install claude-code leaves the statusline alone unless asked (H-10, reading 264)", () => {
  const run = async (args: string[], answer: boolean) => {
    const adapter = fakeAdapter();
    const questions: string[] = [];
    const homeDir = tempDir("vtc-user-");
    const cmd = createInstallCommand(
      installDeps(
        {
          factories: { "claude-code": () => adapter, codex: () => adapter },
          confirm: (q) => (questions.push(q), Promise.resolve(answer)),
        },
        homeDir,
      ),
    );
    // outside a git repo: no session sandbox question
    const { ctx, out, err } = capture(tempDir("vtc-nogit-"), tempHome());
    const code = await cmd.run(args, ctx);
    return { code, adapter, questions, out: out.join("\n"), err: err.join("\n") };
  };

  it("a plain install asks nothing about it and keeps it", async () => {
    const { code, adapter, questions, out } = await run(["claude-code"], true);
    expect(code).toBe(0);
    expect(questions).toEqual([]);
    expect(adapter.requests[0]?.statusline).toBe("keep");
    expect(out).not.toMatch(/statusline/i);
  });

  it("--statusline asks at the terminal and wraps only on yes", async () => {
    const yes = await run(["claude-code", "--statusline"], true);
    expect(yes.code).toBe(0);
    expect(yes.questions).toEqual(["Wrap your Claude Code statusline in vtc statusline-tee?"]);
    expect(yes.adapter.requests[0]?.statusline).toBe("wrap");
    const no = await run(["claude-code", "--statusline"], false);
    expect(no.adapter.requests[0]?.statusline).toBe("keep");
    expect(no.out).toContain("Statusline left as it is.");
  });

  it("--no-statusline undoes it without a question; the two together, or with codex, are refused", async () => {
    const undo = await run(["claude-code", "--no-statusline"], false);
    expect(undo.questions).toEqual([]);
    expect(undo.adapter.requests[0]?.statusline).toBe("unwrap");
    expect((await run(["claude-code", "--statusline", "--no-statusline"], true)).code).not.toBe(0);
    const codex = await run(["codex", "--statusline"], true);
    expect(codex.code).not.toBe(0);
    expect(codex.adapter.requests).toEqual([]);
  });

  it("with the real adapter: installing twice never wraps twice, and a plain install keeps the wrap", async () => {
    const homeDir = tempDir("vtc-user-");
    const settings = join(homeDir, ".claude", "settings.json");
    mkdirSync(join(homeDir, ".claude"), { recursive: true });
    writeFileSync(
      settings,
      JSON.stringify({ statusLine: { type: "command", command: "starship" } }),
    );
    const plugins = writePluginTrees(tempDir("vtc-plugins-"));
    const cmd = createInstallCommand(
      installDeps(
        {
          factories: ADAPTER_FACTORIES,
          pluginDir: (host) => plugins[`plugin:${host}`],
          confirm: () => Promise.resolve(true),
        },
        homeDir,
      ),
    );
    const { ctx } = capture(tempDir("vtc-nogit-"), tempHome());
    const command = (): unknown =>
      (JSON.parse(readFileSync(settings, "utf8")) as { statusLine?: { command?: string } })
        .statusLine?.command;
    expect(await cmd.run(["claude-code"], ctx)).toBe(0);
    expect(command()).toBe("starship");
    expect(await cmd.run(["claude-code", "--statusline"], ctx)).toBe(0);
    expect(await cmd.run(["claude-code", "--statusline"], ctx)).toBe(0);
    expect(command()).toBe(statuslineTeeCommand("starship"));
    expect(await cmd.run(["claude-code"], ctx)).toBe(0);
    expect(command()).toBe(statuslineTeeCommand("starship"));
    expect(await cmd.run(["claude-code", "--no-statusline"], ctx)).toBe(0);
    expect(command()).toBe("starship");
  });

  it("vtc doctor never suggests the statusline shim", async () => {
    const repo = hermeticRepo();
    const home = tempHome();
    const cmd = createDoctorCommand((c) => ({
      exec: () => Promise.resolve({ code: 1, stdout: "", stderr: "" }),
      versions: { node: "22.17.1" },
      sessionSandbox: () =>
        Promise.resolve(claudeSessionSandboxOf(repo, c.vtcHome, sandboxEnv(home))),
      vtcConfigIgnored: () => ignoredVtcConfig(repo),
    }));
    const { ctx, out } = capture(repo, home);
    await cmd.run([], ctx);
    expect(out.join("\n")).not.toMatch(/statusline/i);
  });
});

describe("long sandbox lists are counted, not printed whole (reading 264)", () => {
  const report = (missing: number): SessionSandboxReport => ({
    state: "off",
    missing: Array.from({ length: missing }, (_, i) => `/deny/path-${String(i)}`),
    widening: [],
    unavailable: [],
    file: "ok",
    path: "/r/.claude/settings.local.json",
  });

  it("vtc doctor names how many are missing with at most five examples; --verbose lists all", () => {
    const brief = checkSessionSandbox(report(312)).detail;
    expect(brief).toContain("missing: 312 entries, e.g. /deny/path-0");
    expect(brief).toContain("/deny/path-4");
    expect(brief).not.toContain("/deny/path-5");
    expect(brief).toContain("vtc doctor --verbose");
    expect(DOCTOR_EXAMPLES).toBe(5);
    const all = checkSessionSandbox(report(312), { verbose: true }).detail;
    expect(all).toContain("/deny/path-311");
    expect(all).not.toContain("--verbose");
    // a short list is printed whole
    expect(checkSessionSandbox(report(3)).detail).toContain(
      "missing: /deny/path-0, /deny/path-1, /deny/path-2:",
    );
  });

  it("vtc doctor --verbose reaches the session check", async () => {
    const repo = hermeticRepo();
    const doctor = createDoctorCommand(() => ({
      exec: () => Promise.resolve({ code: 1, stdout: "", stderr: "" }),
      versions: { node: "22.17.1" },
      sessionSandbox: () => Promise.resolve(report(40)),
    }));
    const brief = capture(repo, tempHome());
    await doctor.run([], brief.ctx);
    const briefText = brief.out.join("\n");
    expect(briefText).toContain("40 entries");
    expect(briefText).not.toContain("/deny/path-39");
    const verbose = capture(repo, tempHome());
    await doctor.run(["--verbose"], verbose.ctx);
    expect(verbose.out.join("\n")).toContain("/deny/path-39");
  });

  it("the install preview shows the file and each list's count; --verbose shows every entry", async () => {
    const repo = hermeticRepo();
    const homeDir = tempDir("vtc-user-");
    const vtcHome = join(homeDir, ".vtc");
    mkdirSync(vtcHome);
    const run = async (args: string[]) => {
      const questions: string[] = [];
      const cmd = createInstallCommand(
        installDeps(
          {
            factories: { "claude-code": () => fakeAdapter() },
            confirm: (q) => (questions.push(q), Promise.resolve(false)),
          },
          homeDir,
        ),
      );
      const { ctx, out } = capture(repo, vtcHome);
      expect(await cmd.run(args, ctx)).toBe(0);
      return { text: out.join("\n"), questions };
    };
    const wanted = sessionSandboxSettings(vtcHome, sandboxScopeOf(repo, sandboxEnv(homeDir)));
    const deny = wanted.permissions.deny;
    expect(deny.length).toBeGreaterThan(DOCTOR_EXAMPLES);
    const path = join(repo, CLAUDE_LOCAL_SETTINGS);
    const brief = await run(["claude-code"]);
    expect(brief.text).toContain(`These settings go into ${path}`);
    expect(brief.text).toContain(`  permissions.deny: ${String(deny.length)} entries`);
    expect(brief.text).toContain("  sandbox.enabled: true");
    expect(brief.text).toContain("vtc install claude-code --verbose");
    expect(brief.text).not.toContain(JSON.stringify(deny.at(-1)));
    expect(brief.questions).toEqual([`Write them to ${path}?`]);
    const verbose = await run(["claude-code", "--verbose"]);
    expect(verbose.text).toContain(JSON.stringify(deny.at(-1)));
  });

  it("settingsOutline counts lists and prints other values", () => {
    expect(settingsOutline({ a: { b: [1, 2], c: true }, d: ["x"], e: "s" })).toEqual([
      "a.b: 2 entries",
      "a.c: true",
      "d: 1 entry",
      'e: "s"',
    ]);
  });
});

describe("vtc status before any budget exists (reading 264)", () => {
  it("shows the spend with no cap instead of a cap of $0.00", () => {
    expect(budgetLine({ budget_usd: 0, spent_usd: 2.59 })).toBe("Spent: $2.59 (no cap)");
    expect(budgetLine({ budget_usd: 10, spent_usd: 1.234 })).toBe("Budget: $1.23 of $10.00");
    const status = {
      run: { id: "r1", track: "quick_fix", phase: "specify", paused: false },
      tasks_by_status: {},
      parked: [],
      features: [],
      open_escalations: 0,
      budget: { budget_usd: 0, spent_usd: 2.59 },
      usage: { hosts: [], interrupted_tasks: [], auto_resume_at: null },
    } as unknown as StatusResult;
    const text = formatStatus(status).join("\n");
    expect(text).toContain("Spent: $2.59 (no cap)");
    expect(text).not.toContain("of $0.00");
  });
});

describe("the plugins carry the vtc release version (reading 264)", () => {
  it("both compiled plugin manifests and the cli package say VERSION", () => {
    const out = compiledPlugins();
    const versionOf = (host: "claude-code" | "codex", path: string): unknown =>
      (
        JSON.parse(out.targets[host].find((f) => f.path === path)?.text ?? "{}") as {
          version?: unknown;
        }
      ).version;
    expect(versionOf("claude-code", ".claude-plugin/plugin.json")).toBe(VERSION);
    expect(versionOf("codex", "plugin.json")).toBe(VERSION);
    const cliPackage = JSON.parse(
      readFileSync(join(PRODUCT_ROOT, "packages/cli/package.json"), "utf8"),
    ) as { version: string };
    expect(cliPackage.version).toBe(VERSION);
  });
});

describe(".vtc/project.yaml and .vtc/gates.yml must not be gitignored (reading 265)", () => {
  const ignoringVtc = (): string => {
    const repo = hermeticRepo();
    writeFileSync(join(repo, ".gitignore"), "node_modules/\n.vtc/\n");
    return repo;
  };

  it("names the rule that ignores them and the line to use instead", async () => {
    const repo = ignoringVtc();
    expect(await ignoredVtcConfig(repo)).toEqual([
      { path: ".vtc/project.yaml", source: ".gitignore", line: 2, pattern: ".vtc/" },
      { path: ".vtc/gates.yml", source: ".gitignore", line: 2, pattern: ".vtc/" },
    ]);
    const doctor = createDoctorCommand(() => ({
      exec: () => Promise.resolve({ code: 1, stdout: "", stderr: "" }),
      versions: { node: "22.17.1" },
      vtcConfigIgnored: () => ignoredVtcConfig(repo),
    }));
    const { ctx, out } = capture(repo, tempHome());
    await doctor.run([], ctx);
    expect(out.join("\n")).toMatch(
      /warn +vtc config +\.vtc\/project\.yaml and \.vtc\/gates\.yml are ignored by git \(\.gitignore:2 `\.vtc\/`\).*replace that line with `\.vtc\/state\/`/,
    );
  });

  it("is quiet when only the engine's state is ignored, when a ! rule re-includes them, or when they are tracked", async () => {
    const stateOnly = hermeticRepo();
    writeFileSync(join(stateOnly, ".gitignore"), ".vtc/state/\n");
    expect(await ignoredVtcConfig(stateOnly)).toEqual([]);
    const reincluded = hermeticRepo();
    writeFileSync(join(reincluded, ".gitignore"), ".vtc/*\n!.vtc/project.yaml\n!.vtc/gates.yml\n");
    expect(await ignoredVtcConfig(reincluded)).toEqual([]);
    const tracked = ignoringVtc();
    mkdirSync(join(tracked, ".vtc"));
    writeFileSync(join(tracked, ".vtc/project.yaml"), "version: 1\n");
    writeFileSync(join(tracked, ".vtc/gates.yml"), "version: 1\n");
    git(tracked, "add", "-f", ".vtc");
    git(tracked, "commit", "-q", "-m", "vtc config");
    expect(await ignoredVtcConfig(tracked)).toEqual([]);
  });

  it("vtc init warns too", async () => {
    const repo = ignoringVtc();
    const { ctx, err } = capture(repo, tempHome());
    expect(await init.run([], ctx)).toBe(0);
    expect(err.join("\n")).toMatch(
      /vtc init: warning: \.vtc\/project\.yaml and \.vtc\/gates\.yml are ignored by git.*`\.vtc\/state\/`/,
    );
    const clean = hermeticRepo();
    const quiet = capture(clean, tempHome());
    expect(await init.run([], quiet.ctx)).toBe(0);
    expect(quiet.err).toEqual([]);
  });

  it("reads git's answer, never guesses: no match is no warning", async () => {
    const exec: Exec = (_command, args) =>
      Promise.resolve(
        args[0] === "check-ignore"
          ? { code: 0, stdout: "/x/global-ignore:7:!.vtc/\t.vtc/gates.yml\n", stderr: "" }
          : { code: 1, stdout: "", stderr: "" },
      );
    expect(await ignoredVtcConfig("/r", exec)).toEqual([]);
  });
});
