/**
 * An automatic run's `has_ui` comes from the paths its issue touches (D-ct; spine §5 reading 223),
 * not always false: a project item's location, a VTC-repo item's VTC frames (`dashboard/` is
 * `apps/dashboard/`, every other package `packages/<package>/`).
 */
import type { AutomationRunRef, StartInput } from "@vtc/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  framesFromIssueBody,
  framesTouchUi,
  projectTouchesUi,
  vtcFramePath,
  type AutomationFact,
} from "../../src/upstream/index.js";
import { cleanupDirs } from "../helpers/repo.js";
import { defect, harness, UPSTREAM } from "./harness.js";

afterEach(cleanupDirs);

const runs = () => {
  const started: { input: StartInput; ref: AutomationRunRef }[] = [];
  return {
    started,
    startRun: (input: StartInput, ref: AutomationRunRef): Promise<void> => {
      started.push({ input, ref });
      return Promise.resolve();
    },
  };
};

const finding = (path?: string): Extract<AutomationFact, { type: "project_problem" }> => ({
  type: "project_problem",
  kind: "finding",
  ruleId: "lens/frontend/contrast",
  ...(path === undefined ? {} : { path }),
  title: "Low contrast on the export button",
  detail: "The export button fails the contrast check.",
  run: "R7",
  at: "2026-10-15T11:00:00Z",
});

const DASHBOARD_STACK = [
  "Error: x",
  "    at render (/Users/alice/vtc/apps/dashboard/src/components/views/LookbackView.tsx:1:1)",
].join("\n");
const ENGINE_STACK = [
  "Error: x",
  "    at tick (/Users/alice/vtc/packages/engine/src/core/automation.ts:1:1)",
].join("\n");

describe("the touched paths (pure)", () => {
  it("maps a VTC frame into VTC's tree", () => {
    expect(vtcFramePath("dashboard/components/views/lookbackview:render")).toBe(
      "apps/dashboard/components/views/lookbackview",
    );
    expect(vtcFramePath("engine/core/automation:tick")).toBe("packages/engine/core/automation");
    expect(vtcFramePath("cli/bundle:main")).toBe("packages/cli/bundle");
  });

  it("a dashboard frame touches UI, any other package's does not; no frame touches none", () => {
    expect(framesTouchUi(["engine/core/automation:tick", "dashboard/lib/api:get"])).toBe(true);
    expect(framesTouchUi(["engine/core/automation:tick", "shared/visual:touchesUi"])).toBe(false);
    expect(framesTouchUi([])).toBe(false);
    // only frames VtcFrameSchema accepts count
    expect(framesTouchUi(["../dashboard/x:y", "apps/dashboard/x.tsx"])).toBe(false);
  });

  it("a project path touches UI by its extension", () => {
    expect(projectTouchesUi(["src/components/ExportButton.tsx"])).toBe(true);
    expect(projectTouchesUi(["app/services/payroll.rb"])).toBe(false);
    expect(projectTouchesUi([])).toBe(false);
  });

  it("reads the frames an upstream issue lists, and nothing else of its body", () => {
    const body = [
      "VTC frames:",
      "```",
      "dashboard/components/views/lookbackview:render",
      "engine/core/automation:tick",
      "```",
      "Not a frame: apps/dashboard/src/x.tsx",
    ].join("\n");
    expect(framesFromIssueBody(body)).toEqual([
      "dashboard/components/views/lookbackview:render",
      "engine/core/automation:tick",
    ]);
    expect(framesFromIssueBody(undefined)).toEqual([]);
  });
});

describe("an automatic run's has_ui (D-ct)", () => {
  it("a project finding at a UI file starts a UI run; one at a server file or with no location does not", async () => {
    const ui = runs();
    const h = harness({ startRun: ui.startRun });
    await h.upstream.report(finding("src/components/ExportButton.tsx"), h.ctx);
    await h.upstream.report(
      { ...finding("app/services/payroll.rb"), ruleId: "lens/backend/n_plus_one" },
      h.ctx,
    );
    await h.upstream.report({ ...finding(), ruleId: "lens/frontend/unknown" }, h.ctx);
    expect(ui.started.map((r) => r.input.has_ui)).toEqual([true, false, false]);
  });

  it("a VTC defect located in the dashboard starts a UI run on the bs-vtc checkout; one in the engine does not", async () => {
    const own = runs();
    const h = harness({ startRun: own.startRun, self: true });
    // a defect raises from its second occurrence
    for (let i = 0; i < 2; i += 1)
      await h.upstream.report(defect({ stack: DASHBOARD_STACK }), h.ctx);
    for (let i = 0; i < 2; i += 1)
      await h.upstream.report(defect({ stack: ENGINE_STACK, errorClass: "engine.crash" }), h.ctx);
    expect(own.started.map((r) => [r.ref.target.kind, r.input.has_ui])).toEqual([
      ["upstream", true],
      ["upstream", false],
    ]);
  });

  it("pickup reads the frames of an issue another installation opened", async () => {
    const elsewhere = harness();
    for (let i = 0; i < 2; i += 1)
      await elsewhere.upstream.report(defect({ stack: DASHBOARD_STACK }), elsewhere.ctx);
    for (let i = 0; i < 2; i += 1)
      await elsewhere.upstream.report(
        defect({ stack: ENGINE_STACK, errorClass: "engine.crash" }),
        elsewhere.ctx,
      );
    expect(elsewhere.github.state.issues).toHaveLength(2);
    const own = runs();
    const h = harness({ shared: elsewhere, startRun: own.startRun, self: true });
    const asked = await h.upstream.pickup(h.ctx);
    expect(asked.map((r) => r.target)).toEqual([
      { kind: "upstream", repo: UPSTREAM },
      { kind: "upstream", repo: UPSTREAM },
    ]);
    expect(own.started.map((r) => r.input.has_ui)).toEqual([true, false]);
  });

  it("pickup on the machine that raised the issue reads has_ui from its ledger, not the body", async () => {
    const elsewhere = harness();
    for (let i = 0; i < 2; i += 1)
      await elsewhere.upstream.report(defect({ stack: DASHBOARD_STACK }), elsewhere.ctx);
    for (let i = 0; i < 2; i += 1)
      await elsewhere.upstream.report(
        defect({ stack: ENGINE_STACK, errorClass: "engine.crash" }),
        elsewhere.ctx,
      );
    // a collaborator edits the bodies: the dashboard frame moves to the engine defect's issue
    const frame = "dashboard/components/views/lookbackview:render";
    elsewhere.github.state.issues = elsewhere.github.state.issues.map((issue) =>
      issue.body.includes(frame)
        ? { ...issue, body: issue.body.split(frame).join("") }
        : { ...issue, body: `${issue.body}\n${frame}\n` },
    );
    expect(
      elsewhere.github.state.issues.map((i) => framesTouchUi(framesFromIssueBody(i.body))),
    ).toEqual([false, true]);
    const own = runs();
    const h = harness({
      shared: elsewhere,
      sameHome: true,
      startRun: own.startRun,
      self: true,
    });
    await h.upstream.pickup(h.ctx);
    expect(own.started.map((r) => r.input.has_ui)).toEqual([true, false]);
  });
});
