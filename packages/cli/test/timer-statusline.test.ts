/**
 * The auto-resume timer (§6.9 step 4): the engine's scheduler persists wake-ups; the launchd
 * agent's `vtc engine --wake-due` starts the daemons whose time has come. And the Claude
 * statusline tee shim (§6.9): the user's statusline unchanged, usage forwarded to the engine.
 */
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENGINE_HTTP, engineRepoKey, type RunningDaemon } from "@vtc/shared";
import { createDiskAssetBundle } from "../src/assets.js";
import { createStatuslineTeeCommand } from "../src/commands/statusline-tee.js";
import { WAKE_GRACE_MS, wakeDue } from "../src/commands/engine.js";
import { liveDaemon } from "../src/daemon.js";
import { postToEngine } from "../src/engine-http.js";
import { renderLaunchAgent } from "../src/launchd.js";
import { findRepoRoot } from "../src/repo.js";
import { createWakeScheduler, dueWakeups, wakeRecords } from "../src/scheduler.js";
import {
  forwardStatusline,
  runShellCommand,
  MAX_FORWARD_BYTES,
  runStatuslineTee,
  userCommandOf,
  type StatuslineDeps,
} from "../src/statusline.js";
import { ensureInstallToken, readInstallToken } from "../src/token.js";
import { buildEngineParts, startDaemon } from "../src/wiring.js";
import {
  capture,
  cleanupDirs,
  fakeGateRunner,
  fakePullRequests,
  initProject,
  initRepo,
  tempDir,
  tempHome,
  writePluginTrees,
} from "./helpers.js";

const daemons: RunningDaemon[] = [];
const never = (): never => {
  throw new Error("no command");
};
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.close();
  cleanupDirs();
});

