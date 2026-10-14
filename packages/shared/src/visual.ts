/**
 * Deterministic visual QA (spec §7.5, §9.1; spine AD-24; Lead decision D-ay). New in contracts
 * 4.5.0.
 *
 * The Gate Runner's visual step renders the route × state × width × theme matrix of
 * `.vtc/design/screens.yaml` on the project's own Playwright (or the pinned browser
 * `vtc doctor --install-browser` installed under the VTC home), inside the gate sandbox, with the
 * approved prototype rendered in the same run by the same browser. It runs token lint, axe
 * (WCAG 2.2 AA tags), computed styles against the DTCG tokens, a per-region pixelmatch diff and
 * the design detector, and reports a {@link VisualSummary} on the `GateReport` plus the full
 * {@link VisualReport} under `.vtc/evidence/`. "Unreached is not clean" (§7.5): an unreached
 * render or an axe `incomplete` item never counts as a pass.
 */
import { z } from "zod";
import { PrototypeThemeSchema } from "./design.js";
import { ToolFindingSchema } from "./finding.js";
import {
  FeatureIdSchema,
  IsoDateTimeSchema,
  RelPathSchema,
  RunIdSchema,
  Sha256HexSchema,
  SlugSchema,
  TaskIdSchema,
} from "./primitives.js";

/**
 * Outcome of the visual step: `pass`; `fail` (a finding that blocks); `unchecked` (a render or
 * state was not reached, which blocks like a failure, §7.5); `skipped` (no browser, D-ay: the
 * reason is shown, Levels 1–2 continue, Level 3 does not count it as a pass); `error` (the
 * browser pin did not match, the runner crashed: gate infrastructure, §6.8).
 */
export const VisualStatusSchema = z.enum(["pass", "fail", "unchecked", "skipped", "error"]);
export type VisualStatus = z.infer<typeof VisualStatusSchema>;

/** The reason shown when the visual step is skipped for lack of a browser (D-ay). */
export const VISUAL_SKIPPED_NO_BROWSER =
  "no browser for the visual gates: install Playwright in the project, or run vtc doctor --install-browser";

/** The axe-core tags the visual step runs (WCAG 2.2 AA, §7.5 step 3). */
export const VISUAL_AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] as const;

/** Defaults of `gates.yml` `visual` (§7.5 step 2 widths, pixelmatch v8 threshold). */
export const VISUAL_DEFAULTS = {
  widths: [390, 768, 1440],
  themes: ["light", "dark"],
  /** Largest share of a region's pixels that may differ, in percent. */
  region_budget_pct: 0.5,
  /** Largest OKLab ΔE between a computed colour and its nearest token. */
  color_delta: 0.02,
  /** pixelmatch `threshold`; anti-aliased pixels are always ignored. */
  pixel_threshold: 0.1,
  axe_tags: VISUAL_AXE_TAGS,
  include_best_practice: false,
} as const;

const LOOPBACK_APP_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * `.vtc/gates.yml` `visual.app`: the app server the visual step renders the implementation from
 * (§7.5 step 2; spine §5 reading 121). Every screen state renders at
 * `<url><route>?state=<state>&theme=<theme>`, the prototype's convention (`prototypeStatePath`),
 * so implementation and prototype compare state by state. Human-calibrated like every gate: the
 * `command` must pass the machine's gate allowlist (`gateCommandAllowed`), and the `url` is an
 * http(s) loopback URL (the gate sandbox allows nothing else). New in 4.6.0.
 */
export const VisualAppSchema = z.strictObject({
  /** argv, run without a shell. */
  command: z.array(z.string().min(1).max(4096)).min(1).max(64),
  /** Base URL the server answers on, e.g. `http://127.0.0.1:4173`. */
  url: z
    .url()
    .max(2048)
    .refine((u) => {
      try {
        const url = new URL(u);
        return (
          (url.protocol === "http:" || url.protocol === "https:") &&
          LOOPBACK_APP_HOSTS.has(url.hostname)
        );
      } catch {
        return false;
      }
    }, "the app server must answer on an http(s) loopback URL"),
  /** Working directory inside the checkout. */
  cwd: RelPathSchema.optional(),
  ready_timeout_s: z.int().positive().max(600).default(120),
});
export type VisualApp = z.infer<typeof VisualAppSchema>;

