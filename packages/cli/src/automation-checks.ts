/**
 * `vtc doctor`'s automation checks (spine AD-27 rules 1, 6 and 7; readings 189, 194, 196, 200 and
 * 203; owner: cli+binary team):
 * - `gh login`: `gh auth status`'s exit code only (no token, nothing it prints);
 * - `evidence`: the hosting PR media get (`branch`, or `attach` with gh ≥ 2.99.0 on github.com) and
 *   the browser capture uses;
 * - `ffmpeg`: optional, GIF previews;
 * - `automation`: `automationFor` over `project.yaml`, `~/.vtc/config.yaml` and this machine;
 * - `billing`: the neutral notice for a host billed through a provider (D-ci);
 * - `host web`: where research roles get host web search (D-cf, `hostWebRoute`).
 * None of them fails doctor, except a `project.yaml` that does not load.
 */
import {
  automationFor,
  HOST_WEB_OFF_NOTICE,
  PROVIDER_BILLING_NOTICE,
  type EvidenceHosting,
  type HostAuthStatus,
  type HostId,
  type ProjectConfig,
} from "@vtc/shared";
import {
  evidenceHostingFor,
  upstreamSettingsOf,
  type AutomationProbe,
} from "./automation-wiring.js";
import type { DoctorCheck } from "./doctor-checks.js";
import type { UserConfigRead } from "./user-config.js";

/** `gh auth status` (exit code only); `null` when gh is missing, which the gh line reports. */
export const checkGhLogin = (probe: AutomationProbe): DoctorCheck | null => {
  if (probe.ghVersion === null || probe.ghLoggedIn === null) return null;
  return probe.ghLoggedIn
    ? {
        name: "gh login",
        status: "ok",
        detail: "logged in (gh auth status); automatic issues and PRs use this login",
      }
    : {
        name: "gh login",
        status: "warn",
        detail:
          "not logged in (gh auth status): automatic issues and PRs are off, and merge levels 2 and 3 cannot open PRs; run gh auth login",
      };
};

const BRANCH = "PR media go to the orphan vtc-evidence branch";

/** What capture runs in: vtc's pinned browser, or the project's own Playwright (AD-24). */
const captureNote = (browser: DoctorCheck | null): { text: string; ok: boolean } | null => {
  if (browser === null) return null;
  return browser.status === "ok"
    ? { text: "capture uses vtc's pinned browser", ok: true }
    : {
        text: "no browser installed by vtc: capture uses the project's own Playwright, and without one no automatic PR opens (issues still do); run vtc doctor --install-browser",
        ok: false,
      };
};

/**
 * Where PR media go (reading 196) and whether capture has a browser (D-ce). `attach` asked for but
 * not possible warns, and so does capture without vtc's browser; the default never fails.
 */
export const checkEvidence = (
  probe: AutomationProbe,
  requested: EvidenceHosting,
  browser: DoctorCheck | null,
): DoctorCheck => {
  const decision = evidenceHostingFor(requested, probe);
  const attachable = evidenceHostingFor("attach", probe).hosting === "attach";
  const ghVersion = /\d+\.\d+\.\d+/.exec(probe.ghVersion ?? "")?.[0] ?? "";
  const hosting =
    decision.fallback !== undefined
      ? `automation.evidence_hosting is attach, but ${decision.fallback}: ${BRANCH} instead`
      : decision.hosting === "attach"
        ? `PR media are attached with gh --attach (gh ${ghVersion}, github.com)`
        : `${BRANCH} (automation.evidence_hosting: branch, the default)${attachable ? "; this gh could attach them instead (attach)" : ""}`;
  const capture = captureNote(browser);
  return {
    name: "evidence",
    status: decision.fallback === undefined && capture?.ok !== false ? "ok" : "warn",
    detail: capture === null ? hosting : `${hosting}; ${capture.text}`,
  };
};

/** ffmpeg makes the GIF previews; without it automatic PRs still open (D-ce). */
export const checkFfmpeg = (version: string | null): DoctorCheck =>
  version === null
    ? {
        name: "ffmpeg",
        status: "info",
        detail:
          "not on PATH (optional): GIF previews off; automatic PRs carry the WebM recording and screenshots, and with branch hosting they are labelled evidence: partial",
      }
    : { name: "ffmpeg", status: "ok", detail: `${version}: GIF previews on` };

