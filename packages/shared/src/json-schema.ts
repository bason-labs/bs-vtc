/** JSON Schema export of every contract (§16: "Zod schemas = JSON Schemas"). */
import { z } from "zod";
import {
  AnswerInputSchema,
  ApproveInputSchema,
  ArtifactContentSchema,
  ChangeRequestInputSchema,
  ChangeRequestResultSchema,
  ConsultInputSchema,
  ConsultResultSchema,
  DesignReviewCommentInputSchema,
  DesignReviewResultSchema,
  EscalationListSchema,
  EventPageSchema,
  FeatureListSchema,
  HealthResultSchema,
  HttpErrorSchema,
  IngestResultSchema,
  LeadActionSchema,
  NextResultSchema,
  RunControlResultSchema,
  RunListSchema,
  RunScopedInputSchema,
  SessionExchangeInputSchema,
  SessionExchangeResultSchema,
  SessionNonceResultSchema,
  StartInputSchema,
  StartResultSchema,
  StatusResultSchema,
  SubmitInputSchema,
  SubmitResultSchema,
  TaskDetailSchema,
  TaskDiffSchema,
  TaskListSchema,
} from "./engine-api.js";
import {
  EngineDiscoverySchema,
  EngineSocketHelloSchema,
  EngineSocketWelcomeSchema,
} from "./engine-instance.js";
import { DesignScreensFileSchema } from "./design.js";
import { EscalationSchema } from "./escalation.js";
import { EVENT_PAYLOAD_SCHEMAS } from "./event-payloads.js";
import { EventSchema } from "./event.js";
import { FeatureSchema } from "./feature.js";
import { FindingDraftSchema, FindingSchema } from "./finding.js";
import {
  GateReportSchema,
  GateResultSchema,
  GateRunRequestSchema,
  TestInventorySchema,
  WriteScopeReportSchema,
} from "./gate-result.js";
import { GateAllowlistSchema, GatesConfigSchema, ScannerPinsSchema } from "./gates-config.js";
import { HostOutcomeSchema, SubagentInstructionSchema } from "./interfaces/host-adapter.js";
import { PluginManifestSchema } from "./plugin-manifest.js";
import { ProjectConfigSchema, UserConfigSchema } from "./project-config.js";
import { QuestionSchema } from "./question.js";
import { RoleContractSchema } from "./role-contract.js";
import { RoleResultSchema } from "./role-result.js";
import { RunSchema } from "./run.js";
import { PlanFileFrontmatterSchema, TaskDraftSchema, TaskSchema } from "./task.js";
import { TaskPackSchema } from "./task-pack.js";
import {
  AssertionProvenanceSchema,
  EvidenceBundleSchema,
  TraceabilityReportSchema,
} from "./traceability.js";
import { StatuslineIngestSchema, UsageReportSchema, UsageSnapshotSchema } from "./usage.js";
import { WorkflowEdgeSchema, WorkflowGraphSchema, WorkflowNodeSchema } from "./workflow.js";

