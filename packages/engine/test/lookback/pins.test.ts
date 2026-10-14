import {
  canaryArmFor,
  effectivePromptSha,
  LOOKBACK_HOME,
  LOOKBACK_PINS_LOCK_STALE_MS,
  LookbackPinsSchema,
  type LookbackPinsInput,
  type PromptVersionFrontmatter,
} from "@vtc/shared";
import { mkdir, readdir, readFile, utimes, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseYaml, toYaml } from "../../src/core/index.js";
import {
  autoRollback,
  canaryAssignedEvent,
  checkEngineWrite,
  createPromptPins,
  pinsPath,
  PromptVersionError,
  promptVersionRef,
  readPins,
  selectPromptVersion,
  selectPromptVersionSync,
  storePromptVersion,
} from "../../src/lookback/index.js";
import { writeAtomicIfUnchanged } from "../../src/lookback/files.js";
import { EDITABLE, EFFECTIVE, HOST, LOCKED, tempDir } from "./log.js";

const REPO = "0123456789abcdef";
const CANDIDATE_TEXT = "Prefer small diffs. Write the failing test first.";
const candidate = promptVersionRef({
  role: "engineer",
  host: HOST,
  locked: LOCKED,
  editable: CANDIDATE_TEXT,
});
const now = new Date("2026-10-14T12:00:00.000Z");

const frontmatter = (): PromptVersionFrontmatter => ({
  v: 1,
  version: candidate,
  parent: EFFECTIVE,
  proposal: "p-1",
  changelog: { hypothesis: "Tests first cuts fix rounds.", trace_ids: ["a-1"], evaluation: null },
  created_at: now.toISOString(),
});

const writePins = async (home: string, pins: LookbackPinsInput): Promise<void> => {
  await mkdir(join(home, "lookback"), { recursive: true });
  await writeFile(pinsPath(home), toYaml(LookbackPinsSchema.parse(pins)));
};

const select = (home: string, task?: string) =>
  selectPromptVersion({
    vtcHome: home,
    repoKey: REPO,
    target: { role: "engineer", host: HOST },
    task,
    locked: LOCKED,
    defaultEditable: EDITABLE,
  });

const taskInArm = (arm: "candidate" | "baseline"): string => {
  for (let i = 1; i < 100; i += 1)
    if (canaryArmFor(REPO, `T-${String(i)}`) === arm) return `T-${String(i)}`;
  throw new Error("no task");
};

describe("prompt versions (AD-21 rules 1 and 3)", () => {
  it("are written once, never changed, and verified on load", async () => {
    const home = await tempDir("home");
    const path = await storePromptVersion(home, frontmatter(), CANDIDATE_TEXT);
    expect(path).toBe(
      join(
        home,
        "lookback",
        "prompts",
        "engineer",
        HOST,
        `${candidate.effective_sha256.slice(0, 8)}.md`,
      ),
    );
    expect(await storePromptVersion(home, frontmatter(), CANDIDATE_TEXT)).toBe(path);
    await expect(storePromptVersion(home, frontmatter(), "something else")).rejects.toThrow(
      PromptVersionError,
    );
    expect(candidate.effective_sha256).toBe(effectivePromptSha(LOCKED, CANDIDATE_TEXT));
  });

  it("never replaces a file that is already at the version's path, even in a race", async () => {
    const home = await tempDir("home");
    const path = await storePromptVersion(home, frontmatter(), CANDIDATE_TEXT);
    const squatter = "---\nnot a version\n---\n";
    await writeFile(path, squatter);
    await expect(storePromptVersion(home, frontmatter(), CANDIDATE_TEXT)).rejects.toThrow(
      PromptVersionError,
    );
    expect(await readFile(path, "utf8")).toBe(squatter);
    // Concurrent stores of one version: one writes it, the others find it in place.
    const fresh = await tempDir("home");
    const paths = await Promise.all(
      Array.from({ length: 5 }, () => storePromptVersion(fresh, frontmatter(), CANDIDATE_TEXT)),
    );
    expect(new Set(paths).size).toBe(1);
    expect(await readdir(dirname(paths[0] ?? ""))).toEqual([basename(paths[0] ?? "")]);
  });
});

