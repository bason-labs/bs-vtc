/**
 * The real evidence runner script, run by Node through the recorder, `sandboxedEvidenceRunner`
 * and the gate jail (the recording fake sandbox), against a fake Playwright module: the network
 * guard, the video recipe, the init script and binding, the screenshot masks, the scan's verdicts
 * and the signed result, without a browser or a network.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { BrowserPinSchema, SECRET_PATTERNS, type EvidenceCaptureRequest } from "@vtc/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEvidenceRecorder,
  EVIDENCE_PAINT_DEFAULTS,
  sandboxedEvidenceRunner,
  type EvidenceRunnerCall,
} from "../../../src/gates/capture/index.js";
import { GateCommandJail, type GateJailSpec } from "../../../src/gates/sandbox.js";
import type { VisualToolchain } from "../../../src/gates/visual/index.js";
import { tempDir } from "../../helpers/repo.js";
import { NODE, recordingSandbox } from "../fixture.js";

/**
 * A Playwright stand-in. `scenario.json` next to it says, per path, what the page check answers
 * (`texts`, `state`), its child frames (`frames`: the same, or `script: false` for a frame the
 * init script did not run in), a frame that comes and goes during a recording (`transientFrame`)
 * and what the page hands the binding during a recording (`live`). With `fetch`, `goto` really
 * requests the URL and logs the body. Everything the runner asked for is logged to `log.json`.
 */
const FAKE_PLAYWRIGHT = String.raw`
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const scenario = JSON.parse(readFileSync(join(here, "scenario.json"), "utf8"));
const log = { launch: null, contexts: [], routes: [], ws: 0, continued: [], aborted: [], init: [], bindings: [], order: [], screenshots: [], waited: [], videoPathBeforeClose: 0, fetched: [] };
const flush = () => writeFileSync(join(here, "log.json"), JSON.stringify(log));
const PNG = Buffer.from("89504e470d0a1a0a", "hex");
const request = async (ctx, url) => {
  let outcome = { continued: true };
  for (const handler of ctx.routes) {
    outcome = await new Promise((resolve) => handler({
      request: () => ({ url: () => url }),
      continue: async () => { log.continued.push(url); resolve({ continued: true }); },
      abort: async (code) => { log.aborted.push([url, code]); resolve({ aborted: true }); },
    }));
  }
  return outcome;
};
export const chromium = {
  launch: async (o) => {
    log.launch = { executablePath: o.executablePath, headless: o.headless };
    flush();
    return {
      version: () => "140.0.1",
      newContext: async (options = {}) => {
        log.contexts.push(options);
        const ctx = { routes: [], bindings: {}, closed: false, page: null };
        return {
          route: async (pattern, handler) => { log.routes.push(pattern); ctx.routes.push(handler); },
          routeWebSocket: async () => { log.ws += 1; },
          exposeBinding: async (name, fn) => {
            if (ctx.page) throw new Error("binding exposed after the page opened");
            log.order.push("binding");
            log.bindings.push(name);
            ctx.bindings[name] = fn;
          },
          addInitScript: async (script) => {
            if (ctx.page) throw new Error("init script added after the page opened");
            log.order.push("init");
            log.init.push(script);
          },
          newPage: async () => {
            let path = "/";
            const handlers = {};
            const locator = (selector) => {
              const loc = { selector, first: () => loc, waitFor: async () => { if (selector === ".never") throw new Error("Timeout 30000ms exceeded waiting for .never"); } };
              return loc;
            };
            const frame = (spec) => ({
              evaluate: async () => (spec().script === false ? null : { state: spec().state || { painted: true, broken: null }, texts: spec().texts || [], error: null }),
              locator,
              isDetached: () => spec().detached === true,
            });
            const main = frame(() => scenario.pages[path] || {});
            let children = [];
            ctx.page = {
              on: (event, fn) => { handlers[event] = fn; },
              mainFrame: () => main,
              frames: () => [main, ...children.filter((f) => !f.isDetached())],
              goto: async (url) => {
                path = new URL(url).pathname;
                const first = await request(ctx, url);
                for (const extra of scenario.extraRequests || []) await request(ctx, extra);
                if (scenario.fetch) log.fetched.push(await (await fetch(url)).text());
                flush();
                if (first.aborted) throw new Error("net::ERR_BLOCKED_BY_CLIENT");
                children = ((scenario.pages[path] || {}).frames || []).map((f) => frame(() => f));
                for (const child of children) handlers.frameattached?.(child);
                return { status: () => (path === "/missing" ? 404 : 200) };
              },
              locator,
              waitForTimeout: async (ms) => {
                log.waited.push(ms);
                const page = scenario.pages[path] || {};
                if (page.live) await ctx.bindings.__vtcEvidenceText({}, page.live);
                if (page.transientFrame) handlers.frameattached?.(frame(() => ({ detached: true })));
              },
              screenshot: async (o) => {
                log.screenshots.push({ type: o.type, animations: o.animations, caret: o.caret, scale: o.scale, mask: o.mask.map((m) => m.selector), maskColor: o.maskColor });
                flush();
                return PNG;
              },
              video: () => (options.recordVideo ? {
                path: async () => {
                  if (!ctx.closed) { log.videoPathBeforeClose += 1; throw new Error("not written until the context closes"); }
                  return join(options.recordVideo.dir, "page@1.webm");
                },
              } : null),
            };
            return ctx.page;
          },
          close: async () => {
            ctx.closed = true;
            if (options.recordVideo) {
              mkdirSync(options.recordVideo.dir, { recursive: true });
              writeFileSync(join(options.recordVideo.dir, "page@1.webm"), "WEBM-" + options.recordVideo.size.width + "x" + options.recordVideo.size.height);
            }
            flush();
          },
        };
      },
      close: async () => undefined,
    };
  },
};
`;

