/**
 * Maps an engine HTTP request (AD-5 `ENGINE_HTTP` read routes) to the golden-run fixture file that
 * holds its exact response (`fixtures/golden-run/api/*.json`). Used by the dev fixture server and
 * by the tests, so both serve the same thing. Returns `null` for anything the fixture lacks.
 */
export const GOLDEN_RUN = "golden-1";

/** Artifact paths the fixture holds, by `?path=` value. */
const ARTIFACTS: Readonly<Record<string, string>> = { ".vtc/spec/spec.md": "artifact-spec" };

const TASK_ID = /^T-[1-9]\d*$/;

/** The fixture file name (without `.json`) for `GET <url>`, or `null`. */
export const fixtureNameFor = (method: string, url: string): string | null => {
  if (method !== "GET") return null;
  const { pathname, searchParams } = new URL(url, "http://127.0.0.1");
  if (pathname === "/api/health") return "health";
  if (pathname === "/api/status") return "status";
  if (pathname === "/api/runs") return "runs";
  if (pathname === "/api/usage") return "usage";
  if (pathname === "/api/spend") return "client-spend";
  const parts = pathname.split("/").slice(1);
  if (parts[0] !== "api" || parts[1] !== "runs" || parts[2] !== GOLDEN_RUN) return null;
  const rest = parts.slice(3);
  const [head, task, tail] = rest;
  if (rest.length === 1) {
    switch (head) {
      case "events":
        return "events";
      case "tasks":
        return "tasks";
      case "features":
        return "features";
      case "escalations":
        return "escalations";
      case "artifacts":
        return ARTIFACTS[searchParams.get("path") ?? ""] ?? null;
      case "graph": {
        const scope = searchParams.get("scope");
        if (scope === "project" || scope === "task_dag") return `graph-${scope}`;
        const id = searchParams.get("task") ?? "";
        return scope === "task" && TASK_ID.test(id) ? `graph-task-${id}` : null;
      }
      default:
        return null;
    }
  }
  if (head !== "tasks" || task === undefined || !TASK_ID.test(task)) return null;
  if (rest.length === 2) return `task-${task}`;
  if (rest.length === 3 && tail === "diff") return `task-${task}-diff`;
  return null;
};
