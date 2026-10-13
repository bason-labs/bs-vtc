/**
 * Reading 49: the engine requests `network: "none"` for every role run. Plugin-only mode (AD-17)
 * launches no headless run, so no code asks an adapter for a sandbox today; this check makes the
 * helpers mandatory for whichever launcher comes first. Any engine or cli source that asks a host
 * adapter for a sandbox profile or launches a headless role run must build the request with
 * `roleSandboxRequest` and refuse an unsafe profile with `roleSandboxProblem`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const SOURCES = ["packages/engine/src", "packages/cli/src"];
/** An adapter call that needs a role sandbox (a method call, not a type or an interface member). */
const LAUNCH = /\.\s*(sandboxProfile|spawnRole|headlessCommand)\s*\(/;

const sourceFiles = (): { path: string; text: string }[] =>
  SOURCES.flatMap((dir) =>
    readdirSync(join(ROOT, dir), { recursive: true })
      .map(String)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))
      .map((f) => {
        const path = `${dir}/${f.split("\\").join("/")}`;
        return { path, text: readFileSync(join(ROOT, path), "utf8") };
      }),
  );

describe("role sandbox requests go through the engine's helpers (reading 49)", () => {
  it("finds the sources and the helpers", () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(20);
    const sandbox = files.find((f) => f.path === "packages/engine/src/core/sandbox.ts");
    expect(sandbox?.text).toContain("export const roleSandboxRequest");
    expect(sandbox?.text).toContain("export const roleSandboxProblem");
    // the pattern catches the calls it is meant to catch
    expect(LAUNCH.test("await adapter.sandboxProfile(request)")).toBe(true);
    expect(LAUNCH.test("deps.adapters[host]?.spawnRole({ ...request })")).toBe(true);
    expect(LAUNCH.test("sandboxProfile: () => profile")).toBe(false);
  });
  it("every launcher builds its request with roleSandboxRequest and checks roleSandboxProblem", () => {
    const offenders = sourceFiles()
      .filter((f) => LAUNCH.test(f.text))
      .filter(
        (f) => !/roleSandboxRequest\s*\(/.test(f.text) || !/roleSandboxProblem\s*\(/.test(f.text),
      )
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });
});