const pin = BrowserPinSchema.parse({
  v: 1,
  source: "vtc",
  name: "chromium",
  version: "140.0.1",
  playwright_core_version: "1.59.0",
  executable: "/fake/chrome-headless-shell",
  executable_sha256: "b".repeat(64),
  installed_at: "2026-10-01T00:00:00.000Z",
});

const GITHUB_TOKEN = `ghp_${"x".repeat(36)}`;

const fakeTools = (scenario: object): string => {
  const tools = join(tempDir("vtc-evidence-tools-"), "tools");
  mkdirSync(tools);
  writeFileSync(join(tools, "playwright.mjs"), FAKE_PLAYWRIGHT);
  writeFileSync(join(tools, "scenario.json"), JSON.stringify(scenario));
  return tools;
};

const setup = (
  scenario: object,
  options: { kind?: "bwrap"; repoRoot?: string; origin?: string } = {},
) => {
  const dir = tempDir("vtc-evidence-script-");
  const tools = fakeTools(scenario);
  const toolchain: VisualToolchain = {
    source: "vtc",
    playwright: join(tools, "playwright.mjs"),
    playwrightVersion: "1.59.0",
    axe: null,
    pixelmatch: null,
    browsersPath: tools,
    readable: [tools],
  };
  const recording = recordingSandbox(options.kind);
  const recorder = createEvidenceRecorder(
    {
      vtcHome: join(dir, "home"),
      sandbox: recording.sandbox,
      ...(options.repoRoot === undefined ? {} : { repoRoot: options.repoRoot }),
    },
    {
      node: NODE,
      env: { PATH: process.env.PATH ?? "" },
      toolchain: () => toolchain,
      checkBrowser: () => Promise.resolve({ ok: true, pin }),
    },
  );
  const outDir = join(dir, "staging");
  const log = () =>
    JSON.parse(readFileSync(join(tools, "log.json"), "utf8")) as {
      launch: { executablePath: string; headless: boolean };
      contexts: { viewport: object; recordVideo?: { dir: string; size: object } }[];
      routes: string[];
      ws: number;
      continued: string[];
      aborted: [string, string][];
      init: string[];
      bindings: string[];
      order: string[];
      screenshots: {
        mask: string[];
        maskColor: string;
        animations: string;
        caret: string;
        type: string;
      }[];
      waited: number[];
      videoPathBeforeClose: number;
      fetched: string[];
    };
  const request = (extra: Partial<EvidenceCaptureRequest> = {}): EvidenceCaptureRequest => ({
    origin: options.origin ?? "http://127.0.0.1:45678",
    outDir,
    shots: [
      {
        name: "01-replay.webm",
        kind: "replay_video",
        path: "/clean",
        viewport: { width: 1280, height: 800 },
        videoSeconds: 2,
        waitFor: "[data-flow]",
      },
      {
        name: "02-gates.png",
        kind: "gate_report",
        path: "/clean",
        viewport: { width: 1024, height: 768 },
      },
    ],
    redactSelectors: [".prompt-text"],
    denyText: ["acme-client"],
    ...extra,
  });
  return { recorder, request, outDir, log, specs: recording.specs };
};

