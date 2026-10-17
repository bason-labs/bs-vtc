/**
 * The read side of the engine (AD-5 rule 4): one function per read route, answering from the
 * projected run state plus the files and git history it points at. The HTTP transport maps
 * routes to these; live mode and snapshot mode share them (AD-5 rule 7).
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import {
  ARTIFACT_MAX_BYTES,
  EVENT_PAGE_LIMIT,
  evidenceBundlePath,
  isServableArtifactPath,
  TASK_DIFF_MAX_PATCH_CHARS,
  type ArtifactContent,
  type EngineVersions,
  type EscalationList,
  type EventPage,
  type FeatureList,
  type GitOps,
  type HealthResult,
  type HostId,
  type RunList,
  type StatusResult,
  type TaskDetail,
  type TaskDiff,
  type TaskList,
  type ClientSpendReport,
  type UsageReport,
  type UsageSnapshot,
  type WorkflowGraph,
  type AutomationReport,
  type AutomationSettings,
  type VtcEvent,
} from "@vtc/shared";
import { AUTOMATION_SNAPSHOT_NOTE, automationReportView } from "./automation.js";
import { readModelState } from "./replay-view.js";
import { projectGraph, taskDagGraph, taskPipelineGraph } from "./graph.js";
import { acceptanceCriteriaOf, parseSpecItems, type SpecItem } from "./spec.js";
import type { RunState } from "./state.js";
import {
  escalationListView,
  eventPageView,
  featureListView,
  runListView,
  statusView,
  taskDetailView,
  taskListView,
  usageReportView,
} from "./views.js";

export type ReadResult<T> =
  | { readonly ok: true; readonly body: T }
  | { readonly ok: false; readonly code: "not_found" | "bad_request"; readonly message: string };

const ok = <T>(body: T): ReadResult<T> => ({ ok: true, body });
const notFound = <T>(message: string): ReadResult<T> => ({ ok: false, code: "not_found", message });
const badRequest = <T>(message: string): ReadResult<T> => ({
  ok: false,
  code: "bad_request",
  message,
});

export interface ReadModelDeps {
  readonly repoRoot: string;
  readonly mode: "live" | "snapshot";
  readonly versions: EngineVersions;
  readonly prototypeUrl: () => string | null;
  /** Every run of the repo, oldest first. */
  readonly runs: () => readonly RunState[];
  readonly usage: () => ReadonlyMap<HostId, UsageSnapshot>;
  /** Git history for diffs; `null` when the repo has no git (snapshot of a bare `.vtc/`). */
  readonly git: Pick<GitOps, "changedFiles" | "diff"> | null;
  /**
   * The project's client scope from the VTC home's spend record (§14, reading 153); absent where
   * there is none to read.
   */
  readonly clientSpend?: () => ClientSpendReport;
  /**
   * The project's resolved automation settings (`automationFor`, D-bz), or `null` when the engine
   * has no automation wiring (`EngineDeps.automation` absent). Absent: `null`.
   */
  readonly automation?: () => AutomationSettings | null;
  /**
   * Automation events no run's log holds yet (recorded while no run was open, D-ca), which the
   * Automation view shows with the runs' own. Absent: none.
   */
  readonly automationEvents?: () => readonly VtcEvent[];
}

export interface ReadModel {
  health(): HealthResult;
  status(): ReadResult<StatusResult>;
  runs(): RunList;
  events(run: string, after: number, limit: number): ReadResult<EventPage>;
  tasks(run: string): ReadResult<TaskList>;
  task(run: string, task: string): ReadResult<TaskDetail>;
  taskDiff(run: string, task: string): Promise<ReadResult<TaskDiff>>;
  features(run: string): ReadResult<FeatureList>;
  artifact(run: string, path: string): ReadResult<ArtifactContent>;
  graph(run: string, scope: string, task: string | undefined): ReadResult<WorkflowGraph>;
  escalations(run: string): ReadResult<EscalationList>;
  usage(): UsageReport;
  clientSpend(): ReadResult<ClientSpendReport>;
  /** `GET /api/automation` (D-ca): from the `upstream.*` events of every run of the repo. */
  automation(): AutomationReport;
}

/** The run tools act on when none is named: the newest unfinished run, else the newest. */
export const activeRun = (runs: readonly RunState[]): RunState | undefined =>
  [...runs].reverse().find((r) => r.run.finished_at === undefined) ?? runs.at(-1);

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  mmd: "text/plain",
  json: "application/json",
  jsonl: "application/x-ndjson",
  yaml: "application/yaml",
  yml: "application/yaml",
  toml: "application/toml",
  xml: "application/xml",
  sarif: "application/sarif+json",
  html: "text/html",
  css: "text/css",
  js: "text/javascript",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

