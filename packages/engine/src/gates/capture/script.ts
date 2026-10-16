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
 * - Paint (layer 2): an init script, run before any page script in every frame, adopts a
 *   stylesheet that paints every redact selector as a solid block, drops its `::before` /
 *   `::after` content and hides everything inside it, so every video frame and screenshot is
 *   covered. A selector that is not valid CSS, a stylesheet the page removed, or page CSS that wins
 *   the cascade over the paint (computed colour, pseudo content or a visible descendant, checked at
 *   every scan) fails the shot (fail closed). Screenshots also pass `mask` / `maskColor` for the
 *   painted selectors and the project's `visual.dynamic_regions` / `redact_selectors`, in every
 *   frame.
 * - Scan (layer 3): text nodes, `title` / `alt` / `aria-label` / `placeholder`, input values
 *   (not passwords), SVG text and the document title, outside painted subtrees and `script` /
 *   `style`, plus the text nodes joined (a token split over elements), are matched against
 *   `SECRET_PATTERNS` and `deny_text`: in every frame of the page, before and after every
 *   screenshot, and during a recording through a `MutationObserver` (and the `value` setters of
 *   form fields) that hands each change to the runner with `exposeBinding`, then once more over
 *   every frame before the context closes. A frame without the init script, or one removed before
 *   it could be scanned, fails the shot. It scans every text in the DOM, not only what is on
 *   screen, so it errs towards discarding. `deny_text` matches case-insensitively (AD-27 rule 6:
 *   any hit discards): as a substring, or as a whole word for a value under `deny_substring_min`
 *   characters without a `/` (spine §5 reading 212(12)). A hit discards the file; the result names only the kinds
 *   found. A shadow root (attached by script, or open) fails the shot, since neither the paint nor
 *   the scan reaches into it. Text drawn into `<canvas>`, images, CSS generated content outside
 *   painted subtrees and declarative closed shadow roots is not scanned (research §3 residual).
 * - Video: `recordVideo` always with `size` (1280x800); the file exists only after
 *   `context.close()`, then it is kept (renamed to the shot's name and hashed) or deleted.
 * - Scripted flow (D-ct, `BeforeAfterRequest.flow`): a recording with `flow` runs its steps
 *   (goto a path on the origin, click, fill a value, press a key, wait for a selector, wait a
 *   bounded time) once its first page loaded, every step and the hold after the last one within
 *   `video_seconds` of the page opening. The whole page is checked and scanned before every step
 *   and at the end, as above. A step that fails or runs out of time ends the flow as `failed`; the
 *   recording up to it is kept (if its scan passes). No step's error text is reported (it may
 *   hold a selector, which is project text).
 *
 * - App server (UI before/after, D-ct; spine §5 reading 223): with `app`, the script imports
 *   Playwright first, checks that nothing already answers on the app's loopback port, starts the
 *   app (`visual.app` of the commit's clean gate checkout) detached in a process group of its own,
 *   waits until it answers, captures every shot from its origin, and kills the group. An app that
 *   does not start, does not answer in time or stops during the capture fails the whole run
 *   (`app: "failed"`, no shot kept). Its output is discarded, so no reason carries project text.
 *   The run's key is read and deleted before the app starts, as in the visual runner, so the app
 *   cannot sign a result; so is the input, whose `deny_text` holds the run's known secret values.
 *   Known limit: on macOS the sandbox shares the host's loopback, so the free-port check before
 *   the spawn and the app's bind are not atomic. A server another process binds to that port in
 *   between, beside an app that falls back to another port instead of exiting (Vite without
 *   `strictPort`), would answer the readiness and liveness probes; nothing ties the listening
 *   socket to the child. Linux gives the sandbox a loopback of its own, where this cannot happen.
 *
 * The script writes only into its output directory, a video directory beside it and the result
 * file. It never throws past `main`: a failure of the whole run is the result's `error`.
 */
import { FLOW_HOLD_MS } from "./protocol.js";

export const EVIDENCE_RUNNER_SCRIPT = String.raw`// VTC evidence runner (generated; see packages/engine/src/gates/capture/script.ts).
import { spawn } from "node:child_process";
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
// The input holds deny_text (the run's known secret values): kept in memory only, its file deleted
// before Playwright is imported or the app server starts, so no project code can read it.
const input = JSON.parse(readFileSync(process.argv[2], "utf8"));
unlinkSync(process.argv[2]);
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
// A short value (no "/") matches as a whole word, a longer one or a path as a substring.
const escapeRe = (s) => s.replace(/[.*+?^${"$"}{}()|[\]\\/-]/g, "\\$&");
const DENY = input.deny_text
  .map((v) => String(v).trim().toLowerCase())
  .filter((v) => v !== "")
  .map((v) => {
    if (v.length >= input.deny_substring_min || v.includes("/")) return (low) => low.includes(v);
    const word = new RegExp("(?<![a-z0-9])" + escapeRe(v) + "(?![a-z0-9])");
    return (low) => word.test(low);
  });
const scan = (texts, hits) => {
  if (!Array.isArray(texts)) { hits.add("unscannable"); return; }
  for (const raw of texts) {
    if (typeof raw !== "string") { hits.add("unscannable"); continue; }
    if (raw === "") continue;
    for (const p of PATTERNS) if (!hits.has(p.kind) && p.re.test(raw)) hits.add(p.kind);
    if (hits.has("denied_text")) continue;
    const low = raw.toLowerCase();
    for (const denied of DENY) {
      if (denied(low)) { hits.add("denied_text"); break; }
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
  const fail = (reason) => { if (!state.broken) state.broken = reason; };
  let sheet = null;
  try {
    for (const selector of config.paint) document.querySelectorAll(selector);
    sheet = new CSSStyleSheet();
    for (const selector of config.paint) {
      const s = ":is(" + selector + ")";
      sheet.insertRule(s + " { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; background: " + config.color + " !important; border-color: " + config.color + " !important; caret-color: transparent !important; fill: transparent !important; stroke: transparent !important; }");
      sheet.insertRule(s + " * { visibility: hidden !important; }");
      sheet.insertRule(s + "::placeholder { color: transparent !important; }");
      sheet.insertRule(s + "::before, " + s + "::after, " + s + " *::before, " + s + " *::after { content: none !important; }");
    }
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    state.painted = true;
  } catch (error) {
    state.broken = "a redact selector is not valid CSS, so nothing could be painted";
  }
  // Neither the paint nor the scan reaches into a shadow root: one attached by script fails closed.
  if (typeof Element === "function" && typeof Element.prototype.attachShadow === "function") {
    const attach = Element.prototype.attachShadow;
    Object.defineProperty(Element.prototype, "attachShadow", {
      value: function (...args) {
        fail("the page attached a shadow root, which the redaction cannot cover");
        return attach.apply(this, args);
      },
      writable: false,
      configurable: false,
    });
  }
  const isPainted = (el) => {
    try { return el.matches(list); } catch { return true; }
  };
  // The paint holds when page CSS has not won the cascade over it: the painted element's text and
  // generated content are invisible, and so is every element inside it.
  const TRANSPARENT = "rgba(0, 0, 0, 0)";
  const paintHolds = (el) => {
    const cs = getComputedStyle(el);
    if (cs.color !== TRANSPARENT || cs.getPropertyValue("-webkit-text-fill-color") !== TRANSPARENT) return false;
    if (cs.textShadow !== "none") return false;
    for (const pseudo of ["::before", "::after"]) {
      const content = getComputedStyle(el, pseudo).content;
      if (content !== "none" && content !== "normal") return false;
    }
    for (const d of el.querySelectorAll("*")) {
      if (getComputedStyle(d).visibility !== "hidden") return false;
    }
    return true;
  };
  const checkPainted = (el) => {
    if (!paintHolds(el)) throw new Error("page CSS overrides the redaction paint, so a painted region may show");
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
    for (let el = start; el; el = el.parentElement) {
      if (isPainted(el)) { checkPainted(el); return texts; }
    }
    const joined = [];
    const painted = [];
    const walker = document.createTreeWalker(start, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => {
        if (n.nodeType !== 1) return NodeFilter.FILTER_ACCEPT;
        if (SKIP.has(n.tagName.toUpperCase())) return NodeFilter.FILTER_REJECT;
        if (isPainted(n)) { painted.push(n); return NodeFilter.FILTER_REJECT; }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    for (let n = walker.currentNode; n; n = walker.nextNode()) {
      if (n.nodeType === 3) {
        push(n.nodeValue);
        joined.push(n.nodeValue);
        continue;
      }
      if (n.shadowRoot) throw new Error("the page has a shadow root, which the scan cannot cover");
      for (const a of ATTRS) push(n.getAttribute(a));
      const tag = n.tagName.toUpperCase();
      if ((tag === "INPUT" && String(n.type).toLowerCase() !== "password") || tag === "TEXTAREA" || tag === "SELECT") push(String(n.value));
    }
    push(joined.join(""));
    for (const el of painted) checkPainted(el);
    return texts;
  };
  const check = () => {
    if (state.painted && !document.adoptedStyleSheets.includes(sheet)) {
      fail("the redaction stylesheet was removed from the page");
    }
  };
  const deliver = (root) => {
    let texts;
    try { texts = collect(root); } catch (error) { fail(String(error && error.message)); return; }
    if (texts.length === 0) return;
    const fn = typeof send === "function" ? send : window[config.binding];
    if (typeof fn !== "function") { fail("the text scan binding is missing"); return; }
    const p = Promise.resolve()
      .then(() => fn(texts))
      .catch(() => { fail("the text scan binding failed"); })
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
    // style / class / hidden too: a change there can undo the paint of a region.
    observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS.concat(["value", "type", "style", "class", "hidden"]) });
    document.addEventListener("input", (e) => { if (e.target && e.target.nodeType === 1) deliver(e.target); }, true);
    document.addEventListener("DOMContentLoaded", () => deliver(document));
    // A value a script sets fires no mutation and no input event: scan it as it is set.
    for (const name of ["HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement"]) {
      const C = window[name];
      const d = typeof C === "function" ? Object.getOwnPropertyDescriptor(C.prototype, "value") : undefined;
      if (!d || typeof d.set !== "function" || typeof d.get !== "function") continue;
      Object.defineProperty(C.prototype, "value", {
        get: d.get,
        set: function (v) { d.set.call(this, v); deliver(this); },
        enumerable: d.enumerable,
        configurable: false,
      });
    }
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

// Whole-page check, in every frame: redaction still in force, pending binding calls delivered,
// every text scanned. A frame the init script did not run in (a blocked or script-written frame)
// cannot be vouched for, so it fails the shot.
const checkFrame = async (frame, hits, where) => {
  const r = await frame.evaluate(async () => {
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
    throw new Error("the redaction script did not run in " + where);
  }
  if (r.state.painted !== true || r.state.broken) {
    throw new Error("redaction is not in force" + (where === "the page" ? "" : " in " + where) + ": " + clip(r.state.broken || "nothing was painted", 200));
  }
  if (r.error) throw new Error(where + " could not be scanned: " + clip(r.error, 200));
  scan(r.texts, hits);
};
const checkPage = async (page, hits, attached) => {
  const main = page.mainFrame();
  const frames = page.frames();
  if (!Array.isArray(frames) || !frames.includes(main)) throw new Error("the page's frames could not be listed");
  for (const frame of frames) await checkFrame(frame, hits, frame === main ? "the page" : "a frame of the page");
  // A frame that came and went may have shown text no scan saw.
  if (attached.some((f) => f.isDetached())) throw new Error("a frame was removed before its text could be scanned");
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

// ---------------------------------------------------------------- a scripted flow
// Each step within the time left; the page is checked and scanned before it (a redaction failure
// throws: the shot fails). A step that fails or runs out of time ends the flow as "failed".
const runFlow = async (page, steps, deadline, hits, attached) => {
  for (const step of steps) {
    await checkPage(page, hits, attached);
    const left = deadline - Date.now();
    if (left <= 0) return "failed";
    const timeout = Math.max(1, Math.min(left, input.nav_timeout_ms));
    try {
      if (step.action === "goto") {
        const response = await page.goto(input.origin + step.path, { waitUntil: "load", timeout });
        if (!response || response.status() >= 400) return "failed";
      } else if (step.action === "click") {
        await page.locator(step.selector).first().click({ timeout });
      } else if (step.action === "fill") {
        await page.locator(step.selector).first().fill(step.value, { timeout });
      } else if (step.action === "press") {
        await page.keyboard.press(step.key);
      } else if (step.action === "wait_for") {
        await page.locator(step.selector).first().waitFor({ state: "visible", timeout });
      } else if (step.action === "wait") {
        if (step.ms > left) return "failed";
        await page.waitForTimeout(step.ms);
      } else {
        return "failed";
      }
    } catch {
      return "failed";
    }
  }
  const left = deadline - Date.now();
  if (left > 0) await page.waitForTimeout(Math.min(${String(FLOW_HOLD_MS)}, left));
  return "scripted";
};

// ---------------------------------------------------------------- one shot
const capture = async (browser, shot, index) => {
  const record = { name: shot.name, status: "failed", hits: [] };
  const hits = new Set();
  const video = typeof shot.video_seconds === "number";
  const videoDir = join(dirname(input.out_dir), "video-" + index);
  let failure = null;
  let page = null;
  let png = null;
  const attached = [];
  const context = await browser.newContext({
    viewport: { width: shot.width, height: shot.height },
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: "UTC",
    reducedMotion: "reduce",
    serviceWorkers: "block",
    ...(shot.color_scheme ? { colorScheme: shot.color_scheme } : {}),
    ...(video ? { recordVideo: { dir: videoDir, size: input.video_size } } : {}),
  });
  try {
    await guard(context);
    if (video) {
      await context.exposeBinding(BINDING, (_source, texts) => { scan(texts, hits); });
    }
    await context.addInitScript(initScript(video));
    page = await context.newPage();
    const deadline = Date.now() + Math.round((shot.video_seconds || 0) * 1000);
    page.on("frameattached", (frame) => { attached.push(frame); });
    const response = await page.goto(input.origin + shot.path, { waitUntil: "load", timeout: input.nav_timeout_ms });
    if (!response) throw new Error("no response for " + clip(shot.path, 200));
    if (response.status() >= 400) throw new Error("HTTP " + response.status() + " for " + clip(shot.path, 200));
    if (shot.wait_for) {
      await page.locator(shot.wait_for).first().waitFor({ state: "visible", timeout: input.nav_timeout_ms });
    }
    if (video) {
      if (shot.flow) record.flow = await runFlow(page, shot.flow.steps, deadline, hits, attached);
      else await page.waitForTimeout(Math.round(shot.video_seconds * 1000));
      await checkPage(page, hits, attached);
    } else {
      await checkPage(page, hits, attached);
      png = await page.screenshot({
        type: "png",
        animations: "disabled",
        caret: "hide",
        scale: "css",
        mask: page.frames().flatMap((frame) => input.mask.map((s) => frame.locator(s))),
        maskColor: input.mask_color,
      });
      await checkPage(page, hits, attached);
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

// ---------------------------------------------------------------- the app server (before/after)
// Whether something accepts connections at host:port: on macOS the sandbox shares the host's
// loopback at the app's port, so a server already there (the developer's own dev server) would
// answer in place of the commit under capture.
const portTaken = (host, port) => new Promise((done) => {
  const socket = connect({ host, port });
  const finish = (taken) => { socket.destroy(); done(taken); };
  socket.setTimeout(2000, () => finish(false));
  socket.once("connect", () => finish(true));
  socket.once("error", () => finish(false));
});

// Its output is project text: it is never kept, so no reason can carry it.
const startApp = async (app) => {
  const url = new URL(app.url);
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  for (const host of new Set([url.hostname.replace(/^\[|\]$/g, ""), "127.0.0.1", "::1"])) {
    if (await portTaken(host, port)) {
      throw new Error("port " + port + " is already in use on the loopback: a server this capture did not start answers there, so nothing is captured from it");
    }
  }
  const child = spawn(app.command[0], app.command.slice(1), {
    cwd: app.cwd,
    stdio: ["ignore", "ignore", "ignore"],
    detached: true,
    env: process.env,
  });
  let exited = null;
  child.on("exit", (code, signal) => { exited = code === null ? String(signal) : "exit " + String(code); });
  child.on("error", () => { exited = "it could not be spawned"; });
  const started = { child, exited: () => exited };
  const deadline = Date.now() + app.ready_timeout_ms;
  while (Date.now() < deadline) {
    if (exited !== null) throw new Error("the app server stopped (" + exited + ") before it answered");
    try {
      const response = await fetch(app.url, { redirect: "manual" });
      // Answered, and by a live child (one that failed to bind would have exited).
      if (response.status < 500 && exited === null) return started;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  stopApp(started);
  throw new Error("the app server did not answer within " + app.ready_timeout_ms + " ms");
};

const stopApp = (app) => {
  try { process.kill(-app.child.pid, "SIGKILL"); } catch { try { app.child.kill("SIGKILL"); } catch { /* gone */ } }
};

const main = async () => {
  // Imported before the app server starts, so it cannot swap the module under the runner.
  const mod = await import(pathToFileURL(input.playwright).href);
  const pw = mod.chromium ? mod : mod.default || mod;
  if (!pw || !pw.chromium) throw new Error("the Playwright module exports no chromium");
  let relay = null;
  let browser = null;
  let app = null;
  try {
    if (input.relay) {
      relay = await startRelay(join(dirname(input.out_dir), "relay.sock"), Number(new URL(input.origin).port));
    }
    if (input.app) {
      try {
        app = await startApp(input.app);
      } catch (error) {
        out.app = "failed";
        throw error;
      }
      out.app = "served";
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
    // The app server died during the capture: whatever answered on its port was not its code. It
    // must still answer now, and its process must still be the one this run started.
    if (app !== null) {
      let alive = app.exited() === null;
      if (alive) {
        try {
          const response = await fetch(input.app.url, { redirect: "manual" });
          alive = response.status < 500 && app.exited() === null;
        } catch {
          alive = false;
        }
      }
      if (!alive) {
        out.app = "failed";
        out.shots = [];
        throw new Error("the app server stopped (" + (app.exited() || "it no longer answers") + ") during the capture, so what was captured from its port is not the commit's code");
      }
    }
  } finally {
    if (browser !== null) await browser.close().catch(() => undefined);
    if (app !== null) stopApp(app);
    if (relay !== null) relay.close();
  }
};

main().then(save, (error) => {
  out.error = clip((error && (error.stack || error.message)) || error, 2000) || "the evidence runner failed";
  save();
});
`;
