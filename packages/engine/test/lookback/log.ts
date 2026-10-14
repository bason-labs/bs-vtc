/**
 * A small builder of valid run event logs for Lookback tests. Every event goes through
 * `EventSchema.parse`, so the tests feed Lookback only what a real log can hold.
 */
import {
  effectivePromptSha,
  EventSchema,
  sha256Hex,
  type HostId,
  type VtcEvent,
} from "@vtc/shared";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const LOCKED = "You are the Engineer. Follow the task pack.";
export const EDITABLE = "Prefer small diffs. Run the tests before you submit.";
export const LOCKED_SHA = sha256Hex(LOCKED);
export const EDITABLE_SHA = sha256Hex(EDITABLE);
export const EFFECTIVE = effectivePromptSha(LOCKED, EDITABLE);
export const HOST: HostId = "claude-code";

export const lockedShaFor = (): string => LOCKED_SHA;

const HEAD = "b".repeat(40);
const BASE = "a".repeat(40);

export const tempDir = (prefix: string): Promise<string> =>
  mkdtemp(join(tmpdir(), `vtc-${prefix}-`));

export class RunLog {
  readonly events: VtcEvent[] = [];
  private seq = 0;
  private time: number;
  private actions = 0;

  constructor(
    readonly run = "r1",
    start = "2026-10-14T10:00:00.000Z",
  ) {
    this.time = Date.parse(start);
  }

  add(event: Record<string, unknown>): VtcEvent {
    this.seq += 1;
    this.time += 60_000;
    const parsed = EventSchema.parse({
      v: 1,
      seq: this.seq,
      ts: new Date(this.time).toISOString(),
      run: this.run,
      actor: "engine",
      data: {},
      ...event,
    });
    this.events.push(parsed);
    return parsed;
  }

  taskCreated(task: string, discipline = "backend", stackPacks: string[] = []): void {
    this.add({
      type: "task.created",
      task,
      data: {
        task: {
          id: task,
          title: `Task ${task}`,
          feature: "F-1",
          origin: "planner",
          covers: ["REQ-1"],
          after: [],
          files_scope: ["src/**"],
          discipline,
          stack_packs: stackPacks,
          consumes_contracts: [],
          risk: "med",
          cap: 4,
          size: "M",
          arch_triage: "fits",
          budget_usd: 5,
          spent_usd: 0,
          status: "draft",
          round: 0,
          deferred: [],
          risk_tags: [],
        },
        intent: {
          statement: "Do the thing.",
          always: ["Keep it small"],
          never: ["Log secrets"],
          io_matrix: [{ case: "basic", input: "x", expected: "y" }],
        },
      },
    });
  }

  /** A dispatch and its end; returns the action id. */
  dispatch(
    role: string,
    options: {
      task?: string;
      end?: "built" | "done" | "rejected" | "failed" | "none";
      tokens?: number | null;
      prompt?: { effective: string; editable: string };
      arm?: "candidate" | "baseline";
      versioned?: boolean;
      mode?: string;
      action?: string;
    } = {},
  ): string {
    this.actions += 1;
    const action = options.action ?? `a-${this.run}-${String(this.actions)}`;
    const prompt = options.prompt ?? { effective: EFFECTIVE, editable: EDITABLE_SHA };
    const envelope = {
      role,
      host: HOST,
      model: "claude-sonnet-5",
      prompt_sha: prompt.effective,
      ...(options.task === undefined ? {} : { task: options.task }),
    };
    this.add({
      type: "role.dispatched",
      ...envelope,
      data: {
        action_id: action,
        dispatch: "subagent",
        agent: `vtc-${role}`,
        pack: `.vtc/state/packs/${action}.md`,
        resume: null,
        ...(options.mode === undefined ? {} : { mode: options.mode }),
        ...(options.versioned === false ? {} : { editable_sha256: prompt.editable }),
        ...(options.arm === undefined ? {} : { canary_arm: options.arm }),
      },
    });
    const end = options.end ?? "built";
    const tokens = options.tokens === undefined ? 1000 : options.tokens;
    if (end === "built" || end === "done") {
      this.add({
        type: "role.submitted",
        actor: "role",
        ...envelope,
        tokens: tokens === null ? null : { in: tokens - 100, out: 100, cache_r: 0, cache_w: 0 },
        cost_usd: 0.1,
        data: {
          action_id: action,
          exit: end,
          findings: 0,
          questions: 0,
          session_ref: null,
          ...(end === "built" ? { head: HEAD } : {}),
        },
      });
    } else if (end === "rejected") {
      this.add({
        type: "role.rejected",
        ...envelope,
        data: { action_id: action, reason: "schema" },
      });
    } else if (end === "failed") {
      this.add({
        type: "role.failed",
        ...envelope,
        data: { action_id: action, kind: "error", message: "host error", retryable: true },
      });
    }
    return action;
  }