const mediaTypeOf = (path: string): string => {
  const name = path.split("/").at(-1) ?? "";
  const dot = name.lastIndexOf(".");
  return (
    MEDIA_TYPES[dot > 0 ? name.slice(dot + 1).toLowerCase() : ""] ?? "application/octet-stream"
  );
};

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * One git-tracked run artifact under `.vtc/` (AD-5 rule 10): never `.vtc/state/`, never through
 * a symlink that leaves `.vtc/`, at most {@link ARTIFACT_MAX_BYTES}, always as JSON.
 */
export const readArtifact = (
  repoRoot: string,
  run: string,
  path: string,
): ReadResult<ArtifactContent> => {
  if (!isServableArtifactPath(path)) return badRequest("artifacts are served from .vtc/ only");
  const absolute = join(repoRoot, path);
  let real: string;
  let vtcRoot: string;
  try {
    real = realpathSync(absolute);
    vtcRoot = realpathSync(join(repoRoot, ".vtc"));
  } catch {
    return notFound(`no artifact ${path}`);
  }
  const stateRoot = join(vtcRoot, "state");
  if (
    !real.startsWith(`${vtcRoot}${sep}`) ||
    real === stateRoot ||
    real.startsWith(`${stateRoot}${sep}`)
  ) {
    return badRequest("artifacts are served from .vtc/ only");
  }
  const info = lstatSync(real);
  if (!info.isFile()) return notFound(`no artifact ${path}`);
  if (info.size > ARTIFACT_MAX_BYTES)
    return badRequest(`artifact is larger than ${String(ARTIFACT_MAX_BYTES)} bytes`);
  const bytes = readFileSync(real);
  let text: string | null;
  try {
    text = utf8.decode(bytes);
  } catch {
    text = null;
  }
  return ok({
    run,
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
    media_type: mediaTypeOf(path),
    encoding: text === null ? "base64" : "utf8",
    content: text ?? bytes.toString("base64"),
  });
};

/** Per-file added and deleted line counts of a unified diff. */
export const diffLineCounts = (
  patch: string,
): Map<string, { additions: number; deletions: number }> => {
  const counts = new Map<string, { additions: number; deletions: number }>();
  let current: { additions: number; deletions: number } | undefined;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const match = / b\/(.+)$/.exec(line);
      current = { additions: 0, deletions: 0 };
      if (match?.[1] !== undefined) counts.set(match[1], current);
      inHunk = false;
      continue;
    }
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk || current === undefined) continue;
    if (line.startsWith("+")) current.additions += 1;
    else if (line.startsWith("-")) current.deletions += 1;
  }
  return counts;
};

/** Where Security's design mode writes the threat model (its write scope, spine §5 reading 37). */
const THREAT_MODEL_DIR = ".vtc/architecture/threat-model/";

/**
 * The frozen requirements: the items of the spec G1 froze under `.vtc/spec/`, then the `SEC-n`
 * requirements (and their ACs) of the threat model G2 froze (§6.1, §5.2 Security design mode;
 * spine §5 reading 147). The spec is never edited after G1, so the engine adds Security's SEC-n
 * here: the Planner's coverage check, task packs, traceability and Final Review read them like
 * the spec's. An id the spec already defines keeps the spec's text.
 */
export const frozenSpecItems = (repoRoot: string, state: RunState): SpecItem[] => {
  const read = (path: string): SpecItem[] => {
    try {
      return parseSpecItems(readFileSync(join(repoRoot, path), "utf8"));
    } catch {
      return [];
    }
  };
  const spec = state.run.gates.G1.frozen.find((f) => f.path.startsWith(".vtc/spec/"));
  const items = spec === undefined ? [] : read(spec.path);
  const known = new Set(items.map((i) => i.id));
  for (const model of state.run.gates.G2.frozen.filter((f) => f.path.startsWith(THREAT_MODEL_DIR)))
    for (const item of read(model.path))
      if (item.id.startsWith("SEC-") && !known.has(item.id)) {
        known.add(item.id);
        items.push(item);
      }
  return items;
};

/** The ACs a task covers: from the frozen spec, else what its findings and verdicts name. */
export const taskAcceptanceCriteria = (
  repoRoot: string,
  state: RunState,
  taskId: string,
): string[] => {
  const task = state.tasks.get(taskId);
  if (task === undefined) return [];
  const fromSpec = acceptanceCriteriaOf(frozenSpecItems(repoRoot, state), task.covers);
  if (fromSpec.length > 0) return fromSpec;
  const named = new Set<string>();
  for (const record of state.findings.values()) {
    if (record.finding.task !== taskId) continue;
    for (const ref of record.finding.req_ids) if (ref.includes(".AC-")) named.add(ref);
  }
  for (const run of state.roleRuns.values()) {
    if (run.task === taskId && run.subject?.includes(".AC-") === true) named.add(run.subject);
  }
  return [...named];
};