describe("evidence runner script (AD-27 rule 6)", () => {
  it("records a video and a screenshot with the recipe, and returns them signed", async () => {
    const { recorder, request, outDir, log, specs } = setup({
      pages: { "/clean": { texts: ["Run R1", "all gates pass"] } },
      extraRequests: ["https://fonts.example.com/inter.woff2", "http://127.0.0.1:45678/api/runs"],
    });
    const result = await recorder.capture(request());
    expect(result.failed).toEqual([]);
    expect(result.files.map((f) => f.name)).toEqual(["01-replay.webm", "02-gates.png"]);
    // The recording exists only after the context closed, at the explicit size.
    expect(readFileSync(join(outDir, "01-replay.webm"), "utf8")).toBe("WEBM-1280x800");
    const l = log();
    expect(l.videoPathBeforeClose).toBe(0);
    expect(l.launch).toEqual({ executablePath: "/fake/chrome-headless-shell", headless: true });
    expect(l.contexts[0]?.recordVideo?.size).toEqual({ width: 1280, height: 800 });
    expect(l.contexts[1]?.recordVideo).toBeUndefined();
    expect(l.contexts[1]?.viewport).toEqual({ width: 1024, height: 768 });
    expect(l.waited).toEqual([2000]);
    // Only the origin is reached: everything else is aborted, WebSockets routed too.
    expect(l.routes).toEqual(["**/*", "**/*"]);
    expect(l.ws).toBe(2);
    expect(l.aborted).toContainEqual(["https://fonts.example.com/inter.woff2", "blockedbyclient"]);
    expect(l.continued).toContain("http://127.0.0.1:45678/api/runs");
    expect(l.continued.every((u) => u.startsWith("http://127.0.0.1:45678/"))).toBe(true);
    // The binding (video only) and the paint script are in place before the page opens.
    expect(l.bindings).toEqual(["__vtcEvidenceText"]);
    expect(l.order).toEqual(["binding", "init", "init"]);
    expect(l.init[0]).toContain(".prompt-text");
    expect(l.init[0]).toContain("[data-vtc-redact]");
    // Screenshots mask the painted selectors in the paint colour, animations and caret off.
    expect(l.screenshots).toEqual([
      {
        type: "png",
        animations: "disabled",
        caret: "hide",
        scale: "css",
        mask: ["[data-vtc-redact]", "[data-vtc-secret]", "input[type=password]", ".prompt-text"],
        maskColor: "#1f1f1f",
      },
    ]);
    // Verify phase, only the origin's port of the loopback.
    expect(specs[0]).toMatchObject({ phase: "verify", loopbackPorts: [45678] });
  });

  it("discards a screenshot whose page shows a secret or a denied value, naming only the kind", async () => {
    const { recorder, request, outDir } = setup({
      pages: {
        "/secret": { texts: ["token", `deploy with ${GITHUB_TOKEN}`] },
        "/denied": { texts: ["Project ACME-CLIENT dashboard"] },
      },
    });
    const shots = ["/secret", "/denied"].map((path, i) => ({
      name: `0${String(i + 1)}-page.png`,
      kind: "screenshot" as const,
      path,
      viewport: { width: 1280, height: 800 },
    }));
    const result = await recorder.capture(request({ shots }));
    expect(result.files).toEqual([]);
    expect(result.failed).toEqual([
      {
        name: "01-page.png",
        reason: "the redaction scan found github_token on the page, so the file was discarded",
      },
      {
        name: "02-page.png",
        reason: "the redaction scan found denied_text on the page, so the file was discarded",
      },
    ]);
    expect(JSON.stringify(result)).not.toContain(GITHUB_TOKEN);
    expect(JSON.stringify(result).toLowerCase()).not.toContain("acme-client");
    expect(() => readFileSync(join(outDir, "01-page.png"))).toThrow();
  });

  it("matches a denied value as a substring, however short (any hit discards)", async () => {
    const { recorder, request } = setup({
      pages: {
        "/word": { texts: ["Open the Acme UI"] },
        "/inside": { texts: ["build passed"] },
        "/clean": { texts: ["all gates pass"] },
      },
    });
    const shots = ["/word", "/inside", "/clean"].map((path, i) => ({
      name: `0${String(i + 1)}-page.png`,
      kind: "screenshot" as const,
      path,
      viewport: { width: 1280, height: 800 },
    }));
    const result = await recorder.capture(request({ shots, denyText: ["ui"] }));
    expect(result.files.map((f) => f.name)).toEqual(["03-page.png"]);
    expect(result.failed.map((f) => f.name)).toEqual(["01-page.png", "02-page.png"]);
  });

  it("scans every frame of the page, and fails a frame it cannot vouch for", async () => {
    const { recorder, request, outDir, log } = setup({
      pages: {
        "/token": {
          texts: ["Run R1"],
          frames: [{ texts: ["calm"] }, { texts: [`srcdoc frame ${GITHUB_TOKEN}`] }],
        },
        "/denied": { texts: ["Run R1"], frames: [{ texts: ["the acme-client prototype"] }] },
        "/noscript": { texts: ["Run R1"], frames: [{ script: false }] },
        "/unpainted": {
          texts: ["Run R1"],
          frames: [
            {
              state: {
                painted: false,
                broken: "the redaction stylesheet was removed from the page",
              },
            },
          ],
        },
        "/framed": { texts: ["Run R1"], frames: [{ texts: ["chart"] }] },
      },
    });
    const shots = ["/token", "/denied", "/noscript", "/unpainted", "/framed"].map((path, i) => ({
      name: `0${String(i + 1)}-page.png`,
      kind: "screenshot" as const,
      path,
      viewport: { width: 1280, height: 800 },
    }));
    const result = await recorder.capture(request({ shots }));
    expect(result.files.map((f) => f.name)).toEqual(["05-page.png"]);
    expect(Object.fromEntries(result.failed.map((f) => [f.name, f.reason]))).toEqual({
      "01-page.png": "the redaction scan found github_token on the page, so the file was discarded",
      "02-page.png": "the redaction scan found denied_text on the page, so the file was discarded",
      "03-page.png": "the redaction script did not run in a frame of the page",
      "04-page.png":
        "redaction is not in force in a frame of the page: the redaction stylesheet was removed from the page",
    });
    expect(() => readFileSync(join(outDir, "01-page.png"))).toThrow();
    // Screenshots mask in every frame.
    expect(log().screenshots.at(-1)?.mask).toEqual([
      "[data-vtc-redact]",
      "[data-vtc-secret]",
      "input[type=password]",
      ".prompt-text",
      "[data-vtc-redact]",
      "[data-vtc-secret]",
      "input[type=password]",
      ".prompt-text",
    ]);
  });

  it("fails a recording in which a frame came and went before it could be scanned", async () => {
    const { recorder, request } = setup({
      pages: { "/blink": { texts: ["calm"], transientFrame: true } },
    });
    const result = await recorder.capture(
      request({
        shots: [
          {
            name: "01-replay.webm",
            kind: "replay_video",
            path: "/blink",
            viewport: { width: 1280, height: 800 },
            videoSeconds: 1,
          },
        ],
      }),
    );
    expect(result.files).toEqual([]);
    expect(result.failed).toEqual([
      { name: "01-replay.webm", reason: "a frame was removed before its text could be scanned" },
    ]);
  });

  it("discards a recording when text that appeared during it matched", async () => {
    const { recorder, request, outDir } = setup({
      pages: {
        "/live": { texts: ["calm now"], live: ["streamed", `key sk-ant-${"k".repeat(30)}`] },
      },
    });
    const result = await recorder.capture(
      request({
        shots: [
          {
            name: "01-replay.webm",
            kind: "replay_video",
            path: "/live",
            viewport: { width: 1280, height: 800 },
            videoSeconds: 1,
          },
        ],
      }),
    );
    expect(result.files).toEqual([]);
    expect(result.failed[0]?.reason).toMatch(
      /^the redaction scan found anthropic_key(, openai_key)? on the page, so the file was discarded$/,
    );
    expect(() => readFileSync(join(outDir, "01-replay.webm"))).toThrow();
  });

  it("fails closed when the paint is not in force, the page is missing, or waitFor never shows", async () => {
    const { recorder, request } = setup({
      pages: {
        "/broken": {
          state: {
            painted: false,
            broken: "a redact selector is not valid CSS, so nothing could be painted",
          },
        },
      },
    });
    const base = { kind: "screenshot" as const, viewport: { width: 1280, height: 800 } };
    const result = await recorder.capture(
      request({
        shots: [
          { ...base, name: "01-broken.png", path: "/broken" },
          { ...base, name: "02-missing.png", path: "/missing" },
          { ...base, name: "03-wait.png", path: "/clean", waitFor: ".never" },
        ],
      }),
    );
    expect(result.files).toEqual([]);
    expect(Object.fromEntries(result.failed.map((f) => [f.name, f.reason]))).toEqual({
      "01-broken.png":
        "redaction is not in force: a redact selector is not valid CSS, so nothing could be painted",
      "02-missing.png": "HTTP 404 for /missing",
      "03-wait.png": "Timeout 30000ms exceeded waiting for .never",
    });
  });
});

