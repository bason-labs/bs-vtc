/**
 * Image attachments of a request (spine §5 readings 262, 266; contracts 5.12.0). The owner's first
 * run started from a request whose text read "[Image #1][Image #2][Image #3]": the screenshots
 * were pasted into the Lead's session and never reached VTC. When the host gives the Lead their
 * paths, `start` and `change_request` take them (`attachments`); the engine copies each into
 * gitignored local state (`runAttachmentPath`, `.vtc/state/attachments/<run>/`): they are the
 * owner's private screenshots, never committed with the run, never sent upstream, never PR
 * evidence (reading 266). The DISCOVER and SPECIFY packs list every copy as an `attachments`
 * input; a change request's copies are also listed in the packs of the role that owns the changed
 * artifact ({@link ownedAttachments}). A role working in a worktree gets the copies it is given
 * there too, untracked ({@link placeAttachments}).
 *
 * The engine reads a path a Lead names, so it takes images only: a regular file (never a symbolic
 * link), at most `ATTACHMENTS.maxBytes`, with an image extension and an image file signature. A
 * credential file, a key or the VTC token is none of those, so a Lead steered by injected text
 * cannot have one copied into the repo.
 */
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { extname, isAbsolute, join } from "node:path";
import { ATTACHMENTS, PACK_INPUT_TYPES, runAttachmentPath, type TaskPackInput } from "@vtc/shared";
import { writeRepoFile } from "../git/index.js";
import { EngineError } from "./kernel.js";
import type { RunState } from "./state.js";

/** One attachment read and checked, ready to copy. */
export interface ReadAttachment {
  readonly source: string;
  readonly bytes: Uint8Array;
}

const startsWith = (bytes: Uint8Array, signature: readonly number[], at = 0): boolean =>
  signature.every((b, i) => bytes[at + i] === b);

const ascii = (bytes: Uint8Array, from: number, to: number): string =>
  String.fromCharCode(...bytes.subarray(from, to));

/** Whether the bytes start like an image of a type {@link ATTACHMENTS} allows. */
export const isImageBytes = (bytes: Uint8Array): boolean =>
  startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) || // PNG
  startsWith(bytes, [0xff, 0xd8, 0xff]) || // JPEG
  ascii(bytes, 0, 6) === "GIF87a" ||
  ascii(bytes, 0, 6) === "GIF89a" ||
  (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") ||
  (ascii(bytes, 4, 8) === "ftyp" &&
    /^(heic|heix|hevc|heim|heis|mif1|msf1)$/.test(ascii(bytes, 8, 12))) ||
  ascii(bytes, 0, 2) === "BM" ||
  startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || // TIFF, little-endian
  startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a]); // TIFF, big-endian

const refuse = (path: string, why: string): never => {
  throw new EngineError(
    "invalid",
    `attachment ${path} ${why}; attach image files (${ATTACHMENTS.extensions.join(", ")}, at most ${String(ATTACHMENTS.maxBytes / 1024 / 1024)} MB each)`,
  );
};

/** Where the engine keeps the copies (`runAttachmentPath`), gitignored local state. */
export const ATTACHMENTS_DIR = ".vtc/state/attachments";

/** Reads and checks every attachment, before anything is written. Throws `invalid`. */
export const readAttachments = (paths: readonly string[] | undefined): ReadAttachment[] => {
  if (paths === undefined) return [];
  if (paths.length > ATTACHMENTS.max)
    throw new EngineError("invalid", `at most ${String(ATTACHMENTS.max)} attachments per call`);
  return paths.map((source) => {
    if (!isAbsolute(source)) refuse(source, "is not an absolute path");
    const extension = extname(source).slice(1).toLowerCase();
    if (!(ATTACHMENTS.extensions as readonly string[]).includes(extension))
      refuse(source, "is not an image file");
    let size: number;
    try {
      const stat = lstatSync(source);
      if (!stat.isFile()) refuse(source, "is not a regular file");
      size = stat.size;
    } catch (error) {
      if (error instanceof EngineError) throw error;
      return refuse(source, "cannot be read");
    }
    if (size > ATTACHMENTS.maxBytes) refuse(source, "is too large");
    const bytes = new Uint8Array(readFileSync(source));
    if (!isImageBytes(bytes)) refuse(source, "is not an image");
    return { source, bytes };
  });
};

/** The attachments a run already has (its start's and its change requests'), in order. */
export const runAttachments = (state: RunState): string[] =>
  state.events.flatMap((e) =>
    e.type === "run.started" || e.type === "change_request.opened"
      ? ((e.data as { attachments?: readonly string[] }).attachments ?? [])
      : [],
  );

/**
 * Copies checked attachments into the run, numbered after the run's earlier ones, and returns
 * their repo-relative paths (for the event that records them).
 */
export const copyAttachments = (
  repoRoot: string,
  run: string,
  attachments: readonly ReadAttachment[],
  already = 0,
): string[] =>
  attachments.map((a, i) => {
    const path = runAttachmentPath(run, already + i + 1, a.source);
    writeRepoFile(repoRoot, path, a.bytes);
    return path;
  });

/** The role that owns each artifact a change request may change (an interface contract: its task). */
const OWNER_ROLE: Readonly<Record<string, string>> = {
  spec: "ba",
  architecture: "architect",
  design: "designer",
};

/**
 * The attachments of the run's change requests that a dispatch of `role` (on `task`) owns: those
 * on the spec for the BA, the architecture for the Architect, the design for the Designer, and an
 * interface contract for the provider task's own dispatches. A change request the human rejected
 * gives none.
 */
export const ownedAttachments = (
  state: RunState,
  role: string,
  task: string | undefined,
): string[] =>
  state.events.flatMap((e) => {
    if (e.type !== "change_request.opened") return [];
    const data = e.data as {
      escalation: string;
      artifact: string;
      task?: string;
      attachments?: readonly string[];
    };
    if (state.changeRequests.get(data.escalation)?.decided === "rejected") return [];
    const owns =
      data.artifact === "interface_contract"
        ? task !== undefined && data.task === task
        : OWNER_ROLE[data.artifact] === role;
    return owns ? [...(data.attachments ?? [])] : [];
  });

/**
 * Copies the attachments a pack lists into the worktree the role works in (`cwd`), at the same
 * repo-relative path, with a `.gitignore` of `*` beside them: whatever the repo's own ignores, a
 * worktree snapshot never commits them (reading 266). A copy that is gone (or is not a regular
 * file) is skipped; a write the worktree refuses (a planted link) never fails the dispatch.
 */
export const placeAttachments = (
  repoRoot: string,
  cwd: string,
  inputs: NonNullable<TaskPackInput["inputs"]>,
): void => {
  const paths = inputs.filter((i) => i.type === PACK_INPUT_TYPES.attachments).map((i) => i.path);
  if (paths.length === 0 || cwd === repoRoot) return;
  try {
    // writeRepoFile never writes through a link: one a role planted in its worktree stops it
    writeRepoFile(cwd, `${ATTACHMENTS_DIR}/.gitignore`, "*\n");
    for (const path of paths) {
      const source = join(repoRoot, path);
      if (!existsSync(source) || !lstatSync(source).isFile()) continue;
      writeRepoFile(cwd, path, readFileSync(source));
    }
  } catch {
    // the pack still names them; the role reports what it could not read
  }
};