describe("the persisted wake scheduler (AutoResumeScheduler)", () => {
  it("keeps one wake-up per repo, mode 0600, and lists the due ones", async () => {
    const home = tempHome();
    const scheduler = createWakeScheduler(home);
    await scheduler.schedule("/repo/a", new Date("2026-10-13T10:00:00Z"));
    await scheduler.schedule("/repo/a", new Date("2026-10-13T12:00:00Z")); // moved
    await scheduler.schedule("/repo/b", new Date("2026-10-13T11:00:00Z"));
    const file = join(home, "wake", `${engineRepoKey("/repo/a")}.json`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(wakeRecords(home).map((r) => [r.repo_root, r.at])).toEqual([
      ["/repo/b", "2026-10-13T11:00:00.000Z"],
      ["/repo/a", "2026-10-13T12:00:00.000Z"],
    ]);
    expect(dueWakeups(home, new Date("2026-10-13T11:30:00Z")).map((r) => r.repo_root)).toEqual([
      "/repo/b",
    ]);
    await scheduler.cancel("/repo/b");
    await scheduler.cancel("/repo/b");
    expect(wakeRecords(home).map((r) => r.repo_root)).toEqual(["/repo/a"]);
    writeFileSync(
      join(home, "wake", "0000000000000000.json"),
      JSON.stringify({ v: 1, repo_root: "/x", at: "2026-01-01T00:00:00Z" }),
    );
    writeFileSync(join(home, "wake", "garbage.json"), "{");
    expect(wakeRecords(home).map((r) => r.repo_root)).toEqual(["/repo/a"]);
    expect(readdirSync(join(home, "wake")).some((n) => n.endsWith(".tmp"))).toBe(false);
  });

  it("vtc engine --wake-due starts each due repo's daemon with --wake, leaving the wake-up to it", async () => {
    const home = tempHome();
    const due = initProject(tempDir());
    const moved = initProject(tempDir());
    const later = initProject(tempDir());
    const gone = join(tempDir(), "deleted-repo");
    const uninitialised = tempDir(); // its .vtc/ was removed since: nothing to resume there
    const scheduler = createWakeScheduler(home);
    await scheduler.schedule(uninitialised, new Date("2026-10-13T09:30:00Z"));
    await scheduler.schedule(due, new Date("2026-10-13T10:00:00Z"));
    await scheduler.schedule(moved, new Date("2026-10-13T10:00:00Z"));
    await scheduler.schedule(later, new Date("2026-10-13T20:00:00Z"));
    await scheduler.schedule(gone, new Date("2026-10-13T09:00:00Z"));
    const started: string[] = [];
    const { ctx, out } = capture("/", home);
    const count = await wakeDue(ctx, new Date("2026-10-13T10:05:00Z"), async (options) => {
      started.push(`${options.repoRoot} ${(options.flags ?? []).join(" ")}`);
      // the woken engine re-parks one repo (still limited) and leaves the other alone
      if (options.repoRoot === moved)
        await scheduler.schedule(moved, new Date("2026-10-13T11:00:00Z"));
      return {} as never;
    });
    expect(count).toBe(2);
    expect(started.sort()).toEqual([`${due} --wake`, `${moved} --wake`].sort());
    expect(existsSync(join(uninitialised, ".vtc"))).toBe(false);
    // within the grace the woken engine owns its wake-up: nothing is dropped under it
    expect(
      wakeRecords(home)
        .map((r) => r.repo_root)
        .sort(),
    ).toEqual([due, later, moved].sort());
    expect(out).toHaveLength(2);
    // past the grace, a wake-up the engine neither cancelled nor moved is dropped after one more try
    const late = new Date(Date.parse("2026-10-13T10:00:00Z") + WAKE_GRACE_MS);
    started.length = 0;
    expect(
      await wakeDue(ctx, late, (o) => (started.push(o.repoRoot), Promise.resolve({} as never))),
    ).toBe(1);
    expect(started).toEqual([due]);
    expect(
      wakeRecords(home)
        .map((r) => r.repo_root)
        .sort(),
    ).toEqual([later, moved].sort());
  });

  it("renders a launchd agent that runs --wake-due every minute with the user's PATH", () => {
    const plist = renderLaunchAgent({
      selfCommand: ["/Applications/V&C/vtc"],
      vtcHome: "/Users/u/.vtc",
      path: "/opt/homebrew/bin:/usr/bin",
    });
    expect(plist).toContain("<string>vtc.auto-resume</string>");
    expect(plist).toContain("<string>/Applications/V&amp;C/vtc</string>");
    expect(plist).toContain("<key>StartInterval</key>\n  <integer>60</integer>");
    expect(plist).toContain("<string>/opt/homebrew/bin:/usr/bin</string>");
    expect(plist).not.toMatch(/token|credential/i);
  });
});

const STATUSLINE = {
  session_id: "s-1",
  model: { id: "claude-opus-4-8", display_name: "Opus" },
  workspace: { current_dir: "" },
  rate_limits: {
    five_hour: { used_percentage: 37.5, resets_at: 1792022400 },
    seven_day: { used_percentage: 12, resets_at: 1792454400 },
  },
};

const getJson = (port: number, path: string, token: string): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        headers: { host: `127.0.0.1:${String(port)}`, authorization: `Bearer ${token}` },
      },
      (res) => {
        let body = "";
        res.on("data", (c: Buffer) => (body += c.toString("utf8")));
        res.on("end", () => {
          resolve(JSON.parse(body));
        });
      },
    );
    req.on("error", reject);
    req.end();
  });

