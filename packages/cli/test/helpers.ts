/**
 * Shared test helpers: temp git repos and VTC homes, the real compiled plugins on disk, a
 * capturing `CommandContext`, fakes for the PR service and the Gate Runner.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compilePlugins, readSources } from "@vtc/compiler";
import {
  HOST_IDS,
  type AssetNamespace,
  type EngineClient,
  type GateRunner,
  type PullRequestService,
} from "@vtc/shared";
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
