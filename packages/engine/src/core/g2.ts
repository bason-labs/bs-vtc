/**
 * What G2 shows and what its approval must carry (spec §8.2, §8.6, §9.1 steps 3–5, §6.1 DESIGN;
 * spine AD-22 rule 4, §5 readings 109–110). Engine core reads only git-tracked files here (the
 * facts table, the Designer's artifacts, `screens.yaml`, the frozen spec); the research module
 * (lookback-research team, wired by the daemon) writes the facts and is never imported (AD-13
 * rule 12).
 * - **Directions**: the Designer's 2–3 `design_direction` artifacts, each with its novelty verdict
 *   (`novelty_report`, `unchecked` without one).
 * - **Unverified facts**: every fact in `.vtc/research/facts.jsonl` whose current row is
 *   unverified, stale or conflicting, every `UNVERIFIED:` tag in the documents G2 shows or the
 *   research briefs, and every version, licence, CVE or EOL claim in a research section (a
 *   research brief, or a section of a shown document whose heading names research) that cites no
 *   fact id. An approval must waive each one with a reason (`fact_waivers`). The stale facts are
 *   re-fetched first, through the injected refresher (`Engine.setFactRefresher`).
 * Role-written files are read without following a symlink (a role could plant one to a host file).
 * - **The chosen direction** enters the per-client design library once G2 is approved
 *   (`recordChosenDirection`, §9.1 step 6).
 * - **Design coverage**: every requirement of the frozen spec has a screen, every screen covers a
 *   requirement, and every component the component specs use is registered.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import {
  DESIGN_LIBRARY_DIR,
  DESIGN_SCREENS_PATH,
  DesignCoverageReportSchema,
  DesignLibraryEntrySchema,
  engineRepoKey,
  DesignScreensFileSchema,
  factId,
  FactRowSchema,
  G2DirectionDraftSchema,
  G2DirectionSchema,
  NoveltyReportSchema,
  parsePersisted,
  RESEARCH_FACTS_FILE,
  researchScopeFor,
  sha256Hex,
  SlugSchema,
  type ApproveInput,
  type DesignCoverageReport,
  type FactRow,
  type FrozenArtifact,
  type G2Direction,
  type G2DirectionDraft,
  type NoveltyReport,
  type UnverifiedFactSummary,
} from "@vtc/shared";
import { assertNoSymlinks } from "../git/index.js";
import type { Kernel, RunHandle } from "./kernel.js";
import { lastSubmitted } from "./queries.js";
import { frozenSpecItems } from "./read-model.js";
import { parseYaml } from "./yaml.js";

/** What the approve_gate action and `gate.requested` carry beyond the gates and artifacts. */
export interface GateExtras {
  readonly design_directions: string[];
  readonly directions?: G2Direction[];
  readonly unverified_facts: string[];
  readonly facts?: UnverifiedFactSummary[];
  readonly design_coverage?: DesignCoverageReport;
}

/**
 * A repo file's text, or `null`: never through a symlink (any component), so a role cannot make
 * the engine read and echo a file outside the repo.
 */
const read = (repoRoot: string, path: string): string | null => {
  try {
    assertNoSymlinks(repoRoot, path);
    if (!lstatSync(join(repoRoot, path)).isFile()) return null;
    return readFileSync(join(repoRoot, path), "utf8");
  } catch {
    return null;
  }
};

const submittedArtifacts = (
  h: RunHandle,
  role: string,
  mode?: string,
): { type: string; path: string }[] => {
  const run = lastSubmitted(h.state, { role, ...(mode === undefined ? {} : { mode }) });
  if (run === undefined) return [];
  const event = h.state.events.find(
    (e) =>
      e.type === "role.submitted" && (e.data as { action_id?: string }).action_id === run.action_id,
  );
  return (
    (event?.data as { artifacts?: { type: string; path: string }[] } | undefined)?.artifacts ?? []
  );
};

// ---------------------------------------------------------------- directions

const parseStructured = (text: string, path: string): unknown => {
  if (extname(path) === ".json") return JSON.parse(text) as unknown;
  return parseYaml(text);
};