/** Every frozen contract by name. */
export const CONTRACT_SCHEMAS = {
  // domain records
  Run: RunSchema,
  Task: TaskSchema,
  TaskDraft: TaskDraftSchema,
  PlanFileFrontmatter: PlanFileFrontmatterSchema,
  Feature: FeatureSchema,
  Finding: FindingSchema,
  FindingDraft: FindingDraftSchema,
  Question: QuestionSchema,
  Escalation: EscalationSchema,
  Event: EventSchema,
  EventPayloads: z.strictObject(EVENT_PAYLOAD_SCHEMAS),
  RoleResult: RoleResultSchema,
  RoleContract: RoleContractSchema,
  AssertionProvenance: AssertionProvenanceSchema,
  TaskPack: TaskPackSchema,
  TraceabilityReport: TraceabilityReportSchema,
  EvidenceBundle: EvidenceBundleSchema,
  DesignScreensFile: DesignScreensFileSchema,
  PluginManifest: PluginManifestSchema,
  // config files
  ProjectConfig: ProjectConfigSchema,
  UserConfig: UserConfigSchema,
  GatesConfig: GatesConfigSchema,
  ScannerPins: ScannerPinsSchema,
  GateAllowlist: GateAllowlistSchema,
  // gate runner (AD-13)
  GateRunRequest: GateRunRequestSchema,
  GateResult: GateResultSchema,
  GateReport: GateReportSchema,
  WriteScopeReport: WriteScopeReportSchema,
  TestInventory: TestInventorySchema,
  // usage
  UsageSnapshot: UsageSnapshotSchema,
  UsageReport: UsageReportSchema,
  StatuslineIngest: StatuslineIngestSchema,
  // flow graph
  WorkflowNode: WorkflowNodeSchema,
  WorkflowEdge: WorkflowEdgeSchema,
  WorkflowGraph: WorkflowGraphSchema,
  // hosts
  HostOutcome: HostOutcomeSchema,
  SubagentInstruction: SubagentInstructionSchema,
  // engine instance (AD-12)
  EngineDiscovery: EngineDiscoverySchema,
  EngineSocketHello: EngineSocketHelloSchema,
  EngineSocketWelcome: EngineSocketWelcomeSchema,
  // MCP tools (AD-4)
  RunScopedInput: RunScopedInputSchema,
  StartInput: StartInputSchema,
  StartResult: StartResultSchema,
  LeadAction: LeadActionSchema,
  NextResult: NextResultSchema,
  SubmitInput: SubmitInputSchema,
  SubmitResult: SubmitResultSchema,
  StatusResult: StatusResultSchema,
  EscalationList: EscalationListSchema,
  AnswerInput: AnswerInputSchema,
  ApproveInput: ApproveInputSchema,
  ChangeRequestInput: ChangeRequestInputSchema,
  ChangeRequestResult: ChangeRequestResultSchema,
  ConsultInput: ConsultInputSchema,
  ConsultResult: ConsultResultSchema,
  RunControlResult: RunControlResultSchema,
  // HTTP (AD-5)
  HealthResult: HealthResultSchema,
  RunList: RunListSchema,
  EventPage: EventPageSchema,
  TaskList: TaskListSchema,
  TaskDetail: TaskDetailSchema,
  TaskDiff: TaskDiffSchema,
  FeatureList: FeatureListSchema,
  ArtifactContent: ArtifactContentSchema,
  SessionNonceResult: SessionNonceResultSchema,
  SessionExchangeInput: SessionExchangeInputSchema,
  SessionExchangeResult: SessionExchangeResultSchema,
  IngestResult: IngestResultSchema,
  DesignReviewCommentInput: DesignReviewCommentInputSchema,
  DesignReviewResult: DesignReviewResultSchema,
  HttpError: HttpErrorSchema,
} as const;
export type ContractName = keyof typeof CONTRACT_SCHEMAS;

export const isContractName = (name: string): name is ContractName =>
  Object.hasOwn(CONTRACT_SCHEMAS, name);

export type JsonSchema = Record<string, unknown>;

export interface JsonSchemaOptions {
  /**
   * `input` (default) describes what a producer may send: fields with defaults are optional.
   * `output` describes the parsed value: defaulted fields are required.
   */
  readonly io?: "input" | "output";
  /**
   * `contract` (default): the plain export. `structured-output`: the form handed to hosts as
   * `--output-schema` / `--json-schema` (AD-3 rule 8): an object root (a root union is merged
   * into one object), every property required (optional ones become nullable), no `default`,
   * and no `$schema` or `$id` (Claude Code's `--json-schema` rejects a document that names the
   * draft-2020-12 meta-schema; spike 2026-10-13, spine §7), so both hosts take the same form.
   * Parse what the host returns with {@link fromStructuredOutput}, which re-validates with Zod.
   */
  readonly target?: "contract" | "structured-output";
}

/** Contracts a host may be asked to produce as structured output. */
export const STRUCTURED_OUTPUT_CONTRACTS = [
  "RoleResult",
] as const satisfies readonly ContractName[];
export type StructuredOutputContract = (typeof STRUCTURED_OUTPUT_CONTRACTS)[number];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const NULL_SCHEMA = { type: "null" };

const nullable = (schema: unknown): unknown => {
  if (isRecord(schema) && Array.isArray(schema.anyOf)) {
    const members = schema.anyOf as unknown[];
    return members.some((m) => isRecord(m) && m.type === "null")
      ? schema
      : { ...schema, anyOf: [...members, NULL_SCHEMA] };
  }
  return { anyOf: [schema, NULL_SCHEMA] };
};

/** Allowed literal values of a discriminator property, or null if it is not one. */
const literalValues = (schema: unknown): unknown[] | null => {
  if (!isRecord(schema)) return null;
  if ("const" in schema) return [schema.const];
  if (Array.isArray(schema.enum)) return schema.enum as unknown[];
  return null;
};

