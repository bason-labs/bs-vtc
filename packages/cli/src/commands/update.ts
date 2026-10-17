/**
 * Owner: cli+binary team. `vtc update [--check] [--version vX.Y.Z] [--yes] [--wait] [--repo <path>]…`:
 * replaces this `vtc` with the newest release (or the one named) and installs the host plugins
 * again with it (`update.ts`). `--check` only reports. The human confirms at the terminal unless
 * `--yes`. When a role run is in flight under a running engine, the update stops there, or with
 * `--wait` waits for the role runs to finish. `--repo` adds repos whose Codex install to refresh
 * besides the ones `vtc install codex` recorded.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ttyConfirm } from "../confirm.js";
import { stopDaemon } from "../daemon.js";
import { exec as realExec, type Exec } from "../process.js";
import { findRepoRoot, UsageError } from "../repo.js";
import { runtime } from "../runtime.js";
import {
  checkNewBinary,
  claudeCodeInstalled,
  codexInstalledIn,
  compareVersions,
  engineRecords,
  fetchRelease,
  listReleases,
  parseVersion,
  readProjects,
  releaseNotes,
  releaseTarget,
  rememberCodexProject,
  replaceBinary,
  replaceProblem,
  roleRunHost,
  roleRunsUnder,
  type ChildProcessInfo,
  type Release,
} from "../update.js";
import { VERSION } from "../version.js";
import type { CommandSpec } from "./types.js";
import { EXIT, guarded, parseFlags } from "./util.js";

export interface UpdateDeps {
  readonly exec: Exec;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  /** The running `vtc` binary (`process.execPath` in the binary). */
  readonly execPath: string;
  readonly runtimeKind: "dev" | "binary";
  readonly version: string;
  /** A fresh empty folder for the download. */
  readonly tempDir: () => string;
  readonly confirm: (question: string) => Promise<boolean>;
  /** Stops a repo's engine as `vtc engine --stop` does; resolves the stopped pid or `null`. */
  readonly stopEngine: (vtcHome: string, repoRoot: string) => Promise<number | null>;
  readonly sleep: (ms: number) => Promise<void>;
  /** A folder that is no git repo, to run `vtc install claude-code` in (no session sandbox step). */
  readonly neutralDir: () => string;
}

export const defaultUpdateDeps = (): UpdateDeps => ({
  exec: realExec,
  platform: process.platform,
  arch: process.arch,
  execPath: process.execPath,
  runtimeKind: runtime().kind,
  version: VERSION,
  tempDir: () => mkdtempSync(join(tmpdir(), "vtc-update-")),
  confirm: ttyConfirm,
  stopEngine: (vtcHome, repoRoot) => stopDaemon(vtcHome, repoRoot),
  sleep: (ms) =>
    new Promise((done) => {
      setTimeout(done, ms);
    }),
  neutralDir: homedir,
});

/** How often `--wait` looks again at the role runs in flight. */
export const WAIT_POLL_MS = 15_000;

const USAGE = "usage: vtc update [--check] [--version vX.Y.Z] [--yes] [--wait] [--repo <path>]...";