/** A slug from a file or directory name (`direction-a.md` → `direction-a`). */
const slugOf = (path: string): string | null => {
  const name = basename(path, extname(path));
  const candidate = (name === "direction" || name === "index" ? basename(dirname(path)) : name)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return SlugSchema.safeParse(candidate).success ? candidate : null;
};

/**
 * One `design_direction` artifact as G2 shows it: a structured file (`G2DirectionDraft`, JSON or
 * YAML, at `designDirectionPath(id)`), or a Markdown direction contract whose first heading is its
 * title and whose `THESIS:` line is its thesis (§9.1 Direction contract). A `novelty` the Designer
 * wrote is dropped: the verdict is the engine's (spine §5 reading 116).
 */
const readDirection = (k: Kernel, path: string): G2DirectionDraft => {
  const text = read(k.deps.repoRoot, path) ?? "";
  if ([".json", ".yaml", ".yml"].includes(extname(path))) {
    try {
      const parsed = parsePersisted(G2DirectionDraftSchema, parseStructured(text, path));
      if (parsed.success) return parsed.data;
    } catch {
      // not structured: read it as a direction contract below
    }
  }
  const id = slugOf(path) ?? "direction";
  const title = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? id;
  const thesis = /^\s*(?:[-*]\s*)?\**THESIS\**\s*[:—-]\s*(.+)$/im.exec(text)?.[1]?.trim() ?? title;
  const prototypeDir = `.vtc/design/prototype/${id}`;
  return {
    id,
    title: title.slice(0, 120),
    thesis: thesis.slice(0, 500),
    prototype: existsSync(join(k.deps.repoRoot, prototypeDir))
      ? prototypeDir
      : ".vtc/design/prototype",
  };
};

/** The Designer's novelty reports (§9.1 step 4), by direction; an unreadable one is left out. */
const noveltyReports = (k: Kernel, h: RunHandle): Map<string, NoveltyReport> => {
  const reports = new Map<string, NoveltyReport>();
  for (const a of submittedArtifacts(h, "designer").filter((x) => x.type === "novelty_report")) {
    try {
      const parsed = parsePersisted(
        NoveltyReportSchema,
        JSON.parse(read(k.deps.repoRoot, a.path) ?? "") as unknown,
      );
      if (parsed.success) reports.set(parsed.data.direction, parsed.data);
    } catch {
      // an unreadable report leaves the direction unchecked
    }
  }
  return reports;
};

/** The Designer's directions for G2 with their novelty verdicts (§9.1 steps 3–5), at most 3. */
export const g2Directions = (k: Kernel, h: RunHandle): G2Direction[] => {
  const artifacts = submittedArtifacts(h, "designer");
  const novelty = new Map(
    [...noveltyReports(k, h)].map(([direction, report]) => [direction, report.verdict] as const),
  );
  const seen = new Set<string>();
  const directions: G2Direction[] = [];
  for (const a of artifacts.filter((x) => x.type === "design_direction")) {
    const d = readDirection(k, a.path);
    if (seen.has(d.id)) continue;
    seen.add(d.id);
    directions.push(G2DirectionSchema.parse({ ...d, novelty: novelty.get(d.id) ?? "unchecked" }));
  }
  return directions.slice(0, 3);
};

/**
 * §9.1 step 6: the direction the human chose at G2 enters the design library under the VTC home
 * (`~/.vtc/design-library/<scope>/<id>.json`, `DesignLibraryEntry`), in the project's client
 * scope (`_shared` or `client-<slug>`, as for research, §14), so the novelty check of later
 * projects steers away from it. The entry carries the perceptual hash and token vector of the
 * direction's novelty report; a direction with none has nothing to compare and is not recorded.
 * The id is fixed per repo, run and direction, so recording twice writes one file. Returns the
 * entry's path, or `null`.
 */
export const recordChosenDirection = (
  k: Kernel,
  h: RunHandle,
  direction: string,
): string | null => {
  const report = noveltyReports(k, h).get(direction);
  if (report === undefined) return null;
  const key = engineRepoKey(k.deps.repoRoot);
  const entry = DesignLibraryEntrySchema.parse({
    v: 1,
    id: `${key}-${sha256Hex(`${h.state.id}\n${direction}`).slice(0, 12)}`,
    project_key: key,
    direction,
    phash: report.phash,
    token_vector: report.token_vector,
    chosen_at: k.now().toISOString(),
  });
  const dir = join(k.deps.vtcHome, DESIGN_LIBRARY_DIR, researchScopeFor(k.config().client));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${entry.id}.json`);
  const temp = `${path}.${String(process.pid)}.tmp`;
  writeFileSync(temp, `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
  return path;
};

