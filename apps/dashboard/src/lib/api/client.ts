import {
  ArtifactContentSchema,
  DesignReviewCommentInputSchema,
  DesignReviewResultSchema,
  EscalationListSchema,
  EVENT_PAGE_LIMIT,
  EventPageSchema,
  FeatureListSchema,
  HealthResultSchema,
  HttpErrorSchema,
  parsePersisted,
  RunListSchema,
  StatusResultSchema,
  TaskDetailSchema,
  TaskDiffSchema,
  TaskListSchema,
  UsageReportSchema,
  WorkflowGraphSchema,
  type ArtifactContent,
  type DesignReviewCommentInput,
  type DesignReviewResult,
  type EngineHttpRouteName,
  type EscalationList,
  type EventPage,
  type FeatureList,
  type HealthResult,
  type RunList,
  type StatusResult,
  type TaskDetail,
  type TaskDiff,
  type TaskList,
  type UsageReport,
  type WorkflowGraph,
  type WorkflowScope,
} from "@vtc/shared";
import type { z } from "zod";
import { ApiError, codeForStatus } from "./errors";
import { routeUrl, type RouteParams, type RouteQuery } from "./routes";

export interface EngineClientOptions {
  readonly fetch: typeof fetch;
  /** The browser session token (AD-5 rule 2), or `null` (dev fixture server, no session). */
  readonly getToken: () => string | null;
  /** Called when the engine refuses the credentials (401/403). */
  readonly onUnauthorized?: () => void;
}

/** Read-only access to the engine's HTTP API (AD-5): every response validated by its contract. */
export interface EngineClient {
  health(signal?: AbortSignal): Promise<HealthResult>;
  status(signal?: AbortSignal): Promise<StatusResult>;
  runs(signal?: AbortSignal): Promise<RunList>;
  events(run: string, after: number, signal?: AbortSignal): Promise<EventPage>;
  tasks(run: string, signal?: AbortSignal): Promise<TaskList>;
  task(run: string, task: string, signal?: AbortSignal): Promise<TaskDetail>;
  taskDiff(run: string, task: string, signal?: AbortSignal): Promise<TaskDiff>;
  features(run: string, signal?: AbortSignal): Promise<FeatureList>;
  artifact(run: string, path: string, signal?: AbortSignal): Promise<ArtifactContent>;
  graph(
    run: string,
    scope: WorkflowScope,
    task?: string,
    signal?: AbortSignal,
  ): Promise<WorkflowGraph>;
  escalations(run: string, signal?: AbortSignal): Promise<EscalationList>;
  usage(signal?: AbortSignal): Promise<UsageReport>;
  /**
   * The dashboard's only write (AD-5 rule 5): a click-to-pin design review comment, which the
   * engine appends to `.vtc/design/reviews/<screen>.jsonl`. Validated before it is sent.
   */
  postDesignReview(
    input: DesignReviewCommentInput,
    signal?: AbortSignal,
  ): Promise<DesignReviewResult>;
  /** Opens the SSE stream (`GET /api/stream`); the caller reads and closes the body. */
  openStream(lastEventId: string | null, signal: AbortSignal): Promise<ReadableStream<Uint8Array>>;
}

/** Authorization header for the current session, if any (never a cookie, AD-5 rule 2). */
const authHeaders = (token: string | null): Record<string, string> =>
  token === null ? {} : { authorization: `Bearer ${token}` };

export const createEngineClient = (options: EngineClientOptions): EngineClient => {
  const send = async (
    url: string,
    accept: string,
    signal?: AbortSignal,
    extra: Readonly<Record<string, string>> = {},
    body?: string,
  ) => {
    let response: Response;
    try {
      response = await options.fetch(url, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          accept,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...authHeaders(options.getToken()),
          ...extra,
        },
        ...(body === undefined ? {} : { body }),
        credentials: "omit",
        cache: "no-store",
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      if (signal?.aborted === true) throw new ApiError("aborted", "request aborted");
      throw new ApiError("offline", error instanceof Error ? error.message : "network error");
    }
    if (response.ok) return response;
    if (response.status === 401 || response.status === 403) options.onUnauthorized?.();
    const error: unknown = await response.json().catch(() => null);
    const parsed = HttpErrorSchema.safeParse(error);
    if (parsed.success) {
      throw new ApiError(parsed.data.error.code, parsed.data.error.message, response.status);
    }
    throw new ApiError(codeForStatus(response.status), response.statusText, response.status);
  };

  const parse = async <S extends z.ZodType>(
    schema: S,
    route: EngineHttpRouteName,
    response: Response,
  ): Promise<z.infer<S>> => {
    const raw: unknown = await response.json().catch(() => undefined);
    // Tolerant reader (AD-3 rule 2): keys a newer MINOR engine added are dropped, not errors.
    const parsed = parsePersisted(schema, raw);
    if (!parsed.success) {
      throw new ApiError("bad_response", `${route}: response does not match its contract`, 200);
    }
    return parsed.data;
  };

  const read = async <S extends z.ZodType>(
    schema: S,
    route: EngineHttpRouteName,
    params: RouteParams,
    query: RouteQuery,
    signal: AbortSignal | undefined,
  ): Promise<z.infer<S>> =>
    parse(schema, route, await send(routeUrl(route, params, query), "application/json", signal));

  return {
    health: (signal) => read(HealthResultSchema, "health", {}, {}, signal),
    status: (signal) => read(StatusResultSchema, "status", {}, {}, signal),
    runs: (signal) => read(RunListSchema, "runs", {}, {}, signal),
    events: (run, after, signal) =>
      read(EventPageSchema, "runEvents", { run }, { after, limit: EVENT_PAGE_LIMIT.max }, signal),
    tasks: (run, signal) => read(TaskListSchema, "tasks", { run }, {}, signal),
    task: (run, task, signal) => read(TaskDetailSchema, "task", { run, task }, {}, signal),
    taskDiff: (run, task, signal) => read(TaskDiffSchema, "taskDiff", { run, task }, {}, signal),
    features: (run, signal) => read(FeatureListSchema, "features", { run }, {}, signal),
    artifact: (run, path, signal) =>
      read(ArtifactContentSchema, "artifact", { run }, { path }, signal),
    graph: (run, scope, task, signal) =>
      read(WorkflowGraphSchema, "graph", { run }, { scope, task }, signal),
    escalations: (run, signal) => read(EscalationListSchema, "escalations", { run }, {}, signal),
    usage: (signal) => read(UsageReportSchema, "usage", {}, {}, signal),
    postDesignReview: async (input, signal) => {
      const valid = DesignReviewCommentInputSchema.safeParse(input);
      if (!valid.success)
        throw new ApiError("bad_request", "the design review comment is not valid");
      const response = await send(
        routeUrl("designReviews"),
        "application/json",
        signal,
        {},
        JSON.stringify(valid.data),
      );
      return parse(DesignReviewResultSchema, "designReviews", response);
    },
    openStream: async (lastEventId, signal) => {
      const response = await send(
        routeUrl("stream"),
        "text/event-stream",
        signal,
        lastEventId === null ? {} : { "last-event-id": lastEventId },
      );
      if (response.body === null) throw new ApiError("bad_response", "stream has no body", 200);
      return response.body;
    },
  };
};
