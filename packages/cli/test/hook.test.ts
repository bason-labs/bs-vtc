/**
 * `vtc hook` (the frozen contract in `@vtc/shared` hook.ts; spine §5 reading 31): fail open,
 * block only a VTC role agent's git writes and writes outside its dispatch's write scope, a resume
 * hint at session start and a submit reminder when a role agent stops.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { core } from "@vtc/engine";
import { VTC_HOOK, type EngineClient, type RunningDaemon, type SpawnRoleAction } from "@vtc/shared";
import { createHookCommand, defaultHookCommandDeps } from "../src/commands/hook.js";
import { liveDaemon } from "../src/daemon.js";
import { runHook, type HookDeps, type HookOutcome } from "../src/hook.js";
import {
  agentBaseName,
  gitWriteIn,
  globToRegExp,
  isVtcRoleAgent,
  matchesAnyGlob,
  packWriteScope,
  shellCommandOf,
  writeTargets,
} from "../src/hook-rules.js";
import { findRepoRoot } from "../src/repo.js";
import { buildEngineParts, connectToRepoEngine, startDaemon } from "../src/wiring.js";
import { createDiskAssetBundle } from "../src/assets.js";
import {
  capture,
  cleanupDirs,
  fakeGateRunner,
  fakePullRequests,
  initRepo,
  tempDir,
  tempHome,
  writePluginTrees,
} from "./helpers.js";

describe("hook rules", () => {
  it("recognises VTC role agents after the host's namespace", () => {
    expect(isVtcRoleAgent("vtc:vtc-engineer-backend")).toBe(true);
    expect(isVtcRoleAgent("vtc-qa-author")).toBe(true);
    expect(isVtcRoleAgent("general-purpose")).toBe(false);
    expect(isVtcRoleAgent("my:vtcish")).toBe(false);
    expect(isVtcRoleAgent(undefined)).toBe(false);
    expect(agentBaseName("vtc:vtc-ba")).toBe("vtc-ba");
  });

  it("finds git commits, pushes, merges, rebases, resets and config changes anywhere in a line", () => {
    const blocked: [string, string][] = [
      ["git commit -m wip", "commit"],
      ["git -C ../x push origin main", "push"],
      ["cd a && git merge vtc/T-1", "merge"],
      ["git rebase -i HEAD~2", "rebase"],
      ["git reset --hard", "reset"],
      ["git config core.hooksPath x", "config"],
      ["git -c core.fsmonitor=evil status", "-c"],
      ["/usr/bin/git --no-pager commit", "commit"],
      ["bash -lc 'git push'", "push"],
      ['echo $(git commit -am "x")', "commit"],
      ["GIT_DIR=.git git pull", "pull"],
      ["git cherry-pick abc", "cherry-pick"],
      ["git status; git am < p", "am"],
      ['"git" push', "push"],
      ["sudo -E git push", "push"],
      ["env A=1 git reset --hard", "reset"],
      ['sh -c "cd x && git commit -m y"', "commit"],
      ["eval git push", "push"],
      ["echo `git commit -m x`", "commit"],
      ['echo "$(git push)"', "push"],
      ["git branch -f main HEAD~1", "branch"],
      ["git branch -D vtc/T-1", "branch"],
      ["git tag v1.0", "tag"],
      ["git tag -d v1.0", "tag"],
      ["git checkout -B main", "checkout"],
      ["git switch -C main", "switch"],
      ["git config --unset user.name", "config"],
      ["git config set user.name x", "config"],
      ["git config --global user.email a@b.c", "config"],
    ];
    for (const [line, sub] of blocked) expect(gitWriteIn(line), line).toBe(sub);
    for (const line of [
      "git status",
      "git diff HEAD",
      "git log -p",
      "ls git",
      "npm test",
      "digit commit",
      "git -C dir status",
      // a quoted mention of git is an argument, not a git call
      'grep -rn "git commit" src',
      'echo "git push later"',
      "echo 'git reset --hard'",
      'rg "git (push|commit)" -n',
      // read-only forms
      "git config --get user.name",
      "git config --list --show-origin",
      "git config -l",
      "git config user.name",
      "git config get user.name",
      "git branch",
      "git branch --list 'vtc/*'",
      "git tag",
      "git tag -l 'v*'",
      "git checkout -- src/a.ts",
    ])
      expect(gitWriteIn(line), line).toBeNull();
  });

  it("reads an argv command as the argv it is", () => {
    expect(shellCommandOf({ command: ["bash", "-lc", "git push origin main"] })).toBe(
      "bash -lc 'git push origin main'",
    );
    expect(gitWriteIn(shellCommandOf({ command: ["bash", "-lc", "git push"] }) ?? "")).toBe("push");
    expect(gitWriteIn(shellCommandOf({ command: ["grep", "-rn", "git push", "."] }) ?? "")).toBe(
      null,
    );
    expect(shellCommandOf({ command: ["echo", "it's"] })).toBe("echo 'it'\\''s'");
    expect(shellCommandOf({ cmd: 7 })).toBeNull();
  });

  it("finds the files a tool call writes", () => {
    expect(writeTargets("Write", { file_path: "/w/a.ts", content: "x" }, "/cwd")).toEqual([
      "/w/a.ts",
    ]);
    expect(writeTargets("Edit", { file_path: "rel/b.ts" }, "/cwd")).toEqual(["/cwd/rel/b.ts"]);
    expect(writeTargets("NotebookEdit", { notebook_path: "/n.ipynb" }, "/")).toEqual(["/n.ipynb"]);
    expect(writeTargets("Read", { file_path: "/w/a.ts" }, "/cwd")).toEqual([]);
    const patch =
      "*** Begin Patch\n*** Add File: src/new.ts\n+x\n*** Update File: src/old.ts\n*** Move to: src/moved.ts\n*** End Patch";
    expect(writeTargets("apply_patch", { command: ["apply_patch", patch] }, "/w")).toEqual([
      "/w/src/new.ts",
      "/w/src/old.ts",
      "/w/src/moved.ts",
    ]);
  });

  it("matches the engine's glob dialect and reads a pack's write scope", () => {
    expect(globToRegExp("src/**").test("src/a/b.ts")).toBe(true);
    expect(globToRegExp("src/**/*.ts").test("src/b.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/a/b.ts")).toBe(false);
    expect(globToRegExp("src/{a,b}.ts").test("src/b.ts")).toBe(true);
    expect(matchesAnyGlob(["docs/**", "src/x.ts"], "src/x.ts")).toBe(true);
    expect(matchesAnyGlob([], "src/x.ts")).toBe(false);
    expect(
      packWriteScope(
        "## Inputs\n\n- a\n\n## Write scope\n\n- src/**\n- test/*.ts\n\n## Gate commands\n\n- x\n",
      ),
    ).toEqual(["src/**", "test/*.ts"]);
    expect(packWriteScope("## Write scope\n\n(none)\n")).toEqual([]);
    expect(packWriteScope("no pack")).toBeNull();
  });
});

