import { describe, expect, it } from "vitest";
import { LOOKBACK_REPO } from "@vtc/shared";
import { isReplayPath, readReplayResult, REPLAY_VERDICTS, replayView } from "@/lib/replays";
import { artifactContent } from "../../scripts/dev-fixtures.ts";
import { SAMPLE_REPLAY, SAMPLE_REPLAY_TEXT, SAMPLE_RUN } from "../golden-samples";

const PATH = `${LOOKBACK_REPO.replaysDir}/p-engineer-1.json`;
const artifact = (text = SAMPLE_REPLAY_TEXT, path = PATH) =>
  artifactContent(SAMPLE_RUN, path, text);

describe("readReplayResult (ReplayResult, .vtc/lookback/replays/)", () => {
  it("reads engine core's recorded replay", () => {
    const read = readReplayResult(artifact());
    expect(read.ok && read.value.proposal).toBe("p-engineer-1");
  });

  it("reads only the replays directory, and says why a file breaks its contract", () => {
    expect(isReplayPath(PATH)).toBe(true);
    expect(isReplayPath(".vtc/lookback/proposals/engineer/proposal.json")).toBe(false);
    expect(isReplayPath(".vtc/lookback/replays/../state/x.json")).toBe(false);
    const broken = readReplayResult(artifact(JSON.stringify({ ...SAMPLE_REPLAY, k: 0 })));
    expect(broken.ok).toBe(false);
    expect(!broken.ok && broken.problem).toMatch(/^k: /);
  });
});

describe("replayView", () => {
  it("names the grader: the gates when the result says nothing (D-ch, reading 202)", () => {
    const view = replayView(SAMPLE_REPLAY);
    expect(view.grader.label).toBe("Graded by the gates");
    expect(view.grader.detail).toMatch(/Gate Runner/);
    const verdict = replayView({ ...SAMPLE_REPLAY, role: "spec_verifier", grader: "verdict" });
    expect(verdict.grader.label).toBe("Graded by the verdict grader");
    expect(verdict.grader.detail).toMatch(/recorded outcome/);
    expect(verdict.grader.detail).toMatch(/G-gate or PR verdict/);
  });

  it("shows the arms per task with the sign test, the A/A rate and tokens", () => {
    const view = replayView(SAMPLE_REPLAY);
    expect(view.target).toBe("engineer · codex");
    expect(view.verdict).toEqual(REPLAY_VERDICTS.inconclusive);
    expect(view.tasks).toEqual([
      { label: "golden-1:T-1", baseline: "1/3 passed", candidate: "3/3 passed", regression: false },
      { label: "golden-1:T-2", baseline: "3/3 passed", candidate: "3/3 passed", regression: true },
    ]);
    expect(view.stats).toEqual([
      ["Trials per task and arm", "3"],
      ["Sign test", "2 of 2 discordant tasks favour the candidate (p = 0.25)"],
      ["A/A flip rate", "0%"],
      ["Tokens, candidate vs baseline", "+4.5%"],
      ["Isolation", "paths only: the host sandbox denied no reads"],
    ]);
  });

  it("shows tasks as ordinals in upstream mode (D-by, reading 208)", () => {
    const view = replayView(SAMPLE_REPLAY, { ordinals: true });
    expect(view.tasks.map((t) => t.label)).toEqual(["task 1", "task 2"]);
    expect(JSON.stringify(view)).not.toContain("golden-1");
  });

  it("says an improvement ships through VTC's own PR once a human merges it (D-cb)", () => {
    expect(REPLAY_VERDICTS.improve.label).toMatch(/improves/);
    expect(replayView({ ...SAMPLE_REPLAY, verdict: "improve" }).next).toMatch(
      /pull request to VTC's own repo.*next VTC release ships the change once a human merges it/,
    );
    expect(replayView(SAMPLE_REPLAY).next).toBeNull();
  });
});
