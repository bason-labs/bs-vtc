/**
 * What G2 shows and what its approval must carry (spec §8.2, §8.6, §9.1 steps 3–5, §6.1 DESIGN;
 * spine AD-22 rule 4, §5 readings 109–110). Engine core reads only git-tracked files here (the
 * facts table, the Designer's artifacts, `screens.yaml`, the frozen spec); the research module
 * (lookback-research team, wired by the daemon) writes the facts and is never imported (AD-13
 * rule 12).
 * - **Directions**: the Designer's 2–3 `design_direction` artifacts, each with the engine's
 *   novelty verdict: before G2 shows, `GateRunner.checkNovelty` checks each direction's first
 *   viewport against the client's design library and the engine writes the report to
 *   `noveltyReportPath(id)` (`checkDirectionsNovelty`, readings 116 and 127); `unchecked` without
 *   one. A verdict a role wrote is never read.
 * - **Unverified facts**: every fact in `.vtc/research/facts.jsonl` whose current row is
 *   unverified, stale or conflicting, every `UNVERIFIED:` tag in the documents G2 shows or the
 *   research briefs, and every version, licence, CVE or EOL claim in a research section (a
 *   research brief, or a section of a shown document whose heading names research) that cites no
 *   fact id. An approval must waive each one with a reason (`fact_waivers`). The stale facts are
 *   re-fetched first, through the injected refresher (`Engine.setFactRefresher`).
 * Role-written files are read without following a symlink (a role could plant one to a host file).
 * - **The chosen direction** enters the per-client design library once G2 is approved, through
 *   `GateRunner.recordDesignChoice` (`recordChosenDirection`, §9.1 step 6, reading 127).
 * - **Design coverage**: every requirement of the frozen spec is named by an AD or a component and
 *   has a screen, every screen covers a requirement, and every component the component specs use
 *   is registered; the coverage loop (`design-loop.ts`, H-13) closes the gaps before G2 shows.
 */
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import {
  DESIGN_SCREENS_PATH,
  DesignCoverageReportSchema,
  DesignExitSchema,
  G2_DIRECTIONS,
  DesignLibraryEntrySchema,
  engineRepoKey,
  DesignScreensFileSchema,
  factId,
  FactRowSchema,
  G2DirectionDraftSchema,
  G2DirectionSchema,
  noveltyReportPath,
  NoveltyReportSchema,
  parsePersisted,
  RESEARCH_FACTS_FILE,
  researchScopeFor,
  sha256Hex,
  SlugSchema,
  type ApproveInput,
  type DesignLibraryEntry,
  type DesignCoverageReport,
  type DesignExit,
  type FactRow,
  type FrozenArtifact,
  type G2Direction,
  type G2DirectionDraft,
  type NoveltyReport,
  type UnverifiedFactSummary,
} from "@vtc/shared";
import { assertNoSymlinks, writeRepoFile } from "../git/index.js";
import { coverageProblems as loopProblems } from "./design-loop.js";
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
  /** With directions on offer: re-roll and the category standard (§9.1 step 5, reading 151). */
  readonly design_exits?: DesignExit[];
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

/**
 * The engine's novelty report of a direction (§9.1 step 4, `noveltyReportPath(id)`; only the
 * engine writes there, reading 116), or `undefined` when there is none or it does not parse.
 */
const noveltyReport = (k: Kernel, direction: string): NoveltyReport | undefined => {
  try {
    const parsed = parsePersisted(
      NoveltyReportSchema,
      JSON.parse(read(k.deps.repoRoot, noveltyReportPath(direction)) ?? "") as unknown,
    );
    return parsed.success && parsed.data.direction === direction ? parsed.data : undefined;
  } catch {
    return undefined; // an unreadable report leaves the direction unchecked
  }
};

