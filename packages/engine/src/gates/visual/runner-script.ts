/**
 * The visual runner (AD-24 rules 1 and 3): a VTC-written ES module the Gate Runner writes into
 * the gate command's private temp directory and runs with the project's Node, inside the gate
 * sandbox, as `node vtc-visual-runner.mjs <input.json> <result.json> <key>`. It imports Playwright
 * from the project or the doctor-installed store (never bundled), launches the pinned executable,
 * and renders every job twice in the same run with the same browser: the implementation from the
 * app server and the approved prototype, served from the base commit's `.vtc/design/prototype/`
 * (a read-only clean checkout the Gate Runner made) through request interception (no socket). The
 * determinism recipe: headless, DPR 1, `en-US`, `UTC`, a fixed clock, reduced motion, fonts
 * ready, animations and the caret off, every non-loopback request aborted, dynamic regions
 * masked. Then axe (an unmodified `axe.min.js`, reading 106), computed styles, and a per-region
 * pixelmatch diff.
 *
 * The app server is project code in the same sandbox, with the same write access to this temp
 * directory, and a process it detaches can outlive it. So the runner reads and deletes the run's
 * key file first, before it imports anything or starts the app, and writes its result once, at
 * the end, as an envelope with an HMAC under that key, listing the SHA-256 of every image it
 * wrote (`protocol.ts`). Whatever the app writes into the temp directory carries no valid MAC
 * and is not used. Playwright and pixelmatch are imported before the app starts.
 *
 * The script writes only into its output directory and the result file; the Gate Runner treats
 * the result as untrusted (`protocol.ts`). It never throws past `main`: a failure of the whole
 * run is the result's `error`.
 */
