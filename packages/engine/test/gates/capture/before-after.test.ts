/**
 * UI before/after evidence (D-ct; spine §5 reading 223): `EvidenceRecorder.captureBeforeAfter`
 * end to end on a real git repo, with real install, build and app-server processes (small Node
 * scripts), the real evidence runner script through `sandboxedEvidenceRunner` and the recording
 * fake sandbox, and a fake Playwright module that fetches each page from the fake app server. No
 * browser, no network beyond the loopback, nothing downloaded.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import {
  BrowserPinSchema,
  EVIDENCE_LIMITS,
  EvidenceFileNameSchema,
  type BeforeAfterRequest,
  type GatesConfigInput,
  type GateSandbox,
} from "@vtc/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  BEFORE_AFTER_FILE_LIMIT_REASON,
  BEFORE_AFTER_LOGS_KEPT,
  BEFORE_AFTER_NO_UNSANDBOXED,
  BEFORE_AFTER_OTHER_REPO,
  BEFORE_AFTER_STATE_DIR,
  buildGatesOf,
  captureBeforeAfter,
  createEvidenceRecorder,
  EVIDENCE_PTRACE_REFUSAL,
  sandboxedEvidenceRunner,
  type BeforeAfterContext,
  type CaptureTarget,
  type EvidenceRecorderDeps,
  type EvidenceRecorderOptions,
} from "../../../src/gates/capture/index.js";
import { parseGatesConfig } from "../../../src/gates/config.js";
import { GateCommandJail } from "../../../src/gates/sandbox.js";
import { addToAllowlist } from "../../../src/gates/index.js";
import { CHECKOUTS_DIR, createGitOps } from "../../../src/git/index.js";
import { cleanupDirs, git, initRepo, tempDir, writeFile } from "../../helpers/repo.js";
import { commitAll, config, NODE, recordingSandbox } from "../fixture.js";

afterEach(cleanupDirs);

/**
 * A Playwright stand-in: `goto` really fetches the page from the app server, the page's text is
 * what it served, a screenshot is a PNG header followed by that text and a recording is "WEBM "
 * and that text. Every context and page is appended to `log.jsonl` next to it.
 */
const FAKE_PLAYWRIGHT = String.raw`
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const log = (entry) => appendFileSync(join(here, "log.jsonl"), JSON.stringify(entry) + "\n");
const PNG = Buffer.from("89504e470d0a1a0a", "hex");
export const chromium = {
  launch: async () => ({
    version: () => "140.0.1",
    close: async () => undefined,
    newContext: async (options = {}) => {
      const routes = [];
      let body = "";
      let initConfig = null;
      // A selector with "missing" in it never shows: a flow step on it fails.
      const locator = (selector) => ({
        first() { return this; },
        waitFor: async () => { log({ wait_for: selector }); if (String(selector).includes("missing")) throw new Error("Timeout exceeded"); },
        click: async () => { if (String(selector).includes("missing")) throw new Error("Timeout exceeded"); log({ click: selector }); },
        fill: async (value) => { if (String(selector).includes("missing")) throw new Error("Timeout exceeded"); log({ fill: selector, value }); },
      });
      const frame = {
        evaluate: async () => ({ state: { painted: true, broken: null }, texts: [body], error: null }),
        locator,
        isDetached: () => false,
      };
      const page = {
        on: () => undefined,
        mainFrame: () => frame,
        frames: () => [frame],
        locator,
        goto: async (url) => {
          for (const handler of routes) {
            let aborted = false;
            await handler({ request: () => ({ url: () => url }), continue: async () => undefined, abort: async () => { aborted = true; } });
            if (aborted) throw new Error("net::ERR_BLOCKED_BY_CLIENT");
          }
          const response = await fetch(url);
          body = await response.text();
          log({ goto: url, body, viewport: options.viewport, colorScheme: options.colorScheme ?? null, video: Boolean(options.recordVideo), paint: initConfig && initConfig.paint });
          return { status: () => response.status };
        },
        waitForTimeout: async (ms) => { log({ waited: ms }); },
        keyboard: { press: async (key) => { log({ press: key }); } },
        screenshot: async (o) => { log({ mask: o.mask.length }); return Buffer.concat([PNG, Buffer.from(body)]); },
        video: () => (options.recordVideo ? { path: async () => join(options.recordVideo.dir, "v.webm") } : null),
      };
      return {
        route: async (_pattern, handler) => { routes.push(handler); },
        routeWebSocket: async () => undefined,
        exposeBinding: async () => undefined,
        addInitScript: async (script) => { initConfig = JSON.parse(script.slice(script.lastIndexOf(")(") + 2, -2)); },
        newPage: async () => page,
        close: async () => {
          if (options.recordVideo) {
            mkdirSync(options.recordVideo.dir, { recursive: true });
            writeFileSync(join(options.recordVideo.dir, "v.webm"), "WEBM " + body);
          }
        },
      };
    },
  }),
};
`;

