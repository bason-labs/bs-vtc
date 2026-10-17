/**
 * `bun scripts/release-notes.ts --version <v> --repo <owner/repo> [--attested] [--signed]
 * [--changelog <CHANGELOG.md>] --out <file>` (H-16, spine §5 reading 240; owner: cli+binary
 * team): writes a GitHub Release's notes from the version's section of `CHANGELOG.md`
 * (`renderReleaseNotes`). The release workflow runs it in `verify` (so a version with no
 * CHANGELOG section fails before anything is built) and in `package`, which hands the notes to
 * `publish` apart from the assets. The Lead can run it locally for `gh release create
 * --notes-file` or `gh release edit --notes-file`.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { renderReleaseNotes } from "./release-lib.js";

const PRODUCT_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const CHANGELOG = join(PRODUCT_ROOT, "CHANGELOG.md");

export const writeReleaseNotes = (options: {
  readonly version: string;
  readonly repo: string;
  readonly out: string;
  readonly attested?: boolean;
  readonly signed?: boolean;
  readonly changelog?: string;
}): string => {
  const notes = renderReleaseNotes({
    changelog: readFileSync(options.changelog ?? CHANGELOG, "utf8"),
    version: options.version,
    repo: options.repo,
    attested: options.attested === true,
    signed: options.signed === true,
  });
  mkdirSync(dirname(options.out), { recursive: true });
  writeFileSync(options.out, notes);
  return options.out;
};

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      version: { type: "string" },
      repo: { type: "string" },
      out: { type: "string" },
      changelog: { type: "string" },
      attested: { type: "boolean" },
      signed: { type: "boolean" },
    },
    strict: true,
  });
  const { version, repo, out, changelog } = values;
  if (version === undefined || repo === undefined || out === undefined) {
    console.error(
      "usage: release-notes.ts --version <v> --repo <owner/repo> [--attested] [--signed] [--changelog <file>] --out <file>",
    );
    process.exitCode = 64;
  } else {
    const path = writeReleaseNotes({
      version,
      repo,
      out: resolve(out),
      attested: values.attested === true,
      signed: values.signed === true,
      ...(changelog === undefined ? {} : { changelog: resolve(changelog) }),
    });
    process.stdout.write(`wrote ${path}\n`);
  }
}
