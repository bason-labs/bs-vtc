/**
 * `vtc doctor`'s research lines (AD-22): whether the user's own yt-dlp is there for YouTube
 * transcripts (D-bs, spine §5 reading 173) and where research search runs (H-3, reading 156).
 *
 * yt-dlp is found by the `youtube` fetcher's own probe (`research.ytDlpAvailable` from
 * `@vtc/engine`, reading 181), so doctor and the fetcher always agree: an absolute PATH entry
 * outside the repo, as given and by real path. Doctor only looks for the file; it never runs,
 * installs or updates it.
 */
import { research } from "@vtc/engine";
import type { DoctorCheck } from "./doctor-checks.js";
import {
  researchKeyNamesOf,
  researchSearchProviderOf,
  type UserConfigRead,
} from "./user-config.js";

export interface YtDlpProbeEnv {
  /** `PATH`; relative and empty entries are skipped. */
  readonly pathEnv: string;
  /** The repo doctor runs in, whose files never count; `null` outside one. */
  readonly repoRoot: string | null;
}

/** The user's yt-dlp as the `youtube` fetcher finds it, or `null`. */
export const findYtDlp = (env: YtDlpProbeEnv): string | null => {
  const found = research.ytDlpAvailable({
    pathEnv: env.pathEnv,
    excludeDirs: env.repoRoot === null ? [] : [env.repoRoot],
  });
  return found.available ? found.path : null;
};

/** Found: `ok`. Absent: an `info` line (transcripts are optional), never an install. */
export const checkYtDlp = (found: string | null): DoctorCheck =>
  found === null
    ? {
        name: "yt-dlp",
        status: "info",
        detail:
          "yt-dlp is not on PATH, so YouTube transcripts are unavailable to research (the youtube fetcher answers unavailable). VTC never installs it: install it yourself to enable them",
      }
    : {
        name: "yt-dlp",
        status: "ok",
        detail: `${found}: research's youtube fetcher runs it for video transcripts (your own install; VTC never installs or updates it)`,
      };

const HOST_SEARCH =
  "the host's own web search (Claude Code WebSearch/WebFetch, Codex web search) in the Research Analyst's session: no search API key, no extra bill";

/**
 * Where research search runs (H-3): the host's own web search, always; with
 * `research.search_provider` and the key variable `research.api_keys.search` names, the `search`
 * fetcher can also use that keyed provider. A provider without a usable key warns (the fetcher
 * stays unavailable). `null` when the file does not parse (the `env` check reports it).
 */
export const checkResearchSearch = (
  read: UserConfigRead,
  env: Readonly<Record<string, string | undefined>>,
): DoctorCheck | null => {
  if (!read.ok) return null;
  const name = "research";
  const provider = researchSearchProviderOf(read);
  const uses = `research search uses ${HOST_SEARCH}`;
  if (provider === undefined) {
    const unused = read.config.research?.api_keys.search !== undefined;
    return {
      name,
      status: "info",
      detail: unused
        ? `${uses}; research.api_keys.search is not used without research.search_provider (${read.path})`
        : `${uses} (to add a keyed provider, set research.search_provider and research.api_keys.search in ${read.path})`,
    };
  }
  const variable = researchKeyNamesOf(read).search;
  const fallback = `the search fetcher stays unavailable and research search falls back to ${HOST_SEARCH}`;
  if (variable === undefined)
    return {
      name,
      status: "warn",
      detail: `research.search_provider names ${provider}, but research.api_keys.search names no variable in ${read.path}, so ${fallback}`,
    };
  const value = env[variable];
  if (value === undefined || value === "")
    return {
      name,
      status: "warn",
      detail: `research.search_provider names ${provider}, but $${variable} is not set, so ${fallback}`,
    };
  return {
    name,
    status: "ok",
    detail: `${uses}; the search fetcher also uses ${provider} with the key in $${variable} (research.search_provider in ${read.path})`,
  };
};