/** Install marks node_modules; build needs it and writes dist/ from src/page.txt ("broken" fails). */
const TOOLS: Record<string, string> = {
  "tools/install.mjs": `import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync("node_modules", { recursive: true });
writeFileSync("node_modules/.installed", "yes");
`,
  "tools/build.mjs": `import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
if (!existsSync("node_modules/.installed")) process.exit(4);
const page = readFileSync("src/page.txt", "utf8").trim();
if (page === "broken") process.exit(2);
mkdirSync("dist", { recursive: true });
writeFileSync("dist/index.html", page);
`,
  // Serves dist/index.html (and the path it was asked for); "crash" in src/mode.txt exits at once.
  "tools/serve.mjs": `import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
const mode = readFileSync("src/mode.txt", "utf8").trim();
if (mode === "crash") process.exit(3);
// "snoop": project code looking for the evidence runner's input (its denied values) beside it.
const input = join(process.env.TMPDIR ?? "/nowhere", "input.json");
const snoop = mode === "snoop" ? (existsSync(input) ? " input visible" : " input gone") : "";
const body = readFileSync("dist/index.html", "utf8") + snoop;
createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  // "once": answers the readiness check and one page, then stops mid-capture.
  const last = mode === "once" && req.url !== "/";
  res.end(body + " at " + req.url, () => { if (last) process.exit(0); });
}).listen(Number(process.argv[2]), "127.0.0.1");
`,
  "tools/never.mjs": `process.exit(9);\n`,
  // A build gate that looks for what an earlier command of the capture left: another command's
  // temp directory with a runner's files in it (7), or the other side's HOME (8).
  "tools/snoop.mjs": `import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const tmp = process.env.TMPDIR;
const root = dirname(tmp);
for (const name of readdirSync(root)) {
  const dir = join(root, name);
  if (!name.startsWith("tmp-") || dir === tmp) continue;
  if (existsSync(join(dir, "input.json")) || existsSync(join(dir, "out"))) process.exit(7);
}
const mark = join(process.env.HOME, "side-was-here");
if (existsSync(mark)) process.exit(8);
writeFileSync(mark, "x");
`,
};

const SCREENS = `version: 1
screens:
  - id: home
    route: /
  - id: invoices
    route: /invoices
    states: [empty]
`;

const pin = BrowserPinSchema.parse({
  v: 1,
  source: "vtc",
  name: "chromium",
  version: "140.0.1",
  playwright_core_version: "1.59.0",
  executable: "/fake/chrome-headless-shell",
  executable_sha256: "c".repeat(64),
  installed_at: "2026-10-01T00:00:00.000Z",
});

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => {
        resolve(port);
      });
    });
  });

/**
 * A flows file with the flow `pay-invoice`: from /invoices, pay with the `amount` fixture, then
 * the receipt page; `extra` steps follow.
 */
const flowsFile = (extra: readonly Record<string, unknown>[]): string =>
  `${JSON.stringify(
    {
      version: 1,
      fixtures: { amount: "42.00" },
      flows: [
        {
          id: "pay-invoice",
          start: "/invoices",
          screens: ["invoices"],
          paths: ["src/**"],
          steps: [
            { action: "click", selector: "#pay" },
            { action: "fill", selector: "#amount", fixture: "amount" },
            { action: "press", key: "Enter" },
            { action: "goto", route: "/invoices/paid" },
            { action: "wait_for", selector: ".receipt" },
            { action: "wait", ms: 100 },
            ...extra,
          ],
        },
      ],
    },
    null,
    2,
  )}\n`;

type Gate = GatesConfigInput["gates"][number];
const install: Gate = {
  id: "install",
  layer: "L0",
  phase: "install",
  command: [NODE, "tools/install.mjs"],
};
const build: Gate = { id: "build", layer: "L0", command: [NODE, "tools/build.mjs"] };
const tests: Gate = { id: "tests", layer: "L2", command: [NODE, "tools/never.mjs"] };

interface Setup {
  /** `visual` of the committed gates.yml (default: one width, light, the app on a free port). */
  visual?: (port: number) => Record<string, unknown> | undefined;
  gates?: Gate[];
  base?: { page?: string; mode?: string; flows?: string };
  head?: { page?: string; mode?: string; flows?: string };
  allow?: readonly (readonly string[])[];
  sandbox?: GateSandbox | null;
  /** `null`: the recorder gets no GitOps. */
  git?: null;
  deps?: Partial<EvidenceRecorderDeps>;
  options?: Partial<EvidenceRecorderOptions>;
}

