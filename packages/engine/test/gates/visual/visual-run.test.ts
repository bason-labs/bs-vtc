/**
 * The visual step inside a real gate run (AD-24) with a fake visual runner and fake toolchains:
 * no browser is ever started or downloaded.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BROWSER_PIN_FILE,
  engineRepoKey,
  GateReportSchema,
  HIDDEN_TESTS,
  VISUAL_SKIPPED_NO_BROWSER,
  VisualReportSchema,
} from "@vtc/shared";
import {
  RunnerResultSchema,
  type RunnerInput,
  type VisualRunner,
  type VisualRunnerCall,
  type VisualToolchain,
  type VisualToolchains,
} from "../../../src/gates/visual/index.js";
import { encodePng } from "../../../src/gates/visual/png.js";
import { commitAll, config, harness, NODE, testsGate, cases } from "../fixture.js";
import { tempDir, writeFile } from "../../helpers/repo.js";

const SCREENS = `version: 1
screens:
  - id: home
    route: /
  - id: invoices
    route: /invoices
    states: [empty, error]
`;
const TOKENS = JSON.stringify({
  color: { $type: "color", ink: { $value: "#111111" }, paper: { $value: "#ffffff" } },
  space: { $type: "dimension", s: { $value: "8px" }, m: { $value: "16px" } },
});
const APP = `visual:
  widths: [390]
  themes: [light]
  app:
    command: ["${NODE}", "tools/serve.mjs"]
    url: http://127.0.0.1:4173
`;
const DESIGN = {
  ".vtc/design/screens.yaml": SCREENS,
  ".vtc/design/tokens.json": TOKENS,
  ".vtc/design/prototype/index.html": "<main>prototype</main>\n",
  "tests/a.json": cases([{ name: "[REQ-1] works" }]),
};
const PNG = encodePng({ width: 2, height: 2, data: new Uint8Array(16).fill(200) });

/** A fake browser store: an "executable" whose hash the pin records. */
const fakeBrowser = (dir: string): { exe: string; sha: string } => {
  mkdirSync(dir, { recursive: true });
  const exe = join(dir, "chrome-headless-shell");
  writeFileSync(exe, "#!/bin/sh\necho fake browser\n");
  return { exe, sha: createHash("sha256").update(readFileSync(exe)).digest("hex") };
};

const toolchain = (source: "project" | "vtc", browsersPath: string): VisualToolchain => ({
  source,
  playwright: join(browsersPath, "playwright-core", "index.js"),
  playwrightVersion: "1.60.0",
  axe: join(browsersPath, "axe.min.js"),
  pixelmatch: join(browsersPath, "pixelmatch.js"),
  browsersPath,
  readable: [browsersPath],
});

/**
 * A fake runner: answers the probe with `exe`, renders every job as `render` says (default: a
 * clean render with a screenshot and a reference), and records each call.
 */
const fakeRunner = (
  exe: string | null,
  render: (job: RunnerInput["jobs"][number]) => Record<string, unknown> = () => ({}),
): { runner: VisualRunner; calls: VisualRunnerCall[] } => {
  const calls: VisualRunnerCall[] = [];
  return {
    calls,
    runner: {
      run: (call) => {
        calls.push(call);
        if (call.input.mode === "probe") {
          return Promise.resolve({
            ok: true,
            result: RunnerResultSchema.parse({
              v: 1,
              ...(exe === null ? {} : { executable: exe }),
            }),
            file: () => null,
          });
        }
        const renders = call.input.jobs.map((job) => {
          const base = job.key.replace(/[^A-Za-z0-9._-]/g, "_");
          return {
            key: job.key,
            status: "rendered",
            screenshot: `${base}.png`,
            reference: { status: "rendered", screenshot: `${base}.ref.png` },
            axe: { violations: [], incomplete: [] },
            styles: [{ selector: "body", property: "color", value: "rgb(17, 17, 17)" }],
            diffs: [{ region: "main", mismatch_px: 0, total_px: 1000 }],
            ...render(job),
          };
        });
        return Promise.resolve({
          ok: true,
          result: RunnerResultSchema.parse({
            v: 1,
            browser: { name: "chromium", version: "140" },
            renders,
          }),
          file: (name: string) => (name.endsWith(".png") ? PNG : null),
        });
      },
    },
  };
};

