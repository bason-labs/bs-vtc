/** JSON Schema export of every contract (§16: "Zod schemas = JSON Schemas"). */
import { z } from "zod";
import {
  AnswerInputSchema,
  ApproveInputSchema,
  ChangeRequestInputSchema,
  LeadActionSchema,
  NextResultSchema,
  StartInputSchema,
  SubmitInputSchema,
} from "./engine-api.js";
import { EscalationSchema } from "./escalation.js";
import { EventSchema } from "./event.js";
import { FeatureSchema } from "./feature.js";
import { FindingDraftSchema, FindingSchema } from "./finding.js";
import { GatesConfigSchema } from "./gates-config.js";
import { HostOutcomeSchema } from "./interfaces/host-adapter.js";
import { ProjectConfigSchema } from "./project-config.js";
import { RoleContractSchema } from "./role-contract.js";
import { RoleResultSchema } from "./role-result.js";
import { TaskSchema } from "./task.js";
import { UsageSnapshotSchema } from "./usage.js";
import { WorkflowEdgeSchema, WorkflowGraphSchema, WorkflowNodeSchema } from "./workflow.js";

/** Every frozen contract by name. */
export const CONTRACT_SCHEMAS = {
  Task: TaskSchema,
  Feature: FeatureSchema,
  Finding: FindingSchema,
  FindingDraft: FindingDraftSchema,
  Escalation: EscalationSchema,
  Event: EventSchema,
  RoleResult: RoleResultSchema,
  RoleContract: RoleContractSchema,
  ProjectConfig: ProjectConfigSchema,
  GatesConfig: GatesConfigSchema,
  UsageSnapshot: UsageSnapshotSchema,
  WorkflowNode: WorkflowNodeSchema,
  WorkflowEdge: WorkflowEdgeSchema,
  WorkflowGraph: WorkflowGraphSchema,
  HostOutcome: HostOutcomeSchema,
  LeadAction: LeadActionSchema,
  NextResult: NextResultSchema,
  StartInput: StartInputSchema,
  SubmitInput: SubmitInputSchema,
  AnswerInput: AnswerInputSchema,
  ApproveInput: ApproveInputSchema,
  ChangeRequestInput: ChangeRequestInputSchema,
} as const;
export type ContractName = keyof typeof CONTRACT_SCHEMAS;

export type JsonSchema = Record<string, unknown>;

export interface JsonSchemaOptions {
  /**
   * `input` (default) describes what a producer may send: fields with defaults are optional.
   * `output` describes the parsed value: defaulted fields are required.
   */
  readonly io?: "input" | "output";
}

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
