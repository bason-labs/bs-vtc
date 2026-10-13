/**
 * Entry of the Storage contract test binary (AD-2 Check, spine §7): the engine's
 * `runStorageContract` suite, unchanged, on the `bun:sqlite` driver the cli selects inside a
 * `bun build --compile` binary. Built by `scripts/build-binary.ts --storage-contract` (with
 * `vitest` mapped to `vitest-shim.ts`) and run by `binary.test.ts`. Exits 1 on any failure.
 */
import { detectRuntime, loadStorage } from "../../src/storage.js";
import { runStorageContract } from "../../../engine/test/storage-contract.js";
import { runRegistered } from "./vitest-shim.js";

const runtime = detectRuntime();
runStorageContract(
  `${runtime === "bun" ? "bun:sqlite" : "node:sqlite"} in the binary`,
  await loadStorage(),
);
const failures = await runRegistered((line) => process.stdout.write(`${line}\n`));
process.stdout.write(`# runtime ${runtime}\n`);
process.exitCode = failures === 0 && runtime === "bun" ? 0 : 1;
