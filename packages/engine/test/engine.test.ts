import { describe, expect, it } from "vitest";
import { CONTRACTS_VERSION } from "@vtc/shared";
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
  it("loads the node:sqlite driver lazily", async () => {
    const open = await loadNodeSqliteStorage();
    const storage = open({ path: ":memory:" });
    expect(storage.driver).toBe("node:sqlite");
    storage.close();
  });
});

runStorageContract("node:sqlite", openNodeSqlite);