export const VISUAL_RUNNER_SCRIPT = String.raw`// VTC visual runner (generated; see packages/engine/src/gates/visual/runner-script.ts).
import { createHash, createHmac } from "node:crypto";
import { readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

// The run's key: read and deleted before any project code (Playwright, the app server) runs, so
// nothing else in the sandbox can sign a result. If it cannot be deleted, nothing runs.
const key = readFileSync(process.argv[4]);
unlinkSync(process.argv[4]);
const input = JSON.parse(readFileSync(process.argv[2], "utf8"));
const resultFile = process.argv[3];
const out = { v: 1, browser: null, renders: [], files: {} };
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
const PROTO_ORIGIN = "http://prototype.vtc.invalid";
const MASK_COLOR = "#ff00ff";
const MIME = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
};
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

const fileName = (key, suffix) => key.replace(/[^A-Za-z0-9._-]/g, "_") + suffix;

const loadChromium = async () => {
  const mod = await import(pathToFileURL(input.playwright).href);
  const pw = mod.chromium ? mod : mod.default || mod;
  if (!pw || !pw.chromium) throw new Error("the Playwright module exports no chromium");
  return pw.chromium;
};

const prototypeRoot = () => {
  try { return realpathSync(input.prototype_root); } catch { return null; }
};

const fulfillPrototype = async (route, url) => {
  const root = prototypeRoot();
  if (root === null) return route.fulfill({ status: 404, body: "no prototype" });
  let path;
  try { path = decodeURIComponent(url.pathname); } catch { return route.fulfill({ status: 400, body: "" }); }
  const target = resolve(root, "." + path);
  for (const candidate of [target, join(target, "index.html")]) {
    let real;
    try { real = realpathSync(candidate); } catch { continue; }
    if (real !== root && !real.startsWith(root + sep)) continue;
    if (!statSync(real).isFile()) continue;
    const type = MIME[extname(real).toLowerCase()] || "application/octet-stream";
    return route.fulfill({ status: 200, contentType: type, body: readFileSync(real) });
  }
  return route.fulfill({ status: 404, body: "not found" });
};

const newContext = async (browser, job) => {
  const context = await browser.newContext({
    viewport: { width: job.width, height: 900 },
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: "UTC",
    reducedMotion: "reduce",
    colorScheme: job.theme,
    serviceWorkers: "block",
  });
  await context.route("**/*", async (route) => {
    let url;
    try { url = new URL(route.request().url()); } catch { return route.abort("blockedbyclient"); }
    if (url.origin === PROTO_ORIGIN) return fulfillPrototype(route, url);
    if ((url.protocol === "http:" || url.protocol === "https:" || url.protocol === "ws:") && LOOPBACK.has(url.hostname)) {
      return route.continue();
    }
    return route.abort("blockedbyclient");
  });
  return context;
};

const openPage = async (context, url) => {
  const page = await context.newPage();
  if (page.clock && typeof page.clock.setFixedTime === "function") {
    await page.clock.setFixedTime(new Date(input.fixed_time));
  }
  let response;
  try {
    response = await page.goto(url, { waitUntil: "load", timeout: input.nav_timeout_ms });
  } catch (error) {
    return { status: "unreached", detail: clip("navigation failed: " + (error && error.message), 500), page };
  }
  if (response && response.status() >= 400) {
    return { status: "unreached", detail: "HTTP " + response.status() + " for " + clip(url, 300), page };
  }
  await page.evaluate(() => (document.fonts ? document.fonts.ready.then(() => true) : true));
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);
  return { status: "rendered", page };
};

const masks = (page) => input.dynamic_regions.map((selector) => page.locator(selector));

const shoot = async (page, file, clipRect) => {
  const png = await page.screenshot({
    fullPage: true,
    animations: "disabled",
    caret: "hide",
    mask: masks(page),
    maskColor: MASK_COLOR,
    ...(clipRect ? { clip: clipRect } : {}),
  });
  if (file !== null) writeOut(file, png);
  return png;
};

const runAxe = async (page) => {
  if (!input.axe) return null;
  await page.addScriptTag({ path: input.axe });
  const tags = input.include_best_practice ? input.axe_tags.concat(["best-practice"]) : input.axe_tags;
  return page.evaluate(async (values) => {
    const result = await window.axe.run(document, {
      runOnly: { type: "tag", values },
      resultTypes: ["violations", "incomplete"],
    });
    const items = (list) => list.map((v) => ({
      rule: String(v.id).slice(0, 100),
      impact: v.impact || null,
      help: String(v.help || v.id).slice(0, 500),
      nodes: v.nodes.length,
      targets: v.nodes.slice(0, 5).map((n) => String((n.target || []).join(" ")).slice(0, 300)),
    }));
    return { violations: items(result.violations).slice(0, 200), incomplete: items(result.incomplete).slice(0, 200) };
  }, tags);
};

const collectStyles = (page) =>
  page.evaluate(({ props, limit }) => {
    const out = [];
    const seen = new Set();
    const selectorOf = (el) => {
      const parts = [];
      for (let e = el, i = 0; e && e.nodeType === 1 && i < 4; e = e.parentElement, i += 1) {
        let part = e.tagName.toLowerCase();
        if (e.id) { parts.unshift(part + "#" + e.id); break; }
        const classes = Array.from(e.classList).slice(0, 2);
        if (classes.length > 0) part += "." + classes.join(".");
        parts.unshift(part);
      }
      return parts.join(" > ").slice(0, 300);
    };
    const sides = (cs, prop) => ["top", "right", "bottom", "left"].map((s) => cs.getPropertyValue(prop + "-" + s)).join(" ");
    let counted = 0;
    for (const el of document.querySelectorAll("body, body *")) {
      if (counted >= limit) break;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none") continue;
      counted += 1;
      const hasText = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim() !== "");
      for (const prop of props) {
        let value;
        if (prop === "padding" || prop === "margin") value = sides(cs, prop);
        else if (prop === "border-radius") {
          value = ["top-left", "top-right", "bottom-right", "bottom-left"].map((c) => cs.getPropertyValue("border-" + c + "-radius")).join(" ");
        } else if (prop === "gap") value = cs.getPropertyValue("row-gap") + " " + cs.getPropertyValue("column-gap");
        else value = cs.getPropertyValue(prop);
        if ((prop === "color" || prop === "font-family" || prop === "font-size") && !hasText) continue;
        if (prop === "border-top-color" && cs.getPropertyValue("border-top-width") === "0px") continue;
        value = String(value).trim();
        if (value === "" || value === "none" || value === "normal" || value === "normal normal") continue;
        const key = prop + "|" + value;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ selector: selectorOf(el), property: prop, value: value.slice(0, 200) });
      }
    }
    return out;
  }, { props: input.style_properties, limit: input.style_limit });

const regionsOf = (page) =>
  page.evaluate(() => {
    const found = [];
    const names = new Set();
    const add = (name, el) => {
      if (names.has(name)) return;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return;
      names.add(name);
      found.push({
        name,
        x: Math.round(r.left + window.scrollX),
        y: Math.round(r.top + window.scrollY),
        width: Math.round(r.width),
        height: Math.round(r.height),
      });
    };
    const tagged = document.querySelectorAll("[data-vtc-region]");
    if (tagged.length > 0) {
      for (const el of tagged) add(String(el.getAttribute("data-vtc-region")).slice(0, 100) || "region", el);
    } else {
      const landmarks = [
        ["header, [role=banner]", "banner"],
        ["nav, [role=navigation]", "navigation"],
        ["main, [role=main]", "main"],
        ["aside, [role=complementary]", "complementary"],
        ["footer, [role=contentinfo]", "contentinfo"],
      ];
      for (const [selector, name] of landmarks) {
        const el = document.querySelector(selector);
        if (el) add(name, el);
      }
    }
    if (found.length === 0) add("page", document.documentElement);
    return found;
  });

const toRgba = (scratch, png) =>
  scratch.evaluate(async (b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const g = canvas.getContext("2d");
    g.drawImage(bitmap, 0, 0);
    const data = g.getImageData(0, 0, bitmap.width, bitmap.height).data;
    let s = "";
    for (let i = 0; i < data.length; i += 0x8000) s += String.fromCharCode.apply(null, data.subarray(i, i + 0x8000));
    return btoa(s);
  }, Buffer.from(png).toString("base64")).then((b64) => new Uint8Array(Buffer.from(b64, "base64")));

const toPng = (scratch, rgba, width, height) =>
  scratch.evaluate(async ({ b64, width, height }) => {
    const bin = atob(b64);
    const bytes = new Uint8ClampedArray(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext("2d").putImageData(new ImageData(bytes, width, height), 0, 0);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s = "";
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return btoa(s);
  }, { b64: Buffer.from(rgba).toString("base64"), width, height }).then((b64) => Buffer.from(b64, "base64"));

const diffRegions = async (job, impl, ref, pixelmatch, scratch) => {
  const diffs = [];
  const implRegions = await regionsOf(impl);
  const refRegions = await regionsOf(ref);
  for (const r of refRegions.slice(0, 50)) {
    const i = implRegions.find((x) => x.name === r.name);
    if (!i || i.width !== r.width || i.height !== r.height) {
      diffs.push({ region: r.name, mismatch_px: 0, total_px: 0, dimension_mismatch: true });
      continue;
    }
    const a = await toRgba(scratch, await shoot(impl, null, { x: i.x, y: i.y, width: i.width, height: i.height }));
    const b = await toRgba(scratch, await shoot(ref, null, { x: r.x, y: r.y, width: r.width, height: r.height }));
    const output = new Uint8Array(r.width * r.height * 4);
    const mismatch = pixelmatch(a, b, output, r.width, r.height, { threshold: input.pixel_threshold, includeAA: false });
    const entry = { region: r.name, mismatch_px: mismatch, total_px: r.width * r.height, dimension_mismatch: false };
    if (mismatch > 0) {
      entry.diff_image = fileName(job.key, "." + r.name.replace(/[^A-Za-z0-9._-]/g, "_") + ".diff.png");
      writeOut(entry.diff_image, await toPng(scratch, output, r.width, r.height));
    }
    diffs.push(entry);
  }
  return diffs;
};

const renderJob = async (browser, job, app, pixelmatch, scratch) => {
  const record = { key: job.key, status: "error", axe: null, styles: [], diffs: [] };
  const implContext = await newContext(browser, job);
  const refContext = await newContext(browser, job);
  try {
    let impl = null;
    if (app === null) {
      record.status = "unreached";
      record.detail = "no app server is configured for the visual step";
    } else {
      const opened = await openPage(implContext, app.url.replace(/\/$/, "") + job.path);
      record.status = opened.status;
      if (opened.detail) record.detail = opened.detail;
      if (opened.status === "rendered") {
        impl = opened.page;
        record.screenshot = fileName(job.key, ".png");
        await shoot(impl, record.screenshot);
        record.axe = await runAxe(impl);
        record.styles = await collectStyles(impl);
      }
    }
    if (input.prototype_root === null) {
      record.reference = { status: "unreached", detail: "no approved prototype under .vtc/design/prototype/ at the base commit" };
    } else {
      const ref = await openPage(refContext, PROTO_ORIGIN + job.path);
      record.reference = { status: ref.status };
      if (ref.detail) record.reference.detail = ref.detail;
      if (ref.status === "rendered") {
        record.reference.screenshot = fileName(job.key, ".ref.png");
        await shoot(ref.page, record.reference.screenshot);
        if (impl !== null && pixelmatch !== null) {
          record.diffs = await diffRegions(job, impl, ref.page, pixelmatch, scratch);
        }
      }
    }
  } catch (error) {
    record.status = "error";
    record.detail = clip(error && error.message, 500);
  } finally {
    await implContext.close().catch(() => undefined);
    await refContext.close().catch(() => undefined);
  }
  return record;
};

const startApp = async (app) => {
  const child = spawn(app.command[0], app.command.slice(1), {
    cwd: app.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    env: process.env,
  });
  let log = "";
  const keep = (chunk) => { log = (log + chunk).slice(-4000); };
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  let exited = null;
  child.on("exit", (code, signal) => { exited = code === null ? String(signal) : String(code); });
  child.on("error", (error) => { exited = "spawn error: " + error.message; });
  const deadline = Date.now() + app.ready_timeout_ms;
  while (Date.now() < deadline) {
    if (exited !== null) throw new Error("the app server exited (" + exited + ") before it answered: " + clip(log, 1000));
    try {
      const response = await fetch(app.url, { redirect: "manual" });
      if (response.status < 500) return { child, url: app.url };
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  stopApp({ child });
  throw new Error("the app server did not answer at " + app.url + " within " + app.ready_timeout_ms + " ms: " + clip(log, 1000));
};

const stopApp = (app) => {
  try { process.kill(-app.child.pid, "SIGKILL"); } catch { try { app.child.kill("SIGKILL"); } catch { /* gone */ } }
};

const main = async () => {
  const chromium = await loadChromium();
  if (input.mode === "probe") {
    out.executable = chromium.executablePath();
    return;
  }
  // Imported before the app server starts, so it cannot swap the module under the runner.
  const pixelmatch = input.pixelmatch ? (await import(pathToFileURL(input.pixelmatch).href)).default : null;
  const app = input.app ? await startApp(input.app) : null;
  let browser = null;
  try {
    browser = await chromium.launch({
      executablePath: input.executable,
      headless: true,
      chromiumSandbox: false,
      args: ["--force-device-scale-factor=1", "--hide-scrollbars", "--font-render-hinting=none"],
    });
    out.browser = { name: "chromium", version: clip(browser.version(), 64) || "unknown" };
    const scratchContext = await browser.newContext();
    const scratch = await scratchContext.newPage();
    for (const job of input.jobs) {
      out.renders.push(await renderJob(browser, job, app, pixelmatch, scratch));
    }
  } finally {
    if (browser !== null) await browser.close().catch(() => undefined);
    if (app !== null) stopApp(app);
  }
};

main().then(save, (error) => {
  out.error = clip((error && (error.stack || error.message)) || error, 2000) || "the visual runner failed";
  save();
});
`;