const setup = async (s: Setup = {}) => {
  const port = await freePort();
  const visual = s.visual
    ? s.visual(port)
    : {
        widths: [1280],
        themes: ["light"],
        redact_selectors: [".account-number"],
        app: {
          command: [NODE, "tools/serve.mjs", String(port)],
          url: `http://127.0.0.1:${String(port)}`,
        },
      };
  const yml = config(s.gates ?? [install, build, tests], visual === undefined ? {} : { visual });
  const repo = initRepo({
    ...TOOLS,
    ".vtc/gates.yml": yml,
    ".vtc/design/screens.yaml": SCREENS,
    "src/page.txt": `${s.base?.page ?? "the old page"}\n`,
    "src/mode.txt": `${s.base?.mode ?? "ok"}\n`,
    ...(s.base?.flows === undefined ? {} : { ".vtc/design/flows.yaml": s.base.flows }),
  });
  const base = git(repo, "rev-parse", "HEAD");
  writeFile(repo, "src/page.txt", `${s.head?.page ?? "the new page"}\n`);
  writeFile(repo, "src/mode.txt", `${s.head?.mode ?? "ok"}\n`);
  if (s.head?.flows !== undefined) writeFile(repo, ".vtc/design/flows.yaml", s.head.flows);
  const head = commitAll(repo, "head");
  // The user's own uncommitted work: never built, served or captured.
  writeFile(repo, "src/page.txt", "uncommitted work in progress\n");
  const home = tempDir("vtc-ba-home-");
  addToAllowlist(home, repo, s.allow ?? [[NODE]], new Date("2026-10-13T08:00:00.000Z"));
  const tools = join(tempDir("vtc-ba-tools-"), "tools");
  mkdirSync(tools);
  writeFileSync(join(tools, "playwright.mjs"), FAKE_PLAYWRIGHT);
  const recording = recordingSandbox();
  const sandbox = s.sandbox === undefined ? recording.sandbox : s.sandbox;
  const recorder = createEvidenceRecorder(
    {
      vtcHome: home,
      repoRoot: repo,
      ...(s.git === null ? {} : { git: createGitOps({ repoRoot: repo }) }),
      ...(sandbox === null ? {} : { sandbox }),
      ...s.deps,
    },
    {
      node: NODE,
      env: { PATH: process.env.PATH ?? "" },
      detectSandbox: () => null,
      toolchain: () => ({
        source: "vtc",
        playwright: join(tools, "playwright.mjs"),
        playwrightVersion: "1.59.0",
        axe: null,
        pixelmatch: null,
        browsersPath: tools,
        readable: [tools],
      }),
      checkBrowser: () => Promise.resolve({ ok: true, pin }),
      ...s.options,
    },
  );
  const outDir = join(tempDir("vtc-ba-out-"), "staging");
  const request = (extra: Partial<BeforeAfterRequest> = {}): BeforeAfterRequest => ({
    repoRoot: repo,
    base,
    head,
    outDir,
    redactSelectors: [".prompt-text"],
    denyText: [],
    ...extra,
  });
  const log = (): Record<string, unknown>[] => {
    const path = join(tools, "log.jsonl");
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  };
  const capture = async (extra: Partial<BeforeAfterRequest> = {}) => {
    if (recorder.captureBeforeAfter === undefined) {
      throw new Error("the recorder has no captureBeforeAfter");
    }
    return recorder.captureBeforeAfter(request(extra));
  };
  return {
    repo,
    port,
    base,
    head,
    outDir,
    capture,
    log,
    specs: recording.specs,
    argvs: recording.argvs,
  };
};

const read = (dir: string, name: string): string =>
  readFileSync(join(dir, name)).toString("latin1");