// --------------------------------------------------------------------- facts

/** The current rows of the facts table: the last row per id, minus every row a later one superseded. */
export const currentFacts = (repoRoot: string): FactRow[] => {
  const text = read(repoRoot, RESEARCH_FACTS_FILE);
  if (text === null) return [];
  const rows: FactRow[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = FactRowSchema.safeParse(JSON.parse(line));
      if (parsed.success) rows.push(parsed.data);
    } catch {
      // a torn line is skipped; the research module owns the file
    }
  }
  const superseded = new Set(
    rows.flatMap((r) => (r.supersedes === undefined ? [] : [r.supersedes])),
  );
  const byId = new Map<string, FactRow>();
  for (const row of rows) if (!superseded.has(row.id)) byId.set(row.id, row);
  return [...byId.values()];
};

const FACT_REASON: Readonly<Record<"unverified" | "stale" | "conflicting", string>> = {
  unverified: "its locator was not found in the cached source",
  stale: "its cached source expired and the re-fetch did not verify it",
  conflicting: "sources disagree",
};

/** A line's `UNVERIFIED:` tag (§8.2: an unverified claim blocks G2 unless a human waives it). */
const UNVERIFIED_TAG = /UNVERIFIED:\s*(.*)$/;

/** A fact id cited on a line (`FactIdSchema`). */
const FACT_CITE = /\bf-[a-f0-9]{16}\b/;

/**
 * The kinds of claim a research section must back with a fact (AD-22 rule 4), first match wins.
 * Deterministic and deliberately broad: a false positive costs one waiver, a miss lets an uncited
 * claim through G2.
 */
const CLAIM_KINDS: readonly { readonly kind: string; readonly pattern: RegExp }[] = [
  { kind: "cve", pattern: /\b(?:CVE-\d{4}-\d{4,}|GHSA(?:-[a-z0-9]{4}){3})\b|\bvulnerab/i },
  {
    kind: "licence",
    pattern:
      /\blicen[cs]e[ds]?\b|\b(?:MIT|ISC|BSD-\d-Clause|Apache-2\.0|Apache 2\.0|[AL]?GPL(?:-?v?\d(?:\.\d)?)?|MPL-2\.0|SSPL|BUSL)\b/i,
  },
  {
    kind: "eol",
    pattern:
      /\b(?:EOL|end[- ]of[- ](?:life|support)|supported (?:until|through|till)|support ends|LTS|deprecated)\b/i,
  },
  {
    kind: "version",
    pattern: /\bv?\d+\.\d+(?:\.\d+)?\b|[\w.-]@\^?~?\d|\bversions?\b|\breleased?\b/i,
  },
];

/** The kind of uncited claim on `line`, or `null`. */
const uncitedClaim = (line: string): string | null => {
  if (FACT_CITE.test(line)) return null;
  return CLAIM_KINDS.find((c) => c.pattern.test(line))?.kind ?? null;
};

