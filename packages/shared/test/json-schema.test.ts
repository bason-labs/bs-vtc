import { describe, expect, it } from "vitest";
import {
  CONTRACT_SCHEMAS,
  CONTRACTS_VERSION,
  jsonSchemaFor,
  jsonSchemas,
  type ContractName,
} from "../src/index.js";

describe("jsonSchemas", () => {
  it("exports a JSON Schema for every contract", () => {
    const all = jsonSchemas();
    expect(Object.keys(all).sort()).toEqual(Object.keys(CONTRACT_SCHEMAS).sort());
    for (const [name, schema] of Object.entries(all)) {
      expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
      expect(schema.title).toBe(name);
      expect(() => JSON.stringify(schema)).not.toThrow();
    }
  });
  it("marks strict objects as closed and keeps enums", () => {
    const task = jsonSchemaFor("Task");
    expect(task.additionalProperties).toBe(false);
    const props = task.properties as Record<string, { enum?: string[] }>;
    expect(props.status?.enum).toContain("waiting_dependency");
    expect(props.risk?.enum).toEqual(["low", "med", "high"]);
  });
  it("input mode leaves defaulted fields optional; output mode requires them", () => {
    const input = jsonSchemaFor("ProjectConfig");
    const output = jsonSchemaFor("ProjectConfig", { io: "output" });
    expect(input.required).toEqual(["version"]);
    expect(output.required).toContain("merge_level");
  });
  it("represents the RoleResult exit union", () => {
    const schema = JSON.stringify(jsonSchemaFor("RoleResult" satisfies ContractName));
    for (const exit of ["built", "blocked", "spec_conflict", "out_of_scope_fault"]) {
      expect(schema).toContain(exit);
    }
  });
});

describe("frozen contracts (AD-3)", () => {
  it("match the committed JSON Schema snapshot", async () => {
    // Any contract change shows up here. Update deliberately with `vitest -u` and bump
    // CONTRACTS_VERSION (additive = MINOR, anything else = MAJOR). See docs/architecture/vtc-spine.md AD-3.
    const document = { contracts_version: CONTRACTS_VERSION, schemas: jsonSchemas() };
    await expect(`${JSON.stringify(document, null, 2)}\n`).toMatchFileSnapshot(
      "../schemas/contracts.json",
    );
  });
});