/** Every distinct direction the Designer's latest result offers (§9.1 step 3), uncut. */
const offeredDirections = (k: Kernel, h: RunHandle): G2DirectionDraft[] => {
  const seen = new Set<string>();
  const drafts: G2DirectionDraft[] = [];
  for (const a of submittedArtifacts(h, "designer").filter((x) => x.type === "design_direction")) {
    const d = readDirection(k, a.path);
    if (seen.has(d.id)) continue;
    seen.add(d.id);
    drafts.push(d);
  }
  return drafts;
};

/** The Designer's directions as G2 shows them: at most `G2_DIRECTIONS.max`, once each. */
const directionDrafts = (k: Kernel, h: RunHandle): G2DirectionDraft[] =>
  offeredDirections(k, h).slice(0, G2_DIRECTIONS.max);

/** A new-repo UI design must offer `G2_DIRECTIONS` directions (§9.1 steps 3 and 5; D-bt). */
const needsDirections = (h: RunHandle): boolean =>
  h.state.run.repo === "new" && h.state.run.has_ui && h.state.automation === null;

/**
 * How many distinct directions the Designer's latest result offers when that is fewer than a
 * new-repo UI design needs (`G2_DIRECTIONS.min`, D-bt, spine §5 reading 174); `undefined` when
 * the run needs no directions, or the Designer offered enough.
 */
const directionsShortfall = (k: Kernel, h: RunHandle): number | undefined => {
  if (!needsDirections(h)) return undefined;
  const offered = offeredDirections(k, h).length;
  return offered < G2_DIRECTIONS.min ? offered : undefined;
};

/**
 * D-bt (spine §5 reading 174): the note of the Designer's one re-dispatch, when its only result
 * since its DESIGN work began (`since`, {@link designWorkSince}) offers fewer than
 * `G2_DIRECTIONS.min` distinct directions on a new-repo UI design; `undefined` otherwise. After
 * the second result G2 shows the shortfall as `DesignCoverageReport.directions_problem`.
 */
export const designerRedispatchNote = (
  k: Kernel,
  h: RunHandle,
  since: number,
): string | undefined => {
  const results = [...h.state.roleRuns.values()].filter(
    (r) =>
      r.role === "designer" &&
      r.task === undefined &&
      r.status === "submitted" &&
      r.exit === "done" &&
      (r.closedSeq ?? 0) > since,
  );
  if (results.length !== 1) return undefined;
  const offered = directionsShortfall(k, h);
  if (offered === undefined) return undefined;
  return `G2 offers ${String(G2_DIRECTIONS.min)}–${String(G2_DIRECTIONS.max)} design directions on a new UI design (§9.1 steps 3 and 5), and you offered ${String(offered)}. Return ${String(G2_DIRECTIONS.min)}–${String(G2_DIRECTIONS.max)} distinct directions (design_direction artifacts), the ones you keep included.`;
};

/** The Designer's directions for G2 with the engine's novelty verdicts (§9.1 steps 3–5), at most 3. */
export const g2Directions = (k: Kernel, h: RunHandle): G2Direction[] =>
  directionDrafts(k, h).map((d) =>
    G2DirectionSchema.parse({ ...d, novelty: noveltyReport(k, d.id)?.verdict ?? "unchecked" }),
  );

/**
 * §9.1 step 4, reading 127: before G2 shows, each direction with a first viewport is checked
 * against the design library of the project's client scope (`GateRunner.checkNovelty`) and the
 * report written to `noveltyReportPath(id)`. A check that fails leaves its direction `unchecked`;
 * without the method every direction stays `unchecked`.
 */
export const checkDirectionsNovelty = async (k: Kernel, h: RunHandle): Promise<void> => {
  const check = k.deps.gateRunner.checkNovelty?.bind(k.deps.gateRunner);
  if (check === undefined) return;
  const scope = researchScopeFor(k.config().client);
  for (const d of directionDrafts(k, h)) {
    if (d.first_viewport === undefined) continue;
    try {
      const report = NoveltyReportSchema.parse(
        await check({ direction: d.id, firstViewport: d.first_viewport, scope }),
      );
      if (report.direction !== d.id) continue;
      writeRepoFile(
        k.deps.repoRoot,
        noveltyReportPath(d.id),
        `${JSON.stringify(report, null, 2)}\n`,
      );
    } catch {
      // the direction stays unchecked; G2 says so
    }
  }
};

