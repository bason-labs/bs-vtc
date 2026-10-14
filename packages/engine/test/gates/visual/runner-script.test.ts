/**
 * The real visual runner script, run by Node through `sandboxedVisualRunner` and the gate jail
 * (with the recording fake sandbox), against a fake Playwright module and a fake pixelmatch:
 * the script's protocol, recipe and request policy are exercised without any browser.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import type { GateSandbox } from "@vtc/shared";
import { describe, expect, it } from "vitest";
import { GateCommandJail } from "../../../src/gates/index.js";
import {
  sandboxedVisualRunner,
  STYLE_PROPERTIES,
  type RunnerInput,
} from "../../../src/gates/visual/index.js";
import { NODE, recordingSandbox } from "../fixture.js";
import { tempDir } from "../../helpers/repo.js";

/** A Playwright stand-in: records what the script asked for into `log.json` next to it. */
const FAKE_PLAYWRIGHT = String.raw`
import { writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const log = { launch: null, contexts: [], navigations: [], screenshots: [], scripts: [], aborted: [], fulfilled: [] };
const flush = () => writeFileSync(join(here, "log.json"), JSON.stringify(log));
const PNG = Buffer.from("89504e470d0a1a0a", "hex");
const page = (context) => {
  const p = {
    clock: { setFixedTime: async (t) => { context.clock = String(t.toISOString()); } },
    goto: async (url) => {
      log.navigations.push(url);
      let outcome = { status: 200 };
      for (const handler of context.routes) {
        outcome = await new Promise((resolve) => handler({
          request: () => ({ url: () => url }),
          fulfill: async (r) => { log.fulfilled.push([url, r.status]); resolve({ status: r.status }); },
          continue: async () => resolve({ status: url.includes("/missing") ? 404 : 200 }),
          abort: async () => { log.aborted.push(url); resolve({ aborted: true }); },
        }));
      }
      flush();
      if (outcome.aborted) throw new Error("net::ERR_BLOCKED_BY_CLIENT");
      return { status: () => outcome.status };
    },
    waitForLoadState: async () => undefined,
    locator: (s) => ({ selector: s }),
    addScriptTag: async ({ path }) => { log.scripts.push(path); flush(); },
    screenshot: async (o) => {
      log.screenshots.push({ path: o.path ? o.path.split("/").pop() : null, fullPage: o.fullPage, animations: o.animations, caret: o.caret, mask: o.mask.length, clip: !!o.clip });
      if (o.path) writeFileSync(o.path, PNG);
      flush();
      return PNG;
    },
    evaluate: async (fn, arg) => {
      const src = String(fn);
      if (src.includes("fonts")) return true;
      if (src.includes("axe.run")) return { violations: [{ rule: "image-alt", impact: "critical", help: "Images need alt text", nodes: 1, targets: ["img"] }], incomplete: [] };
      if (src.includes("getComputedStyle")) return [{ selector: "body", property: "color", value: "rgb(17, 17, 17)" }];
      if (src.includes("data-vtc-region")) return [{ name: "main", x: 0, y: 0, width: 2, height: 1 }];
      if (src.includes("createImageBitmap")) return Buffer.alloc(8, context.theme === "dark" ? 9 : 1).toString("base64");
      if (src.includes("convertToBlob")) return PNG.toString("base64");
      throw new Error("unexpected evaluate");
    },
  };
  return p;
};
export const chromium = {
  executablePath: () => "/fake/chrome-headless-shell",
  launch: async (options) => {
    log.launch = { executablePath: options.executablePath, headless: options.headless, chromiumSandbox: options.chromiumSandbox };
    flush();
    return {
      version: () => "140.0.1",
      newContext: async (o = {}) => {
        const context = { theme: o.colorScheme, routes: [] };
        log.contexts.push(o);
        return {
          route: async (_pattern, handler) => { context.routes.push(handler); },
          newPage: async () => page(context),
          close: async () => undefined,
        };
      },
      close: async () => undefined,
    };
  },
};
`;

/** pixelmatch stand-in: counts differing bytes. */
const FAKE_PIXELMATCH = String.raw`export default function pixelmatch(a, b, out, w, h, o) {
  if (o.includeAA !== false) throw new Error("expected includeAA false");
  let n = 0;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) n += 1;
  return n;
}`;