const onOff = (on: boolean): string => (on ? "on" : "off");

/**
 * The project's automation as `automationFor` resolves it now (D-bz, D-by), with its notes. `vtc
 * pause` is not known here (it lives in the running engine), so the line says it stops everything.
 * `~/.vtc/config.yaml` that does not parse keeps upstream reports off.
 */
export const checkAutomation = (
  probe: AutomationProbe,
  user: UserConfigRead,
  project: Pick<ProjectConfig, "upstream" | "automation">,
): DoctorCheck => {
  const upstream = upstreamSettingsOf(user);
  const settings = automationFor(
    project,
    {
      upstream: { repo: upstream.repo, share: upstream.share },
      ...(user.ok && user.config.automation !== undefined
        ? { automation: user.config.automation }
        : {}),
    },
    { githubRemote: probe.githubRemote, ghLoggedIn: probe.ghLoggedIn === true, paused: false },
  );
  const where = user.path;
  const checkout =
    !settings.upstream || upstream.checkout !== undefined
      ? ""
      : `; upstream PRs need upstream.checkout in ${where} (a local bs-vtc clone set up for VTC), so upstream gets issues only`;
  const summary = `issues ${onOff(settings.issues)}, PRs ${onOff(settings.prs)}, upstream reports to ${settings.upstreamRepo} ${onOff(settings.upstream)}${settings.upstream && upstream.checkout !== undefined ? ` (upstream PRs from ${upstream.checkout})` : ""}`;
  const notes = settings.notes.length === 0 ? "" : `: ${settings.notes.join("; ")}`;
  const any = settings.issues || settings.prs || settings.upstream;
  return {
    name: "automation",
    status: any ? "ok" : "info",
    detail: `${summary}${notes}${checkout}${any ? "; vtc pause stops all of it" : ""}`,
  };
};

/** D-ci (reading 203): a host billed through a cloud provider or gateway gets a neutral notice. */
export const checkProviderBilling = (statuses: readonly HostAuthStatus[]): DoctorCheck | null => {
  const hosts = statuses.filter((s) => s.billing === "provider").map((s) => s.host);
  return hosts.length === 0
    ? null
    : {
        name: "billing",
        status: "info",
        detail: `${hosts.join(", ")}: ${PROVIDER_BILLING_NOTICE}`,
      };
};

const CODEX_OFF = "Codex web search: off (cached mode not confirmed; live is never used)";

/**
 * D-cf (reading 200): where a research (`host_web`) role gets web search, by the rule of
 * `hostWebRoute`: Claude Code when it is logged in (its role profiles deny the credential stores),
 * else Codex with `web_search = "cached"` confirmed (`HostCapabilities.safeHostWeb`), else none:
 * the role runs on the engine's own fetchers with `HOST_WEB_OFF_NOTICE`. Never a failure.
 */
export const checkHostWeb = (
  statuses: readonly HostAuthStatus[],
  safeHostWeb: Readonly<Partial<Record<HostId, boolean>>>,
): DoctorCheck => {
  const usable = (host: HostId): boolean =>
    statuses.some((s) => s.host === host && s.logged_in === true) && safeHostWeb[host] === true;
  const codexKnown = statuses.some((s) => s.host === "codex") || "codex" in safeHostWeb;
  const codexOff = codexKnown && safeHostWeb.codex !== true ? `; ${CODEX_OFF}` : "";
  if (usable("claude-code"))
    return {
      name: "host web",
      status: "ok",
      detail: `research roles search the web on Claude Code (its role profiles deny reading the credential stores)${codexOff}`,
    };
  if (usable("codex"))
    return {
      name: "host web",
      status: "ok",
      detail:
        'research roles search the web on Codex with web_search = "cached" (it opens no page the model picks)',
    };
  return { name: "host web", status: "info", detail: `${HOST_WEB_OFF_NOTICE}${codexOff}` };
};
