/**
 * Round-4 followups closed in contracts 5.4.0 (spine §5 reading 227 (2)): an unexpected failure is
 * visible as `automation.skipped` reason `error` with the redacted message, and the injected
 * `GitPlumbing`'s own `fetch` / `message` replace the module's `remoteRefs` seam when present.
 */
import type { GitPlumbing } from "@vtc/shared";
import { afterEach, describe, expect, it } from "vitest";
import type { AutoPrInput } from "../../src/upstream/index.js";
import { cleanupDirs } from "../helpers/repo.js";
import { fakeRemoteRefs } from "./fakes.js";
import { defect, harness, UPSTREAM } from "./harness.js";

afterEach(cleanupDirs);

const SECRET = "sk-live-payroll-SECRET-1234";

describe("unexpected failures are events (reason error)", () => {
  it("a gh failure is automation.skipped with reason error and the redacted message, and still answers error", async () => {
    const h = harness();
    h.github.issues.create = () =>
      Promise.reject(new Error(`gh: HTTP 502 while sending ${SECRET}`));
    await h.upstream.report(defect(), h.ctx);
    const outcome = await h.upstream.report(defect(), h.ctx);
    expect(outcome).toMatchObject({ status: "error" });
    expect(JSON.stringify(outcome)).not.toContain(SECRET);
    const skip = h.events.find((e) => e.type === "automation.skipped");
    expect(skip?.payload).toMatchObject({
      reason: "error",
      target: { kind: "upstream", repo: UPSTREAM },
      kind: "defect",
    });
    const detail = (skip?.payload as { detail: string } | undefined)?.detail ?? "";
    expect(detail).toContain("HTTP 502");
    expect(detail).not.toContain(SECRET);
  });

  it("a sweep that fails is an error event too", async () => {
    const h = harness();
    h.github.issues.listAutomatic = () => Promise.reject(new Error("gh: network down"));
    const results = await h.upstream.sweep(h.ctx);
    expect(results.some((r) => r.status === "error")).toBe(true);
    expect(
      h.events.some(
        (e) =>
          e.type === "automation.skipped" &&
          e.payload.reason === "error" &&
          e.payload.detail.includes("network down"),
      ),
    ).toBe(true);
  });

  it("a pickup whose listing fails is an error event and asks for no run", async () => {
    const h = harness({ self: true, startRun: () => Promise.resolve() });
    h.github.pullRequests.listOpenAutomatic = () => Promise.reject(new Error("gh: HTTP 503"));
    expect(await h.upstream.pickup(h.ctx)).toEqual([]);
    const skip = h.events.find((e) => e.type === "automation.skipped");
    expect(skip?.payload).toMatchObject({
      reason: "error",
      target: { kind: "upstream", repo: UPSTREAM },
    });
  });

  it("completing a PR that is not open is an error event", async () => {
    const h = harness();
    expect(await h.upstream.completePullRequest("project", 42, "pass", h.ctx)).toMatchObject({
      status: "error",
      detail: "PR #42 is not open",
    });
    expect(
      h.events.some(
        (e) =>
          e.type === "automation.skipped" &&
          e.payload.reason === "error" &&
          e.payload.detail === "PR #42 is not open",
      ),
    ).toBe(true);
  });
});

describe("GitPlumbing.fetch / message (contracts 5.4.0)", () => {
  const input: AutoPrInput = {
    target: "project",
    kind: "parked",
    fingerprint: "0123456789abcdef",
    summary: "fix the parked export task",
    slots: { summary: "Fixes the export." },
    source: {
      changes: [{ path: "src/a.ts", bytes: new TextEncoder().encode("x") }],
      message: "fix",
    },
    specVerifier: "pending",
    evidence: {
      plan: { run: "R7", upstreamSafe: false, change: "non_ui" },
      snapshot: { routes: {}, events: [] },
      gateReport: {} as never,
    },
  };

  const seam = () => {
    const used: string[] = [];
    return {
      used,
      remoteRefsSeam: () => ({
        fetch: (_remote: string, refspecs: readonly string[]) => {
          used.push(...refspecs);
          return Promise.resolve();
        },
        message: () => Promise.resolve(null),
      }),
    };
  };

  it("fetches through the plumbing when it has fetch and message, not through remoteRefs", async () => {
    const fallback = seam();
    const h = harness({ remoteRefsSeam: fallback.remoteRefsSeam });
    const viaPlumbing = fakeRemoteRefs(h.plumbing);
    Object.assign(h.plumbing, {
      fetch: (remote: string, refspecs: readonly string[]) => viaPlumbing.fetch(remote, refspecs),
      message: (sha: string) => viaPlumbing.message(sha),
    } satisfies Pick<GitPlumbing, "fetch" | "message">);
    expect(await h.upstream.openPullRequest(input, h.ctx)).toMatchObject({ status: "pr" });
    expect(viaPlumbing.fetches.flatMap((f) => f.refspecs)).toEqual(
      expect.arrayContaining([
        "+refs/heads/vtc/auto/*:refs/remotes/origin/vtc/auto/*",
        "+refs/heads/vtc-evidence:refs/remotes/origin/vtc-evidence",
      ]),
    );
    expect(fallback.used).toEqual([]);
  });

  it("falls back to remoteRefs when the plumbing has neither", async () => {
    const fallback = seam();
    const h = harness({ remoteRefsSeam: fallback.remoteRefsSeam });
    expect(await h.upstream.openPullRequest(input, h.ctx)).toMatchObject({ status: "pr" });
    expect(fallback.used).toContain("+refs/heads/vtc/auto/*:refs/remotes/origin/vtc/auto/*");
  });
});
