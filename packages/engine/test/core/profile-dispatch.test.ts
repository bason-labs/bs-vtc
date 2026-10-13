/**
 * Engineer discipline profiles (§5.2a, spine §5 reading 38): an Engineer task whose discipline
 * has a compiled profile agent is spawned as that agent, the dispatched role stays `engineer`
 * (the family shares the Engineer's result contract), and `role.dispatched.prompt_sha` is the
 * profile's (§13). Other roles of the task keep their own agent.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentNameFor,
  PluginManifestSchema,
  promptShaFor,
  type PluginManifestInput,
} from "@vtc/shared";
import { createPluginCatalog } from "../../src/core/index.js";
import { cleanupDirs } from "../helpers/repo.js";
import {
  authorTests,
  build,
  CLAUDE,
  createHarness,
  draft,
  only,
  SPEC_ONE,
  throughPlan,
  type Harness,
} from "../helpers/engine-harness.js";

afterEach(cleanupDirs);

const BACKEND_PROMPT = "You build backends.";

const manifest: PluginManifestInput = {
  v: 1,
  host: "claude-code",
  plugin: "vtc",
  contracts_version: "4.1.0",
  agents: [
    {
      name: agentNameFor("engineer"),
      role: "engineer",
      mode: null,
      kind: "core",
      discipline: null,
      role_version: "1.0.0",
      file: "agents/vtc-engineer.md",
      prompt_sha256: promptShaFor("You are the Engineer."),
      tier: "mid",
      effort: "medium",
    },
    {
      name: agentNameFor("engineer_backend"),
      role: "engineer_backend",
      mode: null,
      kind: "engineer_profile",
      discipline: "backend",
      role_version: "1.0.0",
      file: "agents/vtc-engineer-backend.md",
      prompt_sha256: promptShaFor(BACKEND_PROMPT),
      tier: "mid",
      effort: "medium",
    },
  ],
  skills: [],
};

const plugins = createPluginCatalog({ "claude-code": PluginManifestSchema.parse(manifest) });

interface Line {
  type: string;
  role?: string;
  prompt_sha?: string;
  data: Record<string, unknown>;
}
const events = (h: Harness): Line[] =>
  readFileSync(join(h.repo, `.vtc/runs/${h.engine.status({}).run.id}/events.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Line);

describe("engineer discipline profiles (§5.2a, spine §5 reading 38)", () => {
  it("spawns the profile agent as role engineer, records its prompt SHA and accepts its result", async () => {
    const h = createHarness({ plugins });
    const actions = await throughPlan(h, [draft("T-1", { discipline: "backend" })], SPEC_ONE);
    const qa = only(actions, "qa");
    // the profile is the Engineer's: QA keeps its own agent and gets no profile
    expect(qa.agent).toBe("vtc-qa-author");
    expect(qa.prompt).not.toContain("engineer-backend");
    await authorTests(h, qa);
    const engineer = only((await h.engine.next({}, CLAUDE)).actions, "engineer");
    expect(engineer).toMatchObject({ role: "engineer", agent: "vtc-engineer-backend" });
    expect(engineer.prompt).toContain("you are vtc-engineer-backend");
    expect(engineer.prompt).toContain('role "engineer"');
    const dispatched = events(h).findLast(
      (e) => e.type === "role.dispatched" && e.role === "engineer",
    );
    expect(dispatched?.prompt_sha).toBe(promptShaFor(BACKEND_PROMPT));
    expect(dispatched?.data.agent).toBe("vtc-engineer-backend");
    const out = await build(h, engineer);
    expect(out.accepted).toBe(true);
    await h.release();
  });

  it("falls back to the base Engineer when the plugin has no profile for the discipline", async () => {
    const h = createHarness({ plugins });
    const actions = await throughPlan(h, [draft("T-1", { discipline: "data" })], SPEC_ONE);
    await authorTests(h, only(actions, "qa"));
    const engineer = only((await h.engine.next({}, CLAUDE)).actions, "engineer");
    expect(engineer).toMatchObject({ role: "engineer", agent: "vtc-engineer" });
    const dispatched = events(h).findLast(
      (e) => e.type === "role.dispatched" && e.role === "engineer",
    );
    expect(dispatched?.prompt_sha).toBe(promptShaFor("You are the Engineer."));
    await h.release();
  });
});