const failingDeps = (overrides: Partial<HookDeps> = {}): HookDeps => ({
  vtcHome: "/nonexistent",
  cwd: "/",
  findRepoRoot: () => Promise.reject(new Error("must not be called")),
  liveDaemon: () => {
    throw new Error("must not be called");
  },
  loadRuns: () => {
    throw new Error("must not be called");
  },
  ...overrides,
});

const silentAllow = (outcome: HookOutcome): void => {
  expect(outcome).toEqual({ code: VTC_HOOK.exit.allow });
};

describe("fail open (contract rule 2)", () => {
  it("allows without looking at the repo for anyone but a VTC role agent", async () => {
    silentAllow(
      await runHook(
        "pre-tool-use",
        "claude-code",
        JSON.stringify({ tool_name: "Bash", tool_input: { command: "git push" } }),
        failingDeps(),
      ),
    );
    silentAllow(
      await runHook(
        "subagent-stop",
        "codex",
        JSON.stringify({ agent_type: "Explore" }),
        failingDeps(),
      ),
    );
  });

  it("allows unreadable, invalid and oversized input, and internal errors", async () => {
    const agent = {
      agent_type: "vtc-engineer",
      tool_name: "Bash",
      tool_input: { command: "git push" },
    };
    silentAllow(await runHook("pre-tool-use", "claude-code", "{not json", failingDeps()));
    silentAllow(
      await runHook(
        "pre-tool-use",
        "claude-code",
        JSON.stringify({ agent_type: 7 }),
        failingDeps(),
      ),
    );
    silentAllow(
      await runHook(
        "pre-tool-use",
        "claude-code",
        " ".repeat(VTC_HOOK.maxStdinBytes + 1),
        failingDeps(),
      ),
    );
    silentAllow(await runHook("pre-tool-use", "claude-code", JSON.stringify(agent), failingDeps()));
  });

  it("allows when the repo has no live daemon or no active run", async () => {
    const agent = JSON.stringify({
      agent_type: "vtc-engineer",
      tool_name: "Bash",
      tool_input: { command: "git push" },
      cwd: "/r",
    });
    silentAllow(
      await runHook(
        "pre-tool-use",
        "claude-code",
        agent,
        failingDeps({ findRepoRoot: () => Promise.resolve(null) }),
      ),
    );
    silentAllow(
      await runHook(
        "pre-tool-use",
        "claude-code",
        agent,
        failingDeps({
          findRepoRoot: () => Promise.resolve("/r"),
          liveDaemon: () => Promise.resolve(null),
        }),
      ),
    );
    silentAllow(
      await runHook(
        "session-start",
        "claude-code",
        "{}",
        failingDeps({
          findRepoRoot: () => Promise.resolve("/r"),
          liveDaemon: () => Promise.resolve({} as never),
          loadRuns: () => [],
        }),
      ),
    );
  });

  it("the command ignores bad arguments and finishes within VTC_HOOK.timeoutMs", async () => {
    const written: HookOutcome[] = [];
    const make =
      (stdin: () => Promise<string | null>, timeoutMs = 9_000) =>
      () => ({
        ...defaultHookCommandDeps(),
        stdin,
        write: (o: HookOutcome) => written.push(o),
        timeoutMs,
      });
    const { ctx } = capture("/", "/nonexistent");
    expect(
      await createHookCommand(make(() => Promise.resolve("{}"))).run(
        ["deploy", "--host", "codex"],
        ctx,
      ),
    ).toBe(0);
    expect(
      await createHookCommand(make(() => Promise.resolve("{}"))).run(
        ["pre-tool-use", "--host", "vscode"],
        ctx,
      ),
    ).toBe(0);
    const started = Date.now();
    expect(
      await createHookCommand(make(() => new Promise(() => undefined), 200)).run(
        ["session-start", "--host", "claude-code"],
        ctx,
      ),
    ).toBe(0);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(written.every((o) => o.stdout === undefined && o.stderr === undefined)).toBe(true);
    expect(defaultHookCommandDeps().timeoutMs).toBeLessThan(VTC_HOOK.timeoutMs);
  });
});

