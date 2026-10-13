/**
 * Owner: cli+binary team (AD-5 rule 2 and 7, AD-12, AD-20). `vtc dashboard [--no-open]` opens
 * Flow Studio with the session flow: it mints a single-use nonce (the running daemon's
 * `POST /api/session/nonce` with the install token, or `RunningSnapshot.mintNonce()`) and opens
 * `http://127.0.0.1:<port>/#nonce=<nonce>`; the nonce sits in the fragment, so it never reaches a
 * server log, and the page swaps it for a session token. With no daemon for the repo it serves
 * the committed `.vtc/` snapshot read-only (`serveSnapshot`) until interrupted.
 */
import { spawn } from "node:child_process";
import { serveSnapshot } from "@vtc/engine";
import {
  ENGINE_HTTP,
  SessionNonceResultSchema,
  type AssetBundle,
  type EngineDiscovery,
  type ServeSnapshot,
} from "@vtc/shared";
import { liveDaemon } from "../daemon.js";
import { postToEngine, type EngineHttpResponse } from "../engine-http.js";
import { requireRepoRoot } from "../repo.js";
import { runtime } from "../runtime.js";
import { ensureInstallToken } from "../token.js";
import { engineVersions } from "../wiring.js";
import type { CommandSpec } from "./types.js";
import { EXIT, guarded, parseFlags } from "./util.js";

/** The URL `vtc dashboard` opens: the engine's origin with the nonce in the fragment. */
export const dashboardUrl = (port: number, nonce: string): string =>
  `http://${ENGINE_HTTP.bindHost}:${String(port)}/#nonce=${encodeURIComponent(nonce)}`;

/** Opens `url` in the default browser; failures are ignored (the URL is printed anyway). */
export const openInBrowser = (url: string, platform: NodeJS.Platform = process.platform): void => {
  const [command, args] =
    platform === "darwin"
      ? ["open", [url]]
      : platform === "win32"
        ? ["cmd", ["/d", "/c", "start", '""', url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // printed below
  }
};

export interface DashboardDeps {
  readonly liveDaemon: (vtcHome: string, repoRoot: string) => Promise<EngineDiscovery | null>;
  readonly post: (
    port: number,
    path: string,
    token: string,
    body: string,
  ) => Promise<EngineHttpResponse>;
  readonly serveSnapshot: ServeSnapshot;
  readonly assets: () => AssetBundle;
  readonly open: (url: string) => void;
  /** Resolves when the user stops a snapshot server (Ctrl-C). */
  readonly interrupted: () => Promise<void>;
}

const untilInterrupted = (): Promise<void> =>
  new Promise((resolve) => {
    const done = (): void => {
      process.off("SIGINT", done);
      process.off("SIGTERM", done);
      resolve();
    };
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });

export const defaultDashboardDeps = (): DashboardDeps => ({
  liveDaemon: (vtcHome, repoRoot) => liveDaemon(vtcHome, repoRoot),
  post: postToEngine,
  serveSnapshot,
  assets: () => runtime().assets,
  open: openInBrowser,
  interrupted: untilInterrupted,
});

export const createDashboardCommand = (
  deps: () => DashboardDeps = defaultDashboardDeps,
): CommandSpec => ({
  name: "dashboard",
  summary: "Open Flow Studio on 127.0.0.1 (live engine, or a read-only snapshot)",
  run: (args, ctx) =>
    guarded("dashboard", ctx, async () => {
      const { values } = parseFlags(args, { "no-open": { type: "boolean" } });
      const d = deps();
      const repoRoot = await requireRepoRoot(ctx.cwd);
      const token = ensureInstallToken(ctx.vtcHome);
      const show = (url: string): void => {
        ctx.io.out(`Flow Studio: ${url}`);
        if (values["no-open"] !== true) d.open(url);
      };
      const live = await d.liveDaemon(ctx.vtcHome, repoRoot);
      if (live !== null) {
        const route = ENGINE_HTTP.routes.sessionNonce;
        const response = await d.post(live.port, route.path, token, "{}");
        const parsed =
          response.status === 200
            ? SessionNonceResultSchema.safeParse(JSON.parse(response.body))
            : null;
        if (parsed?.success !== true)
          throw new Error(
            `the engine on port ${String(live.port)} did not issue a session nonce (HTTP ${String(response.status)})`,
          );
        show(dashboardUrl(live.port, parsed.data.nonce));
        return EXIT.ok;
      }
      const snapshot = await d.serveSnapshot({
        repoRoot,
        vtcHome: ctx.vtcHome,
        installToken: token,
        assets: d.assets(),
        versions: engineVersions(),
      });
      try {
        show(dashboardUrl(snapshot.port, snapshot.mintNonce().nonce));
        ctx.io.out(
          "No engine runs for this repo: serving the committed .vtc/ read-only. Ctrl-C stops it.",
        );
        await Promise.race([d.interrupted(), snapshot.closed]);
      } finally {
        await snapshot.close();
      }
      return EXIT.ok;
    }),
});

export const command = createDashboardCommand();
