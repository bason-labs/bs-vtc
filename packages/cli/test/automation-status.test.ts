/**
 * `vtc automation status` (spine AD-27 rule 7, D-ca): the repo's `AutomationReport`
 * (`GET /api/automation`) as text: whether automation is on and why not, the open automatic issues
 * and PRs with their links, and the latest skips. Fakes only: no daemon, gh or GitHub.
 */
import { createServer, type IncomingHttpHeaders } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { AutomationReport, EngineDiscovery } from "@vtc/shared";
import {
  createAutomationCommand,
  formatAutomation,
  type AutomationStatusDeps,
} from "../src/commands/automation.js";
import { getFromEngine } from "../src/engine-http.js";
import { capture, cleanupDirs, initVtcRepo, tempHome } from "./helpers.js";

afterEach(cleanupDirs);

const REPORT: AutomationReport = {
  issues: true,
  prs: true,
  upstream: true,
  upstream_repo: "bason-labs/bs-vtc",
  evidence_hosting: "branch",
  notes: ["ffmpeg is not installed: GIF previews off"],
  items: [
    {
      target: { kind: "project", repo: "acme/shop" },
      kind: "ci_failure",
      fingerprint: "0123456789abcdef",
      issue: { number: 12, url: "https://github.com/acme/shop/issues/12", state: "open" },
      pr: {
        number: 13,
        url: "https://github.com/acme/shop/pull/13",
        state: "draft",
        evidence: "partial",
      },
      first_at: "2026-10-14T08:00:00.000Z",
      last_at: "2026-10-14T09:00:00.000Z",
    },
    {
      target: { kind: "upstream", repo: "bason-labs/bs-vtc" },
      kind: "lookback",
      fingerprint: "fedcba9876543210",
      issue: null,
      pr: {
        number: 7,
        url: "https://github.com/bason-labs/bs-vtc/pull/7",
        state: "open",
        evidence: "complete",
      },
      first_at: "2026-10-13T08:00:00.000Z",
      last_at: "2026-10-13T08:00:00.000Z",
    },
    {
      target: { kind: "project", repo: "acme/shop" },
      kind: "parked",
      fingerprint: "aaaaaaaaaaaaaaaa",
      issue: { number: 3, url: "https://github.com/acme/shop/issues/3", state: "closed" },
      pr: null,
      first_at: "2026-10-01T08:00:00.000Z",
      last_at: "2026-10-02T08:00:00.000Z",
    },
  ],
  skipped: [
    {
      at: "2026-10-14T07:00:00.000Z",
      reason: "rate_limit",
      kind: "defect",
      detail: "5 new issues today in bason-labs/bs-vtc",
    },
    {
      at: "2026-10-14T10:00:00.000Z",
      reason: "privacy",
      detail: "a project path in the report\u001b[2J",
    },
  ],
};

describe("formatAutomation", () => {
  it("prints on/off with notes, the open items with links, and the latest skips first", () => {
    expect(formatAutomation(REPORT)).toEqual([
      "Automation: issues on, PRs on, upstream reports to bason-labs/bs-vtc on; evidence hosting branch",
      "  note: ffmpeg is not installed: GIF previews off",
      "Open (2; 1 closed not shown):",
      "  acme/shop ci_failure 01234567: issue #12 open https://github.com/acme/shop/issues/12; PR #13 draft, evidence partial https://github.com/acme/shop/pull/13",
      "  bason-labs/bs-vtc (upstream) lookback fedcba98: PR #7 open, evidence complete https://github.com/bason-labs/bs-vtc/pull/7",
      "Recent skips (2):",
      "  2026-10-14T10:00:00.000Z privacy: a project path in the report\\u001b[2J",
      "  2026-10-14T07:00:00.000Z rate_limit (defect): 5 new issues today in bason-labs/bs-vtc",
    ]);
  });

  it("says when nothing is open or skipped, and keeps only the 10 latest skips", () => {
    const quiet = formatAutomation({
      ...REPORT,
      issues: false,
      prs: false,
      upstream: false,
      notes: [],
      items: [],
      skipped: Array.from({ length: 12 }, (_, i) => ({
        at: `2026-10-14T${String(i).padStart(2, "0")}:00:00.000Z`,
        reason: "paused" as const,
        detail: `skip ${String(i)}`,
      })),
    });
    expect(quiet[0]).toBe(
      "Automation: issues off, PRs off, upstream reports to bason-labs/bs-vtc off; evidence hosting branch",
    );
    expect(quiet[1]).toBe("Open: none");
    expect(quiet[2]).toBe("Recent skips (10 of 12):");
    expect(quiet[3]).toBe("  2026-10-14T11:00:00.000Z paused: skip 11");
    expect(quiet).toHaveLength(13);
    expect(formatAutomation({ ...REPORT, skipped: [] }).at(-1)).toBe("Recent skips: none");
  });
});