describe("QA author mode's hidden tests (§7.3, AD-13 rule 8)", () => {
  it("allows writes into the task's hidden-test staging in the main checkout, nothing else there", async () => {
    const repo = tempDir();
    const pack = ".vtc/state/packs/a-7.md";
    mkdirSync(join(repo, ".vtc/state/packs"), { recursive: true });
    writeFileSync(
      join(repo, pack),
      "## Inputs\n\n- x\n\n## Write scope\n\n- tests/acceptance/**\n- .vtc/state/hidden-staging/T-1/**\n\n## Gate commands\n\n- y\n",
    );
    const run = {
      id: "r1",
      run: { id: "r1" },
      roleRuns: new Map([
        [
          "a-7",
          { action_id: "a-7", status: "in_flight", agent: "vtc-qa-author", pack, task: "T-1" },
        ],
      ]),
    } as never;
    const deps: HookDeps = {
      vtcHome: "/nonexistent",
      cwd: repo,
      findRepoRoot: () => Promise.resolve(repo),
      liveDaemon: () => Promise.resolve({} as never),
      loadRuns: () => [run],
    };
    const write = (path: string) =>
      runHook(
        "pre-tool-use",
        "claude-code",
        JSON.stringify({
          cwd: repo,
          agent_type: "vtc:vtc-qa-author",
          tool_name: "Write",
          tool_input: { file_path: join(repo, path), content: "x" },
        }),
        deps,
      );
    expect(await write(".vtc/state/hidden-staging/T-1/h.test.ts")).toEqual({ code: 0 });
    expect(await write(".vtc/state/hidden-staging/T-1/deep/h.test.ts")).toEqual({ code: 0 });
    expect(await write(".vtc/state/worktrees/T-1/tests/acceptance/a.test.ts")).toEqual({
      code: 0,
    });
    const otherTask = await write(".vtc/state/hidden-staging/T-2/h.test.ts");
    expect(otherTask.code).toBe(VTC_HOOK.exit.block);
    expect(otherTask.stderr).toMatch(/outside your worktree/);
    expect((await write("tests/acceptance/a.test.ts")).code).toBe(VTC_HOOK.exit.block);
    expect((await write(".vtc/state/packs/a-7.md")).code).toBe(VTC_HOOK.exit.block);
  });
});