/** A loopback port nothing listens on (just now). */
const freePort = async (): Promise<number> => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) =>
    server.close(() => {
      resolve();
    }),
  );
  return port;
};

describe("evidence runner script on Linux: the socket relay (bwrap)", () => {
  const savedTmp = process.env.TMPDIR;
  afterEach(() => {
    if (savedTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = savedTmp;
  });

  it("asks for the relay instead of a host port, and hides the repo's state from the browser", async () => {
    const repo = tempDir("vtc-evidence-repo-");
    const port = await freePort();
    const { recorder, request, specs } = setup(
      { pages: { "/clean": { texts: ["all gates pass"] } } },
      { kind: "bwrap", repoRoot: repo, origin: `http://127.0.0.1:${String(port)}` },
    );
    const result = await recorder.capture(request());
    expect(result.failed).toEqual([]);
    expect(specs[0]?.phase).toBe("verify");
    expect(specs[0]).not.toHaveProperty("loopbackPorts");
    const spec = specs[0] as GateJailSpec | undefined;
    expect(spec?.hideRead).toContain(join(repo, ".vtc", "state"));
    expect(spec?.denyRead).toContain(join(repo, ".vtc", "evidence"));
  });

  const relayCall = (tools: string, origin: number, port: number): EvidenceRunnerCall => ({
    input: {
      v: 1,
      playwright: join(tools, "playwright.mjs"),
      executable: "/fake/chrome-headless-shell",
      origin: `http://127.0.0.1:${String(origin)}`,
      relay: true,
      video_size: { width: 1280, height: 800 },
      nav_timeout_ms: 30_000,
      paint: [...EVIDENCE_PAINT_DEFAULTS],
      mask: [...EVIDENCE_PAINT_DEFAULTS],
      mask_color: "#1f1f1f",
      patterns: SECRET_PATTERNS.map((p) => ({
        kind: p.kind,
        source: p.pattern.source,
        flags: p.pattern.flags,
      })),
      deny_text: [],
      max_scan_chars: 100_000,
      shots: [{ name: "01-page.png", path: "/hello", width: 1280, height: 800 }],
    },
    allowRead: [tools],
    port,
    env: { PATH: process.env.PATH ?? "" },
    timeoutMs: 60_000,
  });

  it("reaches the host's origin port only through <tmp>/relay.sock", async () => {
    // The sandbox's loopback is its own on Linux; here the script's relay listens on one port and
    // the recorder forwards relay.sock to another, so the two ends are told apart.
    const server = createHttpServer((req, res) => {
      res.end(`hello from the origin at ${req.url ?? ""}`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const hostPort = (server.address() as AddressInfo).port;
      const tools = fakeTools({ pages: { "/hello": { texts: ["hello"] } }, fetch: true });
      const recording = recordingSandbox("bwrap");
      const jail = new GateCommandJail(recording.sandbox, []);
      try {
        const call = relayCall(tools, await freePort(), hostPort);
        const outcome = await sandboxedEvidenceRunner(jail, NODE).run(call);
        expect(outcome.ok).toBe(true);
        if (outcome.ok) expect(outcome.result.shots[0]?.status).toBe("captured");
        const log = JSON.parse(readFileSync(join(tools, "log.json"), "utf8")) as {
          fetched: string[];
        };
        expect(log.fetched).toEqual(["hello from the origin at /hello"]);
        expect(recording.specs[0]).not.toHaveProperty("loopbackPorts");
      } finally {
        jail.dispose();
      }
    } finally {
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
    }
  });

  it("fails the capture, not the engine, when the relay socket cannot be bound", async () => {
    const long = join(tempDir("vtc-evidence-long-"), "d".repeat(60), "e".repeat(60));
    mkdirSync(long, { recursive: true });
    process.env.TMPDIR = long;
    const tools = fakeTools({ pages: { "/hello": { texts: ["hello"] } } });
    const jail = new GateCommandJail(recordingSandbox("bwrap").sandbox, []);
    try {
      const call = relayCall(tools, await freePort(), await freePort());
      const outcome = await sandboxedEvidenceRunner(jail, NODE).run(call);
      expect(outcome).toEqual({
        ok: false,
        reason: expect.stringMatching(/relay socket path is longer than 107 bytes/) as unknown,
      });
    } finally {
      jail.dispose();
    }
  });
});
