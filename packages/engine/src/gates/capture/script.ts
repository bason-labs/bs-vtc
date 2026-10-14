/**
 * The evidence runner (AD-27 rule 6, D-ce; research §2.3 and §3): a VTC-written ES module the
 * recorder writes into a gate command's private temp directory and runs in the gate sandbox as
 * `node --disable-sigusr1 vtc-visual-runner.mjs <input.json> <result.json> <key>`, the `evidence`
 * job next to the visual step's render job (`visual/runner-script.ts`), with the same signed
 * envelope. It imports the browser store's Playwright, launches the pinned executable, and for
 * each shot opens one fresh context on the loopback origin of the evidence snapshot server.
 *
 * - Network: `context.route("**\/*")` continues only requests to the request's origin and aborts
 *   the rest (WebSockets too, where Playwright can route them). Nothing is downloaded.
 * - Paint (layer 2): an init script, run before any page script, adopts a stylesheet that paints
 *   every redact selector as a solid block and hides everything inside it, so every video frame
 *   and screenshot is covered. A selector that is not valid CSS, or a stylesheet the page removed,
 *   fails the shot (fail closed). Screenshots also pass `mask` / `maskColor` for the painted
 *   selectors and the project's `visual.dynamic_regions` / `redact_selectors`.
 * - Scan (layer 3): text nodes, `title` / `alt` / `aria-label` / `placeholder`, input values
 *   (not passwords), SVG text and the document title, outside painted subtrees and `script` /
 *   `style`, plus the text nodes joined (a token split over elements), are matched against
 *   `SECRET_PATTERNS` and `deny_text`: before and after every screenshot, and during a recording
 *   through a `MutationObserver` that hands each change to the runner with `exposeBinding`, then
 *   once more over the whole page before the context closes. It scans every text in the DOM, not
 *   only what is on screen, so it errs towards discarding. `deny_text` matches case-insensitively,
 *   and a value shorter than four characters only as a whole word (a two-letter repo name would
 *   otherwise discard every page). A hit discards the file; the result
 *   names only the kinds found. Text drawn into `<canvas>`, images and shadow roots is not
 *   scanned (research §3 residual).
 * - Video: `recordVideo` always with `size` (1280x800); the file exists only after
 *   `context.close()`, then it is kept (renamed to the shot's name and hashed) or deleted.
 *
 * The script writes only into its output directory, a video directory beside it and the result
 * file. It never throws past `main`: a failure of the whole run is the result's `error`.
 */
