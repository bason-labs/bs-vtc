/**
 * The VTC stack frames of a crash (D-bv (2), D-by; spine §5 reading 216). When a background job
 * throws, the engine records an `incident.recorded` `crash`; beside its detail it keeps the `at …`
 * lines of the error's stack that lie in VTC's own sources, each path made relative to VTC's
 * source root, so the upstream module can locate the defect (`vtc_frames`) and an automatic run
 * on the bs-vtc checkout can fix it. The run log is git-tracked in the project's repo, so nothing
 * else of the stack is kept: not the message, not a frame of the project, Node or a dependency,
 * and not the absolute path VTC is installed at.
 */
import { fileURLToPath } from "node:url";

/** One `at` line: optional function, then the location (in parentheses or bare). */
const FRAME = /^(\s*at\s+(?:async\s+)?(?:.+?\s+\()?)(.+?)(:\d+:\d+\)?\s*)$/;

/** The virtual root of a Bun single-file binary (`bun build --compile`), POSIX and Windows. */
const BUN_ROOT = /^(?:\/\$bunfs\/root\/|[A-Za-z]:\/~BUN\/root\/)/;

/** The most frames (and characters) a crash keeps (`incident.recorded.stack` holds 4 000). */
const MAX_FRAMES = 20;
const MAX_CHARS = 4000;
const MAX_LINE = 300;

/**
 * Pure: the absolute directory VTC's own sources run from, given the URL of a module of
 * `packages/engine/{src,dist}/core/`; none for the single-file binary (its frames carry its
 * virtual root instead) or any other layout (fail closed: no absolute frame counts).
 */
export const vtcSourceRoots = (moduleUrl: string): string[] => {
  let path: string;
  try {
    path = fileURLToPath(moduleUrl).replace(/\\/g, "/");
  } catch {
    return [];
  }
  const match = /^(.+)\/packages\/engine\/(?:src|dist)\/core\/[^/]+$/.exec(path);
  return match?.[1] === undefined || BUN_ROOT.test(path) ? [] : [match[1]];
};

/** Where this engine's own sources run from (the bs-vtc checkout or the installed packages). */
export const VTC_SOURCE_ROOTS: readonly string[] = vtcSourceRoots(import.meta.url);

/**
 * Pure: the `at` lines of `stack` that lie in VTC's sources: under one of `roots` (rewritten
 * root-relative, `packages/<pkg>/…`) or in the single-file binary (kept as they are). Everything
 * else is dropped, the error's message first. `undefined` when no frame is VTC's.
 */
export const vtcStackFrames = (
  stack: string | undefined,
  roots: readonly string[],
): string | undefined => {
  if (stack === undefined) return undefined;
  const prefixes = roots.map((r) => `${r.replace(/\\/g, "/").replace(/\/+$/, "")}/`);
  const kept: string[] = [];
  let chars = 0;
  for (const line of stack.split("\n")) {
    const match = FRAME.exec(line);
    if (match === null) continue;
    const [, head = "", raw = "", tail = ""] = match;
    const path = raw.replace(/\\/g, "/").replace(/^file:\/\//, "");
    let rel: string | undefined;
    if (BUN_ROOT.test(path)) rel = path;
    else {
      const prefix = prefixes.find((p) => path.startsWith(p));
      if (prefix !== undefined) rel = path.slice(prefix.length);
    }
    if (rel === undefined || rel === "") continue;
    const frame = `${head}${rel}${tail}`.trimEnd().slice(0, MAX_LINE);
    if (chars + frame.length + 1 > MAX_CHARS) break;
    kept.push(frame);
    chars += frame.length + 1;
    if (kept.length === MAX_FRAMES) break;
  }
  return kept.length === 0 ? undefined : kept.join("\n");
};

/** The `incident.recorded` data of a background job that threw (with its VTC frames). */
export const crashIncident = (
  key: string,
  error: unknown,
  roots: readonly string[] = VTC_SOURCE_ROOTS,
): { kind: "crash"; detail: string; stack?: string } => {
  const stack = vtcStackFrames(error instanceof Error ? error.stack : undefined, roots);
  return {
    kind: "crash",
    detail:
      `background job ${key} failed: ${error instanceof Error ? error.message : String(error)}`.slice(
        0,
        2000,
      ),
    ...(stack === undefined ? {} : { stack }),
  };
};