// Each case builds and serves real commits (install, build and app processes): slow on a busy host.
describe("UI before/after evidence (D-ct, reading 223)", { timeout: 60_000 }, () => {
  it("builds and serves base and head in clean gate checkouts and captures each Visual QA screen", async () => {
    const h = await setup();
    const result = await h.capture();
    expect(result.partial).toBeUndefined();
    expect(result.failed).toEqual([]);
    expect(result.files.map((f) => [f.name, f.kind])).toEqual([
      ["01-ui1-w1280-light-before.png", "ui_before"],
      ["02-ui1-w1280-light-after.png", "ui_after"],
      ["03-ui2-w1280-light-before.png", "ui_before"],
      ["04-ui2-w1280-light-after.png", "ui_after"],
    ]);
    for (const f of result.files)
      expect(EvidenceFileNameSchema.safeParse(f.name).success).toBe(true);
    // The base's page before, the head's after; never the user's uncommitted work.
    expect(read(h.outDir, "01-ui1-w1280-light-before.png")).toContain(
      "the old page at /?state=default&theme=light",
    );
    expect(read(h.outDir, "02-ui1-w1280-light-after.png")).toContain(
      "the new page at /?state=default&theme=light",
    );
    expect(read(h.outDir, "04-ui2-w1280-light-after.png")).toContain(
      "the new page at /invoices?state=empty&theme=light",
    );
    expect(JSON.stringify(h.log())).not.toContain("uncommitted");
    // Install (registry phase), then the L0 build (no network), then the runner; never the L2 tests.
    const scripts = h.argvs.flatMap((a) => a.filter((t) => t.startsWith("tools/")));
    expect(scripts).toEqual([
      "tools/install.mjs",
      "tools/build.mjs",
      "tools/install.mjs",
      "tools/build.mjs",
    ]);
    expect(h.argvs.some((a) => a.includes("tools/never.mjs"))).toBe(false);
    expect(h.specs.map((s) => s.phase)).toEqual([
      "install",
      "verify",
      "verify",
      "install",
      "verify",
      "verify",
    ]);
    // The runner reaches only the app's port, from the commit's checkout.
    const runners = h.specs.filter((_, i) => h.argvs[i]?.includes("--disable-sigusr1"));
    expect(runners.map((s) => (s as { loopbackPorts?: number[] }).loopbackPorts)).toEqual([
      [h.port],
      [h.port],
    ]);
    expect(runners[0]?.checkout).toContain(join(".vtc", "state"));
    // Painted: VTC's defaults, the request's and the committed visual.redact_selectors.
    const pages = h.log().filter((e) => e.goto !== undefined);
    expect(pages[0]?.paint).toEqual(
      expect.arrayContaining(["[data-vtc-redact]", ".prompt-text", ".account-number"]),
    );
    expect(pages[0]?.viewport).toEqual({ width: 1280, height: 900 });
    expect(pages[0]?.colorScheme).toBe("light");
    // Every gate checkout is gone again; the user's work tree is untouched.
    const checkouts = join(h.repo, CHECKOUTS_DIR);
    expect(existsSync(checkouts) ? readdirSync(checkouts) : []).toEqual([]);
    expect(readFileSync(join(h.repo, "src/page.txt"), "utf8")).toBe(
      "uncommitted work in progress\n",
    );
  });

  it("records the first rendered screen on both sides when no flow is named, within maxFlowSeconds", async () => {
    const h = await setup();
    const result = await h.capture({ screens: ["invoices"], flowSeconds: 5 });
    expect(result.partial).toBeUndefined();
    expect(result.files.map((f) => [f.name, f.kind])).toEqual([
      ["01-ui1-w1280-light-before.png", "ui_before"],
      ["02-ui1-w1280-light-after.png", "ui_after"],
      ["03-flow-before.webm", "flow_video"],
      ["04-flow-after.webm", "flow_video"],
    ]);
    expect(read(h.outDir, "03-flow-before.webm")).toBe(
      "WEBM the old page at /invoices?state=empty&theme=light",
    );
    expect(read(h.outDir, "04-flow-after.webm")).toBe(
      "WEBM the new page at /invoices?state=empty&theme=light",
    );
    expect(h.log().filter((e) => e.waited !== undefined)).toEqual([
      { waited: 5000 },
      { waited: 5000 },
    ]);
    expect(result.flow).toBeUndefined();
    const tooLong = await h.capture({ flowSeconds: EVIDENCE_LIMITS.maxFlowSeconds + 1 });
    expect(tooLong.files).toEqual([]);
    expect(tooLong.partial?.reason).toBe("capture_failed");
  });

  it("scripts the named flow on each side from that side's own flows file (D-ct, reading 247(7))", async () => {
    const h = await setup({
      base: { flows: flowsFile([]) },
      head: { flows: flowsFile([{ action: "click", selector: "#done" }]) },
    });
    const result = await h.capture({ screens: ["invoices"], flowSeconds: 10, flow: "pay-invoice" });
    expect(result.partial).toBeUndefined();
    expect(result.flow).toEqual({ id: "pay-invoice", before: "scripted", after: "scripted" });
    expect(result.files.map((f) => [f.name, f.kind])).toEqual([
      ["01-ui1-w1280-light-before.png", "ui_before"],
      ["02-ui1-w1280-light-after.png", "ui_after"],
      ["03-flow-before.webm", "flow_video"],
      ["04-flow-after.webm", "flow_video"],
    ]);
    // Each recording ends on the page its own commit's flow led to.
    expect(read(h.outDir, "03-flow-before.webm")).toBe("WEBM the old page at /invoices/paid");
    expect(read(h.outDir, "04-flow-after.webm")).toBe("WEBM the new page at /invoices/paid");
    const origin = `http://127.0.0.1:${String(h.port)}`;
    const steps = (from: number) => {
      const log = h.log();
      const start = log.findIndex((e, i) => i >= from && e.goto === `${origin}/invoices`);
      const end = log.findIndex((e, i) => i > start && e.goto === `${origin}/invoices`);
      return log
        .slice(start, end < 0 ? undefined : end)
        .map((e) =>
          typeof e.goto === "string"
            ? `goto ${e.goto.slice(origin.length)}${e.video === true ? " (recording)" : ""}`
            : JSON.stringify(e),
        );
    };
    const expected = [
      "goto /invoices (recording)",
      '{"click":"#pay"}',
      '{"fill":"#amount","value":"42.00"}',
      '{"press":"Enter"}',
      "goto /invoices/paid (recording)",
      '{"wait_for":".receipt"}',
      '{"waited":100}',
    ];
    const base = steps(0);
    expect(base.slice(0, expected.length)).toEqual(expected);
    expect(base[expected.length]).toMatch(/^\{"waited":\d+\}$/);
    const head = steps(h.log().findIndex((e) => e.goto === `${origin}/invoices`) + 1);
    expect(head.slice(0, expected.length + 1)).toEqual([...expected, '{"click":"#done"}']);
  });

  it("records the first screen on a side without the flow, and keeps a failed flow's recording", async () => {
    const h = await setup({
      head: {
        flows: flowsFile([
          { action: "click", selector: ".missing" },
          { action: "click", selector: "#never" },
        ]),
      },
    });
    const result = await h.capture({ screens: ["invoices"], flowSeconds: 3, flow: "pay-invoice" });
    expect(result.flow).toEqual({ id: "pay-invoice", before: "idle", after: "failed" });
    expect(result.partial).toBeUndefined();
    // The base has no flows file: its first screen, left idle for flowSeconds.
    expect(read(h.outDir, "03-flow-before.webm")).toBe(
      "WEBM the old page at /invoices?state=empty&theme=light",
    );
    expect(h.log().filter((e) => e.waited !== undefined)[0]).toEqual({ waited: 3000 });
    // The head's recording up to the step that failed is kept.
    expect(read(h.outDir, "04-flow-after.webm")).toBe("WEBM the new page at /invoices/paid");
    expect(h.log().some((e) => e.click === "#never")).toBe(false);
    // An id that is no flow id is a bad request.
    const bad = await h.capture({ flowSeconds: 3, flow: "Not a flow" });
    expect(bad.files).toEqual([]);
    expect(bad.partial?.reason).toBe("capture_failed");
  });

  it("renders every width and theme of visual.widths / themes, a dark one in the dark scheme", async () => {
    const h = await setup({
      visual: (port) => ({
        widths: [390, 1440],
        themes: ["light", "dark"],
        app: {
          command: [NODE, "tools/serve.mjs", String(port)],
          url: `http://127.0.0.1:${String(port)}`,
        },
      }),
    });
    const result = await h.capture({ screens: ["home"] });
    expect(result.partial).toBeUndefined();
    expect(result.files.filter((f) => f.kind === "ui_after").map((f) => f.name)).toEqual([
      "02-ui1-w390-light-after.png",
      "04-ui2-w390-dark-after.png",
      "06-ui3-w1440-light-after.png",
      "08-ui4-w1440-dark-after.png",
    ]);
    const dark = h.log().filter((e) => e.colorScheme === "dark");
    expect(dark.map((e) => e.goto)).toEqual([
      `http://127.0.0.1:${String(h.port)}/?state=default&theme=dark`,
      `http://127.0.0.1:${String(h.port)}/?state=default&theme=dark`,
      `http://127.0.0.1:${String(h.port)}/?state=default&theme=dark`,
      `http://127.0.0.1:${String(h.port)}/?state=default&theme=dark`,
    ]);
  });

  it("keeps a PR within its file budget and says what it left out", async () => {
    const h = await setup({
      visual: (port) => ({
        widths: [390, 768, 1440],
        themes: ["light", "dark"],
        app: {
          command: [NODE, "tools/serve.mjs", String(port)],
          url: `http://127.0.0.1:${String(port)}`,
        },
      }),
    });
    const result = await h.capture({ flowSeconds: 2 });
    expect(result.files).toHaveLength(EVIDENCE_LIMITS.maxFilesPerPr);
    expect(result.files.filter((f) => f.kind === "flow_video")).toHaveLength(2);
    // 2 screens x 3 widths x 2 themes = 12 renders; 5 pairs fit beside the two recordings.
    expect(result.failed).toHaveLength(7);
    expect(result.failed.every((f) => f.reason === BEFORE_AFTER_FILE_LIMIT_REASON)).toBe(true);
    expect(result.partial).toBeUndefined();
  });

  it("returns the head's screens with base_build_failed when the base does not build", async () => {
    const h = await setup({ base: { page: "broken" } });
    const result = await h.capture();
    expect(result.partial?.reason).toBe("base_build_failed");
    expect(result.partial?.detail).not.toMatch(/broken|page|build\.mjs/);
    expect(result.files.map((f) => f.kind)).toEqual(["ui_after", "ui_after"]);
    expect(read(h.outDir, "02-ui1-w1280-light-after.png")).toContain("the new page");
  });

  it("returns the head's screens with base_serve_failed when the base's app does not serve", async () => {
    const h = await setup({ base: { mode: "crash" } });
    const result = await h.capture();
    expect(result.partial?.reason).toBe("base_serve_failed");
    expect(result.files.map((f) => f.kind)).toEqual(["ui_after", "ui_after"]);
  });

  it("returns the base's screens with capture_failed when the head does not serve", async () => {
    const h = await setup({ head: { mode: "crash" } });
    const result = await h.capture();
    expect(result.partial?.reason).toBe("capture_failed");
    expect(result.files.map((f) => f.kind)).toEqual(["ui_before", "ui_before"]);
  });

  it("builds nothing without a committed visual.app, or with one this machine did not allow", async () => {
    const none = await setup({ visual: () => undefined });
    const result = await none.capture();
    expect(result).toEqual({
      files: [],
      failed: [],
      partial: { reason: "no_visual_app", detail: expect.any(String) as string },
    });
    expect(none.argvs).toEqual([]);
    const refused = await setup({
      visual: (port) => ({
        app: {
          command: ["/usr/bin/env", "node", "tools/serve.mjs", String(port)],
          url: `http://127.0.0.1:${String(port)}`,
        },
      }),
    });
    const r = await refused.capture();
    expect(r.partial?.reason).toBe("no_visual_app");
    expect(refused.argvs).toEqual([]);
  });

  it("uses the committed gates.yml, never the working tree's", async () => {
    const h = await setup();
    writeFile(h.repo, ".vtc/gates.yml", "not: [valid");
    const result = await h.capture({ screens: ["home"] });
    expect(result.partial).toBeUndefined();
    expect(result.files).toHaveLength(2);
  });

  it("builds nothing without the doctor-installed browser, and nothing without a sandbox", async () => {
    const h = await setup({ options: { toolchain: () => null } });
    const result = await h.capture();
    expect(result.partial?.reason).toBe("no_browser");
    expect(result.files).toEqual([]);
    expect(h.argvs).toEqual([]);
    const bare = await setup({ sandbox: null });
    const r = await bare.capture();
    expect(r.partial?.reason).toBe("capture_failed");
    expect(r.files).toEqual([]);
  });

  it("discards a frame that shows a denied value and keeps the rest, partial with no matched text", async () => {
    const h = await setup({ head: { page: "the new page for Initech" } });
    const result = await h.capture({ screens: ["home"], denyText: ["initech"] });
    expect(result.files.map((f) => f.kind)).toEqual(["ui_before"]);
    expect(result.failed.map((f) => f.name)).toEqual(["02-ui1-w1280-light-after.png"]);
    expect(result.partial?.reason).toBe("capture_failed");
    expect(JSON.stringify(result).toLowerCase()).not.toContain("initech");
  });

  it("reports requested screens screens.yaml does not have, and checks the request", async () => {
    const h = await setup();
    const unknown = await h.capture({ screens: ["nowhere"] });
    expect(unknown.partial?.reason).toBe("capture_failed");
    expect(unknown.files).toEqual([]);
    expect(h.argvs).toEqual([]);
    const some = await h.capture({ screens: ["home", "nowhere"] });
    expect(some.files).toHaveLength(2);
    expect(some.partial?.reason).toBe("capture_failed");
    const relative = await h.capture({ outDir: "staging" });
    expect(relative.partial?.reason).toBe("capture_failed");
    const badSha = await h.capture({ base: "main" });
    expect(badSha.partial?.reason).toBe("capture_failed");
  });

  it("captures nothing from a port something else already answers on (the developer's own server)", async () => {
    const h = await setup();
    const squatter = createHttpServer((_req, res) => res.end("someone else's server"));
    await new Promise<void>((resolve) => squatter.listen(h.port, "127.0.0.1", resolve));
    try {
      const result = await h.capture({ screens: ["home"] });
      expect(result.files).toEqual([]);
      expect(result.partial?.reason).toBe("base_serve_failed");
      expect(JSON.stringify(h.log())).not.toContain("someone else");
    } finally {
      await new Promise((resolve) => squatter.close(resolve));
    }
  });

  it("keeps no shot of a side whose app server stopped during the capture", async () => {
    const h = await setup({ head: { mode: "once" } });
    const result = await h.capture();
    expect(result.files.map((f) => f.kind)).toEqual(["ui_before", "ui_before"]);
    expect(result.partial?.reason).toBe("capture_failed");
    expect(result.failed.map((f) => f.name)).toEqual([
      "02-ui1-w1280-light-after.png",
      "04-ui2-w1280-light-after.png",
    ]);
  });

  it("renders each route under the app URL's own path", async () => {
    const h = await setup({
      visual: (port) => ({
        widths: [1280],
        themes: ["light"],
        app: {
          command: [NODE, "tools/serve.mjs", String(port)],
          url: `http://127.0.0.1:${String(port)}/app/`,
        },
      }),
    });
    const result = await h.capture({ screens: ["invoices"] });
    expect(result.partial).toBeUndefined();
    expect(read(h.outDir, "02-ui1-w1280-light-after.png")).toContain(
      "the new page at /app/invoices?state=empty&theme=light",
    );
  });

  it("keeps the runner's input (its denied values) from the app server, and each side from the other", async () => {
    const snoop: Gate = { id: "snoop", layer: "L0", command: [NODE, "tools/snoop.mjs"] };
    const h = await setup({
      gates: [install, build, snoop],
      base: { mode: "snoop" },
      head: { mode: "snoop" },
    });
    const result = await h.capture({ screens: ["home"], denyText: ["hunter2-secret"] });
    // The head's build gates ran after the base's runner: they found nothing of it, nor its HOME.
    expect(result.partial).toBeUndefined();
    expect(read(h.outDir, "01-ui1-w1280-light-before.png")).toContain("input gone");
    expect(read(h.outDir, "02-ui1-w1280-light-after.png")).toContain("input gone");
    // Each side ran in a jail of its own.
    const homes = new Set(h.specs.map((s) => s.home));
    expect(homes.size).toBe(2);
  });

  it("builds nothing without the injected GitOps, or for another repository", async () => {
    const none = await setup({ git: null });
    const r = await none.capture();
    expect(r.partial?.reason).toBe("capture_failed");
    expect(none.argvs).toEqual([]);
    const h = await setup();
    const other = initRepo({ "README.md": "another project\n" });
    const elsewhere = await h.capture({ repoRoot: other });
    expect(elsewhere).toEqual({
      files: [],
      failed: [],
      partial: { reason: "capture_failed", detail: BEFORE_AFTER_OTHER_REPO },
    });
    expect(h.argvs).toEqual([]);
  });

  it("never builds unconfined, even with gates.allow_unsandboxed", async () => {
    const h = await setup({ sandbox: null, deps: { allowUnsandboxed: true } });
    const result = await h.capture();
    expect(result).toEqual({
      files: [],
      failed: [],
      partial: { reason: "capture_failed", detail: BEFORE_AFTER_NO_UNSANDBOXED },
    });
    expect(existsSync(join(h.repo, CHECKOUTS_DIR))).toBe(false);
    expect(existsSync(join(h.repo, BEFORE_AFTER_STATE_DIR))).toBe(false);
  });

  it("builds nothing on a Linux host whose ptrace policy is open, and says so for evidence", async () => {
    const h = await setup({ options: { platform: "linux", ptraceScope: () => "0" } });
    const result = await h.capture();
    expect(result.partial).toEqual({ reason: "capture_failed", detail: EVIDENCE_PTRACE_REFUSAL });
    expect(result.partial?.detail).not.toContain("visual step");
    expect(h.argvs).toEqual([]);
  });

  it("keeps each capture's build logs apart, made without links, and only the newest", async () => {
    const h = await setup();
    const logs = join(h.repo, BEFORE_AFTER_STATE_DIR);
    mkdirSync(logs, { recursive: true });
    for (let i = 0; i < BEFORE_AFTER_LOGS_KEPT + 2; i += 1) {
      const old = join(logs, `old-${String(i)}`);
      mkdirSync(old);
      utimesSync(old, new Date(2020, 0, 1 + i), new Date(2020, 0, 1 + i));
    }
    await h.capture({ screens: ["home"] });
    await h.capture({ screens: ["home"] });
    const kept = readdirSync(logs);
    expect(kept).toHaveLength(BEFORE_AFTER_LOGS_KEPT);
    const mine = kept.filter((n) => n.startsWith(`${h.base.slice(0, 12)}-${h.head.slice(0, 12)}-`));
    expect(mine).toHaveLength(2);
    // A link in the way: nothing is built.
    const linked = await setup();
    mkdirSync(join(linked.repo, ".vtc/state/gates"), { recursive: true });
    symlinkSync(tempDir("vtc-ba-elsewhere-"), join(linked.repo, BEFORE_AFTER_STATE_DIR));
    const refused = await linked.capture();
    expect(refused.partial?.reason).toBe("capture_failed");
    expect(linked.argvs).toEqual([]);
  });
});