/** A Markdown heading: its level and text. */
const HEADING = /^(#{1,6})\s+(.*)$/;

/**
 * Every claim G2 blocks on (AD-22 rule 4): facts whose current row is unverified, stale or
 * conflicting; then, per document of `documents` (repo-relative) in line order, its `UNVERIFIED:`
 * tags and the version, licence, CVE or EOL claims in its research sections that cite no fact id
 * (a document in `research` is a research section as a whole; elsewhere a section is research
 * when its heading says so); once each.
 */
export const unverifiedFacts = (
  k: Kernel,
  documents: readonly string[],
  research: ReadonlySet<string> = new Set(),
): UnverifiedFactSummary[] => {
  const out = new Map<string, UnverifiedFactSummary>();
  // the research module's re-checked view of the table when it is wired (reading 120): a status
  // a row records is role-writable, so it is trusted only without one
  const checked = k.factTable?.() ?? null;
  for (const fact of checked ?? []) out.set(fact.id, fact);
  for (const row of checked === null ? currentFacts(k.deps.repoRoot) : []) {
    if (row.status !== "unverified" && row.status !== "stale" && row.status !== "conflicting")
      continue;
    out.set(row.id, {
      id: row.id,
      subject: row.subject,
      predicate: row.predicate,
      status: row.status,
      reason:
        row.source === null ? "no source: a claim nobody could source" : FACT_REASON[row.status],
      ...(row.source === null ? {} : { source_url: row.source.url }),
    });
  }
  for (const path of [...new Set(documents)]) {
    const lines = (read(k.deps.repoRoot, path) ?? "").split("\n");
    // the research section the line is in: the heading level that opened it, or 0 for the whole
    // document (a research brief); `null` outside one
    let section: number | null = research.has(path) ? 0 : null;
    let fenced = false;
    lines.forEach((line, i) => {
      const subject = `${path}:${String(i + 1)}`.slice(0, 300);
      const tag = UNVERIFIED_TAG.exec(line);
      if (tag !== null) {
        const claim = (tag[1] ?? "").trim() || "an unverified claim";
        const id = factId(path, "unverified_tag", claim, null);
        if (!out.has(id))
          out.set(id, {
            id,
            subject,
            predicate: "unverified_tag",
            status: "unverified",
            reason: `tagged UNVERIFIED: ${claim}`.slice(0, 500),
          });
        return;
      }
      if (/^\s*(?:```|~~~)/.test(line)) fenced = !fenced;
      const heading = fenced ? null : HEADING.exec(line);
      if (heading !== null) {
        const level = heading[1]?.length ?? 1;
        if (section !== null && section !== 0 && level <= section) section = null;
        if (section === null && /\bresearch\b/i.test(heading[2] ?? "")) section = level;
        return;
      }
      if (section === null) return;
      const kind = uncitedClaim(line);
      if (kind === null) return;
      const claim = line.replace(/^\s*(?:[-*+]|\d+\.)\s+/, "").trim();
      const id = factId(path, `uncited_${kind}`, claim, null);
      if (out.has(id)) return;
      out.set(id, {
        id,
        subject,
        predicate: `uncited_${kind}`,
        status: "unverified",
        reason:
          `a ${kind === "eol" ? "EOL" : kind === "cve" ? "CVE" : kind} claim in a research section cites no fact: ${claim}`.slice(
            0,
            500,
          ),
      });
    });
  }
  return [...out.values()];
};

// ---------------------------------------------------------- design coverage

/** Component spec files (`component_specs`, `.vtc/design/components/*.yaml`) as plain records. */
const componentSpecs = (k: Kernel, h: RunHandle): Record<string, unknown>[] => {
  const paths = new Set(
    submittedArtifacts(h, "designer")
      .filter((a) => a.type === "component_specs")
      .map((a) => a.path),
  );
  const dir = join(k.deps.repoRoot, ".vtc/design/components");
  if (existsSync(dir))
    for (const name of readdirSync(dir))
      if (/\.ya?ml$/.test(name)) paths.add(`.vtc/design/components/${name}`);
  return [...paths].flatMap((path) => {
    try {
      const parsed = parseYaml(read(k.deps.repoRoot, path) ?? "");
      const list = Array.isArray(parsed)
        ? parsed
        : parsed !== null &&
            typeof parsed === "object" &&
            Array.isArray((parsed as { components?: unknown }).components)
          ? (parsed as { components: unknown[] }).components
          : [parsed];
      return list.filter(
        (c): c is Record<string, unknown> =>
          c !== null && typeof c === "object" && !Array.isArray(c),
      );
    } catch {
      return [];
    }
  });
};

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

/**
 * The DESIGN check (§6.1, §9; `DesignCoverageReport`) for a run with UI: every requirement of the
 * frozen spec is covered by a screen's `reqs` (a screen covering `REQ-1` covers its ACs); every
 * screen covers at least one requirement; every component a component spec uses (`uses`) is one a
 * component spec defines (`id`), the registry the Engineer may build from (§9 Consistency).
 * `undefined` when the run has no UI or the Designer wrote no `screens.yaml`.
 */
export const designCoverage = (k: Kernel, h: RunHandle): DesignCoverageReport | undefined => {
  if (!h.state.run.has_ui) return undefined;
  const text = read(k.deps.repoRoot, DESIGN_SCREENS_PATH);
  if (text === null) return undefined;
  let screens;
  try {
    const parsed = parsePersisted(DesignScreensFileSchema, parseYaml(text));
    if (!parsed.success) return undefined;
    screens = parsed.data.screens;
  } catch {
    return undefined;
  }
  const covered = screens.flatMap((s) => s.reqs);
  const reqs = [
    ...new Set(
      frozenSpecItems(k.deps.repoRoot, h.state)
        .map((i) => i.id.split(".")[0] ?? i.id)
        .filter((id) => /^(REQ|SEC)-[1-9]\d*$/.test(id)),
    ),
  ];
  const specs = componentSpecs(k, h);
  const registered = new Set(specs.flatMap((c) => (typeof c.id === "string" ? [c.id] : [])));
  const used = [...new Set(specs.flatMap((c) => strings(c.uses)))];
  const report = {
    reqs_without_screen: reqs.filter(
      (req) => !covered.some((c) => c === req || c.startsWith(`${req}.`)),
    ),
    screens_without_req: screens.filter((s) => s.reqs.length === 0).map((s) => s.id),
    components_unregistered: used
      .filter((c) => !registered.has(c))
      .filter((c) => SlugSchema.safeParse(c).success),
  };
  return DesignCoverageReportSchema.parse({
    ...report,
    ok:
      report.reqs_without_screen.length === 0 &&
      report.screens_without_req.length === 0 &&
      report.components_unregistered.length === 0,
  });
};

// ---------------------------------------------------------------- the gate

/** The research briefs: every Research-Analyst artifact is a research section as a whole. */
const researchBriefs = (h: RunHandle): string[] =>
  submittedArtifacts(h, "research_analyst").map((a) => a.path);

/** The documents G2 scans for claims: what it shows, and the research briefs. */
const factDocuments = (h: RunHandle, shown: readonly FrozenArtifact[]): string[] => [
  ...shown.map((a) => a.path),
  ...researchBriefs(h),
];

/** What the approval of `gates` shows besides the artifacts (only G2 has any). */
export const gateExtras = (
  k: Kernel,
  h: RunHandle,
  gates: readonly string[],
  shown: readonly FrozenArtifact[],
): GateExtras => {
  if (!gates.includes("G2")) return { design_directions: [], unverified_facts: [] };
  const directions = g2Directions(k, h);
  const facts = unverifiedFacts(k, factDocuments(h, shown), new Set(researchBriefs(h)));
  const coverage = designCoverage(k, h);
  return {
    design_directions: directions.map((d) => d.id),
    ...(directions.length === 0 ? {} : { directions }),
    unverified_facts: facts.map((f) => f.id),
    ...(facts.length === 0 ? {} : { facts }),
    ...(coverage === undefined ? {} : { design_coverage: coverage }),
  };
};

/**
 * Why a G2 approval may not go ahead, or `null` (AD-22 rule 4, reading 110; §9.1 step 5): every
 * fact G2 lists needs a waiver with a reason, and with directions on offer the human picks one.
 */
export const g2ApprovalProblem = (
  extras: GateExtras,
  input: Pick<ApproveInput, "fact_waivers" | "design_direction">,
): string | null => {
  const problems: string[] = [];
  const waived = new Set((input.fact_waivers ?? []).map((w) => w.id));
  const missing = extras.unverified_facts.filter((id) => !waived.has(id));
  if (missing.length > 0)
    problems.push(
      `every unverified fact needs a waiver with a reason (fact_waivers); not waived: ${missing.join(", ")}`,
    );
  if (extras.design_directions.length > 0) {
    if (input.design_direction === undefined)
      problems.push(`pick one design direction (${extras.design_directions.join(", ")})`);
    else if (!extras.design_directions.includes(input.design_direction))
      problems.push(
        `${input.design_direction} is not one of the directions shown (${extras.design_directions.join(", ")})`,
      );
  }
  return problems.length === 0 ? null : problems.join("; ");
};