describe("prompt selection", () => {
  it("runs the compiled default without pins", async () => {
    const selection = await select(await tempDir("home"), "T-1");
    expect(selection).toMatchObject({ source: "default", editable: EDITABLE });
    expect(selection.ref.effective_sha256).toBe(EFFECTIVE);
  });

  it("ignores a pins.yaml planted in the repo: pins come from the VTC home only", async () => {
    const home = await tempDir("home");
    const repo = await tempDir("repo");
    await storePromptVersion(home, frontmatter(), CANDIDATE_TEXT);
    const planted: LookbackPinsInput = {
      v: 1,
      projects: {
        [REPO]: {
          pins: [{ role: "engineer", host: HOST, effective_sha256: candidate.effective_sha256 }],
        },
      },
    };
    await writePins(join(repo, ".vtc"), planted);
    await mkdir(join(repo, ".vtc", "lookback"), { recursive: true });
    await writeFile(join(repo, ".vtc", "lookback", "pins.yaml"), toYaml(planted));
    await writeFile(join(repo, "pins.yaml"), toYaml(planted));
    expect((await select(home, "T-1")).source).toBe("default");
    // The same pins in the VTC home do select the pinned version.
    await writePins(home, planted);
    expect(await select(home, "T-1")).toMatchObject({
      source: "pin",
      editable: CANDIDATE_TEXT,
      ref: candidate,
    });
  });

  it("assigns a canary arm by task hash, sticky for the task", async () => {
    const home = await tempDir("home");
    await storePromptVersion(home, frontmatter(), CANDIDATE_TEXT);
    await writePins(home, {
      v: 1,
      projects: {
        [REPO]: {
          canaries: [
            {
              role: "engineer",
              host: HOST,
              candidate: candidate.effective_sha256,
              baseline: EFFECTIVE,
              started_at: now.toISOString(),
              assignment: "task_hash_50",
            },
          ],
        },
      },
    });
    const inCandidate = await select(home, taskInArm("candidate"));
    expect(inCandidate).toMatchObject({
      source: "canary",
      editable: CANDIDATE_TEXT,
      canary: { arm: "candidate" },
    });
    const inBaseline = await select(home, taskInArm("baseline"));
    expect(inBaseline).toMatchObject({
      source: "canary",
      editable: EDITABLE,
      canary: { arm: "baseline" },
    });
    expect((await select(home, taskInArm("candidate"))).canary?.arm).toBe("candidate");
    const event = canaryAssignedEvent(inCandidate, taskInArm("candidate"), "engineer");
    expect(event).toMatchObject({
      type: "lookback.canary_assigned",
      task: taskInArm("candidate"),
      role: "engineer",
      data: { arm: "candidate", candidate: candidate.effective_sha256, baseline: EFFECTIVE },
    });
    expect(
      canaryAssignedEvent(await select(await tempDir("home")), "T-1", "engineer"),
    ).toBeUndefined();
  });

  it("falls back to the default when the pinned version's file is missing or the pins file is broken", async () => {
    const home = await tempDir("home");
    await writePins(home, {
      v: 1,
      projects: {
        [REPO]: {
          pins: [{ role: "engineer", host: HOST, effective_sha256: candidate.effective_sha256 }],
        },
      },
    });
    const missing = await select(home, "T-1");
    expect(missing.source).toBe("default");
    expect(missing.problem).toMatch(/missing or does not verify/);
    await writeFile(pinsPath(home), "v: 2\nprojects: [");
    const broken = await select(home, "T-1");
    expect(broken.source).toBe("default");
    expect(broken.problem).toMatch(/pins.yaml/);
  });
});

