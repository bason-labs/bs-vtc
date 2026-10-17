/**
 * D-cs (spine §5 reading 221): `vtc hook pre-tool-use` appends one `CommandShapeSpoolRow` per shape
 * of a VTC role agent's shell call to `<vtcHome>/guard/<repo-key>/command-shapes.jsonl`, which the
 * engine drains into the dispatch's `role.submitted`. Only the shape is written (never the raw
 * command, an argument value or a path), `O_APPEND`, created 0600, never through a symlink; it
 * fails open, never blocks and stays within `VTC_HOOK.timeoutMs`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { shellCallShapes } from "@vtc/adapters";
import { core } from "@vtc/engine";
import {
  COMMAND_SHAPE_SPOOL_FILE,
  CommandShapeSpoolRowSchema,
  commandShapes,
  HEADLESS_ROLE_ENV,
  VTC_HOOK,
} from "@vtc/shared";
import { runHook, type HookDeps } from "../src/hook.js";
import { cleanupDirs, tempDir, tempHome } from "./helpers.js";

afterAll(cleanupDirs);

const REPO = "/work/app";
const WORKTREE = `${REPO}/.vtc/state/worktrees/T-1`;
const AT = new Date("2026-10-15T09:00:00.000Z");

const depsFor = (vtcHome: string, overrides: Partial<HookDeps> = {}): HookDeps => ({
  vtcHome,
  cwd: "/",
  findRepoRoot: () => Promise.resolve(REPO),
  liveDaemon: () => Promise.resolve({} as never),
  loadRuns: () => {
    throw new Error("a shell call with no write must not replay the runs");
  },
  now: () => AT,
  ...overrides,
});

const bash = (command: unknown, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    session_id: "sess-1",
    cwd: WORKTREE,
    agent_type: "vtc:vtc-engineer-backend",
    tool_name: "Bash",
    tool_input: { command },
    ...extra,
  });

const spoolOf = (vtcHome: string): string =>
  join(core.guardDirFor(vtcHome, REPO), COMMAND_SHAPE_SPOOL_FILE);

const rowsOf = (vtcHome: string): unknown[] =>
  readFileSync(spoolOf(vtcHome), "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as unknown);

const SECRET_COMMAND =
  'cd /Users/me/secret-project && TOKEN=hunter2 npm test -- --grep "card 4111" && git status --short src/payments';

describe("the command-shape spool (D-cs, reading 221)", () => {
  it("appends one schema-valid row per shape, with no argument value or path, and allows the call", async () => {
    const home = tempHome();
    const outcome = await runHook(
      "pre-tool-use",
      "claude-code",
      bash(SECRET_COMMAND),
      depsFor(home),
    );
    expect(outcome).toEqual({ code: VTC_HOOK.exit.allow });
    const rows = rowsOf(home);
    const shapes = commandShapes(SECRET_COMMAND);
    expect(shapes.length).toBe(3);
    expect(rows).toEqual(
      shapes.map((shape) => ({
        v: 1,
        at: AT.toISOString(),
        agent: "vtc:vtc-engineer-backend",
        session: "sess-1",
        cwd: WORKTREE,
        shape,
      })),
    );
    for (const row of rows) expect(CommandShapeSpoolRowSchema.safeParse(row).success).toBe(true);
    const text = readFileSync(spoolOf(home), "utf8");
    for (const leaked of ["secret-project", "hunter2", "4111", "src/payments", "--grep", "--short"])
      expect(text).not.toContain(leaked);
  });

  it("creates the file 0600 in a 0700 directory, and appends without truncating", async () => {
    const home = tempHome();
    await runHook("pre-tool-use", "claude-code", bash("ls -la"), depsFor(home));
    await runHook("pre-tool-use", "claude-code", bash("pnpm test"), depsFor(home));
    if (process.platform !== "win32") {
      expect(statSync(spoolOf(home)).mode & 0o777).toBe(0o600);
      expect(statSync(core.guardDirFor(home, REPO)).mode & 0o777).toBe(0o700);
    }
    const rows = rowsOf(home) as { shape: { program: string; subcommand?: string } }[];
    expect(rows.map((r) => [r.shape.program, r.shape.subcommand])).toEqual([
      ["ls", undefined],
      ["pnpm", "test"],
    ]);
  });

  it("reads a command given as argv, and leaves out an absent session", async () => {
    const home = tempHome();
    await runHook(
      "pre-tool-use",
      "claude-code",
      bash(["git", "log", "--oneline"], { session_id: undefined }),
      depsFor(home),
    );
    const rows = rowsOf(home) as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toHaveProperty("session");
    expect(rows[0]?.shape).toEqual(commandShapes("git log --oneline")[0]);
  });

  it("shapes a shell wrapper as its script, as a headless run's stream does (merge glue, shellCallShapes)", async () => {
    const home = tempHome();
    await runHook(
      "pre-tool-use",
      "claude-code",
      bash("bash -lc 'git status --short' && pnpm test"),
      depsFor(home),
    );
    const rows = rowsOf(home) as { shape: unknown }[];
    expect(rows.map((r) => r.shape)).toEqual(
      shellCallShapes("bash -lc 'git status --short' && pnpm test"),
    );
    expect(rows.map((r) => r.shape)).toEqual([
      commandShapes("git status --short")[0],
      commandShapes("pnpm test")[0],
    ]);
  });

  it("records nothing for anyone but a VTC role agent, for other tools, or without a live daemon", async () => {
    const home = tempHome();
    const quiet = [
      runHook(
        "pre-tool-use",
        "claude-code",
        bash("ls", { agent_type: "general-purpose" }),
        depsFor(home),
      ),
      runHook(
        "pre-tool-use",
        "claude-code",
        JSON.stringify({
          cwd: WORKTREE,
          agent_type: "vtc-engineer",
          tool_name: "Grep",
          tool_input: { pattern: "x" },
        }),
        depsFor(home),
      ),
      runHook(
        "pre-tool-use",
        "claude-code",
        bash("ls"),
        depsFor(home, { liveDaemon: () => Promise.resolve(null) }),
      ),
      runHook(
        "pre-tool-use",
        "claude-code",
        bash("ls"),
        depsFor(home, { findRepoRoot: () => Promise.resolve(null) }),
      ),
      runHook("pre-tool-use", "claude-code", bash("   "), depsFor(home)),
    ];
    for (const outcome of await Promise.all(quiet)) expect(outcome).toEqual({ code: 0 });
    expect(existsSync(spoolOf(home))).toBe(false);
  });

  it("records no shape of a call it blocks (a role agent's git write in an active run)", async () => {
    const home = tempHome();
    const run = { id: "r1", run: { id: "r1" }, tasks: new Map(), roleRuns: new Map() };
    const blocked = await runHook(
      "pre-tool-use",
      "claude-code",
      bash("git push origin main"),
      depsFor(home, { loadRuns: () => [run as never] }),
    );
    expect(blocked.code).toBe(VTC_HOOK.exit.block);
    expect(existsSync(spoolOf(home))).toBe(false);
  });

  it("never writes through a symlink in place of the spool or of its directory", async () => {
    const home = tempHome();
    const guard = core.guardDirFor(home, REPO);
    mkdirSync(guard, { recursive: true, mode: 0o700 });
    const elsewhere = join(tempDir(), "target.txt");
    writeFileSync(elsewhere, "untouched\n");
    symlinkSync(elsewhere, join(guard, COMMAND_SHAPE_SPOOL_FILE));
    expect(await runHook("pre-tool-use", "claude-code", bash("ls"), depsFor(home))).toEqual({
      code: 0,
    });
    expect(readFileSync(elsewhere, "utf8")).toBe("untouched\n");

    const other = tempHome();
    const realDir = tempDir();
    mkdirSync(join(other, core.GUARD_DIR), { recursive: true });
    symlinkSync(realDir, core.guardDirFor(other, REPO));
    expect(await runHook("pre-tool-use", "claude-code", bash("ls"), depsFor(other))).toEqual({
      code: 0,
    });
    expect(existsSync(join(realDir, COMMAND_SHAPE_SPOOL_FILE))).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "does not hang on a FIFO in place of the spool, and appends nothing to it",
    async () => {
      const home = tempHome();
      const guard = core.guardDirFor(home, REPO);
      mkdirSync(guard, { recursive: true, mode: 0o700 });
      execFileSync("mkfifo", [join(guard, COMMAND_SHAPE_SPOOL_FILE)]);
      const started = Date.now();
      expect(await runHook("pre-tool-use", "claude-code", bash("ls"), depsFor(home))).toEqual({
        code: 0,
      });
      expect(Date.now() - started).toBeLessThan(2_000);
    },
  );

  it("fails open when the VTC home cannot be written, and writes nothing past the deadline", async () => {
    const file = join(tempDir(), "home-is-a-file");
    writeFileSync(file, "x");
    expect(await runHook("pre-tool-use", "claude-code", bash("ls"), depsFor(file))).toEqual({
      code: 0,
    });
    const home = tempHome();
    expect(
      await runHook(
        "pre-tool-use",
        "claude-code",
        bash("ls"),
        depsFor(home, { deadline: Date.now() - 1 }),
      ),
    ).toEqual({ code: 0 });
    expect(existsSync(spoolOf(home))).toBe(false);
  });
});

describe("an engine-launched headless role run (hook contract rule 7, contracts 5.5.0)", () => {
  const marked = { [HEADLESS_ROLE_ENV]: "vtc:vtc-engineer-backend" };

  it("spools nothing: the adapter's stream records a headless run's shapes", async () => {
    const home = tempHome();
    const outcome = await runHook(
      "pre-tool-use",
      "claude-code",
      bash("pnpm test"),
      depsFor(home, { env: marked }),
    );
    expect(outcome).toEqual({ code: VTC_HOOK.exit.allow });
    expect(existsSync(spoolOf(home))).toBe(false);
  });

  it("applies the role rules from the marker when the input carries no agent_type", async () => {
    const home = tempHome();
    const run = { id: "r1", run: { id: "r1" }, tasks: new Map(), roleRuns: new Map() };
    const input = bash("git push origin main", { agent_type: undefined });
    const unmarked = await runHook(
      "pre-tool-use",
      "claude-code",
      input,
      depsFor(home, { loadRuns: () => [run as never] }),
    );
    expect(unmarked.code).toBe(VTC_HOOK.exit.allow);
    const blocked = await runHook(
      "pre-tool-use",
      "claude-code",
      input,
      depsFor(home, { loadRuns: () => [run as never], env: marked }),
    );
    expect(blocked.code).toBe(VTC_HOOK.exit.block);
    // a marker that names no VTC role agent is ignored
    const other = await runHook(
      "pre-tool-use",
      "claude-code",
      input,
      depsFor(home, {
        loadRuns: () => [run as never],
        env: { [HEADLESS_ROLE_ENV]: "general-purpose" },
      }),
    );
    expect(other.code).toBe(VTC_HOOK.exit.allow);
  });

  it("prints no resume hint at session start", async () => {
    const home = tempHome();
    const deps = depsFor(home, {
      unfinishedRuns: () =>
        Promise.resolve([{ id: "r1", track: "feature", phase: "build", paused: false }] as never),
    });
    const lead = await runHook("session-start", "claude-code", JSON.stringify({ cwd: REPO }), deps);
    expect(lead.stdout).toMatch(/Resume run\?/);
    const role = await runHook("session-start", "claude-code", JSON.stringify({ cwd: REPO }), {
      ...deps,
      env: marked,
    });
    expect(role).toEqual({ code: VTC_HOOK.exit.allow });
  });
});