describe("before/after building blocks", () => {
  it("leaves pinned scanners out of the build gates: they check, they do not build", () => {
    const parsed = parseGatesConfig(
      config([
        install,
        build,
        { id: "secrets", layer: "L0", command: ["gitleaks", "detect"] },
        { id: "lint", layer: "L0", command: [NODE, "lint.mjs", "{changed}"] },
      ]),
    );
    expect(buildGatesOf(parsed).map((g) => g.id)).toEqual(["install", "build"]);
  });

  it("gives the base at most half of the PR's bytes, and the head the rest", async () => {
    const repo = tempDir("vtc-ba-fake-repo-");
    mkdirSync(join(repo, "co"));
    const home = tempDir("vtc-ba-fake-home-");
    const app = { command: [NODE, "serve.mjs"], url: "http://127.0.0.1:4173" };
    addToAllowlist(home, repo, [[NODE]], new Date("2026-10-13T08:00:00.000Z"));
    const files: Record<string, string> = {
      // Only a check gate: nothing is built.
      ".vtc/gates.yml": config([tests], { visual: { widths: [1280], themes: ["light"], app } }),
      ".vtc/design/screens.yaml": SCREENS,
    };
    const budgets: number[] = [];
    const ctx: BeforeAfterContext = {
      vtcHome: home,
      repoRoot: repo,
      env: {},
      sandbox: () => recordingSandbox().sandbox,
      git: {
        readFileAtCommit: (_sha, path) => {
          const text = files[path];
          return Promise.resolve(text === undefined ? undefined : new TextEncoder().encode(text));
        },
        createCleanCheckout: () => Promise.resolve("co"),
        removeCheckout: () => Promise.resolve(),
      },
      hostProblem: () => null,
      browserProblem: () => Promise.resolve(null),
      capture: (request, target: CaptureTarget) => {
        const budget = target.budgetBytes ?? 0;
        budgets.push(budget);
        // Each side takes all it is given.
        return Promise.resolve({
          files: request.shots
            .slice(0, 1)
            .map((s) => ({ name: s.name, kind: s.kind, bytes: budget })),
          failed: [],
          app: "served",
        });
      },
    };
    const result = await captureBeforeAfter(ctx, {
      repoRoot: repo,
      base: "a".repeat(40),
      head: "b".repeat(40),
      outDir: join(repo, "out"),
      screens: ["home"],
      redactSelectors: [],
      denyText: [],
    });
    expect(budgets).toEqual([
      Math.floor(EVIDENCE_LIMITS.maxBytesPerPr / 2),
      EVIDENCE_LIMITS.maxBytesPerPr - Math.floor(EVIDENCE_LIMITS.maxBytesPerPr / 2),
    ]);
    expect(result.files.map((f) => f.kind)).toEqual(["ui_before", "ui_after"]);
  });
});

