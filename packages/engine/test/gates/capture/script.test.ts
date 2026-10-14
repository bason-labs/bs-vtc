/**
 * The real evidence runner script, run by Node through the recorder, `sandboxedEvidenceRunner`
 * and the gate jail (the recording fake sandbox), against a fake Playwright module: the network
 * guard, the video recipe, the init script and binding, the screenshot masks, the scan's verdicts
 * and the signed result, without a browser or a network.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrowserPinSchema, type EvidenceCaptureRequest } from "@vtc/shared";
import { describe, expect, it } from "vitest";
import { createEvidenceRecorder } from "../../../src/gates/capture/index.js";
import type { VisualToolchain } from "../../../src/gates/visual/index.js";
import { tempDir } from "../../helpers/repo.js";
import { NODE, recordingSandbox } from "../fixture.js";

/**
 * A Playwright stand-in. `scenario.json` next to it says, per path, what the page check answers
 * (`texts`, `state`) and what the page hands the binding during a recording (`live`). Everything
 * the runner asked for is logged to `log.json`.
 */
const FAKE_PLAYWRIGHT = String.raw`
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const scenario = JSON.parse(readFileSync(join(here, "scenario.json"), "utf8"));
const log = { launch: null, contexts: [], routes: [], ws: 0, continued: [], aborted: [], init: [], bindings: [], order: [], screenshots: [], waited: [], videoPathBeforeClose: 0 };
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
            ctx.page = {
              goto: async (url) => {
                path = new URL(url).pathname;
                const main = await request(ctx, url);
                for (const extra of scenario.extraRequests || []) await request(ctx, extra);
                flush();
                if (main.aborted) throw new Error("net::ERR_BLOCKED_BY_CLIENT");
                return { status: () => (path === "/missing" ? 404 : 200) };
              },
              locator: (selector) => {
                const loc = { selector, first: () => loc, waitFor: async () => { if (selector === ".never") throw new Error("Timeout 30000ms exceeded waiting for .never"); } };
                return loc;
              },
              waitForTimeout: async (ms) => {
                log.waited.push(ms);
                const live = (scenario.pages[path] || {}).live;
                if (live) await ctx.bindings.__vtcEvidenceText({}, live);
              },
              evaluate: async () => {
                const page = scenario.pages[path] || {};
                return { state: page.state || { painted: true, broken: null }, texts: page.texts || [], error: null };
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

const setup = (scenario: object) => {
  const dir = tempDir("vtc-evidence-script-");
  const tools = join(dir, "tools");
  mkdirSync(tools);
  writeFileSync(join(tools, "playwright.mjs"), FAKE_PLAYWRIGHT);
  writeFileSync(join(tools, "scenario.json"), JSON.stringify(scenario));
  const toolchain: VisualToolchain = {
    source: "vtc",
    playwright: join(tools, "playwright.mjs"),
    playwrightVersion: "1.59.0",
    axe: null,
    pixelmatch: null,
    browsersPath: tools,
    readable: [tools],
  };
  const recording = recordingSandbox();
  const recorder = createEvidenceRecorder(
    { vtcHome: join(dir, "home"), sandbox: recording.sandbox },
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
    };
  const request = (extra: Partial<EvidenceCaptureRequest> = {}): EvidenceCaptureRequest => ({
    origin: "http://127.0.0.1:45678",
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

  it("matches a denied value shorter than four characters only as a whole word", async () => {
    const { recorder, request } = setup({
      pages: { "/word": { texts: ["Open the Acme UI"] }, "/inside": { texts: ["build passed"] } },
    });
    const shots = ["/word", "/inside"].map((path, i) => ({
      name: `0${String(i + 1)}-page.png`,
      kind: "screenshot" as const,
      path,
      viewport: { width: 1280, height: 800 },
    }));
    const result = await recorder.capture(request({ shots, denyText: ["ui"] }));
    expect(result.files.map((f) => f.name)).toEqual(["02-page.png"]);
    expect(result.failed.map((f) => f.name)).toEqual(["01-page.png"]);
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
