/**
 * Fix round 2 of engine core: every write in the user's checkout is verified (AD-7 rules 2 and
 * 7, AD-8 rule 3). What the engine wrote is the engine's only while it holds the engine's bytes
 * (`EngineWrites`); a failure is checked like a result; a forged event-log line is never
 * replayed; a git configuration change stops engine git until the human resumes.
 */
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SubmitInputSchema, toEventLine, type LeadAction } from "@vtc/shared";
import { EngineWrites, LEDGER_PATH } from "../../src/core/engine-writes.js";
import {
  appendRepoFile,
  GitConfigChangedError,
  removeRepoFile,
  runGit,
  writeRepoFile,
} from "../../src/git/index.js";
import { cleanupDirs, git, initRepo, writeFile } from "../helpers/repo.js";
import {
  CLAUDE,
  createHarness,
  only,
  spawns,
  submitResult,
  type Harness,
} from "../helpers/engine-harness.js";

afterEach(cleanupDirs);

const next = async (h: Harness): Promise<LeadAction[]> => (await h.engine.next({}, CLAUDE)).actions;
const logPath = (h: Harness): string =>
  join(h.repo, `.vtc/runs/${h.engine.status({}).run.id}/events.jsonl`);
const events = (h: Harness): { type: string; seq: number; data: Record<string, unknown> }[] =>
  readFileSync(logPath(h), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { type: string; seq: number; data: Record<string, unknown> });
const pauses = (h: Harness): string =>
  JSON.stringify(events(h).filter((e) => e.type === "run.paused"));
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
/** A valid event line the engine never wrote: it would finish the run if replayed. */
const forged = (h: Harness): string => {
  const last = events(h).at(-1)?.seq ?? 0;
  return toEventLine({
    v: 1,
    seq: last + 1,
    run: h.engine.status({}).run.id,
    ts: "2026-10-13T09:00:00.000Z",
    type: "run.finished",
    actor: "engine",
    data: { outcome: "aborted" },
  } as never);
};

describe("EngineWrites: the engine's writes are its own only while they hold its bytes", () => {
  it("tracks writes, appends and removals, and finds any other change", () => {
    const repo = initRepo();
    const ledger = EngineWrites.open(repo);
    writeRepoFile(repo, ".vtc/tasks/T-1.md", "plan\n");
    appendRepoFile(repo, ".vtc/runs/r1/events.jsonl", "a\n");
    appendRepoFile(repo, ".vtc/runs/r1/events.jsonl", "b\n");
    expect(ledger.check(".vtc/tasks/T-1.md").ok).toBe(true);
    expect(ledger.check(".vtc/runs/r1/events.jsonl").ok).toBe(true);
    // someone else appends: found, with the engine's bytes still intact before it
    appendFileSync(join(repo, ".vtc/runs/r1/events.jsonl"), "forged\n");
    expect(ledger.check(".vtc/runs/r1/events.jsonl")).toMatchObject({ ok: false, intactPrefix: 4 });
    // ... and the next engine append records that the file had changed
    appendRepoFile(repo, ".vtc/runs/r1/events.jsonl", "c\n");
    expect(ledger.foreign(".vtc/runs/r1/events.jsonl")).toContain("before an engine append");
    expect(ledger.check(".vtc/runs/r1/events.jsonl").ok).toBe(false);
    writeFileSync(join(repo, ".vtc/tasks/T-1.md"), "edited\n");
    expect(ledger.check(".vtc/tasks/T-1.md").ok).toBe(false);
    removeRepoFile(repo, ".vtc/tasks/T-1.md");
    expect(ledger.check(".vtc/tasks/T-1.md").ok).toBe(true);
    writeFileSync(join(repo, ".vtc/tasks/T-1.md"), "back\n");
    expect(ledger.check(".vtc/tasks/T-1.md").ok).toBe(false);
    expect(ledger.check(".vtc/tasks/T-9.md").ok).toBe(false);
    expect(ledger.check(LEDGER_PATH).ok).toBe(true);
    appendFileSync(join(repo, LEDGER_PATH), '{"p":"x","s":1,"d":"y"}\n');
    expect(ledger.check(LEDGER_PATH).ok).toBe(false);
    ledger.close();
  });
  it("survives a restart, and tolerates only one cut-off final line on open", () => {
    const repo = initRepo();
    const first = EngineWrites.open(repo);
    appendRepoFile(repo, ".vtc/runs/r1/events.jsonl", "a\n");
    first.close();
    // a crash between the append and its ledger line: one extra line
    appendFileSync(join(repo, ".vtc/runs/r1/events.jsonl"), "b\n");
    const second = EngineWrites.open(repo);
    expect(second.check(".vtc/runs/r1/events.jsonl", { tolerateTail: true }).ok).toBe(true);
    expect(second.check(".vtc/runs/r1/events.jsonl").ok).toBe(false);
    appendFileSync(join(repo, ".vtc/runs/r1/events.jsonl"), "c\n");
    expect(second.check(".vtc/runs/r1/events.jsonl", { tolerateTail: true }).ok).toBe(false);
    second.close();
  });
});

