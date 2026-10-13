import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  FeatureSchema,
  WorkflowGraphSchema,
  type UsageReport,
  type WorkflowNode,
} from "@vtc/shared";
import { StepNodeCard } from "@/components/flows/StepNode";
import { PullRequestCard, FinalReviewTracker } from "@/components/feature/FeatureSummary";
import { ProgressBar } from "@/components/ui";
import { UsagePanel } from "@/components/usage/UsagePanel";
import { nodeStateMeta } from "@/lib/states";
import { readFixture } from "../fixtures";

const node = (id: string): WorkflowNode => {
  const found = WorkflowGraphSchema.parse(readFixture("graph-task-T-2")).nodes.find(
    (n) => n.id === id,
  );
  if (found === undefined) throw new Error(`no node ${id}`);
  return found;
};

describe("StepNodeCard", () => {
  it("shows kind, role, state, label, why it was added and the round, as one accessible button", () => {
    const onSelect = vi.fn();
    const n = node("loop-guard");
    render(<StepNodeCard data={{ node: n, meta: nodeStateMeta(n) }} onSelect={onSelect} />);
    const button = screen.getByRole("button", {
      name: /Round cap, Parked: round cap\. Added because: risk med: cap 4/,
    });
    expect(button).toHaveTextContent("Loop guard");
    expect(button).toHaveTextContent("round 4/4");
    expect(button).toHaveClass("vtc-node-parked");
    button.click();
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it("marks running nodes with the ring and usage-limit interruptions as waiting for the limit", () => {
    const base = node("engineer");
    const running = { ...base, state: "running" as const };
    const waiting = {
      ...base,
      state: "interrupted" as const,
      tokens: { in: 1200, out: 300, cache_r: 0, cache_w: 0 },
    };
    const { rerender } = render(
      <StepNodeCard data={{ node: running, meta: nodeStateMeta(running) }} />,
    );
    expect(screen.getByRole("button")).toHaveClass("vtc-node-running");
    expect(screen.getByRole("button")).toHaveTextContent("Role · engineer");
    rerender(<StepNodeCard data={{ node: waiting, meta: nodeStateMeta(waiting) }} />);
    expect(screen.getByRole("button")).toHaveClass("vtc-node-interrupted");
    expect(screen.getByRole("button")).toHaveTextContent("Waiting for limit");
    expect(screen.getByRole("button")).toHaveTextContent("1.5k tok");
  });
});

describe("UsagePanel", () => {
  it("shows per-model limits, interrupted tasks and the auto-resume countdown", () => {
    const soon = new Date(Date.now() + 20 * 60_000).toISOString();
    const report: UsageReport = {
      hosts: [
        {
          host: "claude-code",
          source: "sdk_event",
          windows: [
            {
              kind: "five_hour",
              label: "five_hour",
              window_minutes: 300,
              used_pct: 100,
              resets_at: soon,
            },
          ],
          model_limits: [
            { model: "claude-opus", resets_at: null, observed_at: new Date().toISOString() },
          ],
          updated_at: new Date().toISOString(),
        },
      ],
      interrupted_tasks: ["T-3"],
      auto_resume_at: soon,
    };
    render(<UsagePanel report={report} />);
    const claude = screen.getByTestId("usage-claude-code");
    expect(
      within(claude).getByText("claude-opus: limit reached, reset time unknown"),
    ).toBeInTheDocument();
    expect(within(claude).getByRole("progressbar", { name: /5-hour window/ })).toHaveAttribute(
      "aria-valuenow",
      "100",
    );
    expect(within(claude).getByRole("img", { name: /Weekly used: unknown/ })).toBeInTheDocument();
    expect(screen.getByTestId("usage-interrupted")).toHaveTextContent(
      "1 task interrupted by usage limits (T-3)",
    );
    expect(screen.getByTestId("usage-interrupted")).toHaveTextContent(
      /Auto-resume .* \(in (19|20)m\)/,
    );
  });
});

describe("ProgressBar", () => {
  it("never renders unknown as 0%", () => {
    render(<ProgressBar value={null} label="Weekly" />);
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.getByRole("img", { name: "Weekly: unknown" })).toBeInTheDocument();
  });
});

describe("feature components", () => {
  const feature = FeatureSchema.parse({
    id: "F-1",
    title: "Password reset",
    status: "fixing",
    tasks: ["T-1"],
    integration_branch: "vtc/F-1",
    round: 2,
    budget_usd: 10,
    final_review_budget_usd: 1.5,
    pr: {
      url: "https://github.com/acme/app/pull/7",
      draft: true,
      state: "open",
      head_sha: "b".repeat(40),
      ci: "pending",
    },
  });
  it("shows Final Review fixing as n/3 on the current step", () => {
    render(<FinalReviewTracker feature={feature} />);
    const current = screen.getByText("Final Review ⇄ fixing 2/3").closest("li");
    expect(current).toHaveAttribute("aria-current", "step");
  });
  it("links the draft PR safely in a new tab with its CI state", () => {
    render(<PullRequestCard feature={feature} />);
    const card = screen.getByTestId("pull-request");
    expect(within(card).getByText("Draft")).toBeInTheDocument();
    expect(within(card).getByText("CI pending")).toBeInTheDocument();
    const link = within(card).getByRole("link");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });
});
