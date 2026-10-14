/**
 * The human side of Lookback's pins (spine AD-21 rule 3, §5 reading 103; owner: cli+binary team).
 * `~/.vtc/lookback/pins.yaml` (`LOOKBACK_HOME.pinsFile`, `LookbackPins`) is user-level, outside
 * every repo, keyed by `engineRepoKey`. Only these gestures move a pointer forward; the engine may
 * only roll a canary back (`auto_rollback`). Every gesture is appended to `history` with
 * `by: human`.
 *
 * - `approve <version>`: with no canary for the target, starts one (candidate vs. the current
 *   pin, or the version's parent) once the version's replay result says `improve` (AD-21 rule 6);
 *   with that version already the canary's candidate, promotes it to the pin.
 * - `pin <version>`: pins a version outright (ends any canary for the target).
 * - `rollback`: ends the target's canary (back to its baseline), or else moves the pin back to
 *   the version it replaced (no earlier version: the compiled default).
 *
 * Pure planning ({@link planGesture}) is separate from the file IO, which writes atomically
 * (temporary file and rename, never through a link) under a lock file.
 */
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { core } from "@vtc/engine";
import {
  LOOKBACK_HOME,
  LookbackPinsSchema,
  parsePersisted,
  PromptVersionFrontmatterSchema,
  ReplayResultSchema,
  RelPathSchema,
  type HostId,
  type LookbackPins,
  type PromptVersionFrontmatter,
} from "@vtc/shared";

export type Gesture = "approve" | "pin" | "rollback";

/** Which prompt a gesture moves: one role (and mode) on one host. */
export interface PinTarget {
  readonly role: string;
  readonly mode?: string | undefined;
  readonly host: HostId;
}

type Project = LookbackPins["projects"][string];
type HistoryEntry = LookbackPins["history"][number];

const sameTarget = (a: PinTarget, b: PinTarget): boolean =>
  a.role === b.role && a.host === b.host && (a.mode ?? null) === (b.mode ?? null);

const targetOf = (t: PinTarget): PinTarget => ({
  role: t.role,
  ...(t.mode === undefined ? {} : { mode: t.mode }),
  host: t.host,
});

export const describeTarget = (t: PinTarget): string =>
  `${t.role}${t.mode === undefined ? "" : `-${t.mode}`} on ${t.host}`;

const short = (sha: string | null): string =>
  sha === null ? "the compiled default" : sha.slice(0, 8);

// ------------------------------------------------------------------- versions

/** `prompts/<role>[-<mode>]/<host>` under the VTC home. */
export const promptVersionsDir = (vtcHome: string, t: PinTarget): string =>
  join(
    vtcHome,
    LOOKBACK_HOME.promptsDir,
    `${t.role}${t.mode === undefined ? "" : `-${t.mode}`}`,
    t.host,
  );

