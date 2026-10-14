/**
 * The `youtube` fetcher (spec §10; AD-22 rule 7; spine §5 reading 173, D-bs): a video's
 * transcript through the user's own `yt-dlp`. VTC never installs it.
 *
 * - The binary is found on an absolute `PATH` entry outside the repo (a relative entry, or one
 *   inside the project, could be a planted file), resolved through links and checked again. The
 *   child's `PATH` keeps only such entries too, so a `#!/usr/bin/env python3` yt-dlp cannot pick
 *   up an interpreter planted in the repo.
 * - It runs with an argv array and no shell, a timeout, a fresh temporary directory as its working
 *   directory, home and output, no configuration files, no cookies and no login; the directory is
 *   removed afterwards.
 * - Only a YouTube video id is passed on, as the canonical watch URL: yt-dlp does its own
 *   networking outside the injected `HttpClient`, so it never gets an arbitrary URL to fetch.
 * - The transcript is fetched data: turned into plain text, redacted, cached as a
 *   content-addressed blob like any response (so a quote locator can verify against it), and
 *   datamarked when a role reads it (`research_fetch`).
 * - Without yt-dlp the fetcher answers unavailable with the reason; `vtc doctor` asks
 *   {@link ytDlpAvailable}.
 */
import {
  canonicalCacheKey,
  FETCHER_TTL_DAYS,
  redactSecrets,
  type CacheEntry,
  type Fetcher,
  type FetchContext,
  type FetchResult,
} from "@vtc/shared";
import { execFile } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import { sha256Bytes } from "./files.js";
import type { CachedFetchContext } from "./http-fetch.js";
import { RESEARCH_HTTP_LIMITS } from "./http-fetch.js";
import type { FetchQuotaSlot } from "./quota.js";

export const YOUTUBE_FETCHER_VERSION = "2";

/** How long one yt-dlp run may take before it is killed. */
export const YT_DLP_TIMEOUT_MS = 60_000;

/** Where yt-dlp is, or why it cannot be used. */
export type YtDlpLocation =
  | {
      readonly available: true;
      readonly path: string;
      /**
       * The `PATH` the yt-dlp child gets: the absolute entries of the searched `PATH` outside
       * every excluded directory, as given and by real path (never one inside the repo).
       */
      readonly childPathEnv: string;
    }
  | { readonly available: false; readonly reason: string };

/** What one yt-dlp run did. */
export interface YtDlpRunResult {
  /** `null` when it was killed. */
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stderr: string;
}

/** Runs a binary with an argv array (never a shell). */
export type YtDlpRun = (
  binary: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly timeoutMs: number;
  },
) => Promise<YtDlpRunResult>;

/** The seam the fetcher uses: tests inject fakes and never run yt-dlp. */
export interface YtDlp {
  readonly locate: () => YtDlpLocation;
  readonly run: YtDlpRun;
  /** Parent of the fresh temporary directory of each run (default: the OS temp directory). */
  readonly tempRoot?: string;
}

const BINARY_NAMES = process.platform === "win32" ? ["yt-dlp.exe"] : ["yt-dlp"];

const within = (dir: string, path: string): boolean => {
  const rel = relative(resolve(dir), resolve(path));
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
};