/**
 * `.vtc/gates.yml` `visual` (optional; absent = {@link VISUAL_DEFAULTS}). `dynamic_regions` are
 * CSS selectors masked before the pixel diff (clocks, avatars, live data). `app` since 4.6.0.
 */
export const VisualConfigSchema = z.strictObject({
  widths: z.array(z.int().min(200).max(4000)).min(1).max(6).optional(),
  themes: z.array(PrototypeThemeSchema).min(1).max(2).optional(),
  region_budget_pct: z.number().min(0).max(100).optional(),
  color_delta: z.number().min(0).max(1).optional(),
  pixel_threshold: z.number().min(0).max(1).optional(),
  axe_tags: z.array(SlugSchema).min(1).max(20).optional(),
  include_best_practice: z.boolean().optional(),
  dynamic_regions: z.array(z.string().min(1).max(300)).max(50).optional(),
  app: VisualAppSchema.optional(),
});
export type VisualConfig = z.infer<typeof VisualConfigSchema>;

/** Pure: a project's visual settings with the defaults filled in. */
export const visualConfigFor = (config: VisualConfig | undefined) => ({
  widths: config?.widths ?? [...VISUAL_DEFAULTS.widths],
  themes: config?.themes ?? [...VISUAL_DEFAULTS.themes],
  region_budget_pct: config?.region_budget_pct ?? VISUAL_DEFAULTS.region_budget_pct,
  color_delta: config?.color_delta ?? VISUAL_DEFAULTS.color_delta,
  pixel_threshold: config?.pixel_threshold ?? VISUAL_DEFAULTS.pixel_threshold,
  axe_tags: config?.axe_tags ?? [...VISUAL_DEFAULTS.axe_tags],
  include_best_practice: config?.include_best_practice ?? VISUAL_DEFAULTS.include_best_practice,
  dynamic_regions: config?.dynamic_regions ?? [],
});

/**
 * Rule-id prefixes of visual tool findings. `vtc-design/` (the detector rules ported from
 * impeccable, Apache-2.0, `derived_from` kept in the rule's docs) routes to the Designer
 * (`design_gap`, §9.1 "slop findings hold the Designer step"); the rest go to the Engineer.
 */
export const VISUAL_RULE_PREFIX = {
  axe: "axe/",
  tokenLint: "vtc-token/",
  computedStyle: "vtc-style/",
  layoutDiff: "vtc-layout/",
  detector: "vtc-design/",
  unreached: "vtc-visual/unreached",
} as const;

/** Pure: the render key `<screen>:<state>:<width>:<theme>`. */
export const visualRenderKey = (
  screen: string,
  state: string,
  width: number,
  theme: z.infer<typeof PrototypeThemeSchema>,
): string =>
  `${SlugSchema.parse(screen)}:${SlugSchema.parse(state)}:${String(width)}:${PrototypeThemeSchema.parse(theme)}`;

export const VisualRenderKeySchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,63}:[a-z0-9][a-z0-9._-]{0,63}:\d{3,4}:(light|dark)$/);

const BrowserIdentitySchema = z.strictObject({
  name: z.string().min(1).max(100),
  version: z.string().min(1).max(64),
  executable_sha256: Sha256HexSchema,
});

const AxeItemSchema = z.strictObject({
  rule: z.string().min(1).max(100),
  impact: z.enum(["minor", "moderate", "serious", "critical"]).nullable(),
  help: z.string().min(1).max(500),
  nodes: z.int().nonnegative(),
});

