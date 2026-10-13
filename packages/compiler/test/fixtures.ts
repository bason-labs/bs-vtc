/** A minimal, valid source tree for compile tests (paths relative to the repo root). */
import { PROMPT_MARKERS } from "@vtc/shared";
import { MODE_MARKERS, type SourceFile } from "../src/index.js";

const prompt = (locked: string, editable: string): string =>
  `${PROMPT_MARKERS.locked}\n${locked}\n${PROMPT_MARKERS.editable}\n${editable}\n`;

const models = `models:
  claude-code: { tier: mid, effort: medium }
  codex: { tier: mid, effort: high }`;

export const FIXTURE: Readonly<Record<string, string>> = {
  "roles/README.md": "# roles\n",
  "roles/NOTICE": "Portions forked from agency-agents (MIT).\n",
  "roles/_shared/result-protocol.md":
    "## Returning your result\n\nEvidence types: {{evidence_types}}.\nPack sections: {{task_pack_sections}}.\n",
  "roles/_shared/lens-reviewer.md": "## Lens reviewer\n\nCheck the diff against the checklist.\n",
  "roles/engineer/role.yaml": `id: engineer
version: 1.0.0
kind: core
mission: Implement one task in its worktree.
inputs: [task, spec]
output: { artifacts: [], verdicts: [] }
exits: [built, spec_conflict, blocked, out_of_scope_fault]
reviewer: qa
${models}
tools: { profile: code_sandboxed }
budget: { context_tokens: 60000 }
`,
  "roles/engineer/prompt.md": prompt("ENGINEER-LOCKED", "ENGINEER-EDITABLE"),
  "roles/engineer_frontend/role.yaml": `id: engineer_frontend
version: 1.0.0
kind: engineer_profile
discipline: frontend
mission: Implement one frontend task.
inputs: [task, spec, design_md]
output: { artifacts: [], verdicts: [] }
exits: [built, spec_conflict, blocked, out_of_scope_fault]
reviewer: qa
${models}
tools: { profile: code_sandboxed }
budget: { context_tokens: 60000 }
host_overrides:
  codex: { prompt_append: CODEX-ONLY-NOTE }
`,
  "roles/engineer_frontend/prompt.md": prompt("FRONTEND-LOCKED", "FRONTEND-EDITABLE"),
  "roles/qa/role.yaml": `id: qa
version: 2.1.0
kind: core
mission: Author acceptance tests, then judge test adequacy.
inputs: [spec, task]
output: { artifacts: [], verdicts: [] }
exits: [done, blocked]
reviewer: engine
${models}
tools: { profile: read_only }
budget: { context_tokens: 30000 }
modes:
  author:
    output: { artifacts: [acceptance_test], verdicts: [] }
    exits: [done, blocked, spec_conflict]
    tools: { profile: write_scoped, write_paths: ["tests/acceptance/**"] }
  judge:
    output: { artifacts: [], verdicts: [pass, fail, unknown] }
`,
  "roles/qa/prompt.md": prompt(
    [
      "QA-SHARED",
      MODE_MARKERS.start("author"),
      "AUTHOR-ONLY",
      MODE_MARKERS.end,
      MODE_MARKERS.start("judge"),
      "JUDGE-ONLY",
      MODE_MARKERS.end,
    ].join("\n"),
    "QA-EDITABLE",
  ),
  "roles/lens_db/role.yaml": `id: lens_db
version: 1.0.0
kind: lens
mission: Review a migration diff.
inputs: [diff, task]
output: { artifacts: [], verdicts: [pass, fail] }
exits: [done]
reviewer: engine
${models}
tools: { profile: read_only }
budget: { context_tokens: 20000 }
`,
  "roles/lens_db/prompt.md": prompt("LENS-DB-LOCKED", "LENS-DB-EDITABLE"),
  "skills/README.md": "# skills\n",
  "skills/lens-db/SKILL.md":
    "---\nname: lens-db\ndescription: DB migration review checklist.\n---\n\nLENS-DB-CHECKLIST\n",
  "skills/stack-react-next/SKILL.md":
    "---\nname: stack-react-next\ndescription: React and Next.js stack pack.\n---\n\nReact rules.\n",
  "skills/stack-react-next/references/testing.md": "Testing notes.\n",
  "skills/domain-desktop/SKILL.md":
    "---\nname: domain-desktop\ndescription: Desktop domain pack.\n---\n\nDesktop rules.\n",
  "plugins/README.md": "# plugins\n",
  "plugins/common/skills/lead/SKILL.md":
    "---\nname: lead\ndescription: The VTC Lead event loop.\n---\n\nCall next, dispatch, submit.\n",
  "plugins/common/commands/vtc.md":
    "---\ndescription: Drive VTC.\nargument-hint: start|status\n---\n\nUse the lead skill. $ARGUMENTS\n",
  "plugins/claude-code/.claude-plugin/plugin.json": '{ "name": "vtc", "version": "0.1.0" }\n',
  "plugins/claude-code/.mcp.json":
    '{ "mcpServers": { "vtc": { "command": "vtc", "args": ["engine", "--mcp", "--host", "claude-code"] } } }\n',
  "plugins/codex/plugin.json": '{ "name": "vtc", "version": "0.1.0" }\n',
};

export const fixtureFiles = (
  overrides: Readonly<Record<string, string | null>> = {},
): SourceFile[] => {
  const merged: Record<string, string | null> = { ...FIXTURE, ...overrides };
  return Object.entries(merged)
    .filter((entry): entry is [string, string] => entry[1] !== null)
    .map(([path, text]) => ({ path, text }));
};