  gate(task: string, pass: boolean, reason = "round"): void {
    this.add({
      type: "gate.result",
      task,
      data: {
        run: this.run,
        task,
        reason,
        scope: "affected",
        base: BASE,
        head: HEAD,
        results: [
          pass
            ? {
                gate_id: "tests",
                layer: "L2",
                phase: "verify",
                status: "pass",
                blocking: true,
                new_violations: 0,
                baseline_violations: 0,
                duration_ms: 10,
              }
            : {
                gate_id: "tests",
                layer: "L2",
                phase: "verify",
                status: "fail",
                blocking: true,
                new_violations: 1,
                baseline_violations: 0,
                failure_class: "product",
                duration_ms: 10,
              },
        ],
        verdict: pass ? "pass" : "fail",
        started_at: "2026-10-14T10:00:00.000Z",
        finished_at: "2026-10-14T10:00:01.000Z",
      },
    });
  }

  finding(
    task: string,
    route: string,
    options: { source?: "role" | "tool"; category?: string } = {},
  ): void {
    const source = options.source ?? "role";
    this.seqFinding += 1;
    this.add({
      type: "finding.recorded",
      task,
      data: {
        finding: {
          fingerprint: sha256Hex(`${this.run}-${String(this.seqFinding)}`),
          source,
          source_name: source === "role" ? "spec_verifier" : "eslint",
          rule_id: "rule-1",
          category: options.category ?? "correctness",
          ...(source === "role" ? { kind: "implementation_deviation" } : {}),
          title: "A finding",
          severity: "medium",
          confidence: 0.8,
          location: { path: "src/a.ts" },
          evidence: { type: "file_line", ref: "src/a.ts:1" },
          route,
          task,
          round_first_seen: 1,
          status: "open",
        },
      },
    });
  }

  private seqFinding = 0;
  private escalations = 0;

  /** Opens an escalation on the task and, when `who` is given, answers it. */
  escalate(task: string, who?: string, reason = "cap"): void {
    this.escalations += 1;
    const id = `E-${String(this.escalations)}`;
    this.add({
      type: "escalation.opened",
      task,
      data: {
        escalation: {
          id,
          run: this.run,
          task,
          reason,
          question: "How should we proceed?",
          options: [
            { id: "hint", label: "Give a hint", effect: "hint" },
            { id: "drop", label: "Drop it", effect: "drop" },
          ],
          recommended: "hint",
          evidence: [{ type: "file_line", ref: "src/a.ts:1" }],
          blocks: [task],
          created_at: "2026-10-14T10:00:00.000Z",
        },
      },
    });
    if (who !== undefined) {
      this.add({
        type: "escalation.answered",
        actor: "human",
        task,
        data: { escalation: id, answer: { option: "hint", who_should_have_caught: who } },
      });
    }
  }

  status(task: string, from: string, to: string, round: number, parkReason?: string): void {
    this.add({
      type: "task.status_changed",
      task,
      data: {
        from,
        to,
        round,
        cap: 4,
        ...(parkReason === undefined ? {} : { park_reason: parkReason }),
      },
    });
  }
}
