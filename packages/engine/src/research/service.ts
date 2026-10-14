/**
 * The research service (AD-22): the handlers behind `ROLE_MCP_TOOLS` (`research_fetch`,
 * `fact_lookup`, `fact_propose`) and the G2 fact list engine core consumes. The daemon builds one
 * per project with the injected `HttpClient` (`EngineDeps.http`), the cache under the VTC home and
 * the project's scope (`researchScopeFor(project.yaml client)`), and appends the events it emits.
 *
 * A role proposes a fact; the engine decides its status. A fact is `verified` only when
 * `verifyFactLocator` resolves its locator against the cached blob whose SHA the row records.
 */
import {
  factId,
  FactLookupInputSchema,
  FactLookupResultSchema,
  FactProposeInputSchema,
  FactProposeResultSchema,
  FETCHER_TTL_DAYS,
  FetchRequestSchema,
  ResearchFetchInputSchema,
  ResearchFetchResultSchema,
  ResearchScopeSchema,
  verifyFactLocator,
  type EventDataInput,
  type FactLocator,
  type FactLookupResult,
  type FactProposeResult,
  type FactRow,
  type FactStatus,
  type FactWaiver,
  type Fetcher,
  type FetcherId,
  type FetchRequest,
  type FetchRequestInput,
  type FetchResult,
  type HttpClient,
  type ResearchCache,
  type ResearchFetchResult,
  type ResearchScope,
  type RoleId,
  type UnverifiedFactSummary,
} from "@vtc/shared";
import type { RequestMemory } from "./cache.js";
import { scanResearchClaims, type ResearchDocument } from "./claims.js";
import { appendFactRows, currentFacts, readFactRows } from "./facts.js";
import { builtInFetchers } from "./fetchers.js";
import type { CachedFetchContext } from "./http-fetch.js";
import { roleFacingText } from "./text.js";

/** An event the service asks its caller to append (actor `engine`). */
export type ResearchEventDraft =
  | {
      readonly type: "research.fetched";
      readonly actor: "engine";
      readonly data: EventDataInput<"research.fetched">;
    }
  | {
      readonly type: "fact.recorded";
      readonly actor: "engine";
      readonly data: EventDataInput<"fact.recorded">;
    }
  | {
      readonly type: "fact.verified";
      readonly actor: "engine";
      readonly data: EventDataInput<"fact.verified">;
    };

export interface ResearchServiceDeps {
  /** Absolute project root (`.vtc/research/facts.jsonl` lives under it). */
  readonly projectRoot: string;
  readonly cache: ResearchCache & Partial<RequestMemory>;
  readonly scope: ResearchScope;
  /** Absent: fetchers are unavailable and every new fact stays unverified (`EngineDeps.http`). */
  readonly http?: HttpClient | undefined;
  readonly now?: () => Date;
  /** The value of the user's API key for a fetcher, by fetcher id (`~/.vtc/config.yaml`). */
  readonly apiKey?: (fetcher: string) => string | undefined;
  /** Known secret values to redact from fetched text and fact rows. */
  readonly knownValues?: () => readonly string[];
  readonly fetchers?: ReadonlyMap<FetcherId, Fetcher>;
  readonly onEvent?: (event: ResearchEventDraft) => void | Promise<void>;
}

/** What G2 shows and blocks on (`approve_gate.unverified_facts` and `facts`, same order). */
export interface G2Facts {
  readonly unverified_facts: string[];
  readonly facts: UnverifiedFactSummary[];
}

export interface ResearchService {
  /** One fetch through the cache; `body` is the cached blob when there is one. */
  fetch(
    request: FetchRequestInput,
  ): Promise<{ readonly result: FetchResult; readonly body?: Uint8Array }>;
  /** `research_fetch`: the result and the datamarked, redacted text. */
  researchFetch(input: unknown): Promise<ResearchFetchResult>;
  /** `fact_lookup`: current facts by id, or by subject and optional predicate. */
  factLookup(input: unknown): Promise<FactLookupResult>;
  /** `fact_propose`: fetches the source, verifies the locator and records the row. */
  factPropose(input: unknown, recordedBy: RoleId): Promise<FactProposeResult>;
  /** Before G2: re-fetches stale facts, then lists every fact and claim G2 blocks on. */
  g2Facts(documents: readonly ResearchDocument[]): Promise<G2Facts>;
  /** After an approval: a `waived` row for each waived fact row (claims have no row). */
  recordWaivers(waivers: readonly FactWaiver[]): Promise<FactRow[]>;
}

