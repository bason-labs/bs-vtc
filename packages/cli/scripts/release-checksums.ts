/**
 * `bun scripts/release-checksums.ts <dir>` (spine AD-26 rule 2; owner: cli+binary team): writes
 * `<dir>/SHA256SUMS` over every file in `<dir>`, sorted, LF, `sha256sum -c` compatible. The
 * release workflow runs it after signing (rule 3), on the directory it uploads.
 */
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checksumDirectory, SHA256SUMS } from "./release-lib.js";

export const writeChecksums = (dir: string): string => {
  const path = join(dir, SHA256SUMS);
  writeFileSync(path, checksumDirectory(dir));
  return path;
};

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (dir === undefined || process.argv.length !== 3) {
    console.error("usage: release-checksums.ts <dir>");
    process.exitCode = 64;
  } else {
    process.stdout.write(`wrote ${writeChecksums(resolve(dir))}\n`);
  }
}
