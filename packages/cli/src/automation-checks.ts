/**
 * `vtc doctor`'s automation checks (spine AD-27 rules 1, 6 and 7; readings 189, 194, 196, 200 and
 * 203; owner: cli+binary team):
 * - `gh login`: `gh auth status`'s exit code only (no token, nothing it prints);
 * - `evidence`: the hosting PR media get (`branch`, or `attach` with gh ≥ 2.99.0 on github.com) and
 *   the browser capture uses;
 * - `ffmpeg`: optional, GIF previews;
 * - `automation`: `automationFor` over `project.yaml`, `~/.vtc/config.yaml` and this machine;
 * - `upstream`: the `upstream.checkout` clone exists, its origin is `upstream.repo` on
 *   github.com, and `vtc init` ran in it;
 * - `billing`: the neutral notice for a host billed through a provider (D-ci);
 * - `host web`: where research roles get host web search (D-cf, `hostWebRoute`).
 * None of them fails doctor, except a `project.yaml` that does not load.
 */
import { statSync } from "node:fs";
import {
  automationFor,
  HOST_IDS,
  hostWebRoute,
  PROVIDER_BILLING_NOTICE,
  type EvidenceHosting,
  type HostAuthStatus,
  type HostId,
  type HostWebRoute,
  type ProjectConfig,
} from "@vtc/shared";
import {
  evidenceHostingFor,
  PROBE_TIMEOUT_MS,
  upstreamSettingsOf,
  type AutomationProbe,
} from "./automation-wiring.js";
import type { DoctorCheck } from "./doctor-checks.js";
import { isGithubUrl } from "./gh-remote-merge.js";
import type { Exec } from "./process.js";
import { isVtcProject } from "./repo.js";
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

/**
 * Whether evidence capture has its browser: only vtc's pinned browser store, never the project's
 * own Playwright (the evidence recorder; the redaction verdict must not rest on project code).
 */
const captureNote = (browser: DoctorCheck | null): { text: string; ok: boolean } | null => {
  if (browser === null) return null;
  return browser.status === "ok"
    ? { text: "capture uses vtc's pinned browser", ok: true }
    : {
        text: "no browser installed by vtc: evidence capture needs vtc's pinned browser (never the project's own Playwright), so no automatic PR opens (issues still do) until you run vtc doctor --install-browser",
        ok: false,
      };
};

const NO_RECORDER =
  "this vtc build has no evidence recorder, so no automatic PR opens (issues still do)";

/**
 * Where PR media go (reading 196) and whether capture has a browser (D-ce). `attach` asked for but
 * not possible warns, and so does capture without vtc's browser; the default never fails.
 * `recorder: false` (this build has no `gates.createEvidenceRecorder`, merge note of
 * `automation-wiring.ts`) warns too, so a build that can open no automatic PR says so.
 */
