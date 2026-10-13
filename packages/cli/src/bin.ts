#!/usr/bin/env node
import { main } from "./index.js";

process.exitCode = main(process.argv.slice(2), {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
});
