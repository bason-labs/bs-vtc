/** `.vtc/gates.yml` (§4.3, §7): calibrated gate commands, the baseline, and scanner pins. */
import { z } from "zod";
import {
  GitShaSchema,
  GlobSchema,
  IsoDateTimeSchema,
  RelPathSchema,
  Sha256HexSchema,
  SlugSchema,
} from "./primitives.js";

/** Deterministic layers (§7.2). L5 (test integrity + write scope) is engine code, not a command. */
export const GateLayerSchema = z.enum(["L0", "L1", "L2", "L3", "L4", "L5", "L6"]);
export type GateLayer = z.infer<typeof GateLayerSchema>;

/** Calibration sources, in precedence order (§7.1). */
export const CalibrationSourceSchema = z.enum([
  "gates_yml",
  "agents_md",
  "task_runner",
  "ci",
  "devcontainer",
  "lockfile",
]);
export type CalibrationSource = z.infer<typeof CalibrationSourceSchema>;

export const ReportFormatSchema = z.enum(["junit", "sarif", "json", "text"]);
export type ReportFormat = z.infer<typeof ReportFormatSchema>;

/**
 * Sandbox phase (§7.2): `install` may reach package registries only; `verify` has no network.
 */
export const GatePhaseSchema = z.enum(["install", "verify"]);
export type GatePhase = z.infer<typeof GatePhaseSchema>;

export const GateSchema = z
  .strictObject({
    id: SlugSchema,
    layer: GateLayerSchema,
    /**
     * argv, executed without a shell. A config change can only run commands that pass the
     * gate allowlist (§15), so commands are data, never shell strings.
     */
    command: z.array(z.string().min(1)).min(1),
    cwd: RelPathSchema.optional(),
    phase: GatePhaseSchema.default("verify"),
    timeout_s: z.int().positive().max(7200).default(900),
    report: z.strictObject({ format: ReportFormatSchema, path: RelPathSchema }).optional(),
    /** Only L6 architecture checks may be non-blocking ("blocking or warn", §8.5). */
    blocking: z.boolean().default(true),
    /** Run only when the diff touches these globs (e.g. Checkov only when IaC changes, §7.2 L4). */
    when_changed: z.array(GlobSchema).optional(),
  })
  .superRefine((gate, ctx) => {
    if (!gate.blocking && gate.layer !== "L6") {
      ctx.addIssue({
        code: "custom",
        path: ["blocking"],
        message: "only L6 gates may be non-blocking",
      });
    }
  });
export type Gate = z.infer<typeof GateSchema>;

/** Scanner binaries are pinned by version and SHA-256 and never auto-updated (§7.2, §15). */
export const ScannerPinSchema = z.strictObject({
  name: SlugSchema,
  version: z.string().min(1).max(64),
  sha256: Sha256HexSchema,
});
export type ScannerPin = z.infer<typeof ScannerPinSchema>;

export const GatesConfigSchema = z
  .strictObject({
    version: z.literal(1),
    baseline: z.strictObject({
      revision: GitShaSchema,
      calibrated_at: IsoDateTimeSchema,
      /** The human confirms calibration once; only then does the baseline freeze (§7.1). */
      confirmed: z.boolean(),
      /** Test ids that flaked across the two calibration runs. */
      flaky_tests: z.array(z.string().min(1)).default([]),
    }),
    sources: z.array(CalibrationSourceSchema).default([]),
    gates: z.array(GateSchema).min(1),
    scanners: z.array(ScannerPinSchema).default([]),
  })
  .superRefine((config, ctx) => {
    const ids = config.gates.map((g) => g.id);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (dupes.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["gates"],
        message: `duplicate gate ids: ${[...new Set(dupes)].join(", ")}`,
      });
    }
    const scanners = config.scanners.map((s) => s.name);
    if (new Set(scanners).size !== scanners.length) {
      ctx.addIssue({ code: "custom", path: ["scanners"], message: "duplicate scanner pins" });
    }
  });
export type GatesConfig = z.infer<typeof GatesConfigSchema>;
export type GatesConfigInput = z.input<typeof GatesConfigSchema>;