const setup = (options: {
  files?: Record<string, string>;
  gatesExtra?: string;
  project?: boolean;
  store?: "match" | "mismatch";
  runner?: (exe: string) => ReturnType<typeof fakeRunner>;
}) => {
  const browsers = tempDir("vtc-pw-cache-");
  const { exe, sha } = fakeBrowser(browsers);
  const fake = options.runner?.(exe) ?? fakeRunner(exe);
  let storeDir: string | null = null;
  const toolchains: VisualToolchains = {
    project: () => (options.project === true ? toolchain("project", browsers) : null),
    store: (home) => (storeDir === null ? null : toolchain("vtc", join(home, "browsers"))),
  };
  const h = harness(
    { ...DESIGN, ...options.files },
    config([testsGate]) + (options.gatesExtra ?? APP),
    { visual: { visualRunner: fake.runner, visualToolchains: toolchains } },
  );
  if (options.store !== undefined) {
    storeDir = join(h.home, "browsers");
    const store = fakeBrowser(join(storeDir, "chromium"));
    writeFileSync(
      join(h.home, BROWSER_PIN_FILE),
      JSON.stringify({
        v: 1,
        source: "vtc",
        name: "chromium",
        version: "140.0",
        playwright_core_version: "1.60.0",
        executable: store.exe,
        executable_sha256: options.store === "match" ? store.sha : "0".repeat(64),
        installed_at: "2026-10-14T08:00:00.000Z",
      }),
    );
  }
  return { h, fake, exe, sha };
};

const ui = (h: ReturnType<typeof setup>["h"], files: Record<string, string>): string => {
  for (const [path, content] of Object.entries(files)) writeFile(h.repo, path, content);
  return commitAll(h.repo, "ui change");
};

