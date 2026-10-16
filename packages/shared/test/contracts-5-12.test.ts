/**
 * Contracts 5.12.0 (MINOR; spine §5 readings 258–263): the owner's first run. A dispatch's own
 * structured-output schema (`roleResultSchemaFor`), so a host that honours the schema cannot send
 * a task, a mode or an artifact type the dispatch does not allow; the compiled headless
 * instructions of an agent (`PluginManifestAgent.headless_sha256`, `rolePromptAssetPath(<agent>,
 * "headless")`); image attachments on `start` and `change_request` (`attachments`,
 * `PACK_INPUT_TYPES.attachments`).
 */
import { describe, expect, it } from "vitest";
import {
  ATTACHMENTS,
  ChangeRequestInputSchema,
  EVENT_PAYLOAD_SCHEMAS,
  runAttachmentPath,
  checkResultAgainstContract,
  CONTRACTS_VERSION,
  fromStructuredOutput,
  jsonSchemaFor,
  PACK_INPUT_TYPES,
  PluginManifestAgentSchema,
  resolveRoleMode,
  RoleContractSchema,
  roleResultSchemaFor,
  rolePromptAssetPath,
  StartInputSchema,
  type EffectiveRoleContract,
} from "../src/index.js";
import { validRoleContract } from "./fixtures.js";

const effective = (patch: object): EffectiveRoleContract => {
  const resolved = resolveRoleMode(RoleContractSchema.parse({ ...validRoleContract(), ...patch }));
  if (!resolved.ok) throw new Error(resolved.error);
  return resolved.contract;
};

const ba = effective({
  id: "ba",
  reviewer: "spec_verifier",
  output: { artifacts: ["spec"], verdicts: [] },
  exits: ["done", "blocked", "spec_conflict"],
  tools: { profile: "write_scoped", write_paths: [".vtc/spec/**"] },
});

type Schema = Record<string, unknown> & { properties: Record<string, Record<string, unknown>> };
const props = (schema: Record<string, unknown>) => (schema as Schema).properties;
/** The non-null member of a nullable property. */
const inner = (prop: Record<string, unknown> | undefined): Record<string, unknown> => {
  const members = (prop?.anyOf as Record<string, unknown>[] | undefined) ?? [prop ?? {}];
  return members.find((m) => m.type !== "null") ?? {};
};