export const EVIDENCE_RUNNER_SCRIPT = String.raw`// VTC evidence runner (generated; see packages/engine/src/gates/capture/script.ts).
import { createHash, createHmac } from "node:crypto";
import { readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

if (!process.execArgv.includes("--disable-sigusr1")) {
  process.stderr.write("the evidence runner must run with node --disable-sigusr1\n");
  process.exit(2);
}
const key = readFileSync(process.argv[4]);
unlinkSync(process.argv[4]);
const input = JSON.parse(readFileSync(process.argv[2], "utf8"));
const resultFile = process.argv[3];
const out = { v: 1, browser: null, shots: [], files: {} };
const save = () => {
  const body = JSON.stringify(out);
  const mac = createHmac("sha256", key).update(body).digest("hex");
  writeFileSync(resultFile, JSON.stringify({ v: 1, body, mac }));
};
const writeOut = (name, bytes) => {
  writeFileSync(join(input.out_dir, name), bytes);
  out.files[name] = createHash("sha256").update(bytes).digest("hex");
};
const clip = (s, n) => String(s === undefined || s === null ? "" : s).slice(0, n);
const BINDING = "__vtcEvidenceText";

// ---------------------------------------------------------------- the scan (layer 3)
const PATTERNS = input.patterns.map((p) => ({ kind: p.kind, re: new RegExp(p.source, p.flags.replace(/[gy]/g, "")) }));
const escapeRe = (s) => s.replace(/[.*+?^$\\{}()|[\]\\]/g, "\\$&");
const DENY = input.deny_text
  .map((v) => String(v).trim().toLowerCase())
  .filter((v) => v !== "")
  .map((v) => (v.length < 4 ? { word: new RegExp("(?:^|[^a-z0-9])" + escapeRe(v) + "(?:$|[^a-z0-9])") } : { sub: v }));
const scan = (texts, hits) => {
  if (!Array.isArray(texts)) { hits.add("unscannable"); return; }
  for (const raw of texts) {
    if (typeof raw !== "string") { hits.add("unscannable"); continue; }
    if (raw === "") continue;
    for (const p of PATTERNS) if (!hits.has(p.kind) && p.re.test(raw)) hits.add(p.kind);
    if (hits.has("denied_text")) continue;
    const low = raw.toLowerCase();
    for (const d of DENY) {
      if (d.sub !== undefined ? low.includes(d.sub) : d.word.test(low)) { hits.add("denied_text"); break; }
    }
  }
};

// ---------------------------------------------------------------- in the page (layers 2 and 3)
// Runs before any page script, in every document of the context (stringified with its config).
function pageScript(config) {
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);
  const ATTRS = ["title", "alt", "aria-label", "placeholder"];
  const state = { painted: false, broken: null };
  const pending = new Set();
  const list = config.paint.join(", ");
  const send = window[config.binding];
  let sheet = null;
  try {
    for (const selector of config.paint) document.querySelectorAll(selector);
    sheet = new CSSStyleSheet();
    for (const selector of config.paint) {
      const s = ":is(" + selector + ")";
      sheet.insertRule(s + " { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; background: " + config.color + " !important; border-color: " + config.color + " !important; caret-color: transparent !important; }");
      sheet.insertRule(s + " * { visibility: hidden !important; }");
      sheet.insertRule(s + "::placeholder { color: transparent !important; }");
    }
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    state.painted = true;
  } catch (error) {
    state.broken = "a redact selector is not valid CSS, so nothing could be painted";
  }
  const isPainted = (el) => {
    try { return el.matches(list); } catch { return true; }
  };
  const collect = (root) => {
    const texts = [];
    let size = 0;
    const push = (t) => {
      if (typeof t !== "string" || t.trim() === "") return;
      size += t.length;
      if (size > config.maxChars) throw new Error("too much text on the page to scan");
      texts.push(t);
    };
    const start = root && root.nodeType === 9 ? root.documentElement : root;
    if (root && root.nodeType === 9) push(document.title);
    if (!start || start.nodeType !== 1) return texts;
    for (let el = start; el; el = el.parentElement) if (isPainted(el)) return texts;
    const joined = [];
    const walker = document.createTreeWalker(start, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.nodeType === 1 && (SKIP.has(n.tagName.toUpperCase()) || isPainted(n)) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    for (let n = walker.currentNode; n; n = walker.nextNode()) {
      if (n.nodeType === 3) {
        push(n.nodeValue);
        joined.push(n.nodeValue);
        continue;
      }
      for (const a of ATTRS) push(n.getAttribute(a));
      const tag = n.tagName.toUpperCase();
      if ((tag === "INPUT" && String(n.type).toLowerCase() !== "password") || tag === "TEXTAREA" || tag === "SELECT") push(String(n.value));
    }
    push(joined.join(""));
    return texts;
  };
  const check = () => {
    if (state.painted && !document.adoptedStyleSheets.includes(sheet)) {
      state.broken = "the redaction stylesheet was removed from the page";
    }
  };
  const deliver = (root) => {
    let texts;
    try { texts = collect(root); } catch (error) { state.broken = String(error && error.message); return; }
    if (texts.length === 0) return;
    const fn = typeof send === "function" ? send : window[config.binding];
    if (typeof fn !== "function") { state.broken = "the text scan binding is missing"; return; }
    const p = Promise.resolve()
      .then(() => fn(texts))
      .catch(() => { state.broken = "the text scan binding failed"; })
      .finally(() => pending.delete(p));
    pending.add(p);
  };
  if (config.video) {
    const observer = new MutationObserver((records) => {
      const roots = new Set();
      for (const r of records) roots.add(r.target.nodeType === 1 ? r.target : r.target.parentElement);
      for (const root of roots) if (root) deliver(root);
      check();
    });
    observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS.concat(["value", "type"]) });
    document.addEventListener("input", (e) => { if (e.target && e.target.nodeType === 1) deliver(e.target); }, true);
    document.addEventListener("DOMContentLoaded", () => deliver(document));
  }
  Object.defineProperty(window, "__vtcEvidence", {
    value: Object.freeze({
      state: () => { check(); return { painted: state.painted, broken: state.broken }; },
      collect: () => collect(document),
      flush: () => Promise.all([...pending]).then(() => true),
    }),
    writable: false,
    configurable: false,
  });
}

const initScript = (video) =>
  "(" + pageScript.toString() + ")(" +
  JSON.stringify({ paint: input.paint, color: input.mask_color, binding: BINDING, video, maxChars: input.max_scan_chars }) +
  ");";

// Whole-page check: redaction still in force, pending binding calls delivered, every text scanned.
const checkPage = async (page, hits) => {
  const r = await page.evaluate(async () => {
    const e = window.__vtcEvidence;
    if (!e) return null;
    await e.flush();
    const state = e.state();
    let texts = null;
    let error = null;
    try { texts = e.collect(); } catch (err) { error = String(err && err.message); }
    return { state, texts, error };
  });
  if (r === null || typeof r !== "object" || r.state === null || typeof r.state !== "object") {
    throw new Error("the redaction script did not run in the page");
  }
  if (r.state.painted !== true || r.state.broken) {
    throw new Error("redaction is not in force: " + clip(r.state.broken || "nothing was painted", 200));
  }
  if (r.error) throw new Error("the page could not be scanned: " + clip(r.error, 200));
  scan(r.texts, hits);
};

// ---------------------------------------------------------------- network
const guard = async (context) => {
  await context.route("**/*", (route) => {
    let origin = null;
    try { origin = new URL(route.request().url()).origin; } catch { origin = null; }
    return origin === input.origin ? route.continue() : route.abort("blockedbyclient");
  });
  if (typeof context.routeWebSocket === "function") {
    await context.routeWebSocket(/.*/, (ws) => {
      let origin = null;
      try { origin = new URL(ws.url().replace(/^ws/, "http")).origin; } catch { origin = null; }
      if (origin === input.origin) ws.connectToServer();
      else ws.close();
    });
  }
};

// Linux: the sandbox has a loopback of its own; relay the origin's port to the recorder's socket.
const startRelay = (socketPath, port) =>
  new Promise((resolve, reject) => {
    const server = createServer((client) => {
      const upstream = connect(socketPath);
      const end = () => { client.destroy(); upstream.destroy(); };
      client.on("error", end);
      upstream.on("error", end);
      client.pipe(upstream).pipe(client);
    });
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });

// ---------------------------------------------------------------- one shot
const capture = async (browser, shot, index) => {
  const record = { name: shot.name, status: "failed", hits: [] };
  const hits = new Set();
  const video = typeof shot.video_seconds === "number";
  const videoDir = join(dirname(input.out_dir), "video-" + index);
  let failure = null;
  let page = null;
  let png = null;
  const context = await browser.newContext({
    viewport: { width: shot.width, height: shot.height },
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: "UTC",
    reducedMotion: "reduce",
    serviceWorkers: "block",
    ...(video ? { recordVideo: { dir: videoDir, size: input.video_size } } : {}),
  });
  try {
    await guard(context);
    if (video) {
      await context.exposeBinding(BINDING, (_source, texts) => { scan(texts, hits); });
    }
    await context.addInitScript(initScript(video));
    page = await context.newPage();
    const response = await page.goto(input.origin + shot.path, { waitUntil: "load", timeout: input.nav_timeout_ms });
    if (!response) throw new Error("no response for " + clip(shot.path, 200));
    if (response.status() >= 400) throw new Error("HTTP " + response.status() + " for " + clip(shot.path, 200));
    if (shot.wait_for) {
      await page.locator(shot.wait_for).first().waitFor({ state: "visible", timeout: input.nav_timeout_ms });
    }
    if (video) {
      await page.waitForTimeout(Math.round(shot.video_seconds * 1000));
      await checkPage(page, hits);
    } else {
      await checkPage(page, hits);
      png = await page.screenshot({
        type: "png",
        animations: "disabled",
        caret: "hide",
        scale: "css",
        mask: input.mask.map((s) => page.locator(s)),
        maskColor: input.mask_color,
      });
      await checkPage(page, hits);
    }
  } catch (error) {
    failure = clip((error && error.message) || error, 500) || "the capture failed";
  }
  const recording = video && page !== null ? page.video() : null;
  // The recording is written only when its context closes.
  await context.close().catch(() => undefined);
  let webm = null;
  if (recording) {
    try {
      webm = readFileSync(await recording.path());
    } catch (error) {
      failure = failure || "the recording was not written: " + clip(error && error.message, 300);
    }
  }
  rmSync(videoDir, { recursive: true, force: true });
  if (hits.size > 0) {
    record.status = "discarded";
    record.hits = [...hits].sort();
  } else if (failure !== null) {
    record.detail = failure;
  } else {
    const bytes = video ? webm : png;
    if (bytes === null || bytes.length === 0) {
      record.detail = "the capture produced no file";
    } else {
      writeOut(shot.name, bytes);
      record.file = shot.name;
      record.status = "captured";
    }
  }
  return record;
};

const main = async () => {
  const mod = await import(pathToFileURL(input.playwright).href);
  const pw = mod.chromium ? mod : mod.default || mod;
  if (!pw || !pw.chromium) throw new Error("the Playwright module exports no chromium");
  let relay = null;
  let browser = null;
  try {
    if (input.relay) {
      relay = await startRelay(join(dirname(input.out_dir), "relay.sock"), Number(new URL(input.origin).port));
    }
    browser = await pw.chromium.launch({
      executablePath: input.executable,
      headless: true,
      chromiumSandbox: false,
      args: ["--force-device-scale-factor=1", "--hide-scrollbars", "--font-render-hinting=none"],
    });
    out.browser = { name: "chromium", version: clip(browser.version(), 64) || "unknown" };
    for (let i = 0; i < input.shots.length; i += 1) {
      out.shots.push(await capture(browser, input.shots[i], i));
    }
  } finally {
    if (browser !== null) await browser.close().catch(() => undefined);
    if (relay !== null) relay.close();
  }
};

main().then(save, (error) => {
  out.error = clip((error && (error.stack || error.message)) || error, 2000) || "the evidence runner failed";
  save();
});
`;
