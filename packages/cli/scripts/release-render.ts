/**
 * `bun scripts/release-render.ts --version <v> --repo <owner/repo> --sums <SHA256SUMS> --out <dir>`
 * (spine AD-26 rule 2; owner: cli+binary team): renders the release's Homebrew formula
 * (`vtc.rb`, from `packaging/homebrew/vtc.rb.tmpl`, with each platform's SHA-256) and its
 * installer (`install.sh`, from `packaging/install.sh`, defaulting to this repo and version) into
 * `<dir>`. The workflow runs it before the checksums, so both are listed in `SHA256SUMS` too.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { renderFormula, renderInstaller } from "./release-lib.js";

const PRODUCT_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const FORMULA_TEMPLATE = join(PRODUCT_ROOT, "packaging/homebrew/vtc.rb.tmpl");
export const INSTALLER = join(PRODUCT_ROOT, "packaging/install.sh");

export const renderReleaseFiles = (options: {
  readonly version: string;
  readonly repo: string;
  readonly sums: string;
  readonly out: string;
}): string[] => {
  const formula = join(options.out, "vtc.rb");
  writeFileSync(
    formula,
    renderFormula(readFileSync(FORMULA_TEMPLATE, "utf8"), {
      version: options.version,
      repo: options.repo,
      sums: readFileSync(options.sums, "utf8"),
    }),
  );
  const installer = join(options.out, "install.sh");
  writeFileSync(
    installer,
    renderInstaller(readFileSync(INSTALLER, "utf8"), {
      version: options.version,
      repo: options.repo,
    }),
    { mode: 0o755 },
  );
  return [formula, installer];
};

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      version: { type: "string" },
      repo: { type: "string" },
      sums: { type: "string" },
      out: { type: "string" },
    },
    strict: true,
  });
  const { version, repo, sums, out } = values;
  if (version === undefined || repo === undefined || sums === undefined || out === undefined) {
    console.error(
      "usage: release-render.ts --version <v> --repo <owner/repo> --sums <SHA256SUMS> --out <dir>",
    );
    process.exitCode = 64;
  } else {
    for (const path of renderReleaseFiles({
      version,
      repo,
      sums: resolve(sums),
      out: resolve(out),
    }))
      process.stdout.write(`wrote ${path}\n`);
  }
}