describe("checkout roles: every write checked, for every way a run ends (AD-7 rule 7)", () => {
  it("checks a failure submit too: the run pauses with the paths", async () => {
    const h = createHarness();
    await start(h);
    const carto = only(await next(h), "repo_cartographer");
    writeFile(h.repo, "src/evil.ts", "export const evil = 1;\n");
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
    expect(pauses(h)).toContain("src/evil.ts was written outside");
    // no new baseline over the write: nothing is dispatched until the human resumes
    expect(spawns(await next(h))).toEqual([]);
    await h.engine.resume({});
    expect(only(await next(h), "repo_cartographer").role).toBe("repo_cartographer");
    await h.release();
  });
  it("refuses a write where only the engine writes, and a change to the engine's own files", async () => {
    const h = createHarness();
    await start(h);
    const carto = only(await next(h), "repo_cartographer");
    writeFile(h.repo, ".vtc/research/repo-map.md", "# map\n");
    writeFile(h.repo, ".vtc/tasks/T-9.md", "forged plan\n");
    const request = join(h.repo, `.vtc/runs/${h.engine.status({}).run.id}/request.md`);
    writeFileSync(request, "a different request\n");
    const out = await submitResult(h, carto, repoMap);
    expect(out).toMatchObject({ accepted: false, rejection: { reason: "write_scope" } });
    const issues = (out.rejection?.issues ?? []).join("\n");
    expect(issues).toContain(".vtc/tasks/T-9.md was written where only the engine writes");
    expect(issues).toContain("request.md changed outside the engine");
    await h.release();
  });
  it("never replays an event-log line the engine did not write; resume rewrites the log", async () => {
    const h = createHarness();
    await start(h);
    const carto = only(await next(h), "repo_cartographer");
    writeFile(h.repo, ".vtc/research/repo-map.md", "# map\n");
    const line = forged(h);
    appendFileSync(logPath(h), line);
    const out = await submitResult(h, carto, repoMap);
    expect(out).toMatchObject({ accepted: false, rejection: { reason: "write_scope" } });
    expect((out.rejection?.issues ?? []).join("\n")).toContain("events.jsonl changed outside");
    expect(h.engine.status({}).run.paused).toBe(true);
    // rewritten at once from the engine's own events; the changed file is kept aside
    expect(readFileSync(logPath(h), "utf8")).not.toContain(line.trim());
    expect(JSON.stringify(events(h).filter((e) => e.type === "incident.recorded"))).toContain(
      ".vtc/state/forensics/",
    );
    await h.engine.settle();
    const engine = h.reopen();
    Object.assign(h, { engine });
    expect(engine.status({}).run.finished_at).toBeUndefined();
    expect(engine.status({}).run.paused).toBe(true);
    await engine.resume({});
    expect(engine.status({}).run.paused).toBe(false);
    const again = only(await next(h), "repo_cartographer");
    expect((await submitResult(h, again, repoMap)).accepted).toBe(true);
    // and a restart after that is clean
    await h.engine.settle();
    const third = h.reopen();
    Object.assign(h, { engine: third });
    expect(third.status({}).run.paused).toBe(false);
    await h.release();
  });
  it("replays only the engine's bytes when the log changed while the engine was stopped", async () => {
    const h = createHarness();
    await start(h);
    await h.engine.settle();
    const line = forged(h);
    appendFileSync(logPath(h), line);
    appendFileSync(logPath(h), line.replace('"seq":', '"seq":1').replace("aborted", "done"));
    const engine = h.reopen();
    Object.assign(h, { engine });
    expect(engine.status({}).run.finished_at).toBeUndefined();
    expect(engine.status({}).run.paused).toBe(true);
    expect(readFileSync(logPath(h), "utf8")).not.toContain('"run.finished"');
    expect(JSON.stringify(events(h).filter((e) => e.type === "incident.recorded"))).toContain(
      "while it was stopped",
    );
    await h.release();
  });
  it("pauses at once when an engine append finds the log changed", async () => {
    const h = createHarness();
    await start(h);
    appendFileSync(logPath(h), forged(h));
    await next(h); // dispatches: the engine appends and finds the foreign line
    expect(h.engine.status({}).run.paused).toBe(true);
    expect(h.engine.status({}).run.finished_at).toBeUndefined();
    expect(pauses(h)).toContain("event log was changed outside the engine");
    await h.release();
  });
  it("a git configuration change stops engine git until the human resumes", async () => {
    const h = createHarness();
    await start(h);
    const carto = only(await next(h), "repo_cartographer");
    writeFile(h.repo, ".vtc/research/repo-map.md", "# map\n");
    const marker = join(h.repo, "signed");
    writeFile(h.repo, "sign.sh", `#!/bin/sh\ntouch "${marker}"\n`);
    git(h.repo, "config", "commit.gpgsign", "true");
    git(h.repo, "config", "gpg.program", join(h.repo, "sign.sh"));
    await expect(runGit(h.repo, ["status"])).rejects.toBeInstanceOf(GitConfigChangedError);
    const out = await submitResult(h, carto, repoMap);
    expect(out).toMatchObject({ accepted: false, rejection: { reason: "write_scope" } });
    expect((out.rejection?.issues ?? []).join("\n")).toContain(".git/config was changed");
    expect(h.engine.status({}).run.paused).toBe(true);
    // the record is gone, the hold is not: engine git is still refused, after a restart too
    await expect(runGit(h.repo, ["status"])).rejects.toBeInstanceOf(GitConfigChangedError);
    await h.engine.settle();
    const engine = h.reopen();
    Object.assign(h, { engine });
    await expect(runGit(h.repo, ["status"])).rejects.toBeInstanceOf(GitConfigChangedError);
    await engine.resume({});
    expect((await runGit(h.repo, ["status"])).code).toBe(0);
    expect(existsSync(marker)).toBe(false);
    await h.release();
  });
  it("checks a run superseded by resume, and one across a restart", async () => {
    const h = createHarness();
    await start(h);
    only(await next(h), "repo_cartographer");
    await h.engine.settle();
    // a restart while the role runs: the record (and the engine's writes) survive it
    const engine = h.reopen();
    Object.assign(h, { engine });
    writeFile(h.repo, "src/late.ts", "late\n");
    await engine.pause({});
    const resumed = await engine.resume({});
    // the superseded run is checked before anything is taken: the run stays paused
    expect(resumed.paused).toBe(true);
    expect(pauses(h)).toContain("src/late.ts was written outside");
    expect((await engine.resume({})).paused).toBe(false);
    await h.release();
  });
  it("engine signing and hooks never run on engine commits", async () => {
    const h = createHarness();
    await start(h);
    // no role in the checkout: the config is the user's, and signing is still off for the engine
    const marker = join(h.repo, "signed");
    writeFile(h.repo, "sign.sh", `#!/bin/sh\ntouch "${marker}"\nexit 1\n`);
    git(h.repo, "config", "commit.gpgsign", "true");
    git(h.repo, "config", "gpg.program", join(h.repo, "sign.sh"));
    writeFile(h.repo, "x.txt", "x\n");
    await runGit(h.repo, ["add", "x.txt"]);
    await runGit(h.repo, ["commit", "--quiet", "-m", "engine commit"], {
      env: {
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@e",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@e",
      },
    });
    expect(existsSync(marker)).toBe(false);
    rmSync(join(h.repo, "sign.sh"));
    await h.release();
  });
});