const executable = (path: string): boolean => {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * Finds the user's yt-dlp (for `vtc doctor` and the fetcher): the first executable `yt-dlp` on an
 * absolute `PATH` entry outside every excluded directory (the repo; the working directory by
 * default), whose real path is outside them too, with the `PATH` its child may use (the entries
 * that pass the same check). Never installs anything.
 */
export const ytDlpAvailable = (
  options: {
    /** The `PATH` to search (default: this process's). */
    readonly pathEnv?: string | undefined;
    /** Directories yt-dlp may not come from (default: the working directory). */
    readonly excludeDirs?: readonly string[];
  } = {},
): YtDlpLocation => {
  const pathEnv = "pathEnv" in options ? options.pathEnv : process.env.PATH;
  // each excluded directory as given and by its real path, so a link cannot lead around it
  const excluded = (options.excludeDirs ?? [process.cwd()]).flatMap((dir) => {
    try {
      return [dir, realpathSync(dir)];
    } catch {
      return [dir];
    }
  });
  const outside = (path: string): boolean => !excluded.some((dir) => within(dir, path));
  /** An absolute entry outside the excluded directories, as given and by its real path. */
  const safeEntry = (entry: string): boolean => {
    if (entry === "" || !isAbsolute(entry) || !outside(entry)) return false;
    try {
      return outside(realpathSync(entry));
    } catch {
      return false;
    }
  };
  const entries = (pathEnv ?? "").split(delimiter).filter(safeEntry);
  const childPathEnv = [...new Set(entries)].join(delimiter);
  for (const entry of entries) {
    for (const name of BINARY_NAMES) {
      const candidate = join(entry, name);
      if (!executable(candidate)) continue;
      let real: string;
      try {
        real = realpathSync(candidate);
      } catch {
        continue;
      }
      if (outside(real)) return { available: true, path: candidate, childPathEnv };
    }
  }
  return {
    available: false,
    reason:
      "yt-dlp was not found on an absolute PATH entry outside the repo; VTC does not install it. Install yt-dlp yourself to fetch video transcripts",
  };
};

/** Runs a binary through `execFile` (no shell), killed at the timeout. */
export const runProcess: YtDlpRun = (binary, args, options) =>
  new Promise((done) => {
    execFile(
      binary,
      [...args],
      {
        cwd: options.cwd,
        env: { ...options.env },
        timeout: options.timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 1024,
        shell: false,
        windowsHide: true,
      },
      (error, _stdout, stderr) => {
        const killed =
          error !== null && (error as { killed?: boolean }).killed === true && error.code === null;
        const code =
          error === null ? 0 : typeof error.code === "number" ? error.code : killed ? null : 1;
        done({ exitCode: code, timedOut: killed, stderr });
      },
    );
  });

/** The real yt-dlp of the user, never searched for inside `excludeDirs` (the repo). */
export const userYtDlp = (excludeDirs?: readonly string[]): YtDlp => ({
  locate: () => ytDlpAvailable(excludeDirs === undefined ? {} : { excludeDirs }),
  run: runProcess,
});

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const WATCH_HOSTS = new Set(["www.youtube.com", "youtube.com", "m.youtube.com"]);

/** The video id of a YouTube watch, shorts, embed or youtu.be URL, or `undefined`. */
export const youtubeVideoId = (url: string): string | undefined => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "")
    return undefined;
  if (parsed.port !== "") return undefined;
  let id: string | null | undefined;
  if (parsed.hostname === "youtu.be") id = parsed.pathname.split("/")[1];
  else if (WATCH_HOSTS.has(parsed.hostname)) {
    const parts = parsed.pathname.split("/");
    if (parsed.pathname === "/watch") id = parsed.searchParams.get("v");
    else if (parts[1] === "shorts" || parts[1] === "embed" || parts[1] === "live") id = parts[2];
  }
  return id !== null && id !== undefined && VIDEO_ID.test(id) ? id : undefined;
};

/** yt-dlp's argv: subtitles only, no config, cookies, cache or playlist; output in `dir`. */
export const ytDlpArgs = (watchUrl: string, dir: string): string[] => [
  "--ignore-config",
  "--no-cookies",
  "--no-cookies-from-browser",
  "--no-cache-dir",
  "--no-playlist",
  "--no-progress",
  "--no-warnings",
  "--skip-download",
  "--write-subs",
  "--write-auto-subs",
  "--sub-langs",
  "en.*,en",
  "--sub-format",
  "vtt",
  "--socket-timeout",
  "20",
  "--paths",
  dir,
  "--output",
  "transcript.%(ext)s",
  "--",
  watchUrl,
];

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", nbsp: " " };

/**
 * Plain text of a WebVTT file: cue text only (no header, timings, cue ids, notes or inline tags),
 * with the repeated lines of rolling automatic captions dropped.
 */
export const vttToText = (vtt: string): string => {
  const out: string[] = [];
  const lines = vtt.replace(/\r\n?/g, "\n").split("\n");
  let skipBlock = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = (lines[i] ?? "").trim();
    if (line === "") {
      skipBlock = false;
      continue;
    }
    if (skipBlock) continue;
    if (/^WEBVTT\b/.test(line) || /^(NOTE|STYLE|REGION)\b/.test(line)) {
      skipBlock = true;
      continue;
    }
    if (line.includes("-->")) continue;
    // a cue id: the line right before a timing line
    if ((lines[i + 1] ?? "").includes("-->")) continue;
    const text = line
      .replace(/<[^>]*>/g, "")
      // one pass, so `&amp;lt;` stays `&lt;`
      .replace(/&(amp|lt|gt|nbsp);/g, (_, name: string) => ENTITIES[name] ?? "")
      .replace(/\s+/g, " ")
      .trim();
    if (text === "" || text === out.at(-1)) continue;
    out.push(text);
  }
  return out.join("\n");
};

/** The subtitle file to read: an English one first, then any. */
const pickSubtitle = (names: readonly string[]): string | undefined => {
  const vtt = names.filter((n) => n.startsWith("transcript.") && n.endsWith(".vtt")).sort();
  return vtt.find((n) => /^transcript\.en([.-]|\.vtt$)/.test(n)) ?? vtt[0];
};

const DETAIL_MAX = 500;
const clip = (text: string): string =>
  text.length > DETAIL_MAX ? `${text.slice(0, DETAIL_MAX - 1)}…` : text;

const lastLine = (text: string): string =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .at(-1) ?? "";

/** Options of {@link createYoutubeFetcher}. */
export interface YoutubeFetcherOptions {
  readonly ytDlp: YtDlp;
  /** The run's research quota (a yt-dlp run is one network request). */
  readonly quota?: FetchQuotaSlot | undefined;
  readonly timeoutMs?: number;
}