export const checkEvidence = (
  probe: AutomationProbe,
  requested: EvidenceHosting,
  browser: DoctorCheck | null,
  recorder = true,
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
  const capture = recorder ? captureNote(browser) : { text: NO_RECORDER, ok: false as boolean };
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

/** What doctor finds at `upstream.checkout`. */
export interface CheckoutFacts {
  /** The path is a directory. */
  readonly exists: boolean;
  /** `git -C <checkout> remote get-url origin`, or `null` (not a git repo, or no origin). */
  readonly origin: string | null;
  /** `vtc init` ran in it (`.vtc/project.yaml` is a file). */
  readonly vtcProject: boolean;
}

/**
 * Looks at `upstream.checkout`: the directory, its origin remote and its `.vtc/project.yaml`. `git`
 * runs by name in `cwd`, a directory of the user's own, and reaches the checkout with `-C`: on
 * Windows a bare name is looked up in the working directory first, and a checkout could ship a
 * `git.exe`.
 */
export const inspectCheckout = async (
  exec: Exec,
  checkout: string,
  cwd: string,
): Promise<CheckoutFacts> => {
  let exists: boolean;
  try {
    exists = statSync(checkout).isDirectory();
  } catch {
    exists = false;
  }
  if (!exists) return { exists, origin: null, vtcProject: false };
  const result = await exec("git", ["-C", checkout, "remote", "get-url", "origin"], {
    cwd,
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  return {
    exists,
    origin: result.code === 0 ? result.stdout.trim() || null : null,
    vtcProject: isVtcProject(checkout),
  };
};

/** `owner/name` of a github.com remote URL, lower-cased; `null` for any other URL. */
export const githubSlugOf = (url: string): string | null => {
  if (!isGithubUrl(url)) return null;
  const match = /github\.com[/:]\/?([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return match?.[1]?.toLowerCase() ?? null;
};

/**
 * `upstream.checkout` (D-by): a local clone of `upstream.repo` set up for VTC, which upstream PRs
 * are opened from. A wrong one warns here instead of failing later in the engine. The origin URL is
 * never printed (it can carry a credential); only whether it is `upstream.repo` on github.com.
 */
export const checkUpstreamCheckout = (
  repo: string,
  checkout: string,
  facts: CheckoutFacts,
): DoctorCheck => {
  const warn = (why: string): DoctorCheck => ({
    name: "upstream",
    status: "warn",
    detail: `upstream.checkout ${checkout} ${why}: upstream PRs cannot open from it, so upstream gets issues only`,
  });
  if (!facts.exists) return warn("is not a directory");
  if (facts.origin === null) return warn("is not a git repository with an origin remote");
  if (githubSlugOf(facts.origin) !== repo.toLowerCase())
    return warn(`has an origin that is not github.com/${repo} (upstream.repo)`);
  if (!facts.vtcProject) return warn("is not set up for VTC (run vtc init in it)");
  return {
    name: "upstream",
    status: "ok",
    detail: `upstream PRs from ${checkout} (origin github.com/${repo}, set up for VTC)`,
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

const LEAD_NAME: Readonly<Record<HostId, string>> = { "claude-code": "Claude", codex: "Codex" };

const routeText = (route: HostWebRoute): string =>
  !route.hostWeb
    ? route.notice
    : route.host === "claude-code"
      ? "research roles search the web on Claude Code (its role profiles deny reading the credential stores)"
      : 'research roles search the web on Codex with web_search = "cached" (it opens no page the model picks)';

/**
 * D-cf (reading 200): where a research (`host_web`) role gets web search, by the engine's own rule
 * (`hostWebRoute`) for each host that could lead a run here. A host counts as dispatchable when it
 * is logged in (doctor's view of `planDispatch`), and its host web as safe when its adapter says so
 * (`HostCapabilities.safeHostWeb`): Claude Code first, else the Lead's host when safe (Codex with
 * `web_search = "cached"` confirmed), else none, and the role runs on the engine's own fetchers
 * with `HOST_WEB_OFF_NOTICE`. When the leads differ the line says it per lead. Never a failure.
 */
export const checkHostWeb = (
  statuses: readonly HostAuthStatus[],
  safeHostWeb: Readonly<Partial<Record<HostId, boolean>>>,
): DoctorCheck => {
  const hosts = Object.fromEntries(
    HOST_IDS.map((host) => [
      host,
      {
        dispatchable: statuses.some((s) => s.host === host && s.logged_in === true),
        safeHostWeb: safeHostWeb[host] === true,
      },
    ]),
  ) as Record<HostId, { dispatchable: boolean; safeHostWeb: boolean }>;
  const codexKnown = statuses.some((s) => s.host === "codex") || "codex" in safeHostWeb;
  const codexOff = codexKnown && safeHostWeb.codex !== true ? `; ${CODEX_OFF}` : "";
  // a run is led by a host that can be dispatched; with none, any lead gives the same answer
  const leads = HOST_IDS.filter((host) => hosts[host].dispatchable);
  const routes = (leads.length === 0 ? (["claude-code"] as const) : leads).map((lead) => ({
    lead,
    route: hostWebRoute(lead, hosts),
  }));
  const texts = [...new Set(routes.map((r) => routeText(r.route)))];
  const detail =
    texts.length === 1
      ? (texts[0] ?? "")
      : routes.map((r) => `on a ${LEAD_NAME[r.lead]}-led run, ${routeText(r.route)}`).join("; ");
  return {
    name: "host web",
    status: routes.every((r) => r.route.hostWeb) ? "ok" : "info",
    detail: `${detail}${codexOff}`,
  };
};