describe("vtc statusline-tee (§6.9)", () => {
  it("takes the user's command from after --: one command string, or an argv", () => {
    expect(userCommandOf(["--", "cat | head -c 5"])).toEqual({
      kind: "shell",
      line: "cat | head -c 5",
    });
    expect(userCommandOf(["--", "~/bin/status.sh", "--short"])).toEqual({
      kind: "argv",
      argv: ["~/bin/status.sh", "--short"],
    });
    expect(userCommandOf([])).toBeNull();
    expect(userCommandOf(["--"])).toBeNull();
  });

  it("hands the command string to the shell exactly once", async () => {
    // the wiring form: the user's original statusLine command as one argument
    const original = `printf '%s|' 'a b' "c  d" | tr -d '\n'`;
    expect(await runShellCommand(userCommandOf(["--", original]) ?? never(), "")).toEqual({
      code: 0,
      stdout: "a b|c  d|",
      stderr: "",
    });
    // several arguments are an argv: no shell parses them, quotes and spaces survive
    expect(
      await runShellCommand(
        userCommandOf(["--", "printf", "%s|", "a 'b'", "$HOME"]) ?? never(),
        "",
      ),
    ).toEqual({ code: 0, stdout: "a 'b'|$HOME|", stderr: "" });
  });

  it("passes stdin of any size to the user's command, forwarding only a statusline-sized one", async () => {
    const posts: string[] = [];
    const deps: StatuslineDeps = {
      vtcHome: tempHome(),
      cwd: "/",
      findRepoRoot: () => Promise.resolve("/r"),
      liveDaemon: () => Promise.resolve({ port: 1 } as never),
      readInstallToken: () => "t",
      post: (_port, path) => {
        posts.push(path);
        return Promise.resolve({ status: 204 });
      },
      runCommand: runShellCommand,
    };
    const big = JSON.stringify({ ...STATUSLINE, pad: "x".repeat(MAX_FORWARD_BYTES) });
    const output = await runStatuslineTee(["--", "wc -c | tr -d ' '"], big, deps);
    expect(output.stdout.trim()).toBe(String(Buffer.byteLength(big)));
    expect(posts).toEqual([]);
    await runStatuslineTee(["--", "true"], JSON.stringify(STATUSLINE), deps);
    expect(posts).toEqual([ENGINE_HTTP.routes.statuslineIngest.path]);
  });

  it("runs the user's statusline unchanged and forwards usage to the live engine", async () => {
    const repo = initRepo();
    const home = tempHome();
    const token = ensureInstallToken(home);
    const daemon = await startDaemon(
      await buildEngineParts({
        repoRoot: repo,
        vtcHome: home,
        installToken: token,
        assets: createDiskAssetBundle(writePluginTrees(tempDir())),
        createGateRunner: fakeGateRunner,
        pullRequests: fakePullRequests(),
        adapterFactories: {},
      }),
      { wake: false },
    );
    daemons.push(daemon);
    const deps: StatuslineDeps = {
      vtcHome: home,
      cwd: "/",
      findRepoRoot: (cwd) => findRepoRoot(cwd),
      liveDaemon,
      readInstallToken,
      post: postToEngine,
      runCommand: runShellCommand,
    };
    const stdin = JSON.stringify({ ...STATUSLINE, workspace: { current_dir: repo } });
    const output = await runStatuslineTee(["--", "cat; printf ' | mine'; exit 3"], stdin, deps);
    expect(output).toEqual({ code: 3, stdout: `${stdin} | mine`, stderr: "" });
    const usage = (await getJson(daemon.port, ENGINE_HTTP.routes.usage.path, token)) as {
      hosts: { host: string; windows: { label: string; used_pct: number | null }[] }[];
    };
    const claude = usage.hosts.find((h) => h.host === "claude-code");
    expect(claude?.windows.map((w) => [w.label, w.used_pct])).toEqual([
      ["five_hour", 37.5],
      ["seven_day", 12],
    ]);
  });

  it("never breaks the statusline: no engine, garbage input or no user command", async () => {
    const deps: StatuslineDeps = {
      vtcHome: tempHome(),
      cwd: "/",
      findRepoRoot: () => Promise.resolve("/r"),
      liveDaemon: () => Promise.resolve(null),
      readInstallToken: () => {
        throw new Error("no token");
      },
      post: () => Promise.reject(new Error("unreachable")),
      runCommand: runShellCommand,
    };
    expect(await forwardStatusline(JSON.stringify(STATUSLINE), deps)).toBe(false);
    expect(await forwardStatusline("not json", deps)).toBe(false);
    expect(
      await forwardStatusline(JSON.stringify(STATUSLINE), {
        ...deps,
        liveDaemon: () => Promise.resolve({ port: 1 } as never),
      }),
    ).toBe(false);
    expect(await runStatuslineTee([], "x", deps)).toEqual({ code: 0, stdout: "", stderr: "" });
    const written: string[] = [];
    const cmd = createStatuslineTeeCommand(() => ({
      stdin: () => Promise.resolve("{}"),
      write: (o) => written.push(o),
      deps: () => deps,
    }));
    expect(await cmd.run(["--", "printf ok"], capture("/", "/h").ctx)).toBe(0);
    expect(written).toEqual(["ok"]);
  });
});