describe("engine core's synchronous prompt selector (reading 135(d))", () => {
  const target = {
    run: "R-1",
    role: "engineer",
    host: HOST,
    agent: "vtc-engineer",
    task: "T-1",
  } as const;
  const compiled = () => ({ locked: LOCKED, editable: EDITABLE });

  it("selects what the asynchronous selector selects", async () => {
    const home = await tempDir("home");
    await storePromptVersion(home, frontmatter(), CANDIDATE_TEXT);
    await writePins(home, {
      v: 1,
      projects: {
        [REPO]: {
          pins: [{ role: "engineer", host: HOST, effective_sha256: candidate.effective_sha256 }],
        },
      },
    });
    const input = {
      vtcHome: home,
      repoKey: REPO,
      target: { role: "engineer", host: HOST },
      task: "T-1",
      locked: LOCKED,
      defaultEditable: EDITABLE,
    };
    expect(selectPromptVersionSync(input)).toEqual(await selectPromptVersion(input));
  });

  it("returns null for the default, follows a changed pins.yaml, and throws on a pin it cannot honour", async () => {
    const home = await tempDir("home");
    await storePromptVersion(home, frontmatter(), CANDIDATE_TEXT);
    const pins = createPromptPins({ vtcHome: home, repoKey: REPO, compiled });
    expect(pins(target)).toBeNull();
    await writePins(home, {
      v: 1,
      projects: {
        [REPO]: {
          pins: [{ role: "engineer", host: HOST, effective_sha256: candidate.effective_sha256 }],
        },
      },
    });
    expect(pins(target)).toEqual({ version: candidate, text: CANDIDATE_TEXT });
    // an agent the plugin carries no texts for keeps its compiled prompt
    expect(
      createPromptPins({ vtcHome: home, repoKey: REPO, compiled: () => undefined })(target),
    ).toBeNull();
    await writeFile(pinsPath(home), "v: 2\nprojects: [");
    expect(() => pins(target)).toThrow(/pins.yaml/);
  });

  it("carries the task's canary arm", async () => {
    const home = await tempDir("home");
    await storePromptVersion(home, frontmatter(), CANDIDATE_TEXT);
    await writePins(home, {
      v: 1,
      projects: {
        [REPO]: {
          canaries: [
            {
              role: "engineer",
              host: HOST,
              candidate: candidate.effective_sha256,
              baseline: EFFECTIVE,
              started_at: now.toISOString(),
              assignment: "task_hash_50",
            },
          ],
        },
      },
    });
    const pins = createPromptPins({ vtcHome: home, repoKey: REPO, compiled });
    expect(pins({ ...target, task: taskInArm("candidate") })).toMatchObject({
      text: CANDIDATE_TEXT,
      canary: { arm: "candidate" },
    });
    // the baseline arm is the compiled default, still recorded as the arm
    expect(pins({ ...target, task: taskInArm("baseline") })).toMatchObject({
      text: EDITABLE,
      canary: { arm: "baseline" },
    });
  });
});

