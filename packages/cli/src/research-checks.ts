/**
 * `vtc doctor`'s research lines (AD-22): whether the user's own yt-dlp is there for YouTube
 * transcripts (D-bs, spine §5 reading 173) and where research search runs (H-3, reading 156).
 *
 * yt-dlp is found the way the `youtube` fetcher looks for it: on an absolute PATH entry outside
 * the repo (a repo could otherwise plant one), resolved through links. Doctor only looks for the
 * file; it never runs, installs or updates it. When lookback-research exports its own probe from
 * `@vtc/engine`'s `research` module, doctor's `ytDlp` seam should call that one instead (contract
 * proposal), so both always agree.
 */
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, relative } from "node:path";
import type { DoctorCheck } from "./doctor-checks.js";
import {
  researchKeyNamesOf,
  researchSearchProviderOf,
  type UserConfigRead,
} from "./user-config.js";

export interface YtDlpProbeEnv {
  /** `PATH`; relative and empty entries are skipped. */
  readonly pathEnv: string;
  readonly platform: NodeJS.Platform;
  /** The repo doctor runs in, whose files never count; `null` outside one. */
  readonly repoRoot: string | null;
}

const realOrNull = (path: string): string | null => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

const executableFile = (path: string): boolean => {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** The user's yt-dlp, or `null`: the first executable one on PATH that is not in the repo. */
export const findYtDlp = (env: YtDlpProbeEnv): string | null => {
  const name = env.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
  const repo = env.repoRoot === null ? null : (realOrNull(env.repoRoot) ?? env.repoRoot);
  for (const dir of env.pathEnv.split(delimiter)) {
    if (dir === "" || !isAbsolute(dir)) continue;
    const candidate = join(dir, name);
    if (!executableFile(candidate)) continue;
    const real = realOrNull(candidate);
    if (real === null) continue;
    if (repo !== null && (inside(repo, candidate) || inside(repo, real))) continue;
    return candidate;
  }
  return null;
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
