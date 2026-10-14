/**
 * Shared test helpers: temp git repos and VTC homes, the real compiled plugins on disk, a
 * capturing `CommandContext`, fakes for the PR service and the Gate Runner.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { compilePlugins, readSources } from "@vtc/compiler";
import { expect } from "vitest";
import {
  ENGINE_MCP_TOOLS,
  HOST_IDS,
  ROLE_MCP_TOOLS,
  type AssetNamespace,
  type EngineClient,
  type GateRunner,
  type PullRequestService,
} from "@vtc/shared";
import { defaultProjectConfig, renderProjectYaml } from "../src/commands/init.js";
import { createCommandContext, type CommandContext } from "../src/index.js";

export const PRODUCT_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const DASHBOARD_FIXTURE = join(PRODUCT_ROOT, "fixtures/dashboard-export");

const dirs: string[] = [];

/** A fresh temp directory, symlinks resolved (macOS `/var` → `/private/var`). */
export const tempDir = (prefix = "vtc-cli-"): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
};

/** A short VTC home: the daemon's socket path must stay under 100 bytes (AD-12). */
export const tempHome = (): string => tempDir("vh-");

export const cleanupDirs = (): void => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
};

export const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** A git repo with one commit. */
export const initRepo = (): string => {
  const repo = tempDir("vtc-repo-");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  writeFileSync(join(repo, "README.md"), "# app\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  return repo;
};

/** What `vtc init` writes: `.vtc/project.yaml` with the defaults and `.vtc/.gitignore`. */
export const initProject = (repo: string): string => {
  mkdirSync(join(repo, ".vtc"), { recursive: true });
  writeFileSync(join(repo, ".vtc/project.yaml"), renderProjectYaml(defaultProjectConfig()));
  writeFileSync(join(repo, ".vtc/.gitignore"), "/state/\n");
  return repo;
};

/**
 * What `vtc calibrate` plus the user's commit leave behind: a confirmed `.vtc/gates.yml`, and the
 * `.vtc/project.yaml` `vtc init` wrote (when there is one), committed at HEAD. A run refuses to
 * start without the first (spine §5 reading 78, D-au) or with an uncommitted second (reading 79).
 */
export const commitVtcConfig = (repo: string): string => {
  mkdirSync(join(repo, ".vtc"), { recursive: true });
  const gatesYml = {
    version: 1,
    baseline: {
      revision: git(repo, "rev-parse", "HEAD"),
      calibrated_at: "2026-10-13T08:00:00.000Z",
      confirmed: true,
    },
    tests: { acceptance_globs: ["tests/acceptance/**"], protected_configs: [] },
    gates: [{ id: "tests", layer: "L2", command: ["pnpm", "test"] }],
  };
  writeFileSync(join(repo, ".vtc/gates.yml"), `${JSON.stringify(gatesYml, null, 2)}\n`);
  git(repo, "add", "--", ".vtc");
  git(repo, "commit", "-q", "-m", "vtc: init and calibrate");
  return repo;
};

/** A git repo with one commit, set up for VTC as `vtc init` does. */
export const initVtcRepo = (): string => initProject(initRepo());

let compiled: ReturnType<typeof compilePlugins> | undefined;

/** The real compiler output for `roles/`, `skills/` and `plugins/` (cached). */
export const compiledPlugins = () => {
  compiled ??= compilePlugins(readSources(PRODUCT_ROOT).files);
  if (!compiled.ok) throw new Error(compiled.errors.map((e) => e.message).join("\n"));
  return compiled.output;
};

/** Writes the compiled plugins under `root`; returns the namespace roots (dashboard: fixture). */
export const writePluginTrees = (root: string): Record<AssetNamespace, string> => {
  const out = compiledPlugins();
  const roots = { dashboard: DASHBOARD_FIXTURE } as Record<AssetNamespace, string>;
  for (const host of HOST_IDS) {
    const dir = join(root, host);
    for (const file of out.targets[host]) {
      const abs = join(dir, ...file.path.split("/"));
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, file.text);
    }
    roots[`plugin:${host}`] = dir;
  }
  return roots;
};

export interface Captured {
  readonly ctx: CommandContext;
  readonly out: string[];
  readonly err: string[];
}

export const capture = (
  cwd: string,
  vtcHome: string,
  connect?: () => Promise<EngineClient>,
): Captured => {
  const out: string[] = [];
  const err: string[] = [];
  const ctx = createCommandContext(
    { out: (l) => out.push(l), err: (l) => err.push(l) },
    cwd,
    vtcHome,
    connect,
  );
  return { ctx, out, err };
};

/** A PR service that records calls and never touches `gh` or the network. */
export const fakePullRequests = (): PullRequestService & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    upsertDraft: (r) => {
      calls.push(`upsert ${r.branch}`);
      return Promise.reject(new Error("fake"));
    },
    markReady: (b) => {
      calls.push(`ready ${b}`);
      return Promise.reject(new Error("fake"));
    },
    view: (b) => {
      calls.push(`view ${b}`);
      return Promise.resolve(null);
    },
  };
};

export const fakeGateRunner = (): GateRunner => ({
  run: () => Promise.reject(new Error("no gates in this test")),
  checkWriteScope: () => Promise.reject(new Error("no gates in this test")),
});

/** Lines written to a PassThrough, and a wait for the one that matches. */
export const lineSink = (): {
  stdout: PassThrough;
  next: (match: RegExp, ms?: number) => Promise<Record<string, unknown>>;
} => {
  const stdout = new PassThrough();
  const lines: string[] = [];
  let buffer = "";
  stdout.on("data", (c: Buffer) => {
    buffer += c.toString("utf8");
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";
    lines.push(...parts.filter((l) => l !== ""));
  });
  const next = async (match: RegExp, ms = 10_000): Promise<Record<string, unknown>> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const at = lines.findIndex((l) => match.test(l));
      if (at >= 0) return JSON.parse(lines.splice(at, 1)[0] ?? "{}") as Record<string, unknown>;
      if (Date.now() > deadline)
        throw new Error(`no line matching ${String(match)} in ${JSON.stringify(lines)}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  return { stdout, next };
};

/** One JSON-RPC request line. */
export const rpc = (id: number, method: string, params?: unknown): string =>
  `${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })}\n`;

/**
 * A `vtc` server's `tools/list` names: the Lead-facing tools (`ENGINE_MCP_TOOLS`), plus the
 * role-facing research tools (`ROLE_MCP_TOOLS`, AD-22, §5 reading 109) once the engine serves
 * them on the same server.
 */
export const expectServedTools = (names: readonly string[]): void => {
  const lead = ENGINE_MCP_TOOLS.map((t) => t.name).sort();
  const withRoles = [...lead, ...ROLE_MCP_TOOLS.map((t) => t.name)].sort();
  expect([lead, withRoles]).toContainEqual([...names].sort());
};
