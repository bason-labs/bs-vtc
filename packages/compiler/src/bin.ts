#!/usr/bin/env node
/**
 * `node dist/bin.js [--root <repo>] [--check]`: compiles roles/, skills/ and plugins/ into
 * dist/claude-plugin and dist/codex-plugin (AD-20 rule 4: part of `pnpm build`). `--check`
 * compiles without writing. Exits 1 and lists every error when the sources do not compile.
 */
import { resolve } from "node:path";
import { compilePlugins } from "./compile.js";
import { readSources, writeTargets } from "./io.js";
import type { CompileError } from "./types.js";

const args = process.argv.slice(2);
const rootIndex = args.indexOf("--root");
const root = resolve(rootIndex >= 0 ? (args[rootIndex + 1] ?? ".") : ".");
const read = readSources(root);
const result = compilePlugins(read.files);
const errors: readonly CompileError[] = [...read.errors, ...(result.ok ? [] : result.errors)];
if (!result.ok || errors.length > 0) {
  for (const error of errors) console.error(`${error.path}: ${error.message}`);
  console.error(`vtc compiler: ${String(errors.length)} error(s); nothing written.`);
  process.exitCode = 1;
} else if (args.includes("--check")) {
  process.stdout.write("vtc compiler: sources compile.\n");
} else {
  const written = writeTargets(result.output, root);
  process.stdout.write(`vtc compiler: wrote ${String(written.length)} files.\n`);
}