/**
 * A minimal app server on a fixed port that answers 200. It records what it could see of the
 * runner's temp directory (the app server shares it): the input, and whether the key was there.
 */
const SERVER = String.raw`import { createServer } from "node:http";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const tmp = process.env.TMPDIR;
writeFileSync("seen.json", JSON.stringify({ input: existsSync(join(tmp, "input.json")), key: existsSync(join(tmp, "key")) }));
createServer((req, res) => { res.writeHead(200); res.end("ok"); }).listen(Number(process.argv[2]), "127.0.0.1");`;

/**
 * Stand-ins for a process the app server left behind that rewrites the runner's temp directory
 * after the runner's last write: run by {@link tamperingSandbox} once the runner has exited.
 */
const TAMPER = {
  /** A clean result of its own, with a made-up MAC. */
  forge: String.raw`import { writeFileSync } from "node:fs";
const body = JSON.stringify({ v: 1, browser: { name: "chromium", version: "1" }, renders: [], files: {} });
writeFileSync(process.argv[2] + "/result.json", JSON.stringify({ v: 1, body, mac: "0".repeat(64) }));`,
  /** The runner's own envelope, its body edited (every render made "rendered"). */
  edit: String.raw`import { readFileSync, writeFileSync } from "node:fs";
const file = process.argv[2] + "/result.json";
const env = JSON.parse(readFileSync(file, "utf8"));
env.body = env.body.replaceAll('"unreached"', '"rendered"');
writeFileSync(file, JSON.stringify(env));`,
  /** The runner's result left alone, one screenshot replaced. */
  image: String.raw`import { writeFileSync } from "node:fs";
writeFileSync(process.argv[2] + "/out/home_default_390_light.png", "not the runner's screenshot");`,
  /** The result replaced by a bare, unsigned result (the format before envelopes). */
  bare: String.raw`import { writeFileSync } from "node:fs";
writeFileSync(process.argv[2] + "/result.json", JSON.stringify({ v: 1, browser: null, renders: [] }));`,
} as const;

/** The recording sandbox, plus a tamper script run on the temp directory after the command. */
const tamperingSandbox = (script: string): GateSandbox => ({
  kind: "sandbox-exec",
  wrap: (argv, spec) => ({
    command: "/bin/sh",
    args: [
      "-c",
      'n=$1; t=$2; d=$3; shift 3; "$@"; s=$?; "$n" "$t" "$d"; exit $s',
      "vtc-tamper",
      NODE,
      script,
      spec.tempDir,
      ...argv,
    ],
    network: "none",
  }),
});

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => {
        resolve(port);
      });
    });
  });

/** A render run's directories and input: a checkout with a prototype, fake tools, an app server. */
const renderSetup = async () => {
  const dir = tempDir("vtc-visual-script-");
  const checkout = join(dir, "checkout");
  mkdirSync(join(checkout, ".vtc/design/prototype"), { recursive: true });
  writeFileSync(join(checkout, ".vtc/design/prototype/index.html"), "<main>proto</main>");
  const tools = join(dir, "tools");
  mkdirSync(tools);
  writeFileSync(join(tools, "playwright.mjs"), FAKE_PLAYWRIGHT);
  writeFileSync(join(tools, "pixelmatch.mjs"), FAKE_PIXELMATCH);
  writeFileSync(join(tools, "axe.min.js"), "/* axe */");
  writeFileSync(join(checkout, "server.mjs"), SERVER);
  const port = await freePort();
  const input: Omit<RunnerInput, "out_dir"> = {
    v: 1,
    mode: "render",
    playwright: join(tools, "playwright.mjs"),
    executable: "/fake/chrome-headless-shell",
    axe: join(tools, "axe.min.js"),
    pixelmatch: join(tools, "pixelmatch.mjs"),
    prototype_root: join(checkout, ".vtc/design/prototype"),
    app: {
      command: [NODE, "server.mjs", String(port)],
      cwd: checkout,
      url: `http://127.0.0.1:${String(port)}`,
      ready_timeout_ms: 10_000,
    },
    fixed_time: "2026-01-15T12:00:00.000Z",
    axe_tags: ["wcag2a", "wcag2aa"],
    include_best_practice: false,
    pixel_threshold: 0.1,
    dynamic_regions: [".clock"],
    style_properties: [...STYLE_PROPERTIES],
    style_limit: 100,
    nav_timeout_ms: 5000,
    jobs: [
      {
        key: "home:default:390:light",
        path: "/?state=default&theme=light",
        width: 390,
        theme: "light",
      },
      {
        key: "home:default:390:dark",
        path: "/missing?state=default&theme=dark",
        width: 390,
        theme: "dark",
      },
    ],
  };
  const call = () => ({
    input,
    allowRead: [tools],
    loopback: true,
    env: { PATH: process.env.PATH ?? "" },
    checkout,
    timeoutMs: 60_000,
    stdoutPath: join(dir, "out.log"),
    stderrPath: join(dir, "err.log"),
  });
  return { dir, checkout, tools, port, call };
};