/** The full visual evidence of one gate run, written redacted under `.vtc/evidence/<T-n|F-n>/`. */
export const VisualReportSchema = z
  .strictObject({
    v: z.literal(1),
    run: RunIdSchema,
    task: TaskIdSchema.optional(),
    feature: FeatureIdSchema.optional(),
    status: VisualStatusSchema,
    skipped_reason: z.string().min(1).max(500).optional(),
    browser: BrowserIdentitySchema.nullable(),
    renders: z
      .array(
        z.strictObject({
          key: VisualRenderKeySchema,
          status: z.enum(["rendered", "unreached", "error"]),
          screenshot: RelPathSchema.optional(),
          /** The approved prototype rendered in the same run (§7.5 step 5). */
          reference: RelPathSchema.optional(),
          /** Hash of the sources the render depends on: the render cache key (§7.5). */
          source_hash: Sha256HexSchema,
          detail: z.string().min(1).max(500).optional(),
        }),
      )
      .default([]),
    axe: z
      .array(
        z.strictObject({
          key: VisualRenderKeySchema,
          violations: z.array(AxeItemSchema).default([]),
          /** Needs review: goes to the vision judge or the human as unchecked, never a pass. */
          incomplete: z.array(AxeItemSchema).default([]),
        }),
      )
      .default([]),
    computed_style: z
      .array(
        z.strictObject({
          key: VisualRenderKeySchema,
          selector: z.string().min(1).max(300),
          property: z.string().min(1).max(64),
          value: z.string().min(1).max(200),
          nearest_token: z.string().min(1).max(200).nullable(),
          delta: z.number().nonnegative(),
        }),
      )
      .default([]),
    diffs: z
      .array(
        z.strictObject({
          key: VisualRenderKeySchema,
          region: z.string().min(1).max(100),
          mismatch_px: z.int().nonnegative(),
          ratio_pct: z.number().min(0).max(100),
          budget_pct: z.number().min(0).max(100),
          /** Different dimensions are a layout finding, not a pixel diff. */
          dimension_mismatch: z.boolean().default(false),
          diff_image: RelPathSchema.optional(),
        }),
      )
      .default([]),
    /** Every finding of the step (axe, token lint, styles, layout, detector), as triage sees them. */
    findings: z.array(ToolFindingSchema).default([]),
    written_at: IsoDateTimeSchema,
  })
  .superRefine((report, ctx) => {
    if ((report.status === "skipped") !== (report.skipped_reason !== undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["skipped_reason"],
        message: "a skipped visual step, and only a skipped one, carries skipped_reason",
      });
    }
    const unreached = report.renders.some((r) => r.status !== "rendered");
    const incomplete = report.axe.some((a) => a.incomplete.length > 0);
    if (report.status === "pass" && (unreached || incomplete)) {
      ctx.addIssue({
        code: "custom",
        path: ["status"],
        message: "unreached renders and axe incomplete items never pass (§7.5)",
      });
    }
  });
export type VisualReport = z.infer<typeof VisualReportSchema>;
export type VisualReportInput = z.input<typeof VisualReportSchema>;

/** `GateReport.visual`: the step's outcome, counts, findings and the path of its full report. */
export const VisualSummarySchema = z
  .strictObject({
    status: VisualStatusSchema,
    report: RelPathSchema.nullable(),
    skipped_reason: z.string().min(1).max(500).optional(),
    counts: z.strictObject({
      renders: z.int().nonnegative(),
      unreached: z.int().nonnegative(),
      axe_violations: z.int().nonnegative(),
      axe_incomplete: z.int().nonnegative(),
      style_mismatches: z.int().nonnegative(),
      diffs_over_budget: z.int().nonnegative(),
      token_lint: z.int().nonnegative(),
      detector: z.int().nonnegative(),
    }),
    findings: z.array(ToolFindingSchema).default([]),
  })
  .refine((v) => (v.status === "skipped") === (v.skipped_reason !== undefined), {
    message: "a skipped visual step, and only a skipped one, carries skipped_reason",
    path: ["skipped_reason"],
  });
export type VisualSummary = z.infer<typeof VisualSummarySchema>;

/**
 * `GateRunRequest.visual`: run the visual step for these screens (`screens.yaml` ids; empty = all
 * of them, the full matrix of Final Review step 5). Engine core sends it for UI tasks with the
 * screens whose `reqs` the task covers.
 */
export const VisualRequestSchema = z.strictObject({
  screens: z.array(SlugSchema).default([]),
});
export type VisualRequest = z.infer<typeof VisualRequestSchema>;

// ------------------------------------------------------------------ browser