/** The `youtube` fetcher over the user's yt-dlp (reading 173). */
export const createYoutubeFetcher = (options: YoutubeFetcherOptions): Fetcher => {
  const version = YOUTUBE_FETCHER_VERSION;
  return {
    id: "youtube",
    version,
    async fetch(request, context: FetchContext): Promise<FetchResult> {
      if (request.fetcher !== "youtube")
        throw new TypeError(`the youtube fetcher got a ${request.fetcher} request`);
      const now = context.now();
      const empty = (status: FetchResult["status"], url: string, detail: string): FetchResult => ({
        fetcher: "youtube",
        fetcher_version: version,
        url,
        status,
        cache: "miss",
        http_status: null,
        content_type: null,
        content_sha256: null,
        bytes: 0,
        retrieved_at: now.toISOString(),
        detail: clip(detail),
      });
      const id = youtubeVideoId(request.url);
      if (id === undefined)
        return empty("blocked", request.url, "not a YouTube video URL (watch, shorts or youtu.be)");
      const watchUrl = `https://www.youtube.com/watch?v=${id}`;
      const fromEntry = (
        entry: CacheEntry,
        bytes: number,
        cache: FetchResult["cache"],
        detail?: string,
      ): FetchResult => ({
        fetcher: "youtube",
        fetcher_version: version,
        url: entry.url,
        status: "ok",
        cache,
        http_status: entry.http_status,
        content_type: entry.content_type,
        content_sha256: entry.content_sha256,
        bytes,
        retrieved_at: entry.retrieved_at,
        ...(detail === undefined ? {} : { detail: clip(detail) }),
      });

      const key = canonicalCacheKey(version, request);
      const found = await context.cache.get(context.scope, key);
      const blob =
        found === undefined
          ? undefined
          : await context.cache.blob(context.scope, found.content_sha256);
      const entry = blob === undefined ? undefined : found;
      if (
        entry !== undefined &&
        blob !== undefined &&
        now.getTime() - Date.parse(entry.retrieved_at) < entry.ttl_s * 1000
      ) {
        return fromEntry(entry, blob.length, "hit");
      }
      const failed = (detail: string): FetchResult =>
        entry !== undefined && blob !== undefined
          ? fromEntry(entry, blob.length, "stale", detail)
          : empty("error", watchUrl, detail);

      const located = options.ytDlp.locate();
      if (!located.available) return failed(`video transcripts are unavailable: ${located.reason}`);
      if (options.quota !== undefined && !options.quota.take()) {
        return empty(
          "blocked",
          watchUrl,
          `this run's research quota of ${String(options.quota.max)} network requests is spent`,
        );
      }

      const dir = await mkdtemp(join(options.ytDlp.tempRoot ?? tmpdir(), "vtc-yt-dlp-"));
      try {
        const run = await options.ytDlp.run(located.path, ytDlpArgs(watchUrl, dir), {
          cwd: dir,
          // no user config, cookies, plugins or cache: home and XDG dirs are the fresh directory
          env: {
            // absolute entries outside the repo only (a `#!/usr/bin/env python3` yt-dlp still
            // finds the user's python, never one planted in the project)
            PATH: located.childPathEnv,
            HOME: dir,
            XDG_CONFIG_HOME: dir,
            XDG_CACHE_HOME: dir,
            LANG: "C.UTF-8",
          },
          timeoutMs: options.timeoutMs ?? YT_DLP_TIMEOUT_MS,
        });
        if (run.timedOut) return failed("yt-dlp timed out");
        if (run.exitCode !== 0) {
          const why = redactSecrets(lastLine(run.stderr));
          return failed(
            `yt-dlp failed (exit ${String(run.exitCode)})${why === "" ? "" : `: ${why}`}`,
          );
        }
        const name = pickSubtitle(await readdir(dir));
        if (name === undefined)
          return empty("not_found", watchUrl, "the video has no English subtitles or captions");
        const path = join(dir, name);
        if ((await stat(path)).size > RESEARCH_HTTP_LIMITS.maxBytes)
          return empty("blocked", watchUrl, "the transcript is over the byte cap");
        const text = redactSecrets(vttToText(await readFile(path, "utf8")));
        if (text === "") return empty("not_found", watchUrl, "the video's subtitles hold no text");
        const body = new TextEncoder().encode(`${text}\n`);
        const stored: CacheEntry = {
          v: 1,
          key,
          fetcher: "youtube",
          fetcher_version: version,
          url: watchUrl,
          retrieved_at: now.toISOString(),
          ttl_s: Math.round(FETCHER_TTL_DAYS.youtube * 86_400),
          http_status: 200,
          content_type: "text/plain; charset=utf-8",
          content_sha256: sha256Bytes(body),
        };
        await context.cache.put(context.scope, stored, body);
        await (context as CachedFetchContext).requests?.remember(context.scope, key, request);
        return fromEntry(stored, body.length, "miss", "transcript by the user's yt-dlp");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
};
