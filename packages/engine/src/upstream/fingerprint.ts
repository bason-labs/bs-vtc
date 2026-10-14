/**
 * Fingerprints of automatic issues and PRs (AD-27 rule 3; D-bx; spine §5 reading 208): the first 16
 * hex characters of a SHA-256 over a kind's stable fields. Never a line number, an absolute path or
 * a version, so the same problem keeps its identity across machines, checkouts, builds and
 * releases. VTC stack frames are normalised to `package/file:function` (`VtcFrameSchema`).
 */
import { createHash } from "node:crypto";
import {
  AutoKindSchema,
  normalizeFindingPath,
  UPSTREAM_AUTO_KINDS,
  VtcFrameSchema,
  type AutoFingerprint,
  type PROJECT_AUTO_KINDS,
} from "@vtc/shared";

/** Bumped only when the canonical form changes; old fingerprints then stop matching. */
export const AUTO_FINGERPRINT_SCHEME = "vtc-auto-fp-v1";

type ProjectKind = (typeof PROJECT_AUTO_KINDS)[number];

/** The stable fields of each kind (spine §5 reading 208). */
export type FingerprintSubject =
  | {
      readonly kind: "defect";
      /** `adapter.parse_failure`, `incident.gate_infra`, `engine.stuck_loop`, … */
      readonly errorClass: string;
      readonly host?: string;
      readonly role?: string;
      /** Normalised VTC frames (`vtcFramesFromStack`); the top three count. */
      readonly frames: readonly string[];
    }
  | {
      readonly kind: "cost";
      readonly role: string;
      readonly metric: string;
      readonly baselinePromptSha: string;
    }
  | { readonly kind: "security"; readonly advisoryId: string; readonly package: string }
  | {
      readonly kind: "lookback" | "new_agent";
      /** The role (Lookback) or discipline (new agent) the proposal is for. */
      readonly subject: string;
      /** Not the proposal's hash: a newer proposal for the same subject supersedes the old PR. */
      readonly proposalKind: string;
    }
  | { readonly kind: "tool" | "config" | "capability"; readonly subject: string }
  | {
      readonly kind: ProjectKind;
      readonly ruleId: string;
      /** Project-relative, normalised; never absolute, never with a line number. */
      readonly path?: string;
      readonly taskKind?: string;
    };

const sha16 = (parts: readonly unknown[]): AutoFingerprint =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);

const projectPath = (path: string | undefined): string => {
  if (path === undefined) return "";
  const normalized = normalizeFindingPath(path);
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || normalized.startsWith("~")) {
    throw new Error("a project fingerprint path is project-relative");
  }
  if (/:\d+(?::\d+)?$/.test(normalized) || /#L\d+/.test(normalized)) {
    throw new Error("a project fingerprint path carries no line number");
  }
  return normalized;
};

/** Pure: the 16-hex fingerprint of `subject`. */
export const autoFingerprint = (subject: FingerprintSubject): AutoFingerprint => {
  const kind = AutoKindSchema.parse(subject.kind);
  const target = (UPSTREAM_AUTO_KINDS as readonly string[]).includes(kind) ? "upstream" : "project";
  const head = [AUTO_FINGERPRINT_SCHEME, kind, target];
  switch (subject.kind) {
    case "defect":
      return sha16([
        ...head,
        subject.errorClass.trim().toLowerCase(),
        subject.host ?? "",
        subject.role ?? "",
        subject.frames.filter((f) => VtcFrameSchema.safeParse(f).success).slice(0, 3),
      ]);
    case "cost":
      return sha16([
        ...head,
        subject.role,
        subject.metric,
        subject.baselinePromptSha.toLowerCase(),
      ]);
    case "security":
      return sha16([
        ...head,
        subject.advisoryId.trim().toUpperCase(),
        subject.package.trim().toLowerCase(),
      ]);
    case "lookback":
    case "new_agent":
      return sha16([...head, subject.subject, subject.proposalKind]);
    case "tool":
    case "config":
    case "capability":
      return sha16([...head, subject.subject.trim().toLowerCase()]);
    default:
      return sha16([...head, subject.ruleId, projectPath(subject.path), subject.taskKind ?? ""]);
  }
};

/** Where VTC's own sources sit inside a frame's path: a workspace package or the installed one. */
const VTC_PATH =
  /(?:^|\/)(?:packages\/(shared|engine|adapters|compiler|cli)|apps\/(dashboard)|node_modules\/@vtc\/(shared|engine|adapters|compiler|cli|dashboard))\/(?:src|dist)\/([A-Za-z0-9_./-]+?)\.(?:ts|tsx|js|jsx|mjs|cjs)$/;

const FRAME = /^\s*at\s+(?:async\s+)?(?:(.+?)\s+\()?(.+?):\d+:\d+\)?\s*$/;

const functionName = (raw: string | undefined): string => {
  const name = (raw ?? "<anonymous>").replace(/^new\s+/, "").replace(/\s+\[as [^\]]+\]$/, "");
  return /^[A-Za-z0-9_$.<>-]{1,120}$/.test(name) ? name : "<anonymous>";
};

/**
 * Pure: the top three VTC frames of a stack, as `package/file:function` (no line or column, no
 * absolute path, `src/` and `dist/` and the extension dropped, so a dev checkout and a release
 * agree). Frames outside VTC's packages (the project, Node, dependencies) are dropped. With
 * `vtcRoots`, only frames under one of those absolute directories count, so a project that is
 * itself a monorepo with `packages/engine/` cannot pass for VTC.
 */
export const vtcFramesFromStack = (stack: string, vtcRoots: readonly string[] = []): string[] => {
  const frames: string[] = [];
  for (const line of stack.split("\n")) {
    const match = FRAME.exec(line);
    if (match === null) continue;
    const path = (match[2] ?? "").replace(/\\/g, "/").replace(/^file:\/\//, "");
    if (
      vtcRoots.length > 0 &&
      !vtcRoots.some((root) => path.startsWith(`${root.replace(/\/+$/, "")}/`))
    ) {
      continue;
    }
    const where = VTC_PATH.exec(path);
    if (where === null) continue;
    const pkg = where[1] ?? where[2] ?? where[3] ?? "";
    const file = (where[4] ?? "").toLowerCase();
    const frame = `${pkg}/${file}:${functionName(match[1])}`;
    if (!VtcFrameSchema.safeParse(frame).success) continue;
    frames.push(frame);
    if (frames.length === 3) break;
  }
  return frames;
};