/** The browser store under the VTC home (`~/.vtc/browsers/`, `PLAYWRIGHT_BROWSERS_PATH`). */
export const BROWSERS_DIR = "browsers";
/** The pin `vtc doctor --install-browser` writes, relative to the VTC home. */
export const BROWSER_PIN_FILE = "browsers/pin.json";
/**
 * The doctor-installed store's packages, relative to the VTC home (spine §5 reading 121):
 * `playwright-core`, `axe-core`, `pixelmatch` and `pngjs`, installed npm-style at
 * `browsers/node_modules/<name>`, each verified by its npm `integrity`. New in 4.6.0.
 */
export const BROWSER_STORE_NODE_MODULES = "browsers/node_modules";
/**
 * Per-repo pins of a project's own Playwright browser, relative to the VTC home:
 * `browsers/projects/<engineRepoKey>/<sha of the executable path>.json` (`BrowserPin`,
 * `source: project`). New in 4.6.0.
 */
export const PROJECT_BROWSER_PINS_DIR = "browsers/projects";
/**
 * The visual step's report (`VisualReport`), relative to a gate run's evidence directory;
 * `GateReport.visual.report` names the full path. New in 4.6.0.
 */
export const VISUAL_REPORT_FILE = "visual/report.json";

/**
 * The browser the visual step may run (AD-24 rule 3): the executable's SHA-256 is re-verified
 * before every run, like `ScannerPin.binary_sha256`; a mismatch is gate infrastructure (`error`).
 * `source: project` = the project's own Playwright browser (pinned on first use);
 * `source: vtc` = installed by `vtc doctor --install-browser` from a `playwright-core` tarball
 * verified by its npm `integrity`.
 */
export const BrowserPinSchema = z.strictObject({
  v: z.literal(1),
  source: z.enum(["project", "vtc"]),
  name: z.string().min(1).max(100),
  version: z.string().min(1).max(64),
  playwright_core_version: z.string().min(1).max(64),
  /** npm `dist.integrity` of the `playwright-core` tarball (`source: vtc` only). */
  package_integrity: z
    .string()
    .regex(/^sha512-[A-Za-z0-9+/]+={0,2}$/)
    .optional(),
  /** Absolute path of the browser executable. */
  executable: z.string().min(1).max(4096),
  executable_sha256: Sha256HexSchema,
  installed_at: IsoDateTimeSchema,
});
export type BrowserPin = z.infer<typeof BrowserPinSchema>;

// ------------------------------------------------------------------- novelty

/** The design library under the VTC home (`~/.vtc/design-library/<scope>/`, per client, §9.1). */
export const DESIGN_LIBRARY_DIR = "design-library";

/**
 * One chosen direction in the design library (§9.1 step 6), compared by a perceptual hash of the
 * first viewport and a token vector (OKLCH palette, type pair, radius, density). v1 uses no ML
 * embedding (spine §5 reading 107).
 */
export const DesignLibraryEntrySchema = z.strictObject({
  v: z.literal(1),
  id: SlugSchema,
  /** `engineRepoKey` of the project that chose it. */
  project_key: z.string().min(1).max(64),
  direction: SlugSchema,
  /** 64-bit dHash of the first viewport, hex. */
  phash: z.string().regex(/^[a-f0-9]{16}$/),
  token_vector: z.array(z.number()).min(1).max(64),
  chosen_at: IsoDateTimeSchema,
});
export type DesignLibraryEntry = z.infer<typeof DesignLibraryEntrySchema>;

/** The novelty check of one direction (§9.1 step 4), written next to its prototype. */
export const NoveltyReportSchema = z.strictObject({
  v: z.literal(1),
  direction: SlugSchema,
  phash: z.string().regex(/^[a-f0-9]{16}$/),
  token_vector: z.array(z.number()).min(1).max(64),
  nearest: z
    .array(
      z.strictObject({
        entry: SlugSchema,
        /** Hamming distance of the perceptual hashes (0–64). */
        phash_distance: z.int().min(0).max(64),
        token_distance: z.number().nonnegative(),
      }),
    )
    .max(10)
    .default([]),
  thresholds: z.strictObject({
    phash_distance: z.int().min(0).max(64),
    token_distance: z.number().nonnegative(),
  }),
  /** `too_similar` only when both distances are under their thresholds. */
  verdict: z.enum(["novel", "too_similar", "unchecked"]),
});
export type NoveltyReport = z.infer<typeof NoveltyReportSchema>;