/**
 * §9.1 step 6, reading 127: the direction the human chose at G2 enters the design library of the
 * project's client scope (`_shared` or `client-<slug>`, as for research, §14) through
 * `GateRunner.recordDesignChoice`, so the novelty check of later projects steers away from it. The
 * entry carries the perceptual hash and token vector of the engine's novelty report; a direction
 * with none, or a gate runner without the method, records nothing. The id is fixed per repo, run
 * and direction, so recording twice writes one entry. Returns the entry, or `null`; throws when
 * the gate runner could not record it.
 */
export const recordChosenDirection = async (
  k: Kernel,
  h: RunHandle,
  direction: string,
): Promise<DesignLibraryEntry | null> => {
  const record = k.deps.gateRunner.recordDesignChoice?.bind(k.deps.gateRunner);
  const report = noveltyReport(k, direction);
  if (record === undefined || report === undefined) return null;
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
  await record(entry, researchScopeFor(k.config().client));
  return entry;
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

/** Whether `text` names requirement `id` (`REQ-2`, or one of its ACs, never `REQ-21`). */
const names = (text: string, id: string): boolean =>
  new RegExp(`(?<![A-Za-z0-9-])${id}(?![0-9])`).test(text);

/**
 * The DESIGN check (§6.1, §9; `DesignCoverageReport`, spine §5 readings 146 and 237), before every
 * G2, run by the coverage loop (`design-loop.ts`) until its coverage is complete:
 * - every requirement of the frozen spec is mapped to an AD or a component: the Architect's
 *   architecture artifacts (its requirement-to-component map, or an AD that names it) name it;
 * - with UI, every requirement is covered by a screen's `reqs` (a screen covering `REQ-1` covers
 *   its ACs); every screen covers at least one requirement; every component a component spec uses
 *   (`uses`) is one a component spec defines (`id`), the registry the Engineer may build from (§9
 *   Consistency); and a `screens.yaml` that is missing or invalid fails the check
 *   (`screens_problem`) instead of skipping it.
 * An approval is refused while `ok` is false (`g2ApprovalProblem`): with the loop that is only a
 * directions shortfall (reading 174) or a design file changed after the loop's last check.
 */
export const designCoverage = (k: Kernel, h: RunHandle): DesignCoverageReport => {
  const reqs = [
    ...new Set(
      frozenSpecItems(k.deps.repoRoot, h.state)
        .map((i) => i.id.split(".")[0] ?? i.id)
        .filter((id) => /^(REQ|SEC)-[1-9]\d*$/.test(id)),
    ),
  ];
  const architecture = submittedArtifacts(h, "architect")
    .filter((a) => a.type === "architecture")
    .map((a) => read(k.deps.repoRoot, a.path) ?? "")
    .join("\n");
  const unmapped = reqs.filter((req) => !names(architecture, req));
  const ui = ((): Partial<Omit<DesignCoverageReport, "reqs_without_component" | "ok">> => {
    // an automatic run does no UI design (reading 223): its DESIGN check is the spine's alone
    if (!h.state.run.has_ui || h.state.automation !== null) return {};
    const text = read(k.deps.repoRoot, DESIGN_SCREENS_PATH);
    if (text === null) return { screens_problem: `the Designer wrote no ${DESIGN_SCREENS_PATH}` };
    let screens;
    try {
      const parsed = parsePersisted(DesignScreensFileSchema, parseYaml(text));
      if (!parsed.success)
        return {
          screens_problem:
            `${DESIGN_SCREENS_PATH} is invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`.slice(
              0,
              300,
            ),
        };
      screens = parsed.data.screens;
    } catch (error) {
      return {
        screens_problem:
          `${DESIGN_SCREENS_PATH} does not parse: ${error instanceof Error ? error.message : String(error)}`.slice(
            0,
            300,
          ),
      };
    }
    const covered = screens.flatMap((s) => s.reqs);
    const specs = componentSpecs(k, h);
    const registered = new Set(specs.flatMap((c) => (typeof c.id === "string" ? [c.id] : [])));
    const used = [...new Set(specs.flatMap((c) => strings(c.uses)))];
    return {
      reqs_without_screen: reqs.filter(
        (req) => !covered.some((c) => c === req || c.startsWith(`${req}.`)),
      ),
      screens_without_req: screens.filter((s) => s.reqs.length === 0).map((s) => s.id),
      components_unregistered: used
        .filter((c) => !registered.has(c))
        .filter((c) => SlugSchema.safeParse(c).success),
    };
  })();
  // D-bt (reading 174): a new-repo UI design that still offers too few directions after the
  // Designer's one re-dispatch is a blocking notice at G2
  const offered = directionsShortfall(k, h);
  const report = {
    reqs_without_component: unmapped,
    reqs_without_screen: ui.reqs_without_screen ?? [],
    screens_without_req: ui.screens_without_req ?? [],
    components_unregistered: ui.components_unregistered ?? [],
    ...(ui.screens_problem === undefined ? {} : { screens_problem: ui.screens_problem }),
    ...(offered === undefined
      ? {}
      : {
          directions_problem: `the Designer offered ${String(offered)} distinct design direction${offered === 1 ? "" : "s"}; a new UI design needs at least ${String(G2_DIRECTIONS.min)} (reject G2 with design_exit re_roll for new ones)`,
        }),
  };
  return DesignCoverageReportSchema.parse({
    ...report,
    ok:
      report.reqs_without_component.length === 0 &&
      report.reqs_without_screen.length === 0 &&
      report.screens_without_req.length === 0 &&
      report.components_unregistered.length === 0 &&
      report.screens_problem === undefined &&
      report.directions_problem === undefined,
  });
};

/** What a failed DESIGN check says, one clause per gap, the directions shortfall included. */
const coverageProblems = (r: DesignCoverageReport): string[] => [
  ...(r.directions_problem === undefined ? [] : [r.directions_problem]),
  ...loopProblems(r),
];

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
    ...(directions.length === 0 ? {} : { directions, design_exits: [...DesignExitSchema.options] }),
    unverified_facts: facts.map((f) => f.id),
    ...(facts.length === 0 ? {} : { facts }),
    design_coverage: coverage,
  };
};

