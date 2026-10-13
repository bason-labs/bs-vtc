/**
 * AD-5 Check (sub-project 1): the HTTP tests that must pass before the server ships, plus SSE,
 * design-review pins, snapshot mode and static serving of `fixtures/dashboard-export/` (AD-20).
 */
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ENGINE_SESSION,
  HttpErrorSchema,
  PROTOTYPE_CSP,
  type AssetBundle,
  type AssetNamespace,
  type VtcEvent,
} from "@vtc/shared";
import { createReadModel, loadRuns } from "../../src/core/index.js";
import {
  createHttpApi,
  createPrototypeServer,
  createSessionStore,
  type HttpApi,
  type PrototypeServer,
} from "../../src/http/index.js";
import { cleanupDirs, tempDir, writeFile } from "../helpers/repo.js";

const INSTALL = "i".repeat(43);
const fixtures = new URL("../../../../fixtures/", import.meta.url);

const servers: (HttpApi | PrototypeServer)[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  cleanupDirs();
});

/** An `AssetBundle` over a directory (what the cli builds in development, AD-20 rule 3). */
const diskBundle = (dir: string): AssetBundle => {
  const files: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else files.push(relative(dir, p).split("\\").join("/"));
    }
  };
  walk(dir);
  return {
    read: (ns: AssetNamespace, path: string) =>
      ns === "dashboard" && files.includes(path)
        ? new Uint8Array(readFileSync(join(dir, path)))
        : undefined,
    list: (ns: AssetNamespace) => (ns === "dashboard" ? [...files].sort() : []),
  };
};

interface Reply {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

const call = (
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string; host?: string } = {},
): Promise<Reply> =>
  new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: options.method ?? "GET",
        headers: { host: options.host ?? `127.0.0.1:${String(port)}`, ...options.headers },
      },
      (res) => {
        let body = "";
        res.on("data", (c: Buffer) => (body += c.toString("utf8")));
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
        });
      },
    );
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });

const auth = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

interface Setup {
  readonly api: HttpApi;
  readonly repo: string;
  readonly clock: { now: Date };
  readonly ingested: unknown[];
  emit(event: VtcEvent): void;
}

const setup = async (mode: "live" | "snapshot" = "live"): Promise<Setup> => {
  const repo = tempDir("vtc-http-");
  mkdirSync(join(repo, ".vtc/runs/golden-1"), { recursive: true });
  writeFileSync(
    join(repo, ".vtc/runs/golden-1/events.jsonl"),
    readFileSync(new URL("golden-run/events.jsonl", fixtures)),
  );
  writeFile(repo, ".vtc/spec/spec.md", "# spec\n");
  writeFile(repo, ".vtc/state/secret.txt", "raw output\n");
  const runs = loadRuns(repo).map((r) => r.state);
  const clock = { now: new Date("2026-10-13T10:00:00.000Z") };
  const listeners = new Set<(e: VtcEvent) => void>();
  const ingested: unknown[] = [];
  const readModel = createReadModel({
    repoRoot: repo,
    mode,
    versions: { engine: "0.0.0", contracts: "4.0.0" },
    prototypeUrl: () => null,
    runs: () => runs,
    usage: () => new Map(),
    git: null,
  });
  const api = await createHttpApi({
    readModel,
    installToken: INSTALL,
    sessions: createSessionStore(() => clock.now),
    assets: diskBundle(new URL("dashboard-export/", fixtures).pathname),
    repoRoot: repo,
    ingest: mode === "live" ? (body) => ingested.push(body) : null,
    subscribe:
      mode === "live"
        ? (l) => {
            listeners.add(l);
            return () => listeners.delete(l);
          }
        : null,
    secrets: () => ["hunter2-is-secret"],
    now: () => clock.now,
  });
  servers.push(api);
  return {
    api,
    repo,
    clock,
    ingested,
    emit: (e) => {
      for (const l of listeners) l(e);
    },
  };
};

