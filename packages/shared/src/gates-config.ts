/**
 * `.vtc/gates.yml` (§4.3, §7): calibrated gate commands and the baseline of one project.
 * Scanner pins are product data, not project data: they live in the product's `gates/` directory
 * (`gates/scanners.json`, {@link ScannerPinsSchema}) and are embedded in the binary (§4.4).
 */
import { z } from "zod";
import { engineRepoKey } from "./engine-instance.js";
import { VisualConfigSchema } from "./visual.js";
import {
  GitShaSchema,
  GlobSchema,
  IsoDateTimeSchema,
  PlatformSchema,
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
     * argv, executed without a shell, so commands are data, never shell strings. The Gate Runner
     * runs it only when `gateCommandAllowed` accepts it against the machine's
     * {@link GateAllowlistSchema} (§15); otherwise the gate is not run and reports `error` with
     * failure class `infra`, which parks the task with `gate_infra` until a human confirms the
     * command (`vtc calibrate`).
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

/**
 * A scanner pinned by version and per-platform SHA-256, never auto-updated (§7.2, §15). Each
 * download target has its own checksum (§4.4). `url` is a template with `{version}` and
 * `{platform}` placeholders. `vtc doctor` downloads into `~/.vtc/` and verifies the checksum.
 *
 * `binary_sha256` (D-ap, spine §5 reading 73): per platform, the SHA-256 of the executable as
 * extracted from that download. Re-verification before every use compares the installed binary
 * with this pin, never with a manifest stored next to it (a role or gate that could write the
 * store could rewrite both). A platform with a `sha256` but no `binary_sha256` has no anchor for
 * an installed binary: the store must re-verify the download against `sha256` before using it.
 * Each key must also have a `sha256`.
 */
export const ScannerPinSchema = z
  .strictObject({
    name: SlugSchema,
    version: z.string().min(1).max(64),
    url: z
      .url()
      .refine((url) => url.startsWith("https://"), "scanner downloads must use https")
      .refine((url) => url.includes("{platform}"), "url must contain {platform}"),
    sha256: z.partialRecord(PlatformSchema, Sha256HexSchema),
    binary_sha256: z.partialRecord(PlatformSchema, Sha256HexSchema).optional(),
    license: z.string().min(1).max(100),
  })
  .superRefine((pin, ctx) => {
    if (Object.keys(pin.sha256).length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["sha256"],
        message: "pin at least one platform checksum",
      });
    }
    for (const platform of Object.keys(pin.binary_sha256 ?? {})) {
      if (!Object.hasOwn(pin.sha256, platform)) {
        ctx.addIssue({
          code: "custom",
          path: ["binary_sha256", platform],
          message: "a binary checksum needs the download checksum of the same platform",
        });
      }
    }
  });
export type ScannerPin = z.infer<typeof ScannerPinSchema>;

/** The product's scanner pin file, `gates/scanners.json` (§4.4). */
export const ScannerPinsSchema = z
  .strictObject({
    version: z.literal(1),
    scanners: z.array(ScannerPinSchema).default([]),
  })
  .superRefine((pins, ctx) => {
    const names = pins.scanners.map((s) => s.name);
    if (new Set(names).size !== names.length) {
      ctx.addIssue({ code: "custom", path: ["scanners"], message: "duplicate scanner pins" });
    }
  });
export type ScannerPins = z.infer<typeof ScannerPinsSchema>;

/** The calibrated gates file, repo-relative (§4.3). */
export const GATES_CONFIG_FILE = ".vtc/gates.yml";

/**
 * Why a run refuses to start (D-au, spine §5 reading 78): `.vtc/gates.yml` is not committed at
 * the commit the run would start on. Engine core reads `gates.yml` only at that commit (reading
 * 46f), so it refuses `start` with this text (`EngineError` code `config`) instead of starting a
 * run whose first gate run would park.
 */
export const gatesConfigNotCommitted = (commit: string): string =>
  `${GATES_CONFIG_FILE} is not committed at ${commit.slice(0, 12)}: run vtc calibrate, commit ${GATES_CONFIG_FILE}, then start the run again`;

