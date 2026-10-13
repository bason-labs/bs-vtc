#!/usr/bin/env node
import { createCommandContext, main, resolveVtcHome } from "./index.js";

const ctx = createCommandContext(
  {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  },
  process.cwd(),
  resolveVtcHome(process.env),
);

main(process.argv.slice(2), ctx).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`vtc: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 70;
  },
);