const DAY_MS = 86_400_000;

/** Without `EngineDeps.http` every request fails, so only the cache can answer (AD-22). */
export const NO_HTTP_DETAIL = "no HTTP client: research fetchers are unavailable";
const NO_HTTP: HttpClient = { request: () => Promise.reject(new Error(NO_HTTP_DETAIL)) };
const LOOKUP_MAX = 50;

const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

export const createResearchService = (deps: ResearchServiceDeps): ResearchService => {
  const scope = ResearchScopeSchema.parse(deps.scope);
  const now = deps.now ?? (() => new Date());
  const fetchers = deps.fetchers ?? builtInFetchers();
  const keysRead = new Set<string>();
  const knownValues = (): string[] => [...(deps.knownValues?.() ?? []), ...keysRead];
  const apiKey = (name: string): string | undefined => {
    const value = deps.apiKey?.(name);
    if (value !== undefined && value !== "") keysRead.add(value);
    return value;
  };
  const context: CachedFetchContext = {
    cache: deps.cache,
    scope,
    now,
    apiKey,
    http: deps.http ?? NO_HTTP,
    ...(deps.cache.remember !== undefined && deps.cache.recall !== undefined
      ? { requests: deps.cache as RequestMemory }
      : {}),
  };
  const emit = async (event: ResearchEventDraft): Promise<void> => {
    await deps.onEvent?.(event);
  };

  const fetch = async (
    input: FetchRequestInput,
  ): Promise<{ result: FetchResult; body?: Uint8Array }> => {
    const request = FetchRequestSchema.parse(input);
    const fetcher = fetchers.get(request.fetcher);
    if (fetcher === undefined) throw new Error(`no fetcher for ${request.fetcher}`);
    const result = await fetcher.fetch(request, context);
    await emit({ type: "research.fetched", actor: "engine", data: { scope, result } });
    const body =
      result.content_sha256 === null
        ? undefined
        : await deps.cache.blob(scope, result.content_sha256);
    return body === undefined ? { result } : { result, body };
  };

  const record = async (rows: readonly FactRow[]): Promise<FactRow[]> => {
    const written = await appendFactRows(deps.projectRoot, rows, knownValues());
    for (const fact of written)
      await emit({ type: "fact.recorded", actor: "engine", data: { fact } });
    return written;
  };

  /** Verifies a locator against a fetched source: the status the row gets and why. */
  const judge = (
    result: FetchResult,
    body: Uint8Array | undefined,
    locator: FactLocator,
    value: FactRow["value"],
  ): { status: FactStatus; reason: string } => {
    if (result.status !== "ok" || body === undefined) {
      return { status: "unverified", reason: `the source could not be fetched (${result.status})` };
    }
    const check = verifyFactLocator(locator, new TextDecoder().decode(body), value);
    if (!check.ok) return { status: "unverified", reason: check.reason };
    if (result.cache === "stale") return { status: "stale", reason: "the source was served stale" };
    return { status: "verified", reason: "the locator resolves in the source" };
  };

  const expiresAt = (result: FetchResult): string =>
    new Date(
      Date.parse(result.retrieved_at) + FETCHER_TTL_DAYS[result.fetcher] * DAY_MS,
    ).toISOString();

  const isExpired = (row: FactRow, at: Date): boolean =>
    row.expires_at !== undefined && Date.parse(row.expires_at) <= at.getTime();

  const factPropose = async (rawInput: unknown, recordedBy: RoleId): Promise<FactProposeResult> => {
    const input = FactProposeInputSchema.parse(rawInput);
    const recordedAt = now().toISOString();
    const pinned =
      input.pinned_version === undefined ? {} : { pinned_version: input.pinned_version };
    const current = currentFacts((await readFactRows(deps.projectRoot)).rows);

    // A claim with no source, or whose source stored nothing a row could name, stays unsourced.
    const unsourced = async (): Promise<FactProposeResult> => {
      const row: FactRow = {
        v: 1,
        id: factId(input.subject, input.predicate, input.value, null),
        subject: input.subject,
        predicate: input.predicate,
        value: input.value,
        status: "unverified",
        source: null,
        ...pinned,
        recorded_by: recordedBy,
        recorded_at: recordedAt,
      };
      const same = current.find((r) => r.id === row.id && r.status === row.status);
      const fact = same ?? (await record([row]))[0];
      return FactProposeResultSchema.parse({ fact });
    };
    if (input.source === null) return unsourced();

    const { result, body } = await fetch(input.source.request);
    if (result.content_sha256 === null) return unsourced();
    const { status } = judge(result, body, input.source.locator, input.value);

    const id = factId(input.subject, input.predicate, input.value, result.url);
    const rivals = current.filter(
      (r) =>
        r.id !== id &&
        r.subject === input.subject &&
        r.predicate === input.predicate &&
        r.source !== null,
    );
    // The same source now says something else: the new claim replaces the old one.
    const replaced = rivals.find((r) => r.source?.url === result.url);
    // Another source says something else about a verified claim: both are conflicting.
    const disagreeing =
      status === "verified"
        ? rivals.filter(
            (r) =>
              r.source?.url !== result.url &&
              (r.status === "verified" || r.status === "conflicting") &&
              r.value !== input.value,
          )
        : [];
    const row: FactRow = {
      v: 1,
      id,
      subject: input.subject,
      predicate: input.predicate,
      value: input.value,
      status: disagreeing.length > 0 ? "conflicting" : status,
      source: {
        fetcher: result.fetcher,
        url: result.url,
        retrieved_at: result.retrieved_at,
        content_sha256: result.content_sha256,
        locator: input.source.locator,
      },
      ...pinned,
      expires_at: expiresAt(result),
      ...(replaced === undefined ? {} : { supersedes: replaced.id }),
      recorded_by: recordedBy,
      recorded_at: recordedAt,
    };
    const same = current.find(
      (r) =>
        r.id === row.id &&
        r.status === row.status &&
        r.source?.content_sha256 === row.source?.content_sha256,
    );
    if (same !== undefined && disagreeing.length === 0) {
      return FactProposeResultSchema.parse({ fact: same });
    }
    const others: FactRow[] = disagreeing
      .filter((r) => r.status !== "conflicting")
      .map((r) => ({
        ...r,
        status: "conflicting",
        recorded_by: "engine",
        recorded_at: recordedAt,
      }));
    const written = await record([row, ...others]);
    for (const other of others) {
      await emit({
        type: "fact.verified",
        actor: "engine",
        data: { id: other.id, status: "conflicting", detail: `disagrees with ${row.id}` },
      });
    }
    return FactProposeResultSchema.parse({ fact: written[0] });
  };

  /** Re-fetches a fact's source and re-verifies it; the new row, or `undefined` if unchanged. */
  const refresh = async (
    row: FactRow,
    at: Date,
  ): Promise<{ row: FactRow; detail: string } | undefined> => {
    const source = row.source;
    if (source === null) return undefined;
    const request: FetchRequest | undefined = await deps.cache.recall?.(scope, source);
    if (request === undefined) {
      if (row.status === "stale") return undefined;
      return {
        row: { ...row, status: "stale", recorded_by: "engine", recorded_at: at.toISOString() },
        detail: "the source's request is not in this machine's cache, so it cannot be re-fetched",
      };
    }
    const { result, body } = await fetch(request);
    const { status, reason } = judge(result, body, source.locator, row.value);
    if (result.content_sha256 === null) {
      if (row.status === "stale") return undefined;
      return {
        row: { ...row, status: "stale", recorded_by: "engine", recorded_at: at.toISOString() },
        detail: clip(`the source could not be re-fetched: ${result.detail ?? result.status}`, 500),
      };
    }
    return {
      row: {
        ...row,
        status,
        source: {
          ...source,
          url: result.url,
          retrieved_at: result.retrieved_at,
          content_sha256: result.content_sha256,
        },
        expires_at: expiresAt(result),
        recorded_by: "engine",
        recorded_at: at.toISOString(),
      },
      detail: clip(reason, 500),
    };
  };

  /** Why a listed fact is not verified, for the G2 screen. */
  const reasonFor = async (row: FactRow): Promise<string> => {
    if (row.status === "conflicting") return "sources disagree on the value";
    if (row.status === "stale")
      return "the source is past its freshness window and could not be re-fetched";
    if (row.source === null) return "no source";
    const body = await deps.cache.blob(scope, row.source.content_sha256);
    if (body === undefined) return "the cited source is not in this machine's cache";
    const check = verifyFactLocator(row.source.locator, new TextDecoder().decode(body), row.value);
    return check.ok ? "recorded as unverified" : check.reason;
  };

  return {
    fetch,

    async researchFetch(rawInput) {
      const { request } = ResearchFetchInputSchema.parse(rawInput);
      const { result, body } = await fetch(request);
      return ResearchFetchResultSchema.parse({
        result,
        text: roleFacingText(result, body, knownValues()),
      });
    },

    async factLookup(rawInput) {
      const input = FactLookupInputSchema.parse(rawInput);
      const { rows } = await readFactRows(deps.projectRoot);
      let facts: FactRow[];
      if (input.ids !== undefined) {
        const newest = new Map(rows.map((r) => [r.id, r]));
        facts = input.ids.flatMap((id) => {
          const row = newest.get(id);
          return row === undefined ? [] : [row];
        });
      } else {
        facts = currentFacts(rows).filter(
          (r) =>
            r.subject === input.subject &&
            (input.predicate === undefined || r.predicate === input.predicate),
        );
      }
      return FactLookupResultSchema.parse({ facts: facts.slice(0, LOOKUP_MAX) });
    },

    factPropose,

    async g2Facts(documents) {
      const at = now();
      const before = currentFacts((await readFactRows(deps.projectRoot)).rows);
      const refreshed: FactRow[] = [];
      for (const row of before) {
        const due = row.status === "stale" || (row.status === "verified" && isExpired(row, at));
        if (!due || row.source === null) continue;
        const next = await refresh(row, at);
        if (next === undefined) continue;
        await record([next.row]);
        refreshed.push(next.row);
        await emit({
          type: "fact.verified",
          actor: "engine",
          data: { id: next.row.id, status: next.row.status, detail: next.detail },
        });
      }
      const after =
        refreshed.length === 0 ? before : currentFacts((await readFactRows(deps.projectRoot)).rows);
      const facts: UnverifiedFactSummary[] = [];
      for (const row of after) {
        if (row.status !== "unverified" && row.status !== "stale" && row.status !== "conflicting")
          continue;
        facts.push({
          id: row.id,
          subject: row.subject,
          predicate: row.predicate,
          status: row.status,
          reason: clip(await reasonFor(row), 500),
          ...(row.source === null ? {} : { source_url: row.source.url }),
        });
      }
      const listed = new Set(facts.map((f) => f.id));
      for (const claim of scanResearchClaims(documents)) {
        if (listed.has(claim.id)) continue;
        listed.add(claim.id);
        facts.push({
          id: claim.id,
          subject: claim.text,
          predicate: claim.kind === "unverified_tag" ? "unverified_claim" : "uncited_claim",
          status: "unverified",
          reason: clip(
            claim.kind === "unverified_tag"
              ? `an UNVERIFIED: tag at ${claim.path}:${String(claim.line)}`
              : `a version, licence, CVE or EOL claim that cites no fact at ${claim.path}:${String(claim.line)}`,
            500,
          ),
        });
      }
      return { unverified_facts: facts.map((f) => f.id), facts };
    },

    async recordWaivers(waivers) {
      const current = new Map(
        currentFacts((await readFactRows(deps.projectRoot)).rows).map((r) => [r.id, r]),
      );
      const at = now().toISOString();
      const rows: FactRow[] = [];
      for (const waiver of waivers) {
        const row = current.get(waiver.id);
        if (row === undefined || row.status === "waived") continue;
        rows.push({ ...row, status: "waived", recorded_by: "engine", recorded_at: at });
      }
      return rows.length === 0 ? [] : record(rows);
    },
  };
};