describe("visual runner script", () => {
  it("renders app and prototype per job with the recipe, axe, styles and region diffs", async () => {
    const { checkout, tools, port, call } = await renderSetup();
    const { sandbox, specs } = recordingSandbox();
    const jail = new GateCommandJail(sandbox, []);
    const runner = sandboxedVisualRunner(jail, { node: NODE, noSandbox: "none" });
    try {
      const outcome = await runner.run(call());
      if (!outcome.ok) throw new Error(outcome.reason);
      const { result } = outcome;
      expect(result.error).toBeUndefined();
      expect(result.browser).toEqual({ name: "chromium", version: "140.0.1" });
      const [light, dark] = result.renders;
      expect(light).toMatchObject({
        key: "home:default:390:light",
        status: "rendered",
        screenshot: "home_default_390_light.png",
        reference: { status: "rendered", screenshot: "home_default_390_light.ref.png" },
        axe: { violations: [{ rule: "image-alt", impact: "critical" }], incomplete: [] },
        styles: [{ selector: "body", property: "color", value: "rgb(17, 17, 17)" }],
        diffs: [{ region: "main", mismatch_px: 0, total_px: 2, dimension_mismatch: false }],
      });
      expect(outcome.file("home_default_390_light.png")).not.toBeNull();
      expect(outcome.file("../result.json")).toBeNull();
      // Every image the runner wrote is listed with its hash; a name it did not write is absent.
      expect(Object.keys(result.files)).toContain("home_default_390_light.png");
      expect(outcome.file("unlisted.png")).toBeNull();
      // The app server shares the temp directory, but the key was gone before it started.
      expect(JSON.parse(readFileSync(join(checkout, "seen.json"), "utf8"))).toEqual({
        input: true,
        key: false,
      });
      // The app answered 404 for the dark job's route: unreached, never clean.
      expect(dark).toMatchObject({ key: "home:default:390:dark", status: "unreached" });
      expect(dark?.detail).toMatch(/HTTP 404/);
      // The prototype has no /missing: fulfilled with 404 from disk, not over the network.
      expect(dark?.reference).toMatchObject({ status: "unreached" });

      const log = JSON.parse(readFileSync(join(tools, "log.json"), "utf8")) as {
        launch: unknown;
        contexts: Record<string, unknown>[];
        navigations: string[];
        screenshots: Record<string, unknown>[];
        scripts: string[];
        fulfilled: [string, number][];
      };
      expect(log.launch).toEqual({
        executablePath: "/fake/chrome-headless-shell",
        headless: true,
        chromiumSandbox: false,
      });
      expect(log.contexts).toContainEqual(
        expect.objectContaining({
          viewport: { width: 390, height: 900 },
          deviceScaleFactor: 1,
          locale: "en-US",
          timezoneId: "UTC",
          reducedMotion: "reduce",
          colorScheme: "light",
        }),
      );
      expect(log.navigations).toContain(
        `http://127.0.0.1:${String(port)}/?state=default&theme=light`,
      );
      expect(log.fulfilled).toContainEqual([
        "http://prototype.vtc.invalid/?state=default&theme=light",
        200,
      ]);
      expect(log.fulfilled).toContainEqual([
        "http://prototype.vtc.invalid/missing?state=default&theme=dark",
        404,
      ]);
      expect(log.scripts).toEqual([join(tools, "axe.min.js")]);
      expect(log.screenshots[0]).toMatchObject({
        animations: "disabled",
        caret: "hide",
        mask: 1,
        fullPage: true,
      });
      // The command went through the sandbox, verify phase, with the loopback and the extra read root.
      expect(specs.at(-1)).toMatchObject({ phase: "verify", loopback: true });
      expect((specs.at(-1) as { allowRead?: string[] }).allowRead).toEqual(
        expect.arrayContaining([expect.stringContaining("tools")]),
      );
    } finally {
      jail.dispose();
    }
  }, 60_000);

  it.each([
    ["forge", /valid MAC under this run's key/],
    ["edit", /valid MAC under this run's key/],
    ["bare", /valid MAC under this run's key/],
    ["image", /home_default_390_light\.png is not the file the runner wrote/],
  ] as const)(
    "never uses a result or image something other than the runner wrote (%s)",
    async (kind, reason) => {
      const { dir, call } = await renderSetup();
      const script = join(dir, `tamper-${kind}.mjs`);
      writeFileSync(script, TAMPER[kind]);
      const jail = new GateCommandJail(tamperingSandbox(script), []);
      const runner = sandboxedVisualRunner(jail, { node: NODE, noSandbox: "none" });
      try {
        const outcome = await runner.run(call());
        expect(outcome.ok).toBe(false);
        expect(outcome.ok ? "" : outcome.reason).toMatch(reason);
      } finally {
        jail.dispose();
      }
    },
    60_000,
  );

  it("starts nothing when it cannot take the key", async () => {
    const { dir, checkout, call } = await renderSetup();
    // The key is removed before the runner starts: it fails before any project code runs.
    const jail = new GateCommandJail(
      {
        kind: "sandbox-exec",
        wrap: (argv, spec) => ({
          command: "/bin/sh",
          args: ["-c", 'rm -f "$1/key"; shift; "$@"', "vtc-nokey", spec.tempDir, ...argv],
          network: "none",
        }),
      },
      [],
    );
    const runner = sandboxedVisualRunner(jail, { node: NODE, noSandbox: "none" });
    try {
      const outcome = await runner.run(call());
      expect(outcome.ok).toBe(false);
      expect(outcome.ok ? "" : outcome.reason).toMatch(/wrote no result/);
      expect(existsSync(join(checkout, "seen.json"))).toBe(false);
      expect(existsSync(join(dir, "tools", "log.json"))).toBe(false);
    } finally {
      jail.dispose();
    }
  }, 60_000);

  it("answers the probe with the executable Playwright would use, and reports a crash as an error", async () => {
    const dir = tempDir("vtc-visual-probe-");
    writeFileSync(join(dir, "playwright.mjs"), FAKE_PLAYWRIGHT);
    writeFileSync(join(dir, "broken.mjs"), "export const nothing = 1;\n");
    const jail = new GateCommandJail(recordingSandbox().sandbox, []);
    const runner = sandboxedVisualRunner(jail, { node: NODE, noSandbox: "none" });
    const call = (playwright: string) =>
      runner.run({
        input: {
          v: 1,
          mode: "probe",
          playwright,
          executable: null,
          axe: null,
          pixelmatch: null,
          prototype_root: null,
          app: null,
          fixed_time: "2026-01-15T12:00:00.000Z",
          axe_tags: [],
          include_best_practice: false,
          pixel_threshold: 0.1,
          dynamic_regions: [],
          style_properties: [],
          style_limit: 1,
          nav_timeout_ms: 1000,
          jobs: [],
        },
        allowRead: [],
        loopback: false,
        env: { PATH: process.env.PATH ?? "" },
        checkout: dir,
        timeoutMs: 30_000,
        stdoutPath: join(dir, "out.log"),
        stderrPath: join(dir, "err.log"),
      });
    try {
      const probe = await call(join(dir, "playwright.mjs"));
      expect(probe.ok && probe.result.executable).toBe("/fake/chrome-headless-shell");
      const broken = await call(join(dir, "broken.mjs"));
      expect(broken.ok && broken.result.error).toMatch(/exports no chromium/);
      const none = sandboxedVisualRunner(null, { node: NODE, noSandbox: "no OS sandbox" });
      expect(await none.run({} as never)).toEqual({ ok: false, reason: "no OS sandbox" });
    } finally {
      jail.dispose();
    }
  }, 60_000);
});