/** `2 Codex role runs` (a run's wrapper and its native child count once: by host and command). */
const roleRunCount = (children: readonly ChildProcessInfo[]): string => {
  const byHost = new Map<string, number>();
  for (const c of children) {
    if (/\/vendor\//.test(c.command)) continue; // the npm wrapper's native child
    const host = roleRunHost(c.command) === "codex" ? "Codex" : "Claude Code";
    byHost.set(host, (byHost.get(host) ?? 0) + 1);
  }
  return (
    [...byHost]
      .map(([host, n]) => `${String(n)} ${host} role run${n === 1 ? "" : "s"}`)
      .join(" and ") || "a role run"
  );
};

interface Busy {
  readonly repo: string;
  readonly children: readonly ChildProcessInfo[] | null;
}

export const createUpdateCommand = (deps: () => UpdateDeps = defaultUpdateDeps): CommandSpec => ({
  name: "update",
  summary:
    "Update vtc to the newest release (checked against SHA256SUMS) and install its host plugins again; --check only reports",
  run: (args, ctx) =>
    guarded("update", ctx, async () => {
      const { values } = parseFlags(args, {
        check: { type: "boolean" },
        version: { type: "string" },
        yes: { type: "boolean" },
        wait: { type: "boolean" },
        repo: { type: "string", multiple: true },
      });
      const d = deps();
      const current = parseVersion(d.version);
      if (current === null) throw new Error(`this vtc has no release version (${d.version})`);
      const wanted = values.version === undefined ? null : parseVersion(values.version);
      if (values.version !== undefined && wanted === null)
        throw new UsageError(`--version takes vX.Y.Z, got ${values.version}. ${USAGE}`);

      const releases = await listReleases(d.exec);
      let release: Release | undefined;
      if (wanted === null) release = releases[0];
      else release = releases.find((r) => compareVersions(r.version, wanted) === 0);
      if (release === undefined)
        throw new Error(
          wanted === null
            ? "no release of vtc is published yet"
            : `there is no release v${wanted.join(".")}`,
        );
      const target = release.version.join(".");
      const order = compareVersions(release.version, current);
      if (order === 0) {
        ctx.io.out(`vtc ${d.version} is already up to date.`);
        return EXIT.ok;
      }
      if (order < 0 && wanted === null) {
        ctx.io.out(`vtc ${d.version} is newer than the newest release (${target}); nothing to do.`);
        return EXIT.ok;
      }
      if (values.check === true) {
        ctx.io.out(
          order > 0
            ? `Update available: vtc ${d.version} -> ${target}. Run vtc update to install it.`
            : `vtc ${target} is older than this vtc ${d.version}.`,
        );
        return EXIT.ok;
      }

      if (d.runtimeKind === "dev")
        throw new Error(
          "this vtc runs from source; update it with git pull and pnpm build instead",
        );
      const platformTarget = releaseTarget(d.platform, d.arch);
      if (d.platform === "win32" || platformTarget === null)
        throw new Error(
          `vtc update cannot replace the running vtc on ${d.platform}-${d.arch}: download ${target} with gh release download v${target} --repo bason-labs/bs-vtc, check it against SHA256SUMS and replace ${d.execPath} by hand`,
        );
      const problem = replaceProblem(d.execPath);
      if (problem !== null)
        throw new Error(
          `${problem}. Download v${target} with gh release download v${target} --repo bason-labs/bs-vtc, check it against SHA256SUMS and install it with: install -m 0755 vtc ${d.execPath}`,
        );

      if (
        values.yes !== true &&
        !(await d.confirm(
          `Update vtc ${d.version} -> ${target}? Running VTC engines restart; your runs continue where they are.`,
        ))
      ) {
        ctx.io.out(
          "vtc was not updated (confirm at a terminal, or pass --yes where there is none).",
        );
        return EXIT.failed;
      }

      const dir = d.tempDir();
      try {
        ctx.io.out(`Downloading vtc ${target} for ${platformTarget}...`);
        const binary = await fetchRelease(d.exec, release, platformTarget, dir);
        ctx.io.out(`Checksum OK. ${await checkNewBinary(d.exec, binary, target)}`);

        // engines: none may be stopped under a role run
        const engines = engineRecords(ctx.vtcHome);
        const busy = async (): Promise<Busy[]> => {
          const found: Busy[] = [];
          for (const record of engines) {
            const children = await roleRunsUnder(d.exec, record.pid);
            if (children === null || children.length > 0)
              found.push({ repo: record.repo_root, children });
          }
          return found;
        };
        let inFlight = await busy();
        if (inFlight.length > 0 && values.wait === true) {
          ctx.io.out("Waiting for the role runs in flight to finish (Ctrl-C to stop waiting)...");
          while (inFlight.length > 0) {
            await d.sleep(WAIT_POLL_MS);
            inFlight = await busy();
          }
        }
        if (inFlight.length > 0) {
          for (const b of inFlight)
            ctx.io.err(
              b.children === null
                ? `vtc update: cannot tell whether the engine of ${b.repo} is running a role`
                : `vtc update: the engine of ${b.repo} is running ${roleRunCount(b.children)}`,
            );
          ctx.io.err(
            "vtc update: nothing was changed. Run vtc update --wait to update once they finish, or again later.",
          );
          return EXIT.failed;
        }
        for (const record of engines) {
          const pid = await d.stopEngine(ctx.vtcHome, record.repo_root);
          if (pid !== null)
            ctx.io.out(`Stopped the engine of ${record.repo_root} (pid ${String(pid)}).`);
        }

        const backup = replaceBinary(d.execPath, binary, d.version);
        ctx.io.out(`Installed vtc ${target} at ${d.execPath} (the old one is ${backup}).`);

        // the plugins, installed again by the new binary
        const failedInstalls: string[] = [];
        const reinstall = async (host: string, cwd: string): Promise<void> => {
          const result = await d.exec(d.execPath, ["install", host], {
            cwd,
            timeoutMs: 5 * 60_000,
          });
          if (result.code === 0) ctx.io.out(`Updated the ${host} plugin (${cwd}).`);
          else {
            failedInstalls.push(cwd);
            ctx.io.err(
              `vtc update: vtc install ${host} failed in ${cwd}: ${(result.stderr.trim() || result.error) ?? `exit ${String(result.code)}`}; run it there yourself`,
            );
          }
        };
        if (claudeCodeInstalled(ctx.vtcHome)) await reinstall("claude-code", d.neutralDir());
        const here = await findRepoRoot(ctx.cwd);
        const candidates = new Set<string>([
          ...readProjects(ctx.vtcHome),
          ...engines.map((e) => e.repo_root),
          ...(here === null ? [] : [here]),
          ...(values.repo ?? []).map((p) => resolve(ctx.cwd, p)),
        ]);
        for (const repo of [...candidates].sort()) {
          if (!codexInstalledIn(repo)) continue;
          rememberCodexProject(ctx.vtcHome, repo);
          await reinstall("codex", repo);
        }

        // what changed: the notes of every release between the two
        const between = releases
          .filter(
            (r) =>
              compareVersions(r.version, current) > 0 &&
              compareVersions(r.version, release.version) <= 0,
          )
          .reverse()
          .slice(-5);
        for (const r of between) {
          const notes = await releaseNotes(d.exec, r.tag);
          if (notes !== null && notes !== "") ctx.io.out(`\nWhat changed in ${r.tag}:\n${notes}`);
        }
        ctx.io.out(
          "\nOpen a new Codex or Claude Code chat to use it (a chat that is already open keeps the old plugin).",
        );
        return failedInstalls.length > 0 ? EXIT.failed : EXIT.ok;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }),
});

export const command = createUpdateCommand();
