import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/errors";
import { createEngineClient } from "@/lib/api/client";
import { fixtureFetch } from "../../fixtures";

const client = (overrides?: Parameters<typeof fixtureFetch>[0], token: string | null = null) => {
  const f = fixtureFetch(overrides);
  return { f, api: createEngineClient({ fetch: f.fetch, getToken: () => token }) };
};

describe("createEngineClient against the golden run", () => {
  it("reads and validates every read route", async () => {
    const { api } = client();
    expect((await api.health()).mode).toBe("snapshot");
    expect((await api.runs()).runs[0]?.id).toBe("golden-1");
    expect((await api.status()).run.id).toBe("golden-1");
    expect((await api.tasks("golden-1")).tasks.map((t) => t.id)).toEqual(["T-1", "T-2"]);
    expect((await api.task("golden-1", "T-2")).findings).toHaveLength(1);
    expect((await api.taskDiff("golden-1", "T-1")).files[0]?.path).toBe("src/t-1/store.ts");
    expect((await api.features("golden-1")).features[0]?.status).toBe("building");
    expect((await api.escalations("golden-1")).escalations[0]?.id).toBe("E-1");
    expect((await api.usage()).hosts).toHaveLength(2);
    expect((await api.artifact("golden-1", ".vtc/spec/spec.md")).media_type).toBe("text/markdown");
    expect((await api.graph("golden-1", "project")).nodes).toHaveLength(12);
    expect((await api.graph("golden-1", "task", "T-2")).scope).toBe("task");
    expect((await api.events("golden-1", 0)).events.length).toBeGreaterThan(0);
  });

  it("sends the session token as a bearer header and never a cookie", async () => {
    const { api, f } = client(undefined, "s".repeat(43));
    await api.health();
    const req = f.requests[0]!;
    expect(req.headers.get("authorization")).toBe(`Bearer ${"s".repeat(43)}`);
    expect(req.headers.get("cookie")).toBeNull();
  });

  it("sends no authorization header without a session", async () => {
    const { api, f } = client();
    await api.health();
    expect(f.requests[0]!.headers.get("authorization")).toBeNull();
  });

  it("turns an HttpError body into an ApiError with its code", async () => {
    const { api } = client();
    const err = await api.task("golden-1", "T-9").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 404, code: "not_found" });
  });

  it("reports 401/403 as unauthorized and tells the session owner", async () => {
    const onUnauthorized = vi.fn();
    const f = fixtureFetch({
      "/api/health": () => new Response("{}", { status: 403 }),
    });
    const api = createEngineClient({ fetch: f.fetch, getToken: () => null, onUnauthorized });
    const err = await api.health().catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 403, code: "forbidden" });
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it("rejects a response that breaks its contract", async () => {
    const { api } = client({
      "/api/usage": () => Response.json({ hosts: [{ host: "other" }] }),
    });
    await expect(api.usage()).rejects.toMatchObject({ code: "bad_response" });
  });

  it("tolerates keys a newer engine added (AD-3 rule 2)", async () => {
    const { api } = client({
      "/api/health": () =>
        Response.json({
          ok: true,
          mode: "live",
          engine_version: "1.2.0",
          contracts_version: "4.1.0",
          prototype_url: null,
          added_later: 1,
        }),
    });
    expect((await api.health()).mode).toBe("live");
  });

  it("reports a network failure as offline", async () => {
    const api = createEngineClient({
      fetch: () => Promise.reject(new TypeError("Failed to fetch")),
      getToken: () => null,
    });
    await expect(api.runs()).rejects.toMatchObject({ code: "offline" });
  });
});