/** Merges a union of object schemas into one object schema (a host-friendly root). */
const mergeObjectUnion = (
  variants: readonly Record<string, unknown>[],
): Record<string, unknown> => {
  const names = [
    ...new Set(variants.flatMap((v) => Object.keys(isRecord(v.properties) ? v.properties : {}))),
  ];
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const name of names) {
    const defs = variants.map((v) => (isRecord(v.properties) ? v.properties[name] : undefined));
    const present = defs.filter((d) => d !== undefined);
    const everywhere = present.length === variants.length;
    const literals = present.map(literalValues);
    let merged: unknown;
    if (everywhere && literals.every((l) => l !== null)) {
      const values = [...new Set(literals.flat())];
      const first = present[0];
      merged = {
        ...(isRecord(first) && typeof first.type === "string" ? { type: first.type } : {}),
        enum: values,
      };
    } else {
      const distinct = [...new Map(present.map((d) => [JSON.stringify(d), d])).values()];
      merged = distinct.length === 1 ? distinct[0] : { anyOf: distinct };
    }
    const requiredEverywhere =
      everywhere &&
      variants.every((v) => Array.isArray(v.required) && (v.required as unknown[]).includes(name));
    properties[name] = merged;
    if (requiredEverywhere) required.push(name);
  }
  return { type: "object", properties, required, additionalProperties: false };
};

const toStructured = (schema: unknown): unknown => {
  if (Array.isArray(schema)) return schema.map(toStructured);
  if (!isRecord(schema)) return schema;
  let node: Record<string, unknown> = { ...schema };
  delete node.default;
  const union = node.oneOf ?? node.anyOf;
  if (
    Array.isArray(union) &&
    union.length > 1 &&
    union.every((v) => isRecord(v) && v.type === "object")
  ) {
    const { oneOf: _o, anyOf: _a, ...rest } = node;
    node = { ...rest, ...mergeObjectUnion(union as Record<string, unknown>[]) };
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "properties" && isRecord(value)) {
      const required = new Set(Array.isArray(node.required) ? (node.required as string[]) : []);
      const props: Record<string, unknown> = {};
      for (const [name, prop] of Object.entries(value)) {
        const converted = toStructured(prop);
        props[name] = required.has(name) ? converted : nullable(converted);
      }
      out.properties = props;
      out.required = Object.keys(value);
    } else if (key !== "required") {
      out[key] = toStructured(value);
    }
  }
  if (!("properties" in out) && "required" in node) out.required = node.required;
  return out;
};

/**
 * JSON Schema (draft 2020-12) for one contract. Cross-field rules (`superRefine`) are not
 * representable in JSON Schema, so always re-validate with the Zod schema after a host
 * returns structured output.
 */
export const jsonSchemaFor = (name: ContractName, options: JsonSchemaOptions = {}): JsonSchema => {
  const schema = z.toJSONSchema(CONTRACT_SCHEMAS[name], {
    target: "draft-2020-12",
    io: options.io ?? "input",
    unrepresentable: "any",
  }) as JsonSchema;
  if (options.target === "structured-output") {
    const { $schema: _schema, $id: _id, ...body } = toStructured(schema) as JsonSchema;
    return { title: name, ...body };
  }
  return { $id: `https://vtc.local/schemas/${name}.json`, title: name, ...schema };
};

/** JSON Schemas for every contract, keyed by name. */
export const jsonSchemas = (options: JsonSchemaOptions = {}): Record<ContractName, JsonSchema> =>
  Object.fromEntries(
    (Object.keys(CONTRACT_SCHEMAS) as ContractName[]).map((name) => [
      name,
      jsonSchemaFor(name, options),
    ]),
  ) as Record<ContractName, JsonSchema>;

const stripNulls = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, v]) => v !== null)
      .map(([k, v]) => [k, stripNulls(v)]),
  );
};

/**
 * Parses a host's structured output back into the contract: `null` means "absent" (these
 * contracts have no nullable fields, which `json-schema.test.ts` guards), then Zod re-validates
 * every rule, including the cross-field ones JSON Schema cannot express (AD-3 rule 3).
 */
export const fromStructuredOutput = <N extends StructuredOutputContract>(
  name: N,
  value: unknown,
): z.ZodSafeParseResult<z.infer<(typeof CONTRACT_SCHEMAS)[N]>> =>
  CONTRACT_SCHEMAS[name].safeParse(stripNulls(value));