describe("visual step in a gate run", () => {
  it("is skipped with the visible reason when there is no browser, and the verdict is unchanged", async () => {
    const { h } = setup({});
    const report = GateReportSchema.parse(await h.run({ head: h.base, visual: { screens: [] } }));
    expect(report.verdict).toBe("pass");
    expect(report.visual).toMatchObject({
      status: "skipped",
      skipped_reason: VISUAL_SKIPPED_NO_BROWSER,
    });
    const path = report.visual?.report ?? "";
    expect(path).toMatch(/^\.vtc\/evidence\/T-1\/gates\/.+\/visual\/report\.json$/);
    const written = VisualReportSchema.parse(JSON.parse(readFileSync(join(h.repo, path), "utf8")));
    expect(written.status).toBe("skipped");
  });

  it("has no visual summary when the request does not ask for the step", async () => {
    const { h } = setup({});
    const report = await h.run({ head: h.base });
    expect(report.visual).toBeUndefined();
  });

  it("renders the full matrix with the project's browser, pinned on first use", async () => {
    const { h, fake, exe, sha } = setup({ project: true });
    const report = GateReportSchema.parse(await h.run({ head: h.base, visual: { screens: [] } }));
    expect(report.visual?.status).toBe("pass");
    const render = fake.calls.find((c) => c.input.mode === "render");
    expect(render?.input.jobs.map((j) => j.key)).toEqual([
      "home:default:390:light",
      "invoices:empty:390:light",
      "invoices:error:390:light",
    ]);
    expect(render?.input.jobs[1]?.path).toBe("/invoices?state=empty&theme=light");
    expect(render?.input.executable).toBe(realpathSync(exe));
    expect(render?.input.app).toMatchObject({
      command: [NODE, "tools/serve.mjs"],
      url: "http://127.0.0.1:4173",
    });
    expect(render?.input.prototype_root).toMatch(/\.vtc\/design\/prototype$/);
    expect(render?.loopback).toBe(true);
    expect(render?.env.PLAYWRIGHT_BROWSERS_PATH).toBeDefined();
    expect(report.visual?.counts.renders).toBe(3);
    const written = VisualReportSchema.parse(
      JSON.parse(readFileSync(join(h.repo, report.visual?.report ?? ""), "utf8")),
    );
    expect(written.browser?.executable_sha256).toBe(sha);
    const shot = written.renders[0]?.screenshot ?? "";
    expect(existsSync(join(h.repo, shot))).toBe(true);
    const pins = join(h.home, "browsers", "projects");
    expect(existsSync(pins)).toBe(true);
  });

  it("renders only the requested screens", async () => {
    const { h, fake } = setup({ project: true });
    await h.run({ head: h.base, visual: { screens: ["home"] } });
    const render = fake.calls.find((c) => c.input.mode === "render");
    expect(render?.input.jobs.map((j) => j.key)).toEqual(["home:default:390:light"]);
  });

  it("is error when the project's browser no longer matches its pin", async () => {
    const { h, exe } = setup({ project: true });
    await h.run({ head: h.base, visual: { screens: [] } });
    writeFileSync(exe, "tampered");
    const report = await h.run({ head: h.base, visual: { screens: [] } });
    expect(report.visual?.status).toBe("error");
    expect(report.visual?.findings.at(-1)?.title).toMatch(/does not match its pin/);
    expect(report.verdict).toBe("pass");
  });

  it("uses the doctor-installed browser and fails closed on a pin mismatch", async () => {
    const ok = setup({ store: "match" });
    expect((await ok.h.run({ head: ok.h.base, visual: { screens: [] } })).visual?.status).toBe(
      "pass",
    );
    const bad = setup({ store: "mismatch" });
    const report = await bad.h.run({ head: bad.h.base, visual: { screens: [] } });
    expect(report.visual?.status).toBe("error");
    expect(bad.fake.calls.some((c) => c.input.mode === "render")).toBe(false);
  });

  it("is unchecked when a render is not reached", async () => {
    const { h } = setup({
      project: true,
      runner: (exe) =>
        fakeRunner(exe, (job) =>
          job.key.startsWith("invoices:error")
            ? { status: "unreached", detail: "HTTP 404", screenshot: undefined }
            : {},
        ),
    });
    const report = await h.run({ head: h.base, visual: { screens: [] } });
    expect(report.visual?.status).toBe("unchecked");
    expect(report.visual?.counts.unreached).toBe(1);
    expect(report.verdict).toBe("pass");
  });

  it("is error without an app server, or with one the allowlist does not allow", async () => {
    const none = setup({ project: true, gatesExtra: "visual:\n  widths: [390]\n" });
    const r1 = await none.h.run({ head: none.h.base, visual: { screens: [] } });
    expect(r1.visual?.status).toBe("error");
    expect(r1.visual?.findings.at(-1)?.title).toMatch(/no app server/);
    const denied = setup({
      project: true,
      gatesExtra: 'visual:\n  app:\n    command: ["npx", "vite"]\n    url: http://127.0.0.1:5173\n',
    });
    const r2 = await denied.h.run({ head: denied.h.base, visual: { screens: [] } });
    expect(r2.visual?.status).toBe("error");
    expect(r2.visual?.findings.at(-1)?.title).toMatch(/allowlist/);
  });

  it("reports token lint and detector findings from the diff, even with no browser", async () => {
    const { h } = setup({});
    const head = ui(h, {
      "web/card.css": ".card { color: #ff0000; border-left: 4px solid #3355ff; }\n",
    });
    const report = GateReportSchema.parse(
      await h.run({ head, files_scope: ["web/**"], visual: { screens: [] } }),
    );
    expect(report.visual?.status).toBe("fail");
    expect(report.visual?.counts).toMatchObject({ token_lint: 2, detector: 1 });
    expect(report.visual?.findings.map((f) => f.rule_id)).toEqual(
      expect.arrayContaining(["vtc-token/color", "vtc-design/side-tab"]),
    );
    expect(report.verdict).toBe("pass");
  });
  it("takes the hidden acceptance tests out of the checkout before rendering (§7.3)", async () => {
    let seenDuringRender: boolean | null = null;
    const { h } = setup({
      project: true,
      runner: (exe) => {
        const inner = fakeRunner(exe);
        return {
          calls: inner.calls,
          runner: {
            run: (call) => {
              if (call.input.mode === "render") {
                seenDuringRender = existsSync(join(call.checkout, "tests/hidden.json"));
              }
              return inner.runner.run(call);
            },
          },
        };
      },
    });
    const hiddenDir = join(h.home, HIDDEN_TESTS.homeDir, engineRepoKey(h.repo), "T-1", "tests");
    mkdirSync(hiddenDir, { recursive: true });
    writeFileSync(join(hiddenDir, "hidden.json"), cases([{ name: "[REQ-1] hidden" }]));
    const report = await h.run({ head: h.base, include_hidden: true, visual: { screens: [] } });
    expect(report.results.find((r) => r.layer === "L2")?.tests?.executed).toBe(2);
    expect(seenDuringRender).toBe(false);
  });
});
