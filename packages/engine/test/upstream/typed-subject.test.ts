/**
 * The typed upstream subject (contracts 5.7.0; spine §5 reading 247(8)): the allowlist projection
 * builds `UpstreamReport.subject` (`UpstreamSubjectSchema`) from the fact's subject through each
 * kind's pattern, and the module renders a tool, capability or config issue and the routing PR
 * from `report.subject` alone, never from the subject string the fact carried. Under D-cu (reading
 * 241) only a producer cell (the Engineer family, QA author) can be a routing subject.
 */
import {
  routingConfigSubject,
  UpstreamReportSchema,
  UpstreamSubjectSchema,
  upstreamSubjectKey,
} from "@vtc/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  evaluateTrigger,
  projectUpstreamReport,
  upstreamIssueSlots,
  type AutomationFact,
  type UpstreamFacts,
} from "../../src/upstream/index.js";
import { cleanupDirs } from "../helpers/repo.js";
import { harness } from "./harness.js";

afterEach(cleanupDirs);

const facts = (over: Partial<UpstreamFacts>): UpstreamFacts => ({
  kind: "tool",
  fingerprint: "0123456789abcdef",
  vtcVersion: "0.4.0",
  occurrences: 1,
  firstSeen: "2026-10-15T00:00:00Z",
  lastSeen: "2026-10-15T00:00:00Z",
  ...over,
});

const improvement = (
  kind: "tool" | "capability" | "config" | "new_agent",
  subject: string,
  metrics: Record<string, number> = {},
): AutomationFact => ({
  type: "improvement",
  kind,
  subject,
  metrics,
  at: "2026-10-15T11:00:00Z",
});

describe("the projection builds the typed subject (pure)", () => {
  it("projects each improvement kind's subject into UpstreamSubjectSchema", () => {
    const cases = [
      [
        "tool",
        "git status 1a2b3c4d5e6f",
        { kind: "tool", shape: { program: "git", subcommand: "status", flags: "1a2b3c4d5e6f" } },
      ],
      [
        "tool",
        "make - 1a2b3c4d5e6f",
        { kind: "tool", shape: { program: "make", flags: "1a2b3c4d5e6f" } },
      ],
      ["capability", "browser-automation", { kind: "capability", slug: "browser-automation" }],
      ["config", "caps.fix_rounds", { kind: "config", key: "caps.fix_rounds" }],
      [
        "config",
        routingConfigSubject("engineer", "M", "tagged"),
        { kind: "routing", role: "engineer", size: "M", risk: "tagged" },
      ],
    ] as const;
    for (const [kind, subject, expected] of cases) {
      const report = projectUpstreamReport(facts({ kind, subject }));
      expect(report.subject, subject).toEqual(expected);
      // the shared contract's own key names it as the fact did
      expect(upstreamSubjectKey(UpstreamSubjectSchema.parse(report.subject))).toBe(subject);
      expect(UpstreamReportSchema.safeParse(report).success).toBe(true);
    }
  });

  it("fails closed with privacy on a subject outside its kind's pattern, or none", () => {
    for (const [kind, subject] of [
      ["tool", 'git commit -m "fix payroll"'],
      ["capability", "needs a browser to log in to the client portal"],
      ["config", "payroll_portal.export_retries"],
      ["config", "routing.engineer.XL.none"],
      ["tool", undefined],
      ["config", undefined],
    ] as const) {
      expect(() => projectUpstreamReport(facts({ kind, subject })), String(subject)).toThrow(
        expect.objectContaining({ reason: "privacy" }),
      );
    }
  });

  it("carries no subject on any other kind, whatever the fact named", () => {
    expect(
      projectUpstreamReport(facts({ kind: "new_agent", subject: "engineer_ml" })).subject,
    ).toBe(undefined);
    expect(projectUpstreamReport(facts({ kind: "defect" }))).not.toHaveProperty("subject");
  });

  it("keeps the subject on the report's facts, never beside them on the work item", () => {
    const item = evaluateTrigger(improvement("tool", "pnpm exec 0a1b2c3d4e5f"), {
      vtcVersion: "0.4.0",
    });
    expect(item).not.toBeNull();
    expect(item).not.toHaveProperty("subject");
    expect(item?.target === "upstream" ? item.facts.subject : null).toBe("pnpm exec 0a1b2c3d4e5f");
  });
});

describe("issue bodies come from report.subject only", () => {
  it("renders the subject lines of a report that carries one", () => {
    const report = projectUpstreamReport(
      facts({ kind: "capability", subject: "browser-automation" }),
    );
    const slots = upstreamIssueSlots(report);
    expect(slots.title).toBe("vtc(capability): missing capability `browser-automation`");
    expect(slots.evidence).toContain("Missing capability: `browser-automation`");
    // the same report without its subject renders no subject at all
    const { subject: _dropped, ...bare } = report;
    const plain = upstreamIssueSlots(bare);
    expect(plain.title).toBe("vtc(capability): capability proposal");
    expect(plain.evidence ?? "").not.toContain("browser-automation");
  });

  it("opens a tool issue whose body names the report's shape", async () => {
    const h = harness();
    expect(
      await h.upstream.report(improvement("tool", "pnpm exec 0a1b2c3d4e5f"), h.ctx),
    ).toMatchObject({ status: "issue", action: "opened" });
    expect(h.github.state.issues[0]?.body).toContain(
      "Command shape: `pnpm`, subcommand `exec`, flag set `0a1b2c3d4e5f`",
    );
  });
});

describe("routing subjects are producer cells only (D-cu)", () => {
  it("raises the issue of an Engineer-family or QA cell", async () => {
    for (const role of ["engineer", "engineer_frontend", "qa"]) {
      const h = harness();
      expect(
        await h.upstream.report(
          improvement("config", routingConfigSubject(role, "S", "none")),
          h.ctx,
        ),
        role,
      ).toMatchObject({ status: "issue", action: "opened" });
    }
  });

  it("refuses a reviewer's or a task-less role's cell with out_of_scope, opening nothing", async () => {
    for (const role of ["spec_verifier", "security", "visual_qa", "lens_auth", "architect"]) {
      const h = harness();
      expect(
        await h.upstream.report(
          improvement("config", routingConfigSubject(role, "M", "high")),
          h.ctx,
        ),
        role,
      ).toMatchObject({ status: "skipped", reason: "out_of_scope" });
      expect(h.github.state.issues).toEqual([]);
      expect(h.events.find((e) => e.type === "automation.skipped")?.payload).toMatchObject({
        reason: "out_of_scope",
        kind: "config",
      });
    }
  });
});
