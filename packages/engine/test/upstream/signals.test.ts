/**
 * The D-cs and D-cn improvements as VTC's repo reads them (spine §5 readings 219 and 221): a
 * `tool` issue names the command shape and its task count, a `capability` issue the slug and its
 * count (never the reason), and a `config` issue whose subject starts `routing.` is a
 * routing-table change, all through the kind's pattern, the redaction and the denylist.
 */
import { routingConfigSubject } from "@vtc/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  projectSubject,
  ROUTING_TABLE_FILE,
  routingSubjectOfBody,
  type AutomationFact,
} from "../../src/upstream/index.js";
import { cleanupDirs } from "../helpers/repo.js";
import { harness } from "./harness.js";

afterEach(cleanupDirs);

const improvement = (
  kind: "tool" | "capability" | "config",
  subject: string,
  metrics: Record<string, number> = {},
): AutomationFact => ({
  type: "improvement",
  kind,
  subject,
  metrics,
  at: "2026-10-15T11:00:00Z",
});

describe("the subject patterns (pure)", () => {
  it("takes a command shape key, a slug, a routing cell or a config key, and refuses anything else", () => {
    expect(projectSubject("tool", "git status 1a2b3c4d5e6f")).toMatchObject({
      kind: "tool",
      shape: { program: "git", subcommand: "status", flags: "1a2b3c4d5e6f" },
    });
    expect(projectSubject("tool", "<path> - 1a2b3c4d5e6f")).toMatchObject({
      shape: { program: "<path>", flags: "1a2b3c4d5e6f" },
    });
    expect(projectSubject("capability", "browser-automation")).toEqual({
      kind: "capability",
      slug: "browser-automation",
    });
    expect(projectSubject("config", routingConfigSubject("engineer", "S", "none"))).toMatchObject({
      kind: "routing",
      role: "engineer",
      size: "S",
      risk: "none",
    });
    expect(projectSubject("config", "budget.task_s")).toEqual({
      kind: "config",
      key: "budget.task_s",
    });
    expect(projectSubject("new_agent", "anything at all")).toBeUndefined();
    for (const [kind, subject] of [
      ["tool", 'git commit -m "fix payroll"'],
      ["tool", "git status 1a2b3c4d5e6f /Users/alice/x"],
      ["capability", "needs a browser to log in to the client portal"],
      ["config", "routing.engineer.XL.none"],
      ["config", "routing.Engineer.S.none"],
      ["config", "budget task s"],
    ] as const) {
      expect(() => projectSubject(kind, subject), subject).toThrow(/vocabulary/);
    }
  });
});

describe("tool and capability issues (D-cs)", () => {
  it("a tool issue names the shape and its task count, nothing else of the commands", async () => {
    const h = harness();
    const outcome = await h.upstream.report(
      improvement("tool", "pnpm exec 0a1b2c3d4e5f", { "tool.tasks": 4 }),
      h.ctx,
    );
    expect(outcome).toMatchObject({ status: "issue", action: "opened" });
    const issue = h.github.state.issues[0];
    expect(issue?.title).toBe(
      "vtc(tool): promote the recurring command `pnpm exec` to an engine tool",
    );
    expect(issue?.body).toContain(
      "Command shape: `pnpm`, subcommand `exec`, flag set `0a1b2c3d4e5f`",
    );
    expect(issue?.body).toContain("| tool.tasks | 4 |");
  });

  it("a capability issue names the slug and its count, never a reason", async () => {
    const h = harness();
    await h.upstream.report(
      improvement("capability", "browser-automation", { "capability.escalations": 3 }),
      h.ctx,
    );
    const issue = h.github.state.issues[0];
    expect(issue?.title).toBe("vtc(capability): missing capability `browser-automation`");
    expect(issue?.body).toContain("| capability.escalations | 3 |");
    // a reason in place of the slug never leaves
    expect(
      await h.upstream.report(
        improvement("capability", "a browser to log in to the client portal"),
        h.ctx,
      ),
    ).toMatchObject({ status: "skipped", reason: "privacy" });
    expect(h.github.state.issues).toHaveLength(1);
  });

  it("a shape or slug that names the project fails closed on the denylist", async () => {
    const h = harness();
    expect(
      await h.upstream.report(improvement("tool", "globex-export - 0a1b2c3d4e5f"), h.ctx),
    ).toMatchObject({ status: "skipped", reason: "privacy" });
    expect(
      await h.upstream.report(improvement("capability", "payroll-portal-login"), h.ctx),
    ).toMatchObject({ status: "skipped", reason: "privacy" });
    expect(h.github.state.issues).toEqual([]);
  });
});

describe("routing-table changes (D-cn)", () => {
  it("renders a routing config fact as a change of DEFAULT_ROUTING_TABLE's values only", async () => {
    const h = harness();
    const subject = routingConfigSubject("engineer", "M", "tagged");
    await h.upstream.report(
      improvement("config", subject, { "routing.tasks": 14, "routing.escalated_pct": 64 }),
      h.ctx,
    );
    const issue = h.github.state.issues[0];
    expect(issue?.title).toBe("vtc(config): routing: engineer start tier for M tasks, a risk tag");
    expect(issue?.body).toContain(`Routing cell: \`${subject}\``);
    expect(issue?.body).toContain(
      `Change only the values of \`DEFAULT_ROUTING_TABLE\` in \`${ROUTING_TABLE_FILE}\``,
    );
    expect(issue?.body).toContain("`roles.engineer`");
    expect(issue?.body).toContain("| routing.escalated_pct | 64 |");
    expect(issue?.body).toContain("Check the routing scorecard charts");
    expect(routingSubjectOfBody(issue?.body)).toMatchObject({ key: subject });
    // a cap or budget key stays a plain config change
    await h.upstream.report(improvement("config", "caps.fix_rounds"), h.ctx);
    expect(h.github.state.issues[1]?.title).toBe("vtc(config): config change `caps.fix_rounds`");
    expect(routingSubjectOfBody(h.github.state.issues[1]?.body)).toBeNull();
  });

  it("the run a routing issue starts on the bs-vtc checkout carries the rule", async () => {
    const started: string[] = [];
    const h = harness({
      self: true,
      startRun: (input) => {
        started.push(input.request);
        return Promise.resolve();
      },
    });
    await h.upstream.report(
      improvement("config", routingConfigSubject("qa", "S", "none"), { "routing.tasks": 12 }),
      h.ctx,
    );
    expect(started).toHaveLength(1);
    expect(started[0]).toContain("Change only the values of `DEFAULT_ROUTING_TABLE`");
    expect(started[0]).toContain("`CONTRACTS_VERSION`");
  });
});
