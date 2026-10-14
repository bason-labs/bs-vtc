/**
 * The protocol between the Gate Runner and the VTC-written visual runner script
 * (`runner-script.ts`, AD-24 rule 1): one JSON input file and one JSON result file in the
 * command's private temp directory. The result is untrusted (it comes out of a sandbox that ran
 * project code), so it is parsed with these schemas and bounded before anything reads it.
 */
import { z } from "zod";
import { VisualRenderKeySchema } from "@vtc/shared";

export const RUNNER_INPUT_FILE = "input.json";
export const RUNNER_RESULT_FILE = "result.json";
export const RUNNER_SCRIPT_FILE = "vtc-visual-runner.mjs";
export const RUNNER_OUT_DIR = "out";

/** The computed-style properties the runner collects (§7.5 step 4). */
export const STYLE_PROPERTIES = [
  "color",
  "background-color",
  "border-top-color",
  "font-family",
  "font-size",
  "border-radius",
  "padding",
  "margin",
  "gap",
  "box-shadow",
] as const;

export const RunnerJobSchema = z.strictObject({
  key: VisualRenderKeySchema,
  path: z.string().min(1).max(600),
  width: z.int().min(200).max(4000),
  theme: z.enum(["light", "dark"]),
});
export type RunnerJob = z.infer<typeof RunnerJobSchema>;

export interface RunnerInput {
  readonly v: 1;
  /** `probe`: only report the browser executable Playwright would use; `render`: the matrix. */
  readonly mode: "probe" | "render";
  /** Absolute directory of the `playwright-core` (or `playwright`) package to import. */
  readonly playwright: string;
  /** Absolute browser executable, verified against its `BrowserPin` (render mode). */
  readonly executable: string | null;
  /** Absolute `axe.min.js`, injected unmodified (reading 106); `null` when there is none. */
  readonly axe: string | null;
  /** Absolute module file of `pixelmatch`; `null` when there is none. */
  readonly pixelmatch: string | null;
  /** Absolute `.vtc/design/prototype/` of the checkout, served without a socket. */
  readonly prototype_root: string | null;
  /** The app server the implementation renders from; `null`: none configured. */
  readonly app: {
    readonly command: readonly string[];
    readonly cwd: string;
    readonly url: string;
    readonly ready_timeout_ms: number;
  } | null;
  /** Absolute directory the runner writes screenshots and diffs into. */
  readonly out_dir: string;
  /** ISO time the page clock is fixed at. */
  readonly fixed_time: string;
  readonly axe_tags: readonly string[];
  readonly include_best_practice: boolean;
  readonly pixel_threshold: number;
  readonly dynamic_regions: readonly string[];
  readonly style_properties: readonly string[];
  /** Most elements whose computed styles are collected per render. */
  readonly style_limit: number;
  readonly nav_timeout_ms: number;
  readonly jobs: readonly RunnerJob[];
}

const FileNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,200}$/, "a plain file name in the runner's output directory");

const AxeItemSchema = z.strictObject({
  rule: z.string().min(1).max(100),
  impact: z.enum(["minor", "moderate", "serious", "critical"]).nullable(),
  help: z.string().min(1).max(500),
  nodes: z.int().nonnegative(),
  targets: z.array(z.string().max(300)).max(5).default([]),
});
export type RunnerAxeItem = z.infer<typeof AxeItemSchema>;

const RenderStatusSchema = z.enum(["rendered", "unreached", "error"]);

export const RunnerRenderSchema = z.strictObject({
  key: VisualRenderKeySchema,
  status: RenderStatusSchema,
  detail: z.string().max(500).optional(),
  screenshot: FileNameSchema.optional(),
  reference: z
    .strictObject({
      status: RenderStatusSchema,
      detail: z.string().max(500).optional(),
      screenshot: FileNameSchema.optional(),
    })
    .optional(),
  axe: z
    .strictObject({
      violations: z.array(AxeItemSchema).max(200).default([]),
      incomplete: z.array(AxeItemSchema).max(200).default([]),
    })
    .nullable()
    .default(null),
  styles: z
    .array(
      z.strictObject({
        selector: z.string().min(1).max(300),
        property: z.string().min(1).max(64),
        value: z.string().min(1).max(200),
      }),
    )
    .max(5000)
    .default([]),
  diffs: z
    .array(
      z.strictObject({
        region: z.string().min(1).max(100),
        mismatch_px: z.int().nonnegative(),
        total_px: z.int().nonnegative(),
        dimension_mismatch: z.boolean().default(false),
        diff_image: FileNameSchema.optional(),
      }),
    )
    .max(100)
    .default([]),
});
export type RunnerRender = z.infer<typeof RunnerRenderSchema>;

export const RunnerResultSchema = z.strictObject({
  v: z.literal(1),
  /** Probe mode: the executable Playwright would launch. */
  executable: z.string().min(1).max(4096).optional(),
  browser: z
    .strictObject({ name: z.string().min(1).max(100), version: z.string().min(1).max(64) })
    .nullable()
    .default(null),
  renders: z.array(RunnerRenderSchema).max(2000).default([]),
  /** A failure of the whole run (the browser did not start, the app server never answered). */
  error: z.string().min(1).max(2000).optional(),
});
export type RunnerResult = z.infer<typeof RunnerResultSchema>;
