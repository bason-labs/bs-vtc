/**
 * `vtc doctor` in round 4 (spine AD-27 rules 1, 6 and 7; readings 189, 194, 196, 200 and 203):
 * the gh login through `gh auth status`'s exit code only, gh's version and the evidence hosting it
 * allows, ffmpeg (optional: GIF previews), the browser evidence capture uses, the automation notes
 * of `automationFor`, the neutral notice for provider billing (D-ci) and where research roles get
 * host web search (D-cf). Fakes only: no test runs the real gh, ffmpeg or a host.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  HOST_WEB_OFF_NOTICE,
  PROVIDER_BILLING_NOTICE,
  type HostAuthStatus,
  type UserConfig,
} from "@vtc/shared";
import {
  checkAutomation,
  checkEvidence,
  checkFfmpeg,
  checkGhLogin,
  checkHostWeb,
  checkProviderBilling,
} from "../src/automation-checks.js";
import type { AutomationProbe } from "../src/automation-wiring.js";
import { createDoctorCommand, type DoctorCommandEnv } from "../src/commands/doctor.js";
import type { DoctorCheck } from "../src/doctor-checks.js";
import type { Exec } from "../src/process.js";
import type { UserConfigRead } from "../src/user-config.js";
import { capture, cleanupDirs } from "./helpers.js";

afterEach(cleanupDirs);

const PROBE: AutomationProbe = {
  ghVersion: "gh version 2.101.0 (2026-09-15)",
  ghLoggedIn: true,
  githubRemote: true,
  ffmpeg: null,
};

const userRead = (config: Partial<UserConfig> = {}): UserConfigRead => ({
  ok: true,
  path: "/h/config.yaml",
  config: { version: 1, env_passthrough: [], ...config },
});

const BROWSER_OK: DoctorCheck = { name: "browser", status: "ok", detail: "chromium 140" };
const BROWSER_NONE: DoctorCheck = { name: "browser", status: "warn", detail: "none" };

describe("the gh login (AD-27 rule 1: gh auth status, exit code only)", () => {
  it("is ok when gh auth status exits 0, and warns with what stops otherwise", () => {
    expect(checkGhLogin(PROBE)).toEqual({
      name: "gh login",
      status: "ok",
      detail: "logged in (gh auth status); automatic issues and PRs use this login",
    });
    expect(checkGhLogin({ ...PROBE, ghLoggedIn: false })).toEqual({
      name: "gh login",
      status: "warn",
      detail:
        "not logged in (gh auth status): automatic issues and PRs are off, and merge levels 2 and 3 cannot open PRs; run gh auth login",
    });
  });

  it("says nothing more when gh is missing (the gh line already warns)", () => {
    expect(checkGhLogin({ ...PROBE, ghVersion: null, ghLoggedIn: false })).toBeNull();
  });
});

describe("evidence hosting and capture (reading 196, D-ce)", () => {
  it("names the default branch hosting, and that this gh could attach", () => {
    expect(checkEvidence(PROBE, "branch", BROWSER_OK)).toEqual({
      name: "evidence",
      status: "ok",
      detail:
        "PR media go to the orphan vtc-evidence branch (automation.evidence_hosting: branch, the default); this gh could attach them instead (attach); capture uses vtc's pinned browser",
    });
  });

  it("attaches with gh --attach when asked and allowed", () => {
    expect(checkEvidence(PROBE, "attach", BROWSER_OK).detail).toMatch(
      /^PR media are attached with gh --attach \(gh 2\.101\.0, github\.com\); capture uses vtc's pinned browser$/,
    );
  });

  it("warns when attach was asked for but this gh or remote cannot do it", () => {
    const check = checkEvidence(
      { ...PROBE, ghVersion: "gh version 2.98.0 (2026-08-01)" },
      "attach",
      BROWSER_OK,
    );
    expect(check.status).toBe("warn");
    expect(check.detail).toMatch(
      /^automation\.evidence_hosting is attach, but gh version 2\.98\.0 is older than 2\.99\.0, the first with --attach: PR media go to the orphan vtc-evidence branch instead/,
    );
  });

  it("says what capture falls back to without vtc's browser (Playwright presence)", () => {
    const check = checkEvidence(PROBE, "branch", BROWSER_NONE);
    expect(check.status).toBe("warn");
    expect(check.detail).toMatch(
      /no browser installed by vtc: capture uses the project's own Playwright, and without one no automatic PR opens \(issues still do\); run vtc doctor --install-browser$/,
    );
  });
});

describe("ffmpeg is optional (D-ce)", () => {
  it("turns GIF previews on when present and off, as info, when absent", () => {
    expect(checkFfmpeg("ffmpeg version 7.1")).toEqual({
      name: "ffmpeg",
      status: "ok",
      detail: "ffmpeg version 7.1: GIF previews on",
    });
    expect(checkFfmpeg(null)).toEqual({
      name: "ffmpeg",
      status: "info",
      detail:
        "not on PATH (optional): GIF previews off; automatic PRs carry the WebM recording and screenshots, and with branch hosting they are labelled evidence: partial",
    });
  });
});

describe("the automation settings of this project (automationFor, D-bz, D-by)", () => {
  it("is on by default with a GitHub remote and a gh login, upstream issues only without a checkout", () => {
    expect(checkAutomation(PROBE, userRead(), {})).toEqual({
      name: "automation",
      status: "ok",
      detail:
        "issues on, PRs on, upstream reports to bason-labs/bs-vtc on; upstream PRs need upstream.checkout in /h/config.yaml (a local bs-vtc clone set up for VTC), so upstream gets issues only; vtc pause stops all of it",
    });
  });

  it("names the upstream checkout when set", () => {
    const check = checkAutomation(
      PROBE,
      userRead({ upstream: { repo: "me/vtc", checkout: "/src/bs-vtc" } }),
      {},
    );
    expect(check.detail).toBe(
      "issues on, PRs on, upstream reports to me/vtc on (upstream PRs from /src/bs-vtc); vtc pause stops all of it",
    );
  });

  it("is off, as info, with automationFor's notes when there is no remote or login", () => {
    const check = checkAutomation(
      { ...PROBE, githubRemote: false, ghLoggedIn: false },
      userRead(),
      {},
    );
    expect(check.status).toBe("info");
    expect(check.detail).toBe(
      "issues off, PRs off, upstream reports to bason-labs/bs-vtc off: automatic issues and PRs are off: this project has no GitHub remote; automatic issues and PRs are off: gh is not logged in (run gh auth login)",
    );
  });

  it("follows project.yaml and the user-level share switch", () => {
    const check = checkAutomation(PROBE, userRead({ upstream: { share: false } }), {
      automation: { prs: false },
    });
    expect(check.detail).toBe(
      "issues on, PRs off, upstream reports to bason-labs/bs-vtc off: upstream reports are off for every project (~/.vtc/config.yaml); vtc pause stops all of it",
    );
  });

  it("keeps upstream reports off when ~/.vtc/config.yaml does not parse", () => {
    const check = checkAutomation(PROBE, { ok: false, path: "/h/config.yaml", error: "bad" }, {});
    expect(check.detail).toMatch(/upstream reports to bason-labs\/bs-vtc off/);
  });
});

const status = (host: HostAuthStatus["host"], extra: Partial<HostAuthStatus>): HostAuthStatus => ({
  host,
  logged_in: true,
  method: null,
  checked_at: "2026-10-15T00:00:00.000Z",
  ...extra,
});

describe("provider billing (D-ci, reading 203)", () => {
  it("is a neutral info line, never a warning", () => {
    expect(
      checkProviderBilling([
        status("claude-code", { billing: "provider" }),
        status("codex", { billing: "subscription" }),
      ]),
    ).toEqual({
      name: "billing",
      status: "info",
      detail: `claude-code: ${PROVIDER_BILLING_NOTICE}`,
    });
    expect(checkProviderBilling([status("codex", { billing: "api_key" })])).toBeNull();
  });
});

describe("host web search for research roles (D-cf, reading 200)", () => {
  it("prefers Claude Code, whose role profiles deny the credential stores", () => {
    expect(
      checkHostWeb([status("claude-code", {}), status("codex", {})], {
        "claude-code": true,
        codex: false,
      }),
    ).toEqual({
      name: "host web",
      status: "ok",
      detail:
        "research roles search the web on Claude Code (its role profiles deny reading the credential stores); Codex web search: off (cached mode not confirmed; live is never used)",
    });
  });

  it("uses Codex in cached mode when Claude Code is not there", () => {
    expect(
      checkHostWeb([status("claude-code", { logged_in: false }), status("codex", {})], {
        "claude-code": true,
        codex: true,
      }).detail,
    ).toBe(
      'research roles search the web on Codex with web_search = "cached" (it opens no page the model picks)',
    );
  });

  it("says research runs without host web search, as info, when no host can search safely", () => {
    expect(checkHostWeb([status("codex", {})], { codex: false })).toEqual({
      name: "host web",
      status: "info",
      detail: `${HOST_WEB_OFF_NOTICE}; Codex web search: off (cached mode not confirmed; live is never used)`,
    });
  });
});

describe("vtc doctor prints the automation checks", () => {
  const quiet: Exec = () => Promise.resolve({ code: 0, stdout: "", stderr: "" });

  const doctor = async (
    env: Partial<DoctorCommandEnv>,
  ): Promise<{ code: number; text: string }> => {
    const { ctx, out } = capture("/w", "/h");
    const code = await createDoctorCommand(() => ({
      exec: quiet,
      versions: { node: "22.17.1" },
      ...env,
    })).run([], ctx);
    return { code, text: out.join("\n") };
  };

  it("adds gh login, evidence, ffmpeg, automation, billing and host web, and fails none of them", async () => {
    const { code, text } = await doctor({
      userConfig: () => userRead(),
      automation: {
        probe: () => Promise.resolve({ ...PROBE, ghLoggedIn: false }),
        project: () => Promise.resolve({}),
      },
      hostAuth: () => Promise.resolve([status("claude-code", { billing: "provider" })]),
      hostWeb: () => Promise.resolve({ "claude-code": true }),
    });
    expect(code).toBe(0);
    expect(text).toMatch(/^warn {2}gh login {5}not logged in \(gh auth status\)/m);
    expect(text).toMatch(/^ok {4}evidence {5}PR media go to the orphan vtc-evidence branch/m);
    expect(text).toMatch(/^info {2}ffmpeg {7}not on PATH \(optional\): GIF previews off/m);
    expect(text).toMatch(/^info {2}automation {3}issues off, PRs off/m);
    expect(text).toMatch(/^info {2}billing {6}claude-code: billed through your cloud provider/m);
    expect(text).toMatch(/^ok {4}host web {5}research roles search the web on Claude Code/m);
  });

  it("leaves the project line out outside a VTC repo, and reports a project.yaml that does not load", async () => {
    const outside = await doctor({
      userConfig: () => userRead(),
      automation: { probe: () => Promise.resolve(PROBE), project: () => Promise.resolve(null) },
    });
    expect(outside.text).not.toMatch(/automation {3}/);
    expect(outside.text).toMatch(/gh login/);
    const broken = await doctor({
      userConfig: () => userRead(),
      automation: {
        probe: () => Promise.resolve(PROBE),
        project: () => Promise.reject(new Error(".vtc/project.yaml: automation.issues: bad")),
      },
    });
    expect(broken.code).toBe(1);
    expect(broken.text).toMatch(
      /^FAIL {2}automation {3}cannot read the project's settings: \.vtc\/project\.yaml: automation\.issues: bad/m,
    );
  });
});
