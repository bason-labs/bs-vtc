import { describe, expect, it } from "vitest";
import { DEFAULT_UPSTREAM_REPO } from "@vtc/shared";
import { NOTICE_EVENT_TYPES, noticeForEvent, runNotices } from "@/lib/notices";
import { sampleEvent } from "../golden-samples";

/**
 * Automatic issues and PRs in the run's notices (D-ca, AD-27 rule 7): every `upstream.*` event
 * and every `automation.skipped` with its reason. The golden run records no automation sample
 * yet, so these events are built here and checked against their contracts.
 */
const project = { kind: "project", repo: "example-org/golden-app" } as const;
const upstream = { kind: "upstream", repo: DEFAULT_UPSTREAM_REPO } as const;
const ref = (target: typeof project | typeof upstream, number: number, kind = "ci_failure") => ({
  target,
  kind,
  fingerprint: "1a2b3c4d5e6f7081",
  number,
  url: `https://github.com/${target.repo}/${number > 100 ? "pull" : "issues"}/${String(number)}`,
});

describe("automation notices", () => {
  it("covers every upstream.* event and automation.skipped", () => {
    for (const type of [
      "upstream.issue_opened",
      "upstream.issue_updated",
      "upstream.issue_closed",
      "upstream.pr_opened",
      "upstream.pr_closed",
      "automation.skipped",
    ] as const)
      expect(NOTICE_EVENT_TYPES.has(type), type).toBe(true);
  });

  it("shows an opened issue with its link, kind and a regression's origin", () => {
    const notice = noticeForEvent(
      sampleEvent(30, "upstream.issue_opened", { ...ref(project, 41), regression_of: 12 }),
    );
    expect(notice).toMatchObject({
      tone: "accent",
      title: "VTC opened issue #41 in example-org/golden-app",
      detail: "Post-merge CI failure · regression of #12",
      link: { href: "https://github.com/example-org/golden-app/issues/41", label: "Issue #41" },
    });
  });

  it("says what went to VTC's own repo, and nothing project-specific", () => {
    const notice = noticeForEvent(
      sampleEvent(31, "upstream.issue_opened", ref(upstream, 77, "defect")),
    );
    expect(notice?.title).toBe(`VTC opened issue #77 in ${DEFAULT_UPSTREAM_REPO}`);
    expect(notice?.note).toMatch(/only VTC-side data/i);
  });

  it("shows a draft PR for review, its evidence, and that VTC never merges it", () => {
    const notice = noticeForEvent(
      sampleEvent(32, "upstream.pr_opened", {
        ...ref(project, 142),
        branch: "vtc/auto/ci_failure/1a2b3c4d",
        issue: 41,
        evidence: "partial",
      }),
    );
    expect(notice).toMatchObject({
      tone: "accent",
      title: "VTC opened draft PR #142 in example-org/golden-app for review",
      detail: "Post-merge CI failure · fixes issue #41 · evidence partial",
      link: { label: "PR #142" },
    });
    expect(notice?.note).toMatch(/never merges/);
  });

  it("shows updates and closes with their reason", () => {
    const updated = noticeForEvent(
      sampleEvent(33, "upstream.issue_updated", { ...ref(project, 41), action: "reopened" }),
    );
    expect(updated?.title).toBe("VTC reopened issue #41 in example-org/golden-app");
    const quiet = noticeForEvent(
      sampleEvent(34, "upstream.issue_closed", { ...ref(project, 41), reason: "quiet" }),
    );
    expect(quiet).toMatchObject({
      tone: "neutral",
      title: "VTC closed issue #41 in example-org/golden-app",
    });
    expect(quiet?.detail).toMatch(/14 days/);
    const superseded = noticeForEvent(
      sampleEvent(35, "upstream.pr_closed", { ...ref(project, 142), reason: "superseded" }),
    );
    expect(superseded?.title).toBe("VTC closed PR #142 in example-org/golden-app");
    expect(superseded?.detail).toMatch(/newer/);
  });

  it("shows a skipped action with its reason, the same one folded", () => {
    const skip = (seq: number) =>
      sampleEvent(seq, "automation.skipped", {
        reason: "rate_limit",
        target: project,
        kind: "finding",
        detail: "5 new issues already opened today",
      });
    const notice = noticeForEvent(skip(36));
    expect(notice).toMatchObject({
      tone: "warn",
      title: "Automatic issue or PR not raised: finding outside a task's scope",
      detail: "5 new issues already opened today",
      note: "Why: a VTC rate limit was reached.",
    });
    const folded = runNotices([skip(36), skip(37)]);
    expect(folded).toHaveLength(1);
    expect(folded[0]?.repeats).toBe(2);
  });

  it("never links anything but http(s)", () => {
    const notice = noticeForEvent(
      sampleEvent(38, "upstream.issue_opened", { ...ref(project, 41), url: "ftp://x.example/41" }),
    );
    expect(notice?.link).toBeUndefined();
  });
});