describe("the evidence runner with an app server on Linux (reading 164)", () => {
  it("runs nothing while ptrace would let the app reach the runner", async () => {
    const jail = new GateCommandJail(recordingSandbox("bwrap").sandbox, []);
    try {
      const runner = sandboxedEvidenceRunner(jail, NODE, {
        platform: "linux",
        ptraceScope: () => "0",
      });
      const outcome = await runner.run({
        input: {
          v: 1,
          playwright: "/store/playwright.mjs",
          executable: "/store/chrome",
          origin: "http://127.0.0.1:4173",
          relay: false,
          video_size: { width: 1280, height: 800 },
          nav_timeout_ms: 30_000,
          paint: [],
          mask: [],
          mask_color: "#1f1f1f",
          patterns: [],
          deny_text: [],
          deny_substring_min: 4,
          max_scan_chars: 1000,
          shots: [],
          app: {
            command: [NODE, "serve.mjs"],
            cwd: "/checkout",
            url: "http://127.0.0.1:4173",
            ready_timeout_ms: 1000,
          },
        },
        allowRead: [],
        port: 4173,
        env: {},
        timeoutMs: 1000,
      });
      expect(outcome).toEqual({ ok: false, reason: EVIDENCE_PTRACE_REFUSAL });
      expect(jail.ran).toBe(false);
    } finally {
      jail.dispose();
    }
  });
});
