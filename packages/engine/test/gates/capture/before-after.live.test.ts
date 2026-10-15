/**
 * Opt-in live check of UI before/after evidence (D-ct; spine §5 reading 223): the real
 * `EvidenceRecorder.captureBeforeAfter` with this machine's gate sandbox, the browser
 * `vtc doctor --install-browser` installed and pinned, and a small Node app server, so Chromium
 * really renders base and head inside the gate sandbox. Nothing is downloaded here.
 *
 * Skipped unless both are set:
 * - `VTC_LIVE_BROWSER=1`;
 * - `VTC_LIVE_VTC_HOME`: a VTC home kept for this test, where
 *   `VTC_HOME=<that dir> vtc doctor --install-browser` has run. The test adds an allowlist entry
 *   for its own temp repository there, so it is never the user's `~/.vtc`.
 */
import { existsSync, readFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { isAbsolute, join } from "node:path";
import { type BeforeAfterRequest } from "@vtc/shared";
import { afterEach, describe, expect, it } from "vitest";
import { createEvidenceRecorder } from "../../../src/gates/capture/index.js";
import { addToAllowlist } from "../../../src/gates/index.js";
import { createGitOps } from "../../../src/git/index.js";
import { cleanupDirs, git, initRepo, tempDir, writeFile } from "../../helpers/repo.js";
import { commitAll, config, NODE } from "../fixture.js";

afterEach(cleanupDirs);

const home = process.env.VTC_LIVE_VTC_HOME ?? "";
const live = process.env.VTC_LIVE_BROWSER === "1" && isAbsolute(home) && existsSync(home);

/** The build gate: copies src/page.html to dist/ (a build the base and head each run). */
const BUILD = `import { copyFileSync, mkdirSync } from "node:fs";
mkdirSync("dist", { recursive: true });
copyFileSync("src/page.html", "dist/index.html");
`;

/** Serves dist/index.html, with a secret-looking account number the redaction must paint. */
const SERVE = `import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const page = readFileSync("dist/index.html", "utf8");
createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(page);
}).listen(Number(process.argv[2]), "127.0.0.1");
`;

const html = (title: string, color: string): string => `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>body{margin:0;font:16px sans-serif;background:${color}}main{padding:24px}</style></head>
<body><main><h1>${title}</h1><p class="account-number">4111 1111 1111 1111</p></main></body></html>
`;

const SCREENS = `version: 1
screens:
  - id: home
    route: /
`;

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

/** The width and height from a PNG's IHDR chunk, or `null` when it is not a PNG. */
const pngSize = (bytes: Buffer): { width: number; height: number } | null =>
  bytes.length > 24 && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
    ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
    : null;

const setup = async () => {
  const port = await freePort();
  const yml = config([{ id: "build", layer: "L0", command: [NODE, "tools/build.mjs"] }], {
    visual: {
      widths: [1280],
      themes: ["light"],
      redact_selectors: [".account-number"],
      app: {
        command: [NODE, "tools/serve.mjs", String(port)],
        url: `http://127.0.0.1:${String(port)}`,
        ready_timeout_s: 30,
      },
    },
  });
  const repo = initRepo({
    "tools/build.mjs": BUILD,
    "tools/serve.mjs": SERVE,
    ".vtc/gates.yml": yml,
    ".vtc/design/screens.yaml": SCREENS,
    "src/page.html": html("Old invoices page", "#ffffff"),
  });
  const base = git(repo, "rev-parse", "HEAD");
  writeFile(repo, "src/page.html", html("New invoices page", "#dbeafe"));
  const head = commitAll(repo, "head");
  addToAllowlist(home, repo, [[NODE]], new Date());
  const recorder = createEvidenceRecorder(
    { vtcHome: home, repoRoot: repo, git: createGitOps({ repoRoot: repo }) },
    { node: NODE, env: { PATH: process.env.PATH ?? "" } },
  );
  const outDir = join(tempDir("vtc-ba-live-out-"), "staging");
  const capture = (extra: Partial<BeforeAfterRequest> = {}) => {
    if (recorder.captureBeforeAfter === undefined) throw new Error("no captureBeforeAfter");
    return recorder.captureBeforeAfter({
      repoRoot: repo,
      base,
      head,
      outDir,
      redactSelectors: [],
      denyText: [],
      ...extra,
    });
  };
  return { outDir, capture };
};

describe.runIf(live)("live before/after capture (opt-in: VTC_LIVE_BROWSER)", () => {
  it("renders base and head in Chromium inside the gate sandbox at the Visual QA width", async () => {
    const h = await setup();
    const result = await h.capture({ flowSeconds: 2 });
    expect(result.partial, JSON.stringify(result)).toBeUndefined();
    expect(result.failed).toEqual([]);
    const shots = result.files.filter((f) => f.kind !== "flow_video");
    expect(shots.map((f) => [f.name, f.kind])).toEqual([
      ["01-ui1-w1280-light-before.png", "ui_before"],
      ["02-ui1-w1280-light-after.png", "ui_after"],
    ]);
    const [before, after] = shots.map((f) => readFileSync(join(h.outDir, f.name)));
    expect(pngSize(before ?? Buffer.alloc(0))?.width).toBe(1280);
    expect(pngSize(after ?? Buffer.alloc(0))?.width).toBe(1280);
    // Different commits, different pages.
    expect(before?.equals(after ?? Buffer.alloc(0))).toBe(false);
    // Both sides' flow recordings are WebM (EBML) files.
    const videos = result.files.filter((f) => f.kind === "flow_video");
    expect(videos.map((f) => f.name)).toEqual(["03-flow-before.webm", "04-flow-after.webm"]);
    for (const v of videos) {
      expect(readFileSync(join(h.outDir, v.name)).subarray(0, 4).toString("hex")).toBe("1a45dfa3");
    }
  }, 300_000);

  it("discards the head's frame whose visible text holds a denied value (fail closed)", async () => {
    const h = await setup();
    const result = await h.capture({ denyText: ["New invoices"] });
    expect(result.files.map((f) => f.kind)).toEqual(["ui_before"]);
    expect(result.failed.map((f) => f.name)).toEqual(["02-ui1-w1280-light-after.png"]);
    expect(result.partial?.reason).toBe("capture_failed");
    expect(JSON.stringify(result)).not.toContain("New invoices");
  }, 300_000);
});