describe("contracts 5.12.0", () => {
  it("is MINOR over 5.11.0", () => {
    expect(CONTRACTS_VERSION).toBe("5.12.0");
  });

  describe("roleResultSchemaFor (owner run a-1, a-2)", () => {
    const schema = roleResultSchemaFor({ role: "ba" }, ba);

    it("allows only the dispatched role, and null for a task, mode or subject not dispatched", () => {
      expect(props(schema).role).toEqual({ type: "string", enum: ["ba"] });
      expect(props(schema).task).toEqual({ type: "null" });
      expect(props(schema).mode).toEqual({ type: "null" });
    });

    it("lists only the contract's artifact types, exits and outputs", () => {
      const artifact = inner(props(schema).artifacts);
      const items = artifact.items as Schema;
      expect(items.properties.type).toEqual({ type: "string", enum: ["spec"] });
      expect(props(schema).exit).toEqual({
        type: "string",
        enum: ["done", "blocked", "spec_conflict"],
      });
      expect(props(schema).tasks).toEqual({ type: "null" });
      expect(props(schema).acceptance_tests).toEqual({ type: "null" });
      expect(props(schema).verdicts).toEqual({ type: "null" });
      expect(props(schema).fault).toEqual({ type: "null" });
      // blocked and spec_conflict are exits of the BA: their objects stay
      expect(inner(props(schema).question).type).toBe("object");
      expect(inner(props(schema).conflict).type).toBe("object");
    });

    it("keeps every field required and the generic schema unchanged", () => {
      const generic = jsonSchemaFor("RoleResult", { target: "structured-output" });
      expect((schema as Schema).required).toEqual((generic as Schema).required);
      expect(Object.keys(props(schema))).toEqual(Object.keys(props(generic)));
      expect(props(generic).task).not.toEqual({ type: "null" });
    });

    it("pins the dispatched task, mode, feature and verdict subject", () => {
      const verifier = effective({
        id: "spec_verifier",
        reviewer: "engine",
        inputs: ["acceptance_criterion"],
        output: { artifacts: [], verdicts: ["pass", "fail", "unknown"] },
        exits: ["done", "unknown"],
        tools: { profile: "read_only" },
      });
      const pinned = roleResultSchemaFor(
        { role: "spec_verifier", task: "T-7", subject: "REQ-3.AC-2" },
        verifier,
      );
      expect(props(pinned).task).toEqual({ type: "string", enum: ["T-7"] });
      expect(props(pinned).artifacts).toEqual({ type: "null" });
      const verdict = inner(props(pinned).verdicts).items as Schema;
      expect(verdict.properties.subject).toEqual({ type: "string", enum: ["REQ-3.AC-2"] });
      expect(verdict.properties.verdict).toEqual({
        type: "string",
        enum: ["pass", "fail", "unknown"],
      });
      const review = roleResultSchemaFor({ role: "spec_verifier", feature: "F-2" }, verifier);
      expect(props(review).feature).toEqual({ type: "string", enum: ["F-2"] });
    });

    it("a result valid against the dispatch schema conforms; the owner's a-1 shape cannot", () => {
      const sent = {
        role: "ba",
        mode: null,
        task: null,
        feature: null,
        verdicts: null,
        findings: [],
        questions: [],
        tasks: null,
        acceptance_tests: null,
        artifacts: [{ type: "spec", path: ".vtc/spec/spec.md", sha256: null }],
        claims: [],
        summary: "Wrote the spec.",
        exit: "done",
        question: null,
        conflict: null,
        fault: null,
      };
      const parsed = fromStructuredOutput("RoleResult", sent);
      expect(parsed.success).toBe(true);
      if (parsed.success)
        expect(checkResultAgainstContract(parsed.data, ba, { role: "ba" })).toEqual({ ok: true });
      const types = (inner(props(schema).artifacts).items as Schema).properties.type?.enum;
      expect(types).not.toContain("specification");
    });
  });

  describe("headless instructions asset", () => {
    it("has its own asset path and an optional manifest hash", () => {
      expect(rolePromptAssetPath("vtc-ba", "headless")).toBe("vtc/prompts/vtc-ba/headless.md");
      const agent = {
        name: "vtc-ba",
        role: "ba",
        mode: null,
        kind: "core",
        discipline: null,
        role_version: "1.0.0",
        file: "agents/vtc-ba.toml",
        prompt_sha256: "a".repeat(64),
        tier: "top",
        effort: "high",
      };
      expect(PluginManifestAgentSchema.safeParse(agent).success).toBe(true);
      expect(
        PluginManifestAgentSchema.safeParse({ ...agent, headless_sha256: "b".repeat(64) }).success,
      ).toBe(true);
      expect(
        PluginManifestAgentSchema.safeParse({ ...agent, headless_sha256: "nope" }).success,
      ).toBe(false);
    });
  });

  describe("attachments on start and change_request", () => {
    const start = {
      request: "Show the order total on checkout [Image #1]",
      track: "quick_fix",
      repo: "existing",
      has_ui: true,
      risk_hints: [],
    };

    it("takes absolute file paths, at most ten", () => {
      expect(StartInputSchema.safeParse(start).success).toBe(true);
      expect(
        StartInputSchema.safeParse({ ...start, attachments: ["/tmp/screenshot 1.png"] }).success,
      ).toBe(true);
      expect(StartInputSchema.safeParse({ ...start, attachments: ["shot.png"] }).success).toBe(
        false,
      );
      expect(
        StartInputSchema.safeParse({
          ...start,
          attachments: Array.from({ length: 11 }, (_, i) => `/tmp/${String(i)}.png`),
        }).success,
      ).toBe(false);
      expect(
        ChangeRequestInputSchema.safeParse({
          artifact: "spec",
          summary: "Show the total in the cart too",
          detail: "As in the screenshot.",
          attachments: ["/Users/me/Desktop/shot.png"],
        }).success,
      ).toBe(true);
    });

    it("lists each copied file in a pack as an `attachments` input", () => {
      expect(PACK_INPUT_TYPES.attachments).toBe("attachments");
    });

    it("copies each into the run under a numbered, safe name, recorded on the events", () => {
      const run = "r20261016-052258";
      expect(
        runAttachmentPath(run, 1, "/Users/me/Desktop/Screenshot 2026-10-16 at 12.20.01.png"),
      ).toBe(`.vtc/runs/${run}/attachments/1-Screenshot-2026-10-16-at-12.20.01.png`);
      expect(runAttachmentPath(run, 2, "C:\\Users\\me\\..hidden.PNG")).toBe(
        `.vtc/runs/${run}/attachments/2-hidden.PNG`,
      );
      expect(runAttachmentPath(run, 3, "/tmp/")).toBe(`.vtc/runs/${run}/attachments/3-attachment`);
      expect(() => runAttachmentPath(run, 0, "/tmp/a.png")).toThrow(RangeError);
      const started = EVENT_PAYLOAD_SCHEMAS["run.started"];
      const data = {
        ...start,
        merge_level: 2,
        pipeline_config_hash: "a".repeat(64),
        attachments: [`.vtc/runs/${run}/attachments/1-a.png`],
      };
      expect(started.safeParse(data).success).toBe(true);
      expect(started.safeParse({ ...data, attachments: ["/abs.png"] }).success).toBe(false);
      expect(ATTACHMENTS.max).toBe(10);
    });
  });
});
