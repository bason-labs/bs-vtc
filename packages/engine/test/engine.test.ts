import { describe, expect, expectTypeOf, it } from "vitest";
import {
  CONTRACTS_VERSION,
  type CreateGateRunner,
  type RunDaemon,
  type ServeSnapshot,
} from "@vtc/shared";
import * as engine from "../src/index.js";
import {
  ENGINE_CONTRACTS_VERSION,
  ENGINE_NAME,
  engineToolNames,
  loadNodeSqliteStorage,
} from "../src/index.js";
import { openNodeSqlite } from "../src/storage/node-sqlite.js";
import { runStorageContract } from "./storage-contract.js";

describe("@vtc/engine smoke", () => {
  it("builds against the shared contracts", () => {
    expect(ENGINE_NAME).toBe("vtc-engine");
    expect(ENGINE_CONTRACTS_VERSION).toBe(CONTRACTS_VERSION);
    expect(engineToolNames()).toEqual(
      expect.arrayContaining(["next", "submit", "status", "escalations", "answer"]),
    );
  });
  it("implements the frozen composition seam (AD-19)", () => {
    expectTypeOf(engine.runDaemon).toEqualTypeOf<RunDaemon>();
    expectTypeOf(engine.serveSnapshot).toEqualTypeOf<ServeSnapshot>();
    expectTypeOf(engine.gates.createGateRunner).toEqualTypeOf<CreateGateRunner>();
  });
  it("re-exports each module under its own namespace, so names cannot collide (AD-15)", () => {
    expect(
      Object.keys(engine)
        .filter((k) => typeof engine[k as keyof typeof engine] === "object")
        .sort(),
    ).toEqual(["core", "gates", "git", "http", "mcp"]);
    expect(typeof engine.core.openEventLog).toBe("function");
  });
  it("loads the node:sqlite driver lazily", async () => {
    const open = await loadNodeSqliteStorage();
    const storage = open({ path: ":memory:" });
    expect(storage.driver).toBe("node:sqlite");
    storage.close();
  });
});

runStorageContract("node:sqlite", openNodeSqlite);
