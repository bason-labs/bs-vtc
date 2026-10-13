/**
 * Storage driver selection (AD-2 rule 3): `bun:sqlite` inside the Bun binary, `node:sqlite`
 * under Node (development and tests). The engine only ever sees the `StorageFactory`.
 */
import { loadBunSqliteStorage, loadNodeSqliteStorage } from "@vtc/engine";
import type { StorageFactory } from "@vtc/shared";

export type Runtime = "bun" | "node";

export const detectRuntime = (): Runtime => ("Bun" in globalThis ? "bun" : "node");

export const loadStorage = async (runtime: Runtime = detectRuntime()): Promise<StorageFactory> =>
  runtime === "bun" ? loadBunSqliteStorage() : loadNodeSqliteStorage();