/**
 * Why a G2 approval may not go ahead, or `null` (AD-22 rule 4, reading 110; §9.1 steps 4–5,
 * reading 151): every fact G2 lists needs a waiver with a reason, and with directions on offer the
 * human picks one that is not too similar to a past design, or takes the category standard.
 */
export const g2ApprovalProblem = (
  extras: GateExtras,
  input: Pick<ApproveInput, "fact_waivers" | "design_direction" | "design_exit">,
): string | null => {
  const problems: string[] = [];
  // H-13 (reading 237): the coverage loop closes every coverage gap before G2 shows, so there is
  // no "approve anyway"; a design file changed since then still fails here. Too few directions
  // keep reading 174's rule: a blocking notice (re-roll, or the category standard)
  const coverage = extras.design_coverage;
  if (coverage !== undefined && !coverage.ok)
    problems.push(`the DESIGN check failed: ${coverageProblems(coverage).join("; ")}`);
  const waived = new Set((input.fact_waivers ?? []).map((w) => w.id));
  const missing = extras.unverified_facts.filter((id) => !waived.has(id));
  if (missing.length > 0)
    problems.push(
      `every unverified fact needs a waiver with a reason (fact_waivers); not waived: ${missing.join(", ")}`,
    );
  const exits =
    "re-roll them (reject G2 with design_exit re_roll) or take the category standard (design_exit category_standard)";
  if (extras.design_directions.length > 0) {
    const tooSimilar = new Set(
      (extras.directions ?? []).filter((d) => d.novelty === "too_similar").map((d) => d.id),
    );
    if (input.design_exit === "category_standard") {
      // the category standard: no direction is taken, none enters the library
    } else if (input.design_direction === undefined)
      problems.push(
        `pick one design direction (${extras.design_directions.join(", ")}), or ${exits}`,
      );
    else if (!extras.design_directions.includes(input.design_direction))
      problems.push(
        `${input.design_direction} is not one of the directions shown (${extras.design_directions.join(", ")})`,
      );
    else if (tooSimilar.has(input.design_direction))
      problems.push(
        `${input.design_direction} is too similar to a past design (§9.1 step 4): pick another direction, or ${exits}`,
      );
  } else if (input.design_exit !== undefined)
    problems.push("no design directions are on offer, so there is no design exit to take");
  return problems.length === 0 ? null : problems.join("; ");
};

