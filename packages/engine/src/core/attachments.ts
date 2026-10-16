/**
 * Image attachments of a request (spine §5 reading 262, contracts 5.12.0). The owner's first run
 * started from a request whose text read "[Image #1][Image #2][Image #3]": the screenshots were
 * pasted into the Lead's session and never reached VTC. When the host gives the Lead their paths,
 * `start` and `change_request` take them (`attachments`); the engine copies each into the run
 * (`runAttachmentPath`, git-tracked with `request.md`), and the DISCOVER and SPECIFY packs list the
 * copies as `attachments` inputs.
 *
 * The engine reads a path a Lead names, so it takes images only: a regular file (never a symbolic
 * link), at most `ATTACHMENTS.maxBytes`, with an image extension and an image file signature. A
 * credential file, a key or the VTC token is none of those, so a Lead steered by injected text
 * cannot have one copied into the repo.
 */
import { lstatSync, readFileSync } from "node:fs";
import { extname, isAbsolute } from "node:path";
import { ATTACHMENTS, runAttachmentPath } from "@vtc/shared";
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
