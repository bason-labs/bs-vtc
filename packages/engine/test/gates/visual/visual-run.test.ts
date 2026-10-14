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
  DESIGN_SCREENS_PATH,
  engineRepoKey,
  fingerprintFinding,
  GateReportSchema,
  HIDDEN_TESTS,
  VISUAL_SKIPPED_NO_BROWSER,
  VisualReportSchema,
} from "@vtc/shared";
import {
  projectToolchain,
  ranOnProjectToolchain,
  RunnerResultSchema,
  VISUAL_PROJECT_TOOLCHAIN_RULE,
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
  /** `real`: the real resolution in the checkout and the store, with the fake browser cache. */
  project?: boolean | "real";
  store?: "match" | "mismatch";
  runner?: (exe: string) => ReturnType<typeof fakeRunner>;
}) => {
  const browsers = tempDir("vtc-pw-cache-");
  const { exe, sha } = fakeBrowser(browsers);
  const fake = options.runner?.(exe) ?? fakeRunner(exe);
  let storeDir: string | null = null;
  const toolchains: VisualToolchains = {
    project: (checkout, _env, home) =>
      options.project === "real"
        ? projectToolchain(checkout, { PLAYWRIGHT_BROWSERS_PATH: browsers }, home)
        : options.project === true
          ? toolchain("project", browsers)
          : null,
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
    expect(render?.allowRead).toContain(render?.input.prototype_root);
    expect(render?.loopbackPort).toBe(4173);
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
    const notes = written.findings.filter((f) => f.rule_id === "vtc-visual/note");
    const pinned = notes.find((f) => /pinned the project's browser .* on first use/.test(f.title));
    expect(pinned?.sarif_level).toBe("note");
    // The comparison ran in a process that loaded the checkout's playwright-core: said, every run.
    const projectCode = (fs: readonly { rule_id: string; message?: string | undefined }[]) =>
      fs.some(
        (f) =>
          f.rule_id === VISUAL_PROJECT_TOOLCHAIN_RULE &&
          /ran on the project's own Playwright .* the change under review can modify/.test(
            f.message ?? "",
          ),
      );
    expect(projectCode(written.findings)).toBe(true);
    expect(ranOnProjectToolchain(report.visual)).toBe(true);
    // the typed field engine core reads (contracts 4.7.0, reading 137)
    expect(report.visual?.toolchain).toBe("project");
    expect(written.toolchain).toBe("project");
    const later = await h.run({ head: h.base, visual: { screens: [] } });
    expect(later.visual?.status).toBe("pass");
    const laterNotes = later.visual?.findings.filter((f) => f.rule_id === "vtc-visual/note") ?? [];
    expect(laterNotes.some((f) => /pinned the project's browser/.test(f.title))).toBe(false);
    expect(projectCode(later.visual?.findings ?? [])).toBe(true);
    // Engine core reads this to keep such a run from satisfying Level 3 (reading 124).
    expect(ranOnProjectToolchain(later.visual)).toBe(true);
  });

  it("compares with the base commit's prototype, which neither the diff nor project code can change", async () => {
    const BASE_PROTOTYPE = "<main>prototype</main>\n";
    let seen: { root: string | null; inCheckout: boolean; bytes: string | null } | null = null;
    const { h } = setup({
      project: true,
      runner: (exe) => {
        const inner = fakeRunner(exe);
        return {
          calls: inner.calls,
          runner: {
            run: (call) => {
              if (call.input.mode === "render") {
                // Project code (the app server, an earlier gate) rewrites the checkout's prototype.
                const own = join(call.checkout, ".vtc/design/prototype/index.html");
                writeFileSync(own, "<main>whatever the implementation renders</main>\n");
                const root = call.input.prototype_root;
                seen = {
                  root,
                  inCheckout:
                    root !== null && realpathSync(root).startsWith(realpathSync(call.checkout)),
                  bytes: root === null ? null : readFileSync(join(root, "index.html"), "utf8"),
                };
              }
              return inner.runner.run(call);
            },
          },
        };
      },
    });
    const head = ui(h, {
      ".vtc/design/prototype/index.html": "<main>changed by the diff</main>\n",
    });
    const report = await h.run({ head, files_scope: [".vtc/**"], visual: { screens: ["home"] } });
    expect(report.visual?.status).not.toBe("error");
    expect(seen).toMatchObject({ inCheckout: false, bytes: BASE_PROTOTYPE });
    // The reference checkout is gone after the step.
    expect(existsSync((seen as { root: string | null } | null)?.root ?? "/nonexistent")).toBe(
      false,
    );
  });

  it("prefers axe-core and pixelmatch from the browser store over the project's", async () => {
    const { h, fake } = setup({
      project: "real",
      files: {
        "node_modules/playwright-core/package.json": JSON.stringify({
          name: "playwright-core",
          version: "1.60.0",
          main: "index.js",
        }),
        "node_modules/playwright-core/index.js": "",
        "node_modules/pixelmatch/package.json": JSON.stringify({
          name: "pixelmatch",
          main: "index.js",
        }),
        "node_modules/pixelmatch/index.js": "",
        "node_modules/axe-core/package.json": JSON.stringify({ name: "axe-core" }),
        "node_modules/axe-core/axe.min.js": "",
      },
    });
    const store = join(h.home, "browsers", "node_modules");
    for (const [name, file] of [
      ["axe-core", "axe.min.js"],
      ["pixelmatch", "index.js"],
    ] as const) {
      mkdirSync(join(store, name), { recursive: true });
      writeFileSync(join(store, name, "package.json"), JSON.stringify({ name, main: "index.js" }));
      writeFileSync(join(store, name, file), "");
    }
    const report = await h.run({ head: h.base, visual: { screens: ["home"] } });
    const render = fake.calls.find((c) => c.input.mode === "render");
    expect(render?.input.axe).toBe(join(realpathSync(store), "axe-core", "axe.min.js"));
    expect(render?.input.pixelmatch).toBe(join(realpathSync(store), "pixelmatch", "index.js"));
    expect(render?.allowRead).toContain(join(h.home, "browsers"));
    expect(report.visual?.status).toBe("pass");
  });

  it("gives a finding the same fingerprint in every run, whatever its attempt's evidence path", async () => {
    const { h } = setup({
      project: true,
      runner: (exe) =>
        fakeRunner(exe, (job) => ({
          axe: {
            violations: [
              {
                rule: "image-alt",
                impact: "critical",
                help: "Images need alt text",
                nodes: 1,
                targets: ["img"],
              },
            ],
            incomplete: [],
          },
          styles: [{ selector: "p.lead", property: "color", value: "rgb(255, 0, 0)" }],
          diffs: [
            {
              region: "main",
              mismatch_px: 900,
              total_px: 1000,
              diff_image: `${job.key.replace(/[^A-Za-z0-9._-]/g, "_")}.main.diff.png`,
            },
          ],
        })),
    });
    const fingerprints = async () => {
      const report = await h.run({ head: h.base, visual: { screens: ["home"] } });
      expect(report.visual?.status).toBe("fail");
      const findings = report.visual?.findings ?? [];
      expect(findings.map((f) => f.rule_id)).toEqual(
        expect.arrayContaining([
          "axe/image-alt",
          "vtc-style/color",
          "vtc-layout/pixels",
          VISUAL_PROJECT_TOOLCHAIN_RULE,
        ]),
      );
      // The location is the screens file, never this attempt's screenshot, diff image or report.
      expect(findings.every((f) => f.location.path === DESIGN_SCREENS_PATH)).toBe(true);
      expect(findings.find((f) => f.rule_id === "vtc-layout/pixels")?.evidence.ref).toMatch(
        /\/visual\/.+\.diff\.png$/,
      );
      return {
        evidence: report.visual?.report,
        prints: findings.map((f) =>
          fingerprintFinding({
            rule_id: f.rule_id,
            path: f.location.path,
            symbol: f.location.symbol,
            snippet: f.snippet,
            line: f.location.line,
          }),
        ),
      };
    };
    const first = await fingerprints();
    await new Promise((r) => setTimeout(r, 1100));
    const second = await fingerprints();
    expect(second.evidence).not.toBe(first.evidence);
    // Every finding of the second run is the first run's (the first also had the one-off note
    // that pinned the browser), and no two findings of a run share a fingerprint.
    expect(second.prints.length).toBeGreaterThanOrEqual(4);
    expect(first.prints).toEqual(expect.arrayContaining(second.prints));
    expect(new Set(first.prints).size).toBe(first.prints.length);
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
    const passed = await ok.h.run({ head: ok.h.base, visual: { screens: [] } });
    expect(passed.visual?.status).toBe("pass");
    expect(ranOnProjectToolchain(passed.visual)).toBe(false);
    expect(passed.visual?.toolchain).toBe("vtc");
    // VTC's own comparison code: no note about project-controlled code.
    expect(
      passed.visual?.findings.some((f) => /the project's own Playwright/.test(f.message ?? "")),
    ).toBe(false);
    const bad = setup({ store: "mismatch" });
    const report = await bad.h.run({ head: bad.h.base, visual: { screens: [] } });
    expect(report.visual?.status).toBe("error");
    expect(bad.fake.calls.some((c) => c.input.mode === "render")).toBe(false);
  });

  it("prefers the doctor store over the project's Playwright when both are there (reading 124)", async () => {
    const { h, fake } = setup({ project: true, store: "match" });
    const report = await h.run({ head: h.base, visual: { screens: ["home"] } });
    expect(report.visual?.status).toBe("pass");
    // The project's Playwright was never even probed: no project code ran for the comparison.
    expect(fake.calls.some((c) => c.input.mode === "probe")).toBe(false);
    const render = fake.calls.find((c) => c.input.mode === "render");
    expect(render?.input.playwright).toBe(join(h.home, "browsers", "playwright-core", "index.js"));
    expect(
      report.visual?.findings.some((f) => /the project's own Playwright/.test(f.message ?? "")),
    ).toBe(false);
  });

  it("is error, not skipped, when the project's Playwright is installed but its probe fails", async () => {
    const probeFails = (outcome: "crash" | "refused") => (exe: string) => {
      const inner = fakeRunner(exe);
      return {
        calls: inner.calls,
        runner: {
          run: (call: VisualRunnerCall) =>
            call.input.mode !== "probe"
              ? inner.runner.run(call)
              : Promise.resolve(
                  outcome === "refused"
                    ? { ok: false as const, reason: "no OS sandbox to run it in" }
                    : {
                        ok: true as const,
                        result: RunnerResultSchema.parse({ v: 1, error: "Cannot find module" }),
                        file: () => null,
                      },
                ),
        },
      };
    };
    for (const [outcome, reason] of [
      ["crash", /could not be probed: Cannot find module/],
      ["refused", /could not be probed: no OS sandbox/],
    ] as const) {
      const { h } = setup({ project: true, runner: probeFails(outcome) });
      const report = await h.run({ head: h.base, visual: { screens: [] } });
      expect(report.visual?.status).toBe("error");
      expect(report.visual?.skipped_reason).toBeUndefined();
      expect(report.visual?.findings.at(-1)?.title).toMatch(reason);
    }
    // No browser behind a Playwright that does run: still the lenient skip (D-ay).
    const { h } = setup({ project: true, runner: () => fakeRunner("/nowhere/chrome") });
    const report = await h.run({ head: h.base, visual: { screens: [] } });
    expect(report.visual?.status).toBe("skipped");
    expect(report.visual?.skipped_reason).toMatch(/has no browser at \/nowhere\/chrome/);
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
