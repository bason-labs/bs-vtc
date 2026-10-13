/**
 * The dispatch guard (AD-7 rules 2 and 7, AD-8 rule 3; spine §5 readings 21–23), driven through
 * next()/submit() on a real repo: the engine's ledger and dispatch records live in its private
 * directory, outside the repo; a restart replays a run's log only as far as the ledger vouches
 * for it (an in-place edit, an inserted line, a forged tail), finished runs included; a role in
 * flight without its record pauses its run; every dispatched role, task roles included, arms the
 * git baseline, so a planted filter driver never runs; allow-listed config keys may change.
 */
import {
  appendFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { engineRepoKey, SubmitInputSchema, toEventLine, type LeadAction } from "@vtc/shared";
import { EngineWrites } from "../../src/core/engine-writes.js";
import { guardDirFor } from "../../src/core/guard.js";
import {
  appendRepoFile,
  GitConfigChangedError,
  isAllowedConfigKey,
  removeRepoFile,
  runGit,
  setGitSigning,
  writeRepoFile,
} from "../../src/git/index.js";
import { cleanupDirs, git, initRepo, tempDir, writeFile } from "../helpers/repo.js";
import {
  authorTests,
  CLAUDE,
  createHarness,
  draft,
  only,
  SPEC_ONE,
  spawns,
  submitResult,
  throughPlan,
  workdir,
  worktreeOf,
  type Harness,
  type SpawnAction,
} from "../helpers/engine-harness.js";

afterEach(cleanupDirs);

const next = async (h: Harness): Promise<LeadAction[]> => (await h.engine.next({}, CLAUDE)).actions;
const runId = (h: Harness): string => h.engine.status({}).run.id;
const logPath = (h: Harness, run = runId(h)): string =>
  join(h.repo, `.vtc/runs/${run}/events.jsonl`);
interface Line {
  type: string;
  seq: number;
  data: Record<string, unknown>;
}
const events = (h: Harness, run = runId(h)): Line[] =>
  readFileSync(logPath(h, run), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Line);
const incidents = (h: Harness, kind: string): string =>
  JSON.stringify(events(h).filter((e) => e.type === "incident.recorded" && e.data.kind === kind));
const reopen = (h: Harness) => {
  const engine = h.reopen();
  Object.assign(h, { engine });
  return engine;
};
const start = (h: Harness) =>
  h.engine.start(
    {
      request: "Password reset\n\nUsers reset forgotten passwords.",
      track: "feature",
      repo: "existing",
      has_ui: false,
      risk_hints: [],
    },
    CLAUDE,
  );
const repoMap = {
  exit: "done" as const,
  artifacts: [{ type: "repo_map", path: ".vtc/research/repo-map.md" }],
};
const toEngineer = async (h: Harness): Promise<SpawnAction> => {
  const actions = await throughPlan(h, [draft("T-1")], SPEC_ONE);
  await authorTests(h, only(actions, "qa"));
  return only(await next(h), "engineer");
};
/** A valid event line the engine never wrote. */
const forged = (
  run: string,
  seq: number,
  type = "run.finished",
  data: unknown = { outcome: "aborted" },
) =>
  toEventLine({
    v: 1,
    seq,
    run,
    ts: "2026-10-13T09:00:00.000Z",
    type,
    actor: "engine",
    data,
  } as never);

describe("EngineWrites: a ledger in the engine's private directory, with a digest per append", () => {
  it("tracks writes, appends and removals, and finds any other change", () => {
    const repo = initRepo();
    const ledgerPath = join(tempDir("vtc-guard-"), "engine-writes.jsonl");
    const ledger = EngineWrites.open(repo, ledgerPath);
    writeRepoFile(repo, ".vtc/tasks/T-1.md", "plan\n");
    appendRepoFile(repo, ".vtc/runs/r1/events.jsonl", "a\n");
    appendRepoFile(repo, ".vtc/runs/r1/events.jsonl", "b\n");
    expect(ledger.check(".vtc/tasks/T-1.md").ok).toBe(true);
    expect(ledger.check(".vtc/runs/r1/events.jsonl").ok).toBe(true);
    expect(statSync(ledgerPath).mode & 0o777).toBe(0o600);
    // someone else appends: found; the engine's two appends are still the verified prefix
    appendFileSync(join(repo, ".vtc/runs/r1/events.jsonl"), "forged\n");
    expect(ledger.check(".vtc/runs/r1/events.jsonl").ok).toBe(false);
    expect(ledger.verifiedPrefix(".vtc/runs/r1/events.jsonl")).toBe(4);
    // ... and the next engine append records the change without vouching for it
    appendRepoFile(repo, ".vtc/runs/r1/events.jsonl", "c\n");
    expect(ledger.foreign(".vtc/runs/r1/events.jsonl")).toContain("before an engine append");
    expect(ledger.verifiedPrefix(".vtc/runs/r1/events.jsonl")).toBe(4);
    writeFileSync(join(repo, ".vtc/tasks/T-1.md"), "edited\n");
    expect(ledger.check(".vtc/tasks/T-1.md").ok).toBe(false);
    removeRepoFile(repo, ".vtc/tasks/T-1.md");
    expect(ledger.check(".vtc/tasks/T-1.md").ok).toBe(true);
    writeFileSync(join(repo, ".vtc/tasks/T-1.md"), "back\n");
    expect(ledger.check(".vtc/tasks/T-1.md").ok).toBe(false);
    expect(ledger.check(".vtc/tasks/T-9.md").ok).toBe(false);
    ledger.close();
  });
  it("survives a restart with every append's digest, and tolerates nothing after them", () => {
    const repo = initRepo();
    const ledgerPath = join(tempDir("vtc-guard-"), "engine-writes.jsonl");
    const first = EngineWrites.open(repo, ledgerPath);
    for (const line of ["a\n", "bb\n", "ccc\n"])
      appendRepoFile(repo, ".vtc/runs/r1/events.jsonl", line);
    first.close();
    const second = EngineWrites.open(repo, ledgerPath);
    expect(second.check(".vtc/runs/r1/events.jsonl").ok).toBe(true);
    // one extra line (a crash between an append and its ledger line looks the same): refused
    appendFileSync(join(repo, ".vtc/runs/r1/events.jsonl"), "d\n");
    expect(second.check(".vtc/runs/r1/events.jsonl").ok).toBe(false);
    expect(second.verifiedPrefix(".vtc/runs/r1/events.jsonl")).toBe(9);
    // an in-place edit of the second line: only the first is verified
    writeFileSync(join(repo, ".vtc/runs/r1/events.jsonl"), "a\nBB\nccc\n");
    expect(second.verifiedPrefix(".vtc/runs/r1/events.jsonl")).toBe(2);
    // an inserted line: the same
    writeFileSync(join(repo, ".vtc/runs/r1/events.jsonl"), "a\nX\nbb\nccc\n");
    expect(second.verifiedPrefix(".vtc/runs/r1/events.jsonl")).toBe(2);
    second.close();
  });
});

describe("a restart replays only what the ledger vouches for (finding phase-role-writes-unverified)", () => {
  it("keeps the ledger and the dispatch records outside the repo, 0600", async () => {
    const h = createHarness();
    await start(h);
    only(await next(h), "repo_cartographer");
    const guard = guardDirFor(h.home, h.repo);
    expect(guard).toBe(join(h.home, "guard", engineRepoKey(h.repo)));
    expect(statSync(guard).mode & 0o777).toBe(0o700);
    expect(statSync(join(guard, "engine-writes.jsonl")).mode & 0o777).toBe(0o600);
    const records = readdirSync(join(guard, "dispatches"));
    expect(records).toEqual([`${runId(h)}--a-1.json`]);
    expect(statSync(join(guard, "dispatches", records[0] ?? "")).mode & 0o777).toBe(0o600);
    expect(existsSync(join(h.repo, ".vtc/state/engine-writes.jsonl"))).toBe(false);
    expect(existsSync(join(h.repo, ".vtc/state/scopes"))).toBe(false);
    await h.release();
  });
  it("an in-place edit: the log is cut back to the verified prefix, kept aside, and the run pauses", async () => {
    const h = createHarness();
    await start(h);
    await h.engine.settle();
    const before = events(h);
    const lines = readFileSync(logPath(h), "utf8").split("\n");
    const last = lines.length - 2; // the final event (the file ends in a newline)
    lines[last] = (lines[last] ?? "").replace('"to":"discover"', '"to":"build"   ');
    writeFileSync(logPath(h), lines.join("\n"));
    const engine = reopen(h);
    expect(engine.status({}).run.paused).toBe(true);
    expect(engine.status({}).run.phase).toBe(before.at(-2)?.data.to ?? "intake");
    const after = events(h);
    expect(after.slice(0, before.length - 1)).toEqual(before.slice(0, -1));
    expect(JSON.stringify(after)).not.toContain('"to":"build"');
    const incident = incidents(h, "log_corruption");
    expect(incident).toContain(`replayed only its first ${String(before.length - 1)} event(s)`);
    expect(incident).toContain(".vtc/state/forensics/");
    expect(incident).not.toContain("only what the engine wrote was replayed");
    const kept = readdirSync(join(h.repo, ".vtc/state/forensics"));
    expect(readFileSync(join(h.repo, ".vtc/state/forensics", kept[0] ?? ""), "utf8")).toContain(
      '"to":"build"',
    );
    // the human resumes; a restart after that is clean
    await engine.resume({});
    await engine.settle();
    expect(reopen(h).status({}).run.paused).toBe(false);
    await h.release();
  });
  it("an inserted line: nothing from it on is replayed", async () => {
    const h = createHarness();
    await start(h);
    await h.engine.settle();
    const before = events(h);
    const lines = readFileSync(logPath(h), "utf8").split("\n");
    lines.splice(
      lines.length - 2,
      0,
      forged(runId(h), before.length, "gate.approved", {
        gates: ["G1"],
        frozen: [{ path: ".vtc/spec/spec.md", sha256: "a".repeat(64) }],
        waived_facts: [],
      }).trimEnd(),
    );
    writeFileSync(logPath(h), lines.join("\n"));
    const engine = reopen(h);
    expect(engine.status({}).run.gates.G1.status).not.toBe("approved");
    expect(engine.status({}).run.paused).toBe(true);
    await engine.resume({});
    expect(engine.status({}).run.gates.G1.status).not.toBe("approved");
    await h.release();
  });
  it("a forged tail never finishes an unfinished run", async () => {
    const h = createHarness();
    await start(h);
    await h.engine.settle();
    const run = runId(h);
    appendFileSync(logPath(h), forged(run, events(h).length + 1));
    const engine = reopen(h);
    expect(engine.status({}).run.finished_at).toBeUndefined();
    expect(engine.status({}).run.paused).toBe(true);
    expect(readFileSync(logPath(h, run), "utf8")).not.toContain('"run.finished"');
    await h.release();
  });
  it("a finished run's log is cut back too (it stays finished only by its verified prefix)", async () => {
    const h = createHarness();
    const engineer = await toEngineer(h);
    const parked = await submitResult(h, engineer, {
      exit: "spec_conflict",
      conflict: { req_ids: ["REQ-1"], detail: "REQ-1 contradicts itself" },
    });
    expect(parked.accepted).toBe(true);
    const escalation = h.engine.escalations({}).escalations[0];
    await h.engine.answer(
      {
        escalation: escalation?.id ?? "",
        answer: { option: "drop", who_should_have_caught: "ba" },
      },
      CLAUDE,
    );
    await h.engine.settle();
    const run = h.engine.status({}).run;
    expect(run.finished_at).toBeDefined();
    const clean = readFileSync(logPath(h, run.id), "utf8");
    appendFileSync(
      logPath(h, run.id),
      forged(run.id, events(h, run.id).length + 1, "run.resumed", { auto: false }),
    );
    const engine = reopen(h);
    expect(engine.status({ run: run.id }).run.finished_at).toBeDefined();
    expect(readFileSync(logPath(h, run.id), "utf8")).toBe(clean);
    expect(engine.notices.join("\n")).toContain("replayed only its first");
    expect(readdirSync(join(h.repo, ".vtc/state/forensics"))).toHaveLength(1);
    await h.release();
  });
  it("a deleted dispatch record across a restart: the run in flight cannot be verified and pauses", async () => {
    const h = createHarness();
    await start(h);
    only(await next(h), "repo_cartographer");
    await h.engine.settle();
    rmSync(join(guardDirFor(h.home, h.repo), "dispatches"), { recursive: true });
    const engine = reopen(h);
    expect(engine.status({}).run.paused).toBe(true);
    expect(incidents(h, "checkout_write")).toContain("cannot be verified");
    expect(JSON.stringify(events(h).filter((e) => e.type === "run.paused"))).toContain(
      "without a dispatch record",
    );
    await h.release();
  });
  it("an unfinished log this engine never wrote pauses its run", async () => {
    const h = createHarness();
    await start(h);
    await h.engine.settle();
    rmSync(join(guardDirFor(h.home, h.repo), "engine-writes.jsonl"));
    const engine = reopen(h);
    expect(engine.status({}).run.paused).toBe(true);
    expect(incidents(h, "log_corruption")).toContain("not written by this engine install");
    await h.release();
  });
});

describe("every role's dispatch is guarded (AD-7 rule 7)", () => {
  it("a role's write where only the engine writes: rejected, logged in full, the run pauses", async () => {
    const h = createHarness();
    await start(h);
    const carto = only(await next(h), "repo_cartographer");
    writeFile(workdir(carto), ".vtc/research/repo-map.md", "# map\n");
    // through the host, outside its worktree, into the user's checkout
    writeFile(h.repo, ".vtc/tasks/T-9.md", "forged plan\n");
    writeFileSync(join(h.repo, `.vtc/runs/${runId(h)}/request.md`), "a different request\n");
    const out = await submitResult(h, carto, repoMap);
    expect(out).toMatchObject({ accepted: false, rejection: { reason: "write_scope" } });
    const issues = (out.rejection?.issues ?? []).join("\n");
    expect(issues).toContain(".vtc/tasks/T-9.md was written where only the engine writes");
    expect(issues).toContain("request.md changed outside the engine");
    expect(h.engine.status({}).run.paused).toBe(true);
    const incident = events(h).find(
      (e) => e.type === "incident.recorded" && e.data.kind === "checkout_write",
    );
    expect(incident?.data.evidence).toEqual(
      expect.arrayContaining([{ type: "file", ref: ".vtc/tasks/T-9.md" }]),
    );
    const pause = events(h).findLast((e) => e.type === "run.paused");
    expect(String(pause?.data.reason)).toContain("see the incident");
    expect(spawns(await next(h))).toEqual([]);
    await h.engine.resume({});
    expect(only(await next(h), "repo_cartographer").role).toBe("repo_cartographer");
    await h.release();
  });
  it("checks a failure submit too", async () => {
    const h = createHarness();
    await start(h);
    const carto = only(await next(h), "repo_cartographer");
    writeFile(h.repo, ".vtc/evidence/T-1/forged.json", "{}\n");
    const out = await h.engine.submit(
      SubmitInputSchema.parse({
        kind: "failure",
        action_id: carto.action_id,
        outcome: {
          kind: "error",
          message: "the subagent died",
          retryable: true,
          tokens: null,
          cost_usd: null,
        },
      }),
      CLAUDE,
    );
    expect(out.accepted).toBe(true);
    expect(h.engine.status({}).run.paused).toBe(true);
    expect(incidents(h, "checkout_write")).toContain(".vtc/evidence/T-1/forged.json");
    await h.release();
  });
  it("pauses at once when an engine append finds the log changed; never replays the line", async () => {
    const h = createHarness();
    await start(h);
    const line = forged(runId(h), events(h).length + 1);
    appendFileSync(logPath(h), line);
    await next(h); // dispatches: the engine appends and finds the foreign line
    expect(h.engine.status({}).run.paused).toBe(true);
    expect(h.engine.status({}).run.finished_at).toBeUndefined();
    expect(readFileSync(logPath(h), "utf8")).not.toContain(line.trim());
    await h.engine.settle();
    expect(reopen(h).status({}).run.finished_at).toBeUndefined();
    await h.release();
  });
  it("checks a run superseded by resume, and one across a restart", async () => {
    const h = createHarness();
    await start(h);
    only(await next(h), "repo_cartographer");
    await h.engine.settle();
    const engine = reopen(h);
    writeFile(h.repo, ".vtc/tasks/T-7.md", "late\n");
    await engine.pause({});
    const resumed = await engine.resume({});
    expect(resumed.paused).toBe(true);
    expect(incidents(h, "checkout_write")).toContain(".vtc/tasks/T-7.md");
    expect((await engine.resume({})).paused).toBe(false);
    await h.release();
  });
});

describe("git configuration (spine §5 readings 22, 23; finding task-role-git-config-unguarded)", () => {
  it("holds every key that can run code, and only allow-lists keys that cannot", () => {
    for (const key of [
      "user.name",
      "user.email",
      "color.ui",
      "color.diff.meta",
      "init.defaultBranch",
      "pull.rebase",
      "push.default",
      "branch.main.merge",
      "branch.feature/x.y.remote",
      "remote.origin.gh-resolved",
    ])
      expect(isAllowedConfigKey(key), key).toBe(true);
    for (const key of [
      "core.hooksPath",
      "core.fsmonitor",
      "core.sshCommand",
      "core.editor",
      "gpg.program",
      "gpg.ssh.program",
      "user.signingkey",
      "filter.lfs.clean",
      "diff.pdf.textconv",
      "merge.ours.driver",
      "alias.st",
      "credential.helper",
      "remote.origin.url",
      "url.https://x/.insteadof",
      "include.path",
      "includeif.gitdir:~/w/.path",
      "init.templatedir",
      "some.unknown.key",
    ])
      expect(isAllowedConfigKey(key), key).toBe(false);
  });
  it("runs engine git in a clean environment: an inherited GIT_DIR or config never applies", async () => {
    const h = createHarness();
    const saved = { dir: process.env.GIT_DIR, params: process.env.GIT_CONFIG_PARAMETERS };
    process.env.GIT_DIR = join(h.repo, "nowhere");
    process.env.GIT_CONFIG_PARAMETERS = "'core.fsmonitor'='touch /tmp/vtc-never'";
    try {
      const top = await runGit(h.repo, ["rev-parse", "--show-toplevel"]);
      expect(top.stdout.toString("utf8").trim()).toBe(git(h.repo, "rev-parse", "--show-toplevel"));
    } finally {
      if (saved.dir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved.dir;
      if (saved.params === undefined) delete process.env.GIT_CONFIG_PARAMETERS;
      else process.env.GIT_CONFIG_PARAMETERS = saved.params;
    }
    await h.release();
  });
  it("a task role's planted filter driver never runs: engine git stops until the human resumes", async () => {
    const h = createHarness();
    const engineer = await toEngineer(h);
    const marker = join(h.repo, "filtered");
    git(h.repo, "config", "filter.evil.clean", `touch "${marker}"; cat`);
    writeFile(worktreeOf(h, "T-1"), ".gitattributes", "* filter=evil\n");
    writeFile(worktreeOf(h, "T-1"), "src/t-1/impl.ts", "export const x = 1;\n");
    await expect(runGit(h.repo, ["status"])).rejects.toBeInstanceOf(GitConfigChangedError);
    const out = await submitResult(h, engineer, { exit: "built" });
    expect(out).toMatchObject({ accepted: false, rejection: { reason: "write_scope" } });
    expect((out.rejection?.issues ?? []).join("\n")).toContain(".git/config: filter.evil.clean");
    expect(h.engine.status({}).run.paused).toBe(true);
    expect(existsSync(marker)).toBe(false);
    // the hold survives a restart
    await h.engine.settle();
    const engine = reopen(h);
    await expect(runGit(h.repo, ["status"])).rejects.toBeInstanceOf(GitConfigChangedError);
    git(h.repo, "config", "--unset", "filter.evil.clean");
    await engine.resume({});
    expect((await runGit(h.repo, ["status"])).code).toBe(0);
    expect(existsSync(marker)).toBe(false);
    await h.release();
  });
  it("lets allow-listed keys change while a role is in flight", async () => {
    const h = createHarness();
    const engineer = await toEngineer(h);
    git(h.repo, "config", "user.email", "someone@example.com");
    git(h.repo, "config", "color.ui", "always");
    git(h.repo, "config", "branch.main.merge", "refs/heads/main");
    writeFile(worktreeOf(h, "T-1"), "src/t-1/impl.ts", "export const x = 1;\n");
    const out = await submitResult(h, engineer, { exit: "built" });
    expect(out.accepted).toBe(true);
    expect(h.engine.status({}).run.paused).toBe(false);
    await h.release();
  });
  it("refuses a signing program or key set during a run (held keys)", async () => {
    const h = createHarness();
    await start(h);
    only(await next(h), "repo_cartographer");
    git(h.repo, "config", "user.signingkey", "ABCDEF");
    await expect(runGit(h.repo, ["status"])).rejects.toThrow(/user.signingkey/);
    git(h.repo, "config", "--unset", "user.signingkey");
    git(h.repo, "config", "gpg.program", "/bin/true");
    await expect(runGit(h.repo, ["status"])).rejects.toThrow(/gpg.program/);
    git(h.repo, "config", "--unset", "gpg.program");
    expect((await runGit(h.repo, ["status"])).code).toBe(0);
    await h.release();
  });
  it("signs engine commits with the user's own setup only when git.sign_commits is true", async () => {
    const marker = join(tempDir("vtc-sign-"), "signed");
    const program = join(tempDir("vtc-sign-"), "sign.sh");
    writeFileSync(program, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`, { mode: 0o755 });
    const commit = async (repo: string) => {
      writeFile(repo, `x-${String(Date.now())}.txt`, "x\n");
      await runGit(repo, ["add", "--all"]);
      return runGit(repo, ["commit", "--quiet", "-m", "engine commit"], { allowFailure: true });
    };
    const unsigned = createHarness();
    git(unsigned.repo, "config", "gpg.program", program);
    git(unsigned.repo, "config", "commit.gpgsign", "true");
    expect((await commit(unsigned.repo)).code).toBe(0);
    expect(existsSync(marker)).toBe(false);
    await unsigned.release();
    const signed = createHarness({ project: { git: { sign_commits: true } } });
    git(signed.repo, "config", "gpg.program", program);
    expect((await commit(signed.repo)).code).not.toBe(0); // the fake signer refuses
    expect(existsSync(marker)).toBe(true);
    setGitSigning(signed.repo, null);
    await signed.release();
  });
});

describe("a restart never drops a dispatch record unchecked (finding restart-drops-unchecked-dispatch-records)", () => {
  /**
   * The Engineer plants a filter driver, then loses its run's log (`lose`) and the daemon
   * restarts: the record is checked, the git change held, the run's loss reported and held.
   */
  const plantedThenLost = async (
    lose: (h: Harness, log: string) => void,
    check: (h: Harness) => void = () => undefined,
  ) => {
    const h = createHarness();
    await toEngineer(h);
    const run = runId(h);
    const marker = join(h.repo, "filtered");
    git(h.repo, "config", "filter.evil.clean", `touch "${marker}"; cat`);
    writeFile(worktreeOf(h, "T-1"), ".gitattributes", "* filter=evil\n");
    writeFile(worktreeOf(h, "T-1"), "src/t-1/impl.ts", "export const x = 1;\n");
    await h.engine.settle();
    lose(h, logPath(h, run));
    const engine = reopen(h);
    check(h);
    const notices = engine.notices.join("\n");
    expect(notices).toContain(`.vtc/runs/${run}/events.jsonl`);
    expect(notices).toContain("filter.evil.clean");
    expect(engine.gitHold).not.toBeNull();
    expect(readdirSync(join(guardDirFor(h.home, h.repo), "dispatches"))).not.toEqual([]);
    await expect(
      runGit(h.repo, ["-C", worktreeOf(h, "T-1"), "add", "--all"]),
    ).rejects.toBeInstanceOf(GitConfigChangedError);
    expect(existsSync(marker)).toBe(false);
    await expect(start(h)).rejects.toThrow(/vtc resume/);
    // the human removes the planted driver and resumes: the hold is released
    git(h.repo, "config", "--unset", "filter.evil.clean");
    rmSync(join(worktreeOf(h, "T-1"), ".gitattributes"));
    const resumed = await engine.resume({});
    expect(resumed).toMatchObject({ run, paused: false });
    expect(engine.gitHold).toBeNull();
    expect(readdirSync(join(guardDirFor(h.home, h.repo), "dispatches"))).toEqual([]);
    expect((await runGit(h.repo, ["status"])).code).toBe(0);
    expect(existsSync(marker)).toBe(false);
    const again = reopen(h);
    expect(again.notices).toEqual([]);
    expect((await start(h)).run).not.toBe(run);
    await h.release();
  };
  it("a deleted log", async () => {
    await plantedThenLost((_h, log) => {
      rmSync(log);
    });
  });
  it("a log replaced with garbage (kept aside for the human)", async () => {
    await plantedThenLost(
      (_h, log) => {
        writeFileSync(log, "garbage\n");
      },
      (h) => {
        const forensics = join(h.repo, ".vtc/state/forensics");
        const kept = readdirSync(forensics).map((f) => readFileSync(join(forensics, f), "utf8"));
        expect(kept).toEqual(["garbage\n"]);
        expect(existsSync(logPath(h, h.engine.notices[0]?.match(/runs\/([^/]+)\//)?.[1]))).toBe(
          false,
        );
      },
    );
  });
  it("a log cut to 0 verified events", async () => {
    await plantedThenLost((_h, log) => {
      const lines = readFileSync(log, "utf8").split("\n");
      lines[0] = (lines[0] ?? "").replace("Password reset", "Password RESET");
      writeFileSync(log, lines.join("\n"));
    });
  });
  it("a lost log with no record in flight still holds new runs until the human resumes", async () => {
    const h = createHarness();
    await start(h);
    await h.engine.settle();
    const run = runId(h);
    rmSync(join(h.repo, ".vtc/runs", run), { recursive: true });
    const engine = reopen(h);
    expect(engine.notices.join("\n")).toContain(`.vtc/runs/${run}/events.jsonl`);
    await expect(start(h)).rejects.toThrow(/vtc resume/);
    expect(await engine.resume({ run })).toMatchObject({ run, paused: false });
    expect(reopen(h).notices).toEqual([]);
    expect((await start(h)).run).not.toBe(run);
    await h.release();
  });
  it("a finished run's left-over record: checked on open, a git change held", async () => {
    const h = createHarness();
    const engineer = await toEngineer(h);
    const dispatches = join(guardDirFor(h.home, h.repo), "dispatches");
    const name = readdirSync(dispatches)[0] ?? "";
    const record = readFileSync(join(dispatches, name), "utf8");
    await submitResult(h, engineer, {
      exit: "spec_conflict",
      conflict: { req_ids: ["REQ-1"], detail: "REQ-1 contradicts itself" },
    });
    const escalation = h.engine.escalations({}).escalations[0];
    await h.engine.answer(
      {
        escalation: escalation?.id ?? "",
        answer: { option: "drop", who_should_have_caught: "ba" },
      },
      CLAUDE,
    );
    await h.engine.settle();
    const run = runId(h);
    expect(h.engine.status({}).run.finished_at).toBeDefined();
    // a crash between the run's end and the record's drop left the record; git changed since
    writeFileSync(join(dispatches, name), record);
    git(h.repo, "config", "core.hooksPath", join(h.repo, "evil-hooks"));
    const engine = reopen(h);
    expect(engine.status({ run }).run.finished_at).toBeDefined();
    expect(engine.notices.join("\n")).toMatch(/core\.hookspath/i);
    await expect(runGit(h.repo, ["status"])).rejects.toBeInstanceOf(GitConfigChangedError);
    await expect(start(h)).rejects.toThrow(/vtc resume/);
    git(h.repo, "config", "--unset", "core.hooksPath");
    expect(await engine.resume({ run })).toMatchObject({ run, paused: false });
    expect((await runGit(h.repo, ["status"])).code).toBe(0);
    expect(readdirSync(dispatches)).toEqual([]);
    await h.release();
  });
});

describe("the Gate Runner's run arms the git baseline (finding gate-run-git-baseline-unarmed)", () => {
  it("gate code that plants a filter driver: reported, held, never run by engine git", async () => {
    const h = createHarness();
    const engineer = await toEngineer(h);
    const release = h.gates.hold();
    writeFile(worktreeOf(h, "T-1"), "src/t-1/impl.ts", "export const x = 1;\n");
    expect((await submitResult(h, engineer, { exit: "built" })).accepted).toBe(true);
    expect(readdirSync(join(guardDirFor(h.home, h.repo), "dispatches"))).toEqual([]);
    await vi.waitFor(() => {
      expect(h.gates.requests.some((r) => r.reason === "round")).toBe(true);
    });
    // the gate's code runs now: it writes the repo's git config
    const marker = join(h.repo, "filtered");
    git(h.repo, "config", "filter.evil.clean", `touch "${marker}"; cat`);
    writeFile(h.repo, ".gitattributes", "* filter=evil\n");
    await expect(runGit(h.repo, ["status"])).rejects.toBeInstanceOf(GitConfigChangedError);
    release();
    await h.engine.settle();
    expect(h.engine.status({}).run.paused).toBe(true);
    const incident = incidents(h, "checkout_write");
    expect(incident).toContain("filter.evil.clean");
    expect(incident).toContain("Gate Runner");
    expect(h.engine.gitHold).not.toBeNull();
    await expect(runGit(h.repo, ["status"])).rejects.toBeInstanceOf(GitConfigChangedError);
    // the hold survives a restart
    const engine = reopen(h);
    await expect(runGit(h.repo, ["status"])).rejects.toBeInstanceOf(GitConfigChangedError);
    git(h.repo, "config", "--unset", "filter.evil.clean");
    rmSync(join(h.repo, ".gitattributes"));
    await engine.resume({});
    expect((await runGit(h.repo, ["status"])).code).toBe(0);
    expect(existsSync(marker)).toBe(false);
    await h.release();
  });
  it("a restart while gate code runs: the gate's baseline is kept, checked on open, the change held (finding gate-run-git-baseline-lost-on-restart)", async () => {
    const h = createHarness();
    const engineer = await toEngineer(h);
    const run = runId(h);
    h.gates.hold(); // never released: the daemon is killed while the gate's code runs
    writeFile(worktreeOf(h, "T-1"), "src/t-1/impl.ts", "export const x = 1;\n");
    expect((await submitResult(h, engineer, { exit: "built" })).accepted).toBe(true);
    const guard = guardDirFor(h.home, h.repo);
    expect(readdirSync(join(guard, "dispatches"))).toEqual([]);
    await vi.waitFor(() => {
      expect(h.gates.requests.some((r) => r.reason === "round")).toBe(true);
    });
    // the gate run's baseline is kept in the engine's private directory, 0600
    const gates = readdirSync(join(guard, "gates"));
    expect(gates).toHaveLength(1);
    expect(statSync(join(guard, "gates", gates[0] ?? "")).mode & 0o777).toBe(0o600);
    // the gate's code plants a filter driver through the repo's own git config and attributes
    const marker = join(h.repo, "filtered");
    git(h.repo, "config", "filter.evil.clean", `touch "${marker}"; cat`);
    git(h.repo, "config", "filter.evil.smudge", `touch "${marker}"; cat`);
    writeFileSync(join(h.repo, ".git/info/attributes"), "* filter=evil\n");
    // ... and the daemon is killed before the gate run ends
    const engine = reopen(h);
    await expect(runGit(h.repo, ["status"])).rejects.toBeInstanceOf(GitConfigChangedError);
    expect(engine.gitHold).not.toBeNull();
    expect(engine.status({ run }).run.paused).toBe(true);
    const incident = incidents(h, "checkout_write");
    expect(incident).toContain("filter.evil.clean");
    expect(incident).toContain("Gate Runner");
    await engine.settle();
    expect(existsSync(marker)).toBe(false);
    expect(readdirSync(join(guard, "gates"))).toEqual([]);
    await expect(runGit(h.repo, ["status"])).rejects.toBeInstanceOf(GitConfigChangedError);
    // the hold survives another restart; the human removes the driver and resumes
    const again = reopen(h);
    await expect(runGit(h.repo, ["status"])).rejects.toBeInstanceOf(GitConfigChangedError);
    expect(existsSync(marker)).toBe(false);
    git(h.repo, "config", "--remove-section", "filter.evil");
    rmSync(join(h.repo, ".git/info/attributes"));
    await again.resume({});
    expect(again.gitHold).toBeNull();
    expect((await runGit(h.repo, ["status"])).code).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });
  it("a restart while gate code runs that changed nothing: the gate's record is checked and dropped", async () => {
    const h = createHarness();
    const engineer = await toEngineer(h);
    h.gates.hold();
    writeFile(worktreeOf(h, "T-1"), "src/t-1/impl.ts", "export const x = 1;\n");
    expect((await submitResult(h, engineer, { exit: "built" })).accepted).toBe(true);
    await vi.waitFor(() => {
      expect(h.gates.requests.some((r) => r.reason === "round")).toBe(true);
    });
    const guard = guardDirFor(h.home, h.repo);
    expect(readdirSync(join(guard, "gates"))).toHaveLength(1);
    const before = h.gates.requests.length;
    const engine = reopen(h);
    expect(engine.gitHold).toBeNull();
    expect(engine.notices).toEqual([]);
    expect(incidents(h, "checkout_write")).toBe("[]");
    expect((await runGit(h.repo, ["status"])).code).toBe(0);
    // the round's gates start again (and wait on the held gate runner): one record, the new run's
    await vi.waitFor(() => {
      expect(h.gates.requests.length).toBeGreaterThan(before);
    });
    expect(readdirSync(join(guard, "gates"))).toHaveLength(1);
  });
});
