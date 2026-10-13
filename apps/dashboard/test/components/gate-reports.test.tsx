import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { GateReportSchema, TaskDetailSchema, type GateReport } from "@vtc/shared";
import { GateReports } from "@/components/flows/GateReports";
import { readFixture } from "../fixtures";

const golden = (): GateReport => {
  const [report] = TaskDetailSchema.parse(readFixture("task-T-1")).gate_reports;
  if (report === undefined) throw new Error("fixture has a gate report");
  return report;
};

const failing = (): GateReport =>
  GateReportSchema.parse({
    ...golden(),
    started_at: "2026-10-13T09:30:00.000Z",
    finished_at: "2026-10-13T09:30:20.000Z",
    results: [
      {
        gate_id: "secrets",
        layer: "L4",
        phase: "verify",
        status: "fail",
        blocking: true,
        new_violations: 1,
        baseline_violations: 0,
        failure_class: "product",
        findings: [
          {
            tool: "gitleaks",
            rule_id: "generic-api-key",
            category: "secret",
            title: "Generic API key",
            location: { path: "src/t-1/config.ts", line: 3 },
            evidence: { type: "sarif", ref: ".vtc/evidence/T-1/round-2/gitleaks.sarif#0" },
          },
        ],
        duration_ms: 800,
      },
    ],
    verdict: "fail",
    traceability: undefined,
  });

describe("GateReports (drawer: gate-report detail per layer)", () => {
  it("shows the newest report open, per layer, with test counts, coverage and report links", () => {
    render(<GateReports run="golden-1" reports={[golden()]} />);
    const report = screen.getByTestId("gate-report-0");
    expect(report).toHaveAttribute("open");
    expect(within(report).getByText("Round · affected")).toBeInTheDocument();
    const l2 = within(report).getByRole("region", { name: "L2 Tests" });
    expect(within(l2).getByText("tests")).toBeInTheDocument();
    expect(within(l2).getByText("48 executed · 0 skipped · 0 failed")).toBeInTheDocument();
    expect(within(l2).getByText("Line coverage 84.2% · diff coverage 96.5%")).toBeInTheDocument();
    expect(within(l2).getByRole("link", { name: /junit report/ })).toHaveAttribute(
      "href",
      "/artifact/?run=golden-1&path=.vtc%2Fevidence%2FT-1%2Fround-1%2Fjunit.xml",
    );
    expect(within(report).getByRole("link", { name: /Traceability matrix/ })).toHaveAttribute(
      "href",
      "/artifact/?run=golden-1&path=.vtc%2Fevidence%2FT-1%2Ftraceability.json",
    );
    expect(within(report).getByRole("region", { name: "L0 Build, typecheck" })).toBeInTheDocument();
  });

  it("lists the newest report first, keeps older ones collapsed, and shows tool findings", async () => {
    const user = userEvent.setup();
    render(<GateReports run="golden-1" reports={[golden(), failing()]} />);
    const newest = screen.getByTestId("gate-report-0");
    expect(newest).toHaveTextContent("Failed");
    const l4 = within(newest).getByRole("region", { name: "L4 Security and supply chain" });
    expect(within(l4).getByText("Generic API key")).toBeInTheDocument();
    expect(within(l4).getByText(/gitleaks · src\/t-1\/config\.ts:3/)).toBeInTheDocument();
    const older = screen.getByTestId("gate-report-1");
    expect(older).not.toHaveAttribute("open");
    await user.click(within(older).getByText("Round · affected"));
    expect(older).toHaveAttribute("open");
  });
});