describe("AD-5: localhost hardening", () => {
  it("listens on 127.0.0.1 only", async () => {
    const { api } = await setup();
    expect(api.server.address()).toMatchObject({ address: "127.0.0.1" });
  });
  it("403s a missing or wrong token, a foreign Host and a foreign Origin; a Cookie never authenticates", async () => {
    const { api } = await setup();
    const p = api.port;
    expect((await call(p, "/api/health")).status).toBe(403);
    expect((await call(p, "/api/health", { headers: auth("w".repeat(43)) })).status).toBe(403);
    expect(
      (
        await call(p, "/api/health", {
          headers: { cookie: `session=${INSTALL}; token=${INSTALL}` },
        })
      ).status,
    ).toBe(403);
    expect(
      (await call(p, "/api/health", { headers: auth(INSTALL), host: "evil.example:80" })).status,
    ).toBe(403);
    expect(
      (await call(p, "/api/health", { headers: auth(INSTALL), host: `127.0.0.1:${String(p + 1)}` }))
        .status,
    ).toBe(403);
    expect(
      (
        await call(p, "/api/health", {
          headers: { ...auth(INSTALL), origin: "http://evil.example" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(p, "/api/health", {
          headers: { ...auth(INSTALL), origin: `http://127.0.0.1:${String(p + 1)}` },
        })
      ).status,
    ).toBe(403);
    const ok = await call(p, "/api/health", {
      headers: { ...auth(INSTALL), origin: `http://127.0.0.1:${String(p)}` },
    });
    expect(ok.status).toBe(200);
    expect(
      (await call(p, "/api/health", { headers: auth(INSTALL), host: `localhost:${String(p)}` }))
        .status,
    ).toBe(200);
    const forbidden = await call(p, "/api/status", { headers: { origin: "http://evil.example" } });
    expect(HttpErrorSchema.parse(JSON.parse(forbidden.body)).error.code).toBe("forbidden");
  });
  it("never sends CORS headers or cookies", async () => {
    const { api } = await setup();
    const replies = [
      await call(api.port, "/api/health", { headers: auth(INSTALL) }),
      await call(api.port, "/api/health", { headers: { origin: "http://evil.example" } }),
      await call(api.port, "/api/health", {
        method: "OPTIONS",
        headers: { origin: "http://evil.example", "access-control-request-method": "GET" },
      }),
      await call(api.port, "/"),
    ];
    for (const reply of replies) {
      expect(Object.keys(reply.headers).filter((h) => h.startsWith("access-control-"))).toEqual([]);
      expect(reply.headers["set-cookie"]).toBeUndefined();
    }
  });
  it("browser sessions: a nonce works once and not after 60 s; the install token is no nonce", async () => {
    const { api, clock } = await setup();
    const p = api.port;
    const mint = async (): Promise<string> =>
      (
        JSON.parse(
          (await call(p, "/api/session/nonce", { method: "POST", headers: auth(INSTALL) })).body,
        ) as { nonce: string }
      ).nonce;
    const exchange = (nonce: string) =>
      call(p, "/api/session", {
        method: "POST",
        body: JSON.stringify({ nonce }),
        headers: { "content-type": "application/json" },
      });
    const nonce = await mint();
    const first = await exchange(nonce);
    expect(first.status).toBe(200);
    const { session } = JSON.parse(first.body) as { session: string };
    expect(session).not.toBe(INSTALL);
    expect((await exchange(nonce)).status).toBe(403);
    expect((await exchange(INSTALL)).status).toBe(403);
    const late = await mint();
    clock.now = new Date(clock.now.getTime() + ENGINE_SESSION.nonceTtlMs + 1);
    expect((await exchange(late)).status).toBe(403);
    // the session token reads token routes, but not install routes
    expect((await call(p, "/api/runs", { headers: auth(session) })).status).toBe(200);
    expect(
      (await call(p, "/api/session/nonce", { method: "POST", headers: auth(session) })).status,
    ).toBe(403);
    expect(
      (
        await call(p, "/api/ingest/claude-statusline", {
          method: "POST",
          headers: auth(session),
          body: "{}",
        })
      ).status,
    ).toBe(403);
    clock.now = new Date(clock.now.getTime() + ENGINE_SESSION.sessionTtlMs);
    expect((await call(p, "/api/runs", { headers: auth(session) })).status).toBe(403);
  });
  it("a session token dies with the daemon", async () => {
    const first = await setup();
    const nonce = (
      JSON.parse(
        (
          await call(first.api.port, "/api/session/nonce", {
            method: "POST",
            headers: auth(INSTALL),
          })
        ).body,
      ) as { nonce: string }
    ).nonce;
    const { session } = JSON.parse(
      (
        await call(first.api.port, "/api/session", {
          method: "POST",
          body: JSON.stringify({ nonce }),
        })
      ).body,
    ) as { session: string };
    const second = await setup();
    expect((await call(second.api.port, "/api/runs", { headers: auth(session) })).status).toBe(403);
  });
  it("413s oversized bodies and 400s invalid ones", async () => {
    const { api } = await setup();
    const big = JSON.stringify({
      v: 1,
      session_id: "x".repeat(5000),
      model: null,
      rate_limits: { five_hour: null, seven_day: null },
    });
    expect(
      (
        await call(api.port, "/api/ingest/claude-statusline", {
          method: "POST",
          headers: auth(INSTALL),
          body: big,
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await call(api.port, "/api/session", {
          method: "POST",
          body: "x".repeat(ENGINE_SESSION.maxBodyBytes + 1),
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await call(api.port, "/api/ingest/claude-statusline", {
          method: "POST",
          headers: auth(INSTALL),
          body: '{"v":2}',
        })
      ).status,
    ).toBe(400);
  });
  it("ingests statusline usage in live mode; snapshot mode refuses it", async () => {
    const live = await setup("live");
    const body = JSON.stringify({
      v: 1,
      session_id: "s",
      model: "opus",
      rate_limits: { five_hour: { used_percentage: 41, resets_at: 1760360400 }, seven_day: null },
    });
    expect(
      (
        await call(live.api.port, "/api/ingest/claude-statusline", {
          method: "POST",
          headers: auth(INSTALL),
          body,
        })
      ).status,
    ).toBe(200);
    expect(live.ingested).toHaveLength(1);
    const snapshot = await setup("snapshot");
    const refused = await call(snapshot.api.port, "/api/ingest/claude-statusline", {
      method: "POST",
      headers: auth(INSTALL),
      body,
    });
    expect(HttpErrorSchema.parse(JSON.parse(refused.body)).error.code).toBe("snapshot_mode");
    expect(
      JSON.parse((await call(snapshot.api.port, "/api/health", { headers: auth(INSTALL) })).body),
    ).toMatchObject({ mode: "snapshot" });
  });
  it("appends design-review pins under .vtc/design/reviews/ only, redacted; a path-escaping screen is rejected", async () => {
    const { api, repo } = await setup();
    const pin = {
      screen: "login",
      state: "empty",
      viewport: 1280,
      theme: "light",
      x_pct: 10,
      y_pct: 20,
      comment: "contrast hunter2-is-secret",
    };
    const ok = await call(api.port, "/api/design/reviews", {
      method: "POST",
      headers: auth(INSTALL),
      body: JSON.stringify(pin),
    });
    expect(JSON.parse(ok.body)).toEqual({ ok: true, path: ".vtc/design/reviews/login.jsonl" });
    expect(readFileSync(join(repo, ".vtc/design/reviews/login.jsonl"), "utf8")).toContain(
      "[REDACTED:known_value]",
    );
    for (const screen of ["../../state/x", "a/b", ".."]) {
      const bad = await call(api.port, "/api/design/reviews", {
        method: "POST",
        headers: auth(INSTALL),
        body: JSON.stringify({ ...pin, screen }),
      });
      expect(bad.status).toBe(400);
    }
  });
  it("the artifacts route refuses .vtc/state/, `..`, `.` segments and a symlink leaving .vtc/", async () => {
    const { api, repo } = await setup();
    writeFile(repo, "outside.txt", "outside\n");
    symlinkSync(join(repo, "outside.txt"), join(repo, ".vtc/spec/link.md"));
    symlinkSync(join(repo, ".vtc/state/secret.txt"), join(repo, ".vtc/spec/state-link.md"));
    const get = (path: string) =>
      call(api.port, `/api/runs/golden-1/artifacts?path=${encodeURIComponent(path)}`, {
        headers: auth(INSTALL),
      });
    expect((await get(".vtc/spec/spec.md")).status).toBe(200);
    expect((await get(".vtc/spec/spec.md")).headers["x-content-type-options"]).toBe("nosniff");
    for (const path of [
      ".vtc/state/secret.txt",
      ".vtc/spec/../state/secret.txt",
      ".vtc/./state/secret.txt",
      "../etc/passwd",
      "README.md",
      ".vtc/spec/link.md",
      ".vtc/spec/state-link.md",
    ]) {
      const reply = await get(path);
      expect(reply.status, path).toBeGreaterThanOrEqual(400);
      expect(reply.body).not.toContain("raw output");
      expect(reply.body).not.toContain("outside");
    }
  });
  it("serves every read route of the golden run with its contract", async () => {
    const { api } = await setup();
    const get = async (path: string): Promise<unknown> => {
      const reply = await call(api.port, path, { headers: auth(INSTALL) });
      expect(reply.status, path).toBe(200);
      expect(reply.headers["content-type"]).toBe("application/json; charset=utf-8");
      return JSON.parse(reply.body);
    };
    expect(await get("/api/runs")).toEqual(
      JSON.parse(readFileSync(new URL("golden-run/api/runs.json", fixtures), "utf8")),
    );
    expect(await get("/api/status")).toMatchObject({ run: { id: "golden-1" } });
    expect(await get("/api/runs/golden-1/tasks/T-2")).toMatchObject({
      task: { id: "T-2", status: "parked" },
    });
    expect(await get("/api/runs/golden-1/graph?scope=task&task=T-2")).toEqual(
      JSON.parse(readFileSync(new URL("golden-run/api/graph-task-T-2.json", fixtures), "utf8")),
    );
    expect(await get("/api/runs/golden-1/events?after=40&limit=2")).toMatchObject({
      next_after: 42,
    });
    expect((await call(api.port, "/api/runs/nope/tasks", { headers: auth(INSTALL) })).status).toBe(
      404,
    );
    expect((await call(api.port, "/api/nope", { headers: auth(INSTALL) })).status).toBe(404);
    expect(
      (await call(api.port, "/api/runs/golden-1/tasks/T-1/diff", { headers: auth(INSTALL) }))
        .status,
    ).toBe(404);
  });
  it("streams events over SSE with ids run:seq and resumes from Last-Event-ID", async () => {
    const setupResult = await setup();
    const { api } = setupResult;
    const lines: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: api.port,
          path: "/api/stream",
          headers: {
            host: `127.0.0.1:${String(api.port)}`,
            ...auth(INSTALL),
            "last-event-id": "golden-1:42",
          },
        },
        (res) => {
          expect(res.headers["content-type"]).toBe("text/event-stream; charset=utf-8");
          res.on("data", (c: Buffer) => {
            lines.push(...c.toString("utf8").split("\n"));
            if (lines.some((l) => l === "id: golden-1:45")) {
              req.destroy();
              resolve();
            }
          });
        },
      );
      req.on("error", (e) => {
        if (!lines.some((l) => l === "id: golden-1:45")) reject(e);
      });
      req.end();
      setTimeout(() => {
        setupResult.emit({
          v: 1,
          seq: 45,
          ts: "2026-10-13T10:00:00.000Z",
          run: "golden-1",
          type: "run.paused",
          actor: "human",
          data: { reason: "x" },
        });
      }, 100);
    });
    expect(lines.filter((l) => l.startsWith("id: "))).toEqual([
      "id: golden-1:43",
      "id: golden-1:44",
      "id: golden-1:45",
    ]);
  });
});

describe("AD-20: static dashboard serving through the AssetBundle", () => {
  it("serves the export with the right headers, deep-link fallback, and 404 for missing scripts", async () => {
    const { api } = await setup();
    const root = await call(api.port, "/");
    expect(root.status).toBe(200);
    expect(root.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(root.headers["cache-control"]).toBe("no-cache");
    const chunk = await call(api.port, "/_next/static/chunks/app-3f9a.js");
    expect(chunk.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect((await call(api.port, "/task/?run=r1&task=T-2")).status).toBe(200);
    expect((await call(api.port, "/flows/deep")).headers["content-type"]).toBe(
      "text/html; charset=utf-8",
    );
    expect((await call(api.port, "/_next/static/chunks/missing.js")).status).toBe(404);
    expect((await call(api.port, "/../package.json")).status).toBe(404);
    expect((await call(api.port, "/", { host: "evil.example" })).status).toBe(403);
  });
});

describe("AD-5 rule 9: the prototype origin", () => {
  it("sends PROTOTYPE_CSP on every response, checks Host and serves no /api/ route", async () => {
    const repo = tempDir("vtc-proto-");
    writeFile(repo, ".vtc/design/prototype/index.html", "<h1>proto</h1>");
    writeFile(repo, ".vtc/state/secret.txt", "raw\n");
    const proto = await createPrototypeServer(repo);
    servers.push(proto);
    const replies = [
      await call(proto.port, "/"),
      await call(proto.port, "/index.html"),
      await call(proto.port, "/api/health"),
      await call(proto.port, "/missing.js"),
      await call(proto.port, "/../../state/secret.txt"),
      await call(proto.port, "/", { host: "evil.example" }),
    ];
    for (const reply of replies)
      expect(reply.headers["content-security-policy"]).toBe(PROTOTYPE_CSP);
    expect(replies.map((r) => r.status)).toEqual([200, 200, 404, 404, 404, 403]);
    expect(replies[0]?.body).toBe("<h1>proto</h1>");
    expect(replies.some((r) => r.body.includes("raw"))).toBe(false);
  });
});