const DISCOVERY = { port: 4321 } as EngineDiscovery;

const deps = (
  answer: { status: number; body: string },
  seen: string[] = [],
): (() => AutomationStatusDeps) => {
  return () => ({
    discover: (vtcHome, repoRoot) => {
      seen.push(`discover ${vtcHome} ${repoRoot}`);
      return Promise.resolve(DISCOVERY);
    },
    token: () => "t".repeat(43),
    get: (port, path, token) => {
      seen.push(`get ${String(port)} ${path} ${token.slice(0, 3)}`);
      return Promise.resolve(answer);
    },
  });
};

describe("vtc automation status", () => {
  it("reads GET /api/automation from the repo's engine with the install token", async () => {
    const repo = initVtcRepo();
    const home = tempHome();
    const seen: string[] = [];
    const { ctx, out } = capture(repo, home);
    const code = await createAutomationCommand(
      deps({ status: 200, body: JSON.stringify(REPORT) }, seen),
    ).run(["status"], ctx);
    expect(code).toBe(0);
    expect(seen).toEqual([`discover ${home} ${repo}`, "get 4321 /api/automation ttt"]);
    expect(out[0]).toMatch(/^Automation: issues on/);
    const json = capture(repo, home);
    expect(
      await createAutomationCommand(deps({ status: 200, body: JSON.stringify(REPORT) })).run(
        ["status", "--json"],
        json.ctx,
      ),
    ).toBe(0);
    expect(JSON.parse(json.out.join("\n"))).toEqual(REPORT);
  });

  it("explains an engine without the route, an error and a report that does not parse", async () => {
    const repo = initVtcRepo();
    const home = tempHome();
    const run = async (answer: { status: number; body: string }) => {
      const { ctx, err } = capture(repo, home);
      const code = await createAutomationCommand(deps(answer)).run(["status"], ctx);
      return { code, err: err.join("\n") };
    };
    expect(await run({ status: 404, body: "" })).toEqual({
      code: 1,
      err: "vtc automation: the running engine has no automation report (it predates contracts 5.0.0): run vtc engine --stop in this repo, then try again",
    });
    expect((await run({ status: 0, body: "" })).err).toBe(
      "vtc automation: the engine on port 4321 did not answer",
    );
    expect((await run({ status: 500, body: "" })).err).toBe(
      "vtc automation: the engine answered HTTP 500 for /api/automation",
    );
    expect((await run({ status: 200, body: '{"issues":"yes"}' })).err).toMatch(
      /^vtc automation: the engine's automation report does not parse: /,
    );
  });

  it("refuses other subcommands and a repo vtc init never set up", async () => {
    const home = tempHome();
    const usage = capture(initVtcRepo(), home);
    expect(await createAutomationCommand(deps({ status: 200, body: "" })).run([], usage.ctx)).toBe(
      64,
    );
    expect(usage.err.join("\n")).toMatch(/usage: vtc automation status \[--json\]/);
    const other = capture(initVtcRepo(), home);
    expect(
      await createAutomationCommand(deps({ status: 200, body: "" })).run(["open"], other.ctx),
    ).toBe(64);
  });
});

describe("getFromEngine", () => {
  const servers: { close: () => void }[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
  });

  it("GETs with the bearer and the engine's own Host, and reads bodies past 64 KiB", async () => {
    let headers: IncomingHttpHeaders = {};
    let method = "";
    const big = "x".repeat(200 * 1024);
    const server = createServer((req, res) => {
      headers = req.headers;
      method = req.method ?? "";
      res.end(big);
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const response = await getFromEngine(port, "/api/automation", "secret-token");
    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(big.length);
    expect(method).toBe("GET");
    expect(headers.authorization).toBe("Bearer secret-token");
    expect(headers.host).toBe(`127.0.0.1:${String(port)}`);
    expect(headers.origin).toBeUndefined();
  });

  it("answers status 0 when nothing listens", async () => {
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    await new Promise<void>((r) => {
      server.close(() => {
        r();
      });
    });
    expect(await getFromEngine(port, "/api/automation", "t")).toEqual({ status: 0, body: "" });
  });
});