/**
 * The project's test layout, detected by `vtc calibrate` and confirmed with the baseline (§7.1).
 * - `acceptance_globs`: where QA author mode writes visible acceptance tests (artifact type
 *   `ACCEPTANCE_TESTS.artifactType`). It is QA author mode's effective write scope (AD-7 rule 7),
 *   and the files QA wrote there are protected from the Engineer by checksum (§7.3).
 * - `protected_configs`: lint, test and build config the Engineer may not change (§7.2 L5,
 *   §7.6 rule 5); checksummed like QA's tests.
 */
export const TestLayoutSchema = z.strictObject({
  acceptance_globs: z.array(GlobSchema).min(1),
  protected_configs: z.array(GlobSchema).default([]),
});
export type TestLayout = z.infer<typeof TestLayoutSchema>;

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
    tests: TestLayoutSchema,
    gates: z.array(GateSchema).min(1),
    /**
     * The gate sandbox's per-repo settings (D-av, spine §5 reading 84). `verify_loopback`: the
     * human answered yes at `vtc calibrate`'s confirmation that the test suite needs sockets to
     * the loopback, so verify-phase gates may reach 127.0.0.1 / ::1 (never another host). This
     * file is protected and human-calibrated: no role may write it (`REPO_ROLE_DENIED`, L5), and
     * a run takes it from the commit it starts on. Absent: no loopback. New in contracts 4.4.0.
     */
    sandbox: z.strictObject({ verify_loopback: z.boolean() }).optional(),
    /**
     * The deterministic visual step's settings (AD-24, §7.5): widths, themes, budgets, axe tags,
     * masked regions. Absent: `VISUAL_DEFAULTS` (`visualConfigFor`). New in contracts 4.5.0.
     */
    visual: VisualConfigSchema.optional(),
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
  });
export type GatesConfig = z.infer<typeof GatesConfigSchema>;
export type GatesConfigInput = z.input<typeof GatesConfigSchema>;

/**
 * The gate command allowlist (§15: no config change can trigger command execution without passing
 * the gate allowlist). `.vtc/gates.yml` is repo content that a PR or a teammate can change, so the
 * allowlist lives outside the repo, per machine and repo, at `~/.vtc/` + `gateAllowlistFile(root)`,
 * and only a human widens it: `vtc calibrate` shows every argv prefix not yet allowed and writes it
 * after the human confirms. Nothing in a repo, a role or the engine writes it otherwise. Pinned
 * scanners (`gates/scanners.json`, product data) are allowed by name.
 */
export const GateAllowlistSchema = z.strictObject({
  version: z.literal(1),
  commands: z
    .array(
      z.strictObject({
        /** argv tokens a gate command must start with, e.g. `["pnpm", "test"]`. */
        argv_prefix: z.array(z.string().min(1).max(4096)).min(1),
        confirmed_at: IsoDateTimeSchema,
      }),
    )
    .default([]),
});
export type GateAllowlist = z.infer<typeof GateAllowlistSchema>;
export type GateAllowlistInput = z.input<typeof GateAllowlistSchema>;

/** The allowlist file of a repo, relative to `~/.vtc/`: `allowlists/<repo-key>.json`. */
export const gateAllowlistFile = (absRepoRoot: string): string =>
  `allowlists/${engineRepoKey(absRepoRoot)}.json`;

/**
 * Pure: true when `command` (a gate's argv) starts with a confirmed prefix, token by token, or
 * names a pinned scanner (`scanners`, the names in `gates/scanners.json`).
 */
export const gateCommandAllowed = (
  command: readonly string[],
  allowlist: Pick<GateAllowlist, "commands">,
  scanners: readonly string[] = [],
): boolean => {
  const [first] = command;
  if (first === undefined) return false;
  if (scanners.includes(first)) return true;
  return allowlist.commands.some(
    (entry) =>
      entry.argv_prefix.length <= command.length &&
      entry.argv_prefix.every((token, i) => command[i] === token),
  );
};