describe("the engine's only pins write: auto_rollback", () => {
  const canaryPins = (): LookbackPinsInput => ({
    v: 1,
    projects: {
      [REPO]: {
        pins: [{ role: "qa", host: HOST, effective_sha256: "c".repeat(64) }],
        canaries: [
          {
            role: "engineer",
            host: HOST,
            candidate: candidate.effective_sha256,
            baseline: EFFECTIVE,
            started_at: now.toISOString(),
            assignment: "task_hash_50",
          },
        ],
      },
    },
    history: [
      {
        role: "engineer",
        host: HOST,
        at: now.toISOString(),
        repo_key: REPO,
        gesture: "approve",
        from: EFFECTIVE,
        to: candidate.effective_sha256,
        by: "human",
        reason: "replay improved",
      },
    ],
  });

  it("removes the canary and appends one engine auto_rollback, leaving the pins alone", async () => {
    const home = await tempDir("home");
    await writePins(home, canaryPins());
    const event = await autoRollback({
      vtcHome: home,
      repoKey: REPO,
      target: { role: "engineer", host: HOST },
      reason: "tokens up",
      now,
    });
    expect(event).toMatchObject({
      type: "lookback.rolled_back",
      data: {
        target_role: "engineer",
        target_host: HOST,
        from: candidate.effective_sha256,
        to: EFFECTIVE,
        reason: "tokens up",
      },
    });
    const after = LookbackPinsSchema.parse(parseYaml(await readFile(pinsPath(home), "utf8")));
    expect(after.projects[REPO]?.canaries).toEqual([]);
    expect(after.projects[REPO]?.pins).toHaveLength(1);
    expect(after.history.at(-1)).toMatchObject({ gesture: "auto_rollback", by: "engine" });
    expect((await readPins(home)).problem).toBeUndefined();
    // The pins lock is released.
    expect(await readdir(join(home, "lookback"))).not.toContain("pins.lock");
  });

  it("takes the pins lock, and takes over a stale one", async () => {
    const home = await tempDir("home");
    await writePins(home, canaryPins());
    const lock = join(home, LOOKBACK_HOME.pinsLock);
    await writeFile(lock, "a crashed writer's token");
    const old = new Date(Date.now() - LOOKBACK_PINS_LOCK_STALE_MS - 5_000);
    await utimes(lock, old, old);
    const event = await autoRollback({
      vtcHome: home,
      repoKey: REPO,
      target: { role: "engineer", host: HOST },
      reason: "tokens up",
      now,
    });
    expect(event).toMatchObject({ type: "lookback.rolled_back" });
    expect(await readdir(join(home, "lookback"))).not.toContain("pins.lock");
  });

  it("does nothing without a canary or with a pins file it cannot read", async () => {
    const home = await tempDir("home");
    expect(
      await autoRollback({
        vtcHome: home,
        repoKey: REPO,
        target: { role: "engineer", host: HOST },
        reason: "x",
        now,
      }),
    ).toBeUndefined();
    await writePins(home, canaryPins());
    await writeFile(pinsPath(home), "not: [valid");
    expect(
      await autoRollback({
        vtcHome: home,
        repoKey: REPO,
        target: { role: "engineer", host: HOST },
        reason: "x",
        now,
      }),
    ).toBeUndefined();
    expect(await readFile(pinsPath(home), "utf8")).toBe("not: [valid");
  });

  it("refuses any other change (promotion, pin edits, history edits)", () => {
    const before = LookbackPinsSchema.parse(canaryPins());
    const promote = LookbackPinsSchema.parse({
      ...canaryPins(),
      projects: {
        [REPO]: {
          pins: [{ role: "engineer", host: HOST, effective_sha256: candidate.effective_sha256 }],
          canaries: [],
        },
      },
      history: [
        ...before.history,
        {
          role: "engineer",
          host: HOST,
          at: now.toISOString(),
          repo_key: REPO,
          gesture: "auto_rollback",
          from: candidate.effective_sha256,
          to: EFFECTIVE,
          by: "engine",
          reason: "x",
        },
      ],
    });
    expect(() => {
      checkEngineWrite(before, promote);
    }).toThrow(/pins changed/);
    expect(() => {
      checkEngineWrite(before, before);
    }).toThrow(/history must grow/);
  });
});

describe("pins.yaml writes never lose a human gesture", () => {
  it("replaces the file only when it still holds the bytes the engine read", async () => {
    const dir = await tempDir("cas");
    const path = join(dir, "lookback", "pins.yaml");
    expect(await writeAtomicIfUnchanged(path, "engine\n", undefined)).toBe(true);
    // A human gesture wrote in between: the engine's stale write is dropped, not applied.
    await writeFile(path, "human\n");
    expect(await writeAtomicIfUnchanged(path, "engine again\n", "engine\n")).toBe(false);
    expect(await readFile(path, "utf8")).toBe("human\n");
    expect(await writeAtomicIfUnchanged(path, "engine again\n", "human\n")).toBe(true);
    expect(await readFile(path, "utf8")).toBe("engine again\n");
    // No temp file is left behind either way.
    expect((await readdir(join(dir, "lookback"))).sort()).toEqual(["pins.yaml"]);
  });
});
