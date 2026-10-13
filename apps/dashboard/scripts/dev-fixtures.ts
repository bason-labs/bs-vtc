/**
 * Dashboard-owned dev fixtures (`apps/dashboard/dev-fixtures/`) for what the golden run does not
 * record: an evidence bundle and traceability report, the design `screens.yaml`, and a sample
 * prototype for the design review. `vtc/<path>` stands for the repo's `.vtc/<path>`. The dev
 * fixture server and the tests both serve them through the artifacts route, as `ArtifactContent`.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { isServableArtifactPath, type ArtifactContent } from "@vtc/shared";

export const DEV_FIXTURES_DIR = resolve(import.meta.dirname, "../dev-fixtures");

/** The sample prototype the dev fixture server serves on its own port (AD-5 rule 9). */
export const DEV_PROTOTYPE_DIR = join(DEV_FIXTURES_DIR, "prototype");

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".json": "application/json",
  ".jsonl": "application/x-ndjson",
  ".yaml": "application/yaml",
  ".md": "text/markdown",
  ".html": "text/html",
};

export const mediaTypeFor = (path: string): string =>
  MEDIA_TYPES[extname(path)] ?? "application/octet-stream";

/** The file holding `.vtc/<path>`, or `null` when the dev fixtures lack it. */
export const devArtifactFile = (path: string): string | null => {
  if (!isServableArtifactPath(path) || path.split("/").includes("..")) return null;
  const file = join(DEV_FIXTURES_DIR, "vtc", path.slice(".vtc/".length));
  return existsSync(file) && statSync(file).isFile() ? file : null;
};

/** `.vtc/<path>` as the artifacts route returns it (`ArtifactContent`), or `null`. */
export const artifactContent = (run: string, path: string, text: string): ArtifactContent => ({
  run,
  path,
  sha256: createHash("sha256").update(text).digest("hex"),
  size: Buffer.byteLength(text),
  media_type: mediaTypeFor(path),
  encoding: "utf8",
  content: text,
});

export const devArtifact = (run: string, path: string): ArtifactContent | null => {
  const file = devArtifactFile(path);
  return file === null ? null : artifactContent(run, path, readFileSync(file, "utf8"));
};
