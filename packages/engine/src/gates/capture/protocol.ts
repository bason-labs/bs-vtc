/**
 * The protocol between the evidence recorder and its VTC-written runner script (`script.ts`;
 * AD-27 rule 6, D-ce): the same signed envelope as the visual runner (`visual/runner.ts`
 * `runSignedScript`): one JSON input, a per-run key the script deletes first, one result signed
 * with it that lists the SHA-256 of every file the script wrote. The result is parsed with these
 * schemas and bounded before anything reads it.
 */
import { EVIDENCE_LIMITS, EvidenceFileNameSchema } from "@vtc/shared";
import { z } from "zod";

/** Every recording is this size (research §2.3: without `size` Playwright scales to fit 800x800). */
export const EVIDENCE_VIDEO_SIZE = { width: 1280, height: 800 } as const;
/** The colour redacted regions are painted and masked with. */
export const EVIDENCE_MASK_COLOR = "#1f1f1f";
/**
 * Painted as solid blocks in every frame and masked on every screenshot, besides the request's
 * `redactSelectors`: the dashboard's evidence-mode tags (`data-vtc-redact`, `data-vtc-secret`)
 * and password inputs (research §3 layer 2).
 */
export const EVIDENCE_PAINT_DEFAULTS: readonly string[] = [
  "[data-vtc-redact]",
  "[data-vtc-secret]",
  "input[type=password]",
];
/** The scan's name for a `denyText` hit; pattern hits use the `SECRET_PATTERNS` kind. */
export const DENIED_TEXT_HIT = "denied_text";
/** Most characters one page scan may hand over; more is a failed shot (never a partial scan). */
export const MAX_SCAN_CHARS = 4_000_000;
/**
 * `denyText` values shorter than this (and holding no `/`) match only as a whole word, longer ones
 * as a substring, case-insensitively (spine §5 reading 212(12); the upstream module's
 * `DENY_SUBSTRING_MIN`), so a two-letter owner does not discard every page.
 */
export const DENY_SUBSTRING_MIN = 4;
/** The viewport height of a Visual QA screen (the visual step renders at this height too). */
export const UI_VIEWPORT_HEIGHT = 900;

/**
 * One step of a scripted flow as the runner gets it (D-ct; `FlowStep` of `.vtc/design/flows.yaml`):
 * a `goto` path already under the app URL's own path, a `fill` value already taken from the flows
 * file's named fixture.
 */
export type EvidenceRunnerFlowStep =
  | { readonly action: "goto"; readonly path: string }
  | { readonly action: "click"; readonly selector: string }
  | { readonly action: "fill"; readonly selector: string; readonly value: string }
  | { readonly action: "press"; readonly key: string }
  | { readonly action: "wait_for"; readonly selector: string }
  | { readonly action: "wait"; readonly ms: number };

/** How long a scripted recording stays on its last frame after its last step (within its time). */
export const FLOW_HOLD_MS = 1000;

export interface EvidenceRunnerShot {
  readonly name: string;
  /** Path and query on `origin`, starting with one `/`. */
  readonly path: string;
  readonly width: number;
  readonly height: number;
  /** Present: a recording of this many seconds; absent: a PNG screenshot. */
  readonly video_seconds?: number;
  readonly wait_for?: string;
  /** The page's `prefers-color-scheme` (a Visual QA screen's theme); absent: the browser's. */
  readonly color_scheme?: "light" | "dark";
  /**
   * A recording only: run these steps while it records, after `path` loaded, all within
   * `video_seconds` (D-ct, `BeforeAfterRequest.flow`). The page is scanned before every step and
   * at the end, as every recording is. Absent: the page is left idle for `video_seconds`.
   */
  readonly flow?: { readonly steps: readonly EvidenceRunnerFlowStep[] };
}

/**
 * The app server the runner starts in the gate sandbox before it captures (UI before/after, D-ct;
 * spine §5 reading 223): `gates.yml` `visual.app` of the commit's clean gate checkout, the same
 * way the visual step starts it (`visual/runner-script.ts`). `origin` is then the app URL's origin.
 */
