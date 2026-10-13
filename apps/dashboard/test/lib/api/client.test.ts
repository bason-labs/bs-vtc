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

describe("postDesignReview (the dashboard's one write, AD-5 rule 5)", () => {
  const pin = {
    screen: "reset-request",
    state: "empty",
    viewport: 390,
    theme: "light" as const,
    x_pct: 10,
    y_pct: 20,
    comment: "Too tight",
  };

  it("POSTs the validated comment as JSON with the bearer and reads DesignReviewResult", async () => {
    const { api, f } = client(
      {
        "/api/design/reviews": () =>
          Response.json({ ok: true, path: ".vtc/design/reviews/reset-request.jsonl" }),
      },
      "s".repeat(43),
    );
    const result = await api.postDesignReview(pin);
    expect(result.path).toBe(".vtc/design/reviews/reset-request.jsonl");
    const req = f.requests[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe("/api/design/reviews");
    expect(req.headers.get("content-type")).toBe("application/json");
    expect(req.headers.get("authorization")).toBe(`Bearer ${"s".repeat(43)}`);
    expect(JSON.parse(req.body ?? "")).toEqual(pin);
  });

  it("refuses an invalid comment without sending it", async () => {
    const { api, f } = client();
    await expect(api.postDesignReview({ ...pin, screen: "../x" })).rejects.toMatchObject({
      code: "bad_request",
    });
    expect(f.requests).toHaveLength(0);
  });

  it("rejects a result that claims a path outside .vtc/design/reviews/", async () => {
    const { api } = client({
      "/api/design/reviews": () => Response.json({ ok: true, path: ".vtc/spec/spec.md" }),
    });
    await expect(api.postDesignReview(pin)).rejects.toMatchObject({ code: "bad_response" });
  });

  it("passes the engine's refusal through", async () => {
    const { api } = client({
      "/api/design/reviews": () =>
        Response.json(
          { error: { code: "payload_too_large", message: "body over 8192 bytes" } },
          { status: 413 },
        ),
    });
    await expect(api.postDesignReview(pin)).rejects.toMatchObject({
      status: 413,
      code: "payload_too_large",
    });
  });
});
