#!/usr/bin/env node
/** The `vtc` entry under Node (development): assets come from the product repo on disk. */
import { fileURLToPath } from "node:url";
import { configureRuntime, devRuntime, runProcess } from "./index.js";

configureRuntime(
  devRuntime(undefined, [process.execPath, ...process.execArgv, fileURLToPath(import.meta.url)]),
);

void runProcess(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