describe("against a live daemon with a role in flight", () => {
  let repo: string;
  let home: string;
  let daemon: RunningDaemon;
  let client: EngineClient;
  let action: SpawnRoleAction;
  let deps: HookDeps;
  let worktree: string;
  let inScope: string;

  beforeAll(async () => {
    repo = initRepo();
    home = tempHome();
    const parts = await buildEngineParts({
      repoRoot: repo,
      vtcHome: home,
      installToken: "k".repeat(43),
      assets: createDiskAssetBundle(writePluginTrees(tempDir())),
      createGateRunner: fakeGateRunner,
      pullRequests: fakePullRequests(),
      adapterFactories: {},
    });
    daemon = await startDaemon(parts, { wake: false });
    client = await connectToRepoEngine(repo, home);
    deps = {
      vtcHome: home,
      cwd: repo,
      findRepoRoot: (cwd) => findRepoRoot(cwd),
      liveDaemon,
      loadRuns: (root) => core.loadRuns(root).map((r) => r.state),
    };
    // before any run: session start says nothing
    expect(
      await runHook("session-start", "claude-code", JSON.stringify({ cwd: repo }), deps),
    ).toEqual({ code: 0 });
    await client.call("start", {
      request: "Add a health endpoint",
      track: "feature",
      repo: "existing",
      has_ui: false,
    });
    const next = await client.call("next", {});
    const spawn = next.actions.find((a): a is SpawnRoleAction => a.type === "spawn_role");
    if (spawn === undefined) throw new Error(`no spawn_role in ${JSON.stringify(next.actions)}`);
    action = spawn;
    const run = core.loadRuns(repo)[0]?.state;
    const record = run?.roleRuns.get(action.action_id);
    worktree = join(
      repo,
      ".vtc/state/worktrees",
      record?.task ?? core.roleWorktreeId(run?.id ?? "", action.action_id),
    );
    mkdirSync(worktree, { recursive: true });
    const scope = packWriteScope(readFileSync(join(repo, action.pack), "utf8")) ?? [];
    const glob = scope[0] ?? "";
    inScope = glob
      .replace(/\*\*/g, "a")
      .replace(/\*/g, "x")
      .replace(/\{([^,}]*)[^}]*\}/g, "$1")
      .replace(/\?/g, "x");
  }, 30_000);

  afterAll(async () => {
    await client.close();
    await daemon.close();
    cleanupDirs();
  });

  const pre = (input: Record<string, unknown>) =>
    runHook("pre-tool-use", "claude-code", JSON.stringify({ cwd: repo, ...input }), deps);

  it("blocks the role agent's git writes, with the reason on stderr", async () => {
    const outcome = await pre({
      agent_type: `vtc:${action.agent}`,
      tool_name: "Bash",
      tool_input: { command: "git commit -am wip" },
    });
    expect(outcome.code).toBe(VTC_HOOK.exit.block);
    expect(outcome.stderr).toMatch(/never run git commit/);
    expect(outcome.stderr?.length).toBeLessThanOrEqual(VTC_HOOK.maxReasonChars);
    expect(outcome.stdout).toBeUndefined();
    // read-only git and the Lead's own git calls pass
    expect(
      (
        await pre({
          agent_type: action.agent,
          tool_name: "Bash",
          tool_input: { command: "git status" },
        })
      ).code,
    ).toBe(0);
    expect(
      (await pre({ tool_name: "Bash", tool_input: { command: "git commit -m x" } })).code,
    ).toBe(0);
  });

  it("allows writes inside the dispatch's write scope and blocks the rest", async () => {
    const agent = `vtc:${action.agent}`;
    expect(inScope).not.toBe("");
    expect(
      (
        await pre({
          agent_type: agent,
          tool_name: "Write",
          tool_input: { file_path: join(worktree, inScope) },
        })
      ).code,
    ).toBe(0);
    const outside = await pre({
      agent_type: agent,
      tool_name: "Write",
      tool_input: { file_path: join(worktree, "package.json") },
    });
    expect(outside.code).toBe(2);
    expect(outside.stderr).toMatch(/package\.json is outside your write scope/);
    const checkout = await pre({
      agent_type: agent,
      tool_name: "Edit",
      tool_input: { file_path: join(repo, "README.md") },
    });
    expect(checkout.code).toBe(2);
    expect(checkout.stderr).toMatch(/outside your worktree/);
    const other = await pre({
      agent_type: agent,
      tool_name: "Write",
      tool_input: { file_path: join(repo, ".vtc/state/worktrees/T-999/x.ts") },
    });
    expect(other.stderr).toMatch(/not yours/);
    // an agent with no dispatch in flight is left to the engine
    expect(
      (
        await pre({
          agent_type: "vtc-security-verify",
          tool_name: "Write",
          tool_input: { file_path: join(repo, "x") },
        })
      ).code,
    ).toBe(0);
  });

  it("prints a resume hint at session start and a submit reminder when a role agent stops", async () => {
    const start = await runHook("session-start", "codex", JSON.stringify({ cwd: repo }), deps);
    expect(start.code).toBe(0);
    expect(start.stdout).toMatch(/^VTC: run \S+ \(feature, phase \w+\) is in progress/);
    expect(start.stdout).toContain("`next`");
    const stop = await runHook(
      "subagent-stop",
      "claude-code",
      JSON.stringify({ cwd: repo, agent_type: `vtc:${action.agent}` }),
      deps,
    );
    expect(stop.stdout).toMatch(/Submit its outcome with the vtc `submit` tool/);
    expect(
      await runHook(
        "subagent-stop",
        "claude-code",
        JSON.stringify({ cwd: repo, agent_type: "Explore" }),
        deps,
      ),
    ).toEqual({ code: 0 });
  });
});