export const createReadModel = (deps: ReadModelDeps): ReadModel => {
  // reading 177: the views leave out the run's Lookback replay trials
  const find = (run: string): RunState | undefined => {
    const state = deps.runs().find((r) => r.id === run);
    return state === undefined ? undefined : readModelState(state);
  };
  const withRun = <T>(run: string, fn: (state: RunState) => ReadResult<T>): ReadResult<T> => {
    const state = find(run);
    return state === undefined ? notFound(`no run ${run}`) : fn(state);
  };
  return {
    health: () => ({
      ok: true,
      mode: deps.mode,
      engine_version: deps.versions.engine,
      contracts_version: deps.versions.contracts,
      prototype_url: deps.prototypeUrl(),
    }),
    status: () => {
      const state = activeRun(deps.runs());
      return state === undefined
        ? notFound("no run yet")
        : ok(statusView(readModelState(state), deps.usage()));
    },
    runs: () => runListView(deps.runs()),
    events: (run, after, limit) =>
      withRun(run, (state) => {
        if (!Number.isInteger(after) || after < 0) return badRequest("after must be a seq >= 0");
        if (!Number.isInteger(limit) || limit < 1 || limit > EVENT_PAGE_LIMIT.max) {
          return badRequest(`limit must be 1..${String(EVENT_PAGE_LIMIT.max)}`);
        }
        return ok(eventPageView(state, after, limit));
      }),
    tasks: (run) => withRun(run, (state) => ok(taskListView(state))),
    task: (run, task) =>
      withRun(run, (state) => {
        const bundle = state.tasks.has(task) ? evidenceBundlePath(task) : null;
        const detail = taskDetailView(state, task, {
          evidenceBundle:
            bundle !== null && existsSync(join(deps.repoRoot, bundle)) ? bundle : null,
        });
        return detail === null ? notFound(`no task ${task}`) : ok(detail);
      }),
    taskDiff: async (run, task) => {
      const state = find(run);
      if (state === undefined) return notFound(`no run ${run}`);
      const detail = taskDetailView(state, task);
      if (detail === null) return notFound(`no task ${task}`);
      if (detail.diff === null) return notFound(`task ${task} has no verified diff yet`);
      if (deps.git === null) return notFound("no git history in this snapshot");
      const { base, head } = detail.diff;
      let files;
      let patch;
      try {
        files = await deps.git.changedFiles(base, head);
        patch = await deps.git.diff(base, head);
      } catch {
        return notFound(`the commits of task ${task} are not in this clone`);
      }
      const counts = diffLineCounts(patch);
      const truncated = patch.length > TASK_DIFF_MAX_PATCH_CHARS;
      return ok({
        run,
        task,
        base,
        head,
        files: files.map((f) => ({
          path: f.path,
          status: f.status,
          ...(f.oldPath === undefined ? {} : { old_path: f.oldPath }),
          additions: counts.get(f.path)?.additions ?? 0,
          deletions: counts.get(f.path)?.deletions ?? 0,
        })),
        patch: truncated ? patch.slice(0, TASK_DIFF_MAX_PATCH_CHARS) : patch,
        truncated,
      });
    },
    features: (run) => withRun(run, (state) => ok(featureListView(state))),
    artifact: (run, path) => withRun(run, () => readArtifact(deps.repoRoot, run, path)),
    graph: (run, scope, task) =>
      withRun(run, (state) => {
        if (scope === "project") return ok(projectGraph(state));
        if (scope === "task_dag") return ok(taskDagGraph(state));
        if (scope !== "task") return badRequest("scope must be project, task_dag or task");
        if (task === undefined) return badRequest("scope task needs task=T-n");
        const graph = taskPipelineGraph(
          state,
          task,
          taskAcceptanceCriteria(deps.repoRoot, state, task),
        );
        return graph === null ? notFound(`no task ${task}`) : ok(graph);
      }),
    escalations: (run) => withRun(run, (state) => ok(escalationListView(state))),
    usage: () => usageReportView(deps.usage(), activeRun(deps.runs()) ?? null),
    clientSpend: () =>
      deps.clientSpend === undefined
        ? notFound("this dashboard has no client spend record to read")
        : ok(deps.clientSpend()),
    automation: () =>
      automationReportView(
        [...deps.runs().flatMap((state) => state.events), ...(deps.automationEvents?.() ?? [])],
        deps.automation?.() ?? null,
        ...(deps.mode === "snapshot" ? [AUTOMATION_SNAPSHOT_NOTE] : []),
      ),
  };
};
