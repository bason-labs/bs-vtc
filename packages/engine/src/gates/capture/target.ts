/**
 * What one evidence capture runs against besides its request: the recorder's public `capture`
 * and each side of the UI before/after capture (D-ct) share this shape.
 */
import type { EvidenceCaptureResult } from "@vtc/shared";
import type { GateCommandJail } from "../sandbox.js";
import type { EvidenceRunnerShot } from "./protocol.js";

/**
 * What one capture runs against, besides its request (the before/after capture runs one per
 * commit, D-ct).
 */
export interface CaptureTarget {
  /**
   * The project's `visual.redact_selectors` and `visual.dynamic_regions`, read after the request
   * is checked; it throws when they are unknown, which fails every shot (fail closed).
   */
  readonly visual: () => {
    readonly redact: readonly string[];
    readonly dynamic: readonly string[];
  };
  /** Start this app server in the gate sandbox and capture from its origin. */
  readonly app?: {
    readonly command: readonly string[];
    /** Absolute working directory inside `checkout`. */
    readonly cwd: string;
    readonly url: string;
    readonly readyTimeoutMs: number;
    /** Absolute clean gate checkout of the commit. */
    readonly checkout: string;
  };
  /** Run in this jail and leave it open; absent: a jail of the capture's own. */
  readonly jail?: GateCommandJail | null;
  /** Bytes this capture may still return (default `EVIDENCE_LIMITS.maxBytesPerPr`). */
  readonly budgetBytes?: number;
  /** A screen's theme by shot name: the page's `prefers-color-scheme`. */
  readonly colorSchemes?: ReadonlyMap<string, "light" | "dark">;
  /** The steps a recording scripts, by shot name (a before/after side's flow, D-ct). */
  readonly flows?: ReadonlyMap<string, NonNullable<EvidenceRunnerShot["flow"]>>;
}

/** A capture's result, with an app whether it served, and how each scripted flow went. */
export type TargetCaptureResult = EvidenceCaptureResult & {
  readonly app?: "served" | "failed";
  /** By shot name, for each shot with a flow the runner reported on. */
  readonly flows?: ReadonlyMap<string, "scripted" | "failed">;
};