/** The frontmatter of a version file (`---` YAML `---`), or why it cannot be read. */
export const readVersionFrontmatter = (path: string): PromptVersionFrontmatter => {
  const text = readFileSync(path, "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(text);
  if (match?.[1] === undefined) throw new Error(`${path} has no frontmatter`);
  const parsed = parsePersisted(PromptVersionFrontmatterSchema, core.parseYaml(match[1]));
  if (!parsed.success)
    throw new Error(`${path}: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  return parsed.data;
};

/**
 * The immutable version `ref` (a full SHA-256 or at least its first 8 hex) of `target`, from
 * `prompts/<role>[-<mode>]/<host>/<sha8>.md`; throws when it does not exist or names another
 * target.
 */
export const findPromptVersion = (
  vtcHome: string,
  target: PinTarget,
  ref: string,
): PromptVersionFrontmatter => {
  if (!/^[0-9a-f]{8,64}$/.test(ref))
    throw new Error(`a version is a SHA-256 or its first 8+ hex characters, got ${ref}`);
  const dir = promptVersionsDir(vtcHome, target);
  const path = join(dir, `${ref.slice(0, 8)}.md`);
  if (statSync(path, { throwIfNoEntry: false })?.isFile() !== true) {
    const known = (() => {
      try {
        return readdirSync(dir).filter((n) => n.endsWith(".md"));
      } catch {
        return [];
      }
    })();
    throw new Error(
      `no version ${ref} of ${describeTarget(target)} in ${dir}${known.length === 0 ? "" : ` (there: ${known.map((n) => n.slice(0, 8)).join(", ")})`}`,
    );
  }
  const front = readVersionFrontmatter(path);
  const v = front.version;
  if (!v.effective_sha256.startsWith(ref) || !sameTarget(v, target))
    throw new Error(`${path} is not version ${ref} of ${describeTarget(target)}`);
  return front;
};

// ------------------------------------------------------------------ planning

export type GesturePlan =
  | {
      readonly ok: true;
      readonly pins: LookbackPins;
      /** What the human is asked to confirm. */
      readonly summary: string;
    }
  | { readonly ok: false; readonly reason: string };

export interface GestureRequest {
  readonly gesture: Gesture;
  readonly repoKey: string;
  readonly target: PinTarget;
  /** The version's frontmatter (`approve`, `pin`). */
  readonly version?: PromptVersionFrontmatter;
  /** Reads the version's replay result for `approve` (relative to the project root). */
  readonly replay?: (relPath: string) => unknown;
  readonly reason: string;
  readonly now: Date;
}

const emptyProject = (): Project => ({ pins: [], canaries: [] });

/** Pure: the pins after a human gesture, or why it cannot be made. */
export const planGesture = (pins: LookbackPins, request: GestureRequest): GesturePlan => {
  const { target, repoKey } = request;
  const project = pins.projects[repoKey] ?? emptyProject();
  const pin = project.pins.find((p) => sameTarget(p, target));
  const canary = project.canaries.find((c) => sameTarget(c, target));
  const current = pin?.effective_sha256 ?? null;
  const at = request.now.toISOString();
  const history = (gesture: HistoryEntry["gesture"], from: string | null, to: string | null) => ({
    ...targetOf(target),
    at,
    repo_key: repoKey,
    gesture,
    from,
    to,
    by: "human" as const,
    reason: request.reason,
  });
  const withProject = (next: Project, entry: HistoryEntry): LookbackPins =>
    LookbackPinsSchema.parse({
      ...pins,
      projects: { ...pins.projects, [repoKey]: next },
      history: [...pins.history, entry],
    });
  const otherPins = project.pins.filter((p) => !sameTarget(p, target));
  const otherCanaries = project.canaries.filter((c) => !sameTarget(c, target));
  const pinTo = (sha: string) => [...otherPins, { ...targetOf(target), effective_sha256: sha }];
  const name = describeTarget(target);

  switch (request.gesture) {
    case "pin": {
      const sha = request.version?.version.effective_sha256;
      if (sha === undefined) return { ok: false, reason: "pin needs a version" };
      if (current === sha && canary === undefined)
        return { ok: false, reason: `${name} is already pinned to ${short(sha)}` };
      return {
        ok: true,
        summary: `Pin ${name} to ${short(sha)} (now ${short(current)})${canary === undefined ? "" : `, ending the canary of ${short(canary.candidate)}`}.`,
        pins: withProject(
          { pins: pinTo(sha), canaries: otherCanaries },
          history("pin", current, sha),
        ),
      };
    }
    case "approve": {
      const front = request.version;
      if (front === undefined) return { ok: false, reason: "approve needs a version" };
      const sha = front.version.effective_sha256;
      if (canary !== undefined) {
        if (canary.candidate !== sha)
          return {
            ok: false,
            reason: `a canary of ${short(canary.candidate)} is running for ${name}: approve that version to promote it, or roll it back first`,
          };
        return {
          ok: true,
          summary: `Promote the canary ${short(sha)} of ${name} to its pin (now ${short(current ?? canary.baseline)}).`,
          pins: withProject(
            { pins: pinTo(sha), canaries: otherCanaries },
            history("promote", current ?? canary.baseline, sha),
          ),
        };
      }
      if (current === sha)
        return { ok: false, reason: `${name} is already pinned to ${short(sha)}` };
      const evaluation = front.changelog.evaluation;
      if (evaluation === null || request.replay === undefined)
        return {
          ok: false,
          reason: `version ${short(sha)} names no replay result, and a canary starts only after a replay that says improve (AD-21 rule 6); vtc lookback pin pins it without one`,
        };
      const replay = ReplayResultSchema.safeParse(request.replay(RelPathSchema.parse(evaluation)));
      if (!replay.success) return { ok: false, reason: `${evaluation} is not a replay result` };
      const r = replay.data;
      if (r.candidate !== sha || r.role !== target.role || r.host !== target.host)
        return { ok: false, reason: `${evaluation} is the replay of another version` };
      if (r.verdict !== "improve")
        return {
          ok: false,
          reason: `the replay of ${short(sha)} says ${r.verdict}, not improve (p = ${r.sign_test.p.toFixed(3)}, tokens ${r.tokens_delta_pct >= 0 ? "+" : ""}${String(r.tokens_delta_pct)}%): no canary`,
        };
      const baseline = current ?? front.parent;
      if (baseline === null)
        return {
          ok: false,
          reason: `${name} has no pin and version ${short(sha)} no parent, so a canary has no baseline: pin the version that runs now first`,
        };
      return {
        ok: true,
        summary: `Start a canary of ${short(sha)} for ${name} on this project: half its tasks (by hash) run it, half run ${short(baseline)}; the engine rolls it back on a trigger, and you promote it with vtc lookback approve again.`,
        pins: withProject(
          {
            pins: project.pins,
            canaries: [
              ...otherCanaries,
              {
                ...targetOf(target),
                candidate: sha,
                baseline,
                started_at: at,
                assignment: "task_hash_50",
              },
            ],
          },
          history("approve", baseline, sha),
        ),
      };
    }
    case "rollback": {
      if (canary !== undefined)
        return {
          ok: true,
          summary: `End the canary of ${short(canary.candidate)} for ${name}: every task runs ${short(canary.baseline)} again.`,
          pins: withProject(
            { pins: project.pins, canaries: otherCanaries },
            history("rollback", canary.candidate, canary.baseline),
          ),
        };
      if (pin === undefined)
        return {
          ok: false,
          reason: `${name} has no canary and no pin on this project: nothing to roll back`,
        };
      const replaced = [...pins.history]
        .reverse()
        .find(
          (h) =>
            h.repo_key === repoKey &&
            sameTarget(h, target) &&
            (h.gesture === "pin" || h.gesture === "promote") &&
            h.to === current,
        );
      const previous = replaced?.from ?? null;
      return {
        ok: true,
        summary: `Roll ${name} back from ${short(current)} to ${short(previous)}.`,
        pins: withProject(
          {
            pins: previous === null ? otherPins : pinTo(previous),
            canaries: project.canaries,
          },
          history("rollback", current, previous),
        ),
      };
    }
  }
};

// ----------------------------------------------------------------------- IO

export const pinsPath = (vtcHome: string): string => join(vtcHome, LOOKBACK_HOME.pinsFile);

const notALink = (path: string): void => {
  try {
    if (lstatSync(path).isSymbolicLink())
      throw new Error(`${path} is a symbolic link: refusing it`);
  } catch (error) {
    if ((error as { code?: unknown }).code !== "ENOENT") throw error;
  }
};

/** The pins file; `{ v: 1 }` when there is none. Throws when it does not parse (never overwritten). */
export const readPins = (vtcHome: string): LookbackPins => {
  const path = pinsPath(vtcHome);
  notALink(path);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return LookbackPinsSchema.parse({ v: 1 });
    throw error;
  }
  const parsed = parsePersisted(LookbackPinsSchema, core.parseYaml(text) ?? {});
  if (!parsed.success)
    throw new Error(
      `${path} does not parse (${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}); fix it by hand, nothing was changed`,
    );
  return parsed.data;
};

const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 5_000;

/**
 * Runs `fn` holding `lookback/pins.lock` (created exclusively; one older than a minute is
 * stale), so a gesture and the engine's `auto_rollback` never interleave a read and a write.
 */
export const withPinsLock = async <T>(vtcHome: string, fn: () => T): Promise<T> => {
  const dir = join(vtcHome, "lookback");
  notALink(vtcHome);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  notALink(dir);
  const lock = join(dir, "pins.lock");
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      closeSync(openSync(lock, "wx", 0o600));
      break;
    } catch (error) {
      if ((error as { code?: unknown }).code !== "EEXIST") throw error;
      try {
        if (Date.now() - lstatSync(lock).mtimeMs > LOCK_STALE_MS) rmSync(lock, { force: true });
      } catch {
        // removed meanwhile
      }
      if (Date.now() > deadline)
        throw new Error(`${lock} is held by another process; try again`, { cause: error });
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { force: true });
  }
};

/** Writes the pins atomically (validated, a temporary file, then a rename; never through a link). */
export const writePins = (vtcHome: string, pins: LookbackPins): string => {
  const path = pinsPath(vtcHome);
  notALink(path);
  const text = core.toYaml(LookbackPinsSchema.parse(pins));
  const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
  return path;
};