// ------------------------------------------------------------------- re-roll

type RunEvents = RunHandle["state"]["events"];

/** The run's latest gate decision (`gate.approved` or `gate.rejected`) before `seq`. */
const decisionBefore = (events: RunEvents, seq: number) =>
  events.findLast((e) => e.seq < seq && (e.type === "gate.rejected" || e.type === "gate.approved"));

const isReroll = (e: RunEvents[number] | undefined): boolean =>
  e?.type === "gate.rejected" && (e.data as { design_exit?: string }).design_exit === "re_roll";

/**
 * The G2 rejection that re-rolled the directions (§9.1 step 5, spine §5 reading 151), when it is
 * the run's latest gate decision and the run is back in DESIGN; otherwise `undefined`.
 */
export const activeReroll = (h: RunHandle): RunEvents[number] | undefined => {
  if (h.state.run.phase !== "design") return undefined;
  const last = decisionBefore(h.state.events, Number.MAX_SAFE_INTEGER);
  return isReroll(last) ? last : undefined;
};

/**
 * The seq from which a DESIGN role's work counts (`entered`, the phase's entry, unless re-rolled):
 * a re-roll sends only the Designer back, so every other design role's work since the DESIGN phase
 * that preceded the re-roll (or a chain of them) stands.
 */
export const designWorkSince = (h: RunHandle, role: string, entered: number): number => {
  if (role === "designer") return entered;
  let decision = activeReroll(h);
  let since = entered;
  const events = h.state.events;
  while (decision !== undefined) {
    const at = decision.seq;
    const entry = events.findLast(
      (e) =>
        e.seq < at && e.type === "run.phase_changed" && (e.data as { to?: string }).to === "design",
    );
    if (entry === undefined) break;
    since = entry.seq;
    const before = decisionBefore(events, entry.seq);
    decision = isReroll(before) ? before : undefined;
  }
  return since;
};

/**
 * The Designer's re-roll (§9.1 step 5): the engine's novelty report of every direction the last G2
 * showed as too similar (the role input `novelty_report`), and the note saying what to replace. Its
 * constraints are dealt afresh like every Designer dispatch's. `undefined` outside a re-roll.
 */
export const rerollInputs = (
  h: RunHandle,
):
  | { readonly inputs: { type: "novelty_report"; path: string }[]; readonly note: string }
  | undefined => {
  const reroll = activeReroll(h);
  if (reroll === undefined) return undefined;
  const shown = h.state.events.findLast((e) => e.seq < reroll.seq && e.type === "gate.requested")
    ?.data as { directions?: G2Direction[] } | undefined;
  const similar = (shown?.directions ?? []).filter((d) => d.novelty === "too_similar");
  return {
    inputs: similar.map((d) => ({ type: "novelty_report", path: noveltyReportPath(d.id) })),
    note: [
      "Re-roll (§9.1 step 5): the human asked for new directions at G2.",
      similar.length === 0
        ? "Build new directions from the newly dealt constraints."
        : `Replace ${similar.map((d) => d.id).join(", ")} (too similar to a past design: see each novelty_report) with directions built from the newly dealt constraints.`,
      "Return every direction you offer now, the ones you keep included.",
    ].join(" "),
  };
};