export interface EvidenceRunnerApp {
  /** argv, run without a shell, detached in a process group of its own. */
  readonly command: readonly string[];
  /** Absolute working directory inside the commit's gate checkout. */
  readonly cwd: string;
  /** The app's loopback URL (`VisualApp.url`). */
  readonly url: string;
  readonly ready_timeout_ms: number;
}

export interface EvidenceRunnerInput {
  readonly v: 1;
  /** Absolute entry file of the browser store's `playwright-core` to import. */
  readonly playwright: string;
  /** Absolute browser executable, verified against its `BrowserPin`. */
  readonly executable: string;
  /** `http://127.0.0.1:<port>`: every request to another origin is aborted. */
  readonly origin: string;
  /**
   * The sandbox has a network namespace of its own (Linux `bwrap`): the script listens on the
   * origin's port inside it and relays each connection through `relay.sock` next to `out_dir`,
   * which the recorder forwards to the host's loopback port.
   */
  readonly relay: boolean;
  /** Absolute directory the script writes its files into. */
  readonly out_dir: string;
  readonly video_size: { readonly width: number; readonly height: number };
  readonly nav_timeout_ms: number;
  /** Painted as solid blocks by an init script (video and screenshots), and never scanned. */
  readonly paint: readonly string[];
  /** Masked on screenshots (`mask`): `paint` plus `visual.dynamic_regions`. */
  readonly mask: readonly string[];
  readonly mask_color: string;
  /** `SECRET_PATTERNS` as sources (the script cannot import `@vtc/shared`). */
  readonly patterns: readonly {
    readonly kind: string;
    readonly source: string;
    readonly flags: string;
  }[];
  /**
   * Values that must not be visible (case-insensitive): a substring match, or a whole-word one
   * below `deny_substring_min` characters ({@link DENY_SUBSTRING_MIN}).
   */
  readonly deny_text: readonly string[];
  readonly deny_substring_min: number;
  readonly max_scan_chars: number;
  readonly shots: readonly EvidenceRunnerShot[];
  /** Start this app server first and capture from it; absent or `null`: `origin` already serves. */
  readonly app?: EvidenceRunnerApp | null;
}

const FileNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,200}$/, "a plain file name in the runner's output directory");
const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, "a hex SHA-256");

export const EvidenceRunnerShotResultSchema = z.strictObject({
  name: EvidenceFileNameSchema,
  /** `discarded`: the redaction scan found something visible, so the file was never kept. */
  status: z.enum(["captured", "failed", "discarded"]),
  detail: z.string().max(500).optional(),
  /** What the scan found, as kinds only (never the matched text). */
  hits: z
    .array(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/))
    .max(40)
    .default([]),
  file: FileNameSchema.optional(),
  /**
   * A shot with a `flow`: `scripted` when every step ran within its time, `failed` when one did
   * not (the recording up to it is kept, scanned like any other).
   */
  flow: z.enum(["scripted", "failed"]).optional(),
});
export type EvidenceRunnerShotResult = z.infer<typeof EvidenceRunnerShotResultSchema>;

export const EvidenceRunnerResultSchema = z.strictObject({
  v: z.literal(1),
  browser: z
    .strictObject({ name: z.string().min(1).max(100), version: z.string().min(1).max(64) })
    .nullable()
    .default(null),
  shots: z.array(EvidenceRunnerShotResultSchema).max(EVIDENCE_LIMITS.maxFilesPerPr).default([]),
  /** A failure of the whole run (the browser did not start). */
  error: z.string().min(1).max(2000).optional(),
  /**
   * With an `app`: `served` once it answered and stayed up through every shot, `failed` when it
   * did not start, did not answer in time or exited during the capture.
   */
  app: z.enum(["served", "failed"]).optional(),
  files: z
    .record(FileNameSchema, Sha256Schema)
    .refine((f) => Object.keys(f).length <= EVIDENCE_LIMITS.maxFilesPerPr, "too many output files")
    .default({}),
});
export type EvidenceRunnerResult = z.infer<typeof EvidenceRunnerResultSchema>;
