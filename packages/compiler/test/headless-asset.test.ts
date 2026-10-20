/**
 * The headless instructions asset (contracts 5.12.0, spine §5 reading 258). On the owner's first
 * run a Codex BA, run by `codex exec` (which loads no compiled agent), got its role's locked core
 * only: never its contract nor the result protocol, so it returned a task id on a task-less
 * dispatch and an artifact type its contract does not declare. Every agent now ships its compiled
 * locked part as `vtc/prompts/<agent>/headless.md`, hashed in the manifest.
 */
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  HOST_IDS,
  PLUGIN_MANIFEST_ASSET,
  PluginManifestSchema,
  sha256Hex,
  type HostId,
  type PluginManifest,
} from "@vtc/shared";
import { compilePlugins, readSources, rolePromptAssetPath } from "../src/index.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const compiled = compilePlugins(readSources(ROOT).files);
if (!compiled.ok) throw new Error(compiled.errors.map((e) => e.message).join("\n"));
const targets = compiled.output.targets;
const emitted = (host: HostId, path: string): string | undefined =>
  targets[host].find((f) => f.path === path)?.text;
const manifest = (host: HostId): PluginManifest =>
  PluginManifestSchema.parse(JSON.parse(emitted(host, PLUGIN_MANIFEST_ASSET) ?? "{}"));

describe("headless instructions asset", () => {
  it.each(HOST_IDS)("on %s every agent ships one, hashed in the manifest", (host) => {
    const agents = manifest(host).agents;
    expect(agents.length).toBeGreaterThan(10);
    for (const agent of agents) {
      const text = emitted(host, rolePromptAssetPath(agent.name, "headless"));
      expect(text, agent.name).toBeDefined();
      expect(agent.headless_sha256, agent.name).toBe(sha256Hex(text ?? ""));
    }
  });

  it.each(HOST_IDS)(
    "on %s the BA's carries its core, its contract and the result protocol, never its editable section",
    (host) => {
      const text = emitted(host, rolePromptAssetPath("vtc-ba", "headless")) ?? "";
      const locked = emitted(host, rolePromptAssetPath("vtc-ba", "locked")) ?? "";
      const editable = emitted(host, rolePromptAssetPath("vtc-ba", "editable")) ?? "";
      expect(text.startsWith(locked.trim().split("\n")[0] ?? "")).toBe(true);
      expect(text).toContain("## Working and returning your result");
      // the contract names the output artifact type the engine accepts
      expect(text).toMatch(/\bspec\b/);
      expect(text).not.toContain(editable.trim());
    },
  );
});

// owner-run fault 6: a Codex BA (write_scoped) has no file tools, so its prompt must say how to read
it("on codex the BA's headless prompt tells it to read with read-only shell commands", () => {
  const text = emitted("codex", rolePromptAssetPath("vtc-ba", "headless")) ?? "";
  expect(text).toContain("read and search files with read-only shell commands");
});

describe("the Lead passes a request's images (spine §5 reading 262)", () => {
  const lead = readSources(ROOT).files.find(
    (f) => f.path === "plugins/common/skills/lead/SKILL.md",
  )?.text;

  it("passes their paths as attachments, or tells the human they were not passed", () => {
    const starting = /^## Starting a run\n([\s\S]*?)\n## /m.exec(lead ?? "")?.[1] ?? "";
    expect(starting).toContain("`attachments`");
    expect(starting).toContain("did not receive the images");
    const change = /^## Change requests\n([\s\S]*?)\n## /m.exec(lead ?? "")?.[1] ?? "";
    expect(change).toContain("`attachments`");
  });
});
