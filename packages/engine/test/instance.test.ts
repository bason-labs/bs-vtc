import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  dotenvValues,
  ENGINE_INSTANCE,
  engineRepoKey,
  engineSocketFile,
  parseEventLog,
} from "@vtc/shared";
import {
  acquireEngineLock,
  EngineLockedError,
  openEventLog,
  readEngineDiscovery,
  removeEngineDiscovery,
  writeEngineDiscovery,
} from "../src/core/index.js";

const dirs: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "vtc-engine-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const NOW = new Date("2026-10-13T08:00:00.000Z");
const pauseEvent = {
  type: "run.paused",
  actor: "human",
  data: { reason: "vtc pause" },
} as const;

describe("engine lock (AD-12: one engine per repo)", () => {
  it("lets exactly one instance hold the lock", () => {
    const repo = tempDir();
    const first = acquireEngineLock(repo);
    expect(first.isHeld()).toBe(true);
    expect(() => acquireEngineLock(repo)).toThrow(EngineLockedError);
    first.release();
    expect(first.isHeld()).toBe(false);
    const second = acquireEngineLock(repo);
    expect(second.isHeld()).toBe(true);
    second.release();
  });
  it("takes over a lock left by a dead process and reports it", () => {
    const repo = tempDir();
    acquireEngineLock(repo, { pid: 999_999 });
    const stale: (number | null)[] = [];
    const lock = acquireEngineLock(repo, {
      isAlive: () => false,
      onStaleLock: (pid) => stale.push(pid),
    });
    expect(stale).toEqual([999_999]);
    expect(lock.isHeld()).toBe(true);
    lock.release();
  });
  it("keeps the lock under .vtc/state/", () => {
    const repo = tempDir();
    const lock = acquireEngineLock(repo);
    expect(lock.path).toBe(join(repo, ENGINE_INSTANCE.lockFile));
    lock.release();
  });
});

describe("event log single writer (AD-7 rule 2)", () => {
  it("appends validated events with a strictly increasing per-run seq", () => {
    const repo = tempDir();
    const lock = acquireEngineLock(repo);
    const log = openEventLog(repo, "run-1", lock, { now: () => NOW });
    expect(log.append(pauseEvent).seq).toBe(1);
    expect(log.append(pauseEvent).seq).toBe(2);
    const parsed = parseEventLog(readFileSync(log.path, "utf8"));
    expect(parsed.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(parsed.invalidLines).toEqual([]);
    lock.release();
  });
  it("a second instance cannot append: it cannot get the lock", () => {
    const repo = tempDir();
    const lock = acquireEngineLock(repo);
    const log = openEventLog(repo, "run-1", lock);
    log.append(pauseEvent);
    expect(() => {
      const other = acquireEngineLock(repo, { pid: process.pid });
      openEventLog(repo, "run-1", other).append(pauseEvent);
    }).toThrow(EngineLockedError);
    expect(parseEventLog(readFileSync(log.path, "utf8")).events).toHaveLength(1);
    lock.release();
  });
  it("a writer that lost its lock stops appending", () => {
    const repo = tempDir();
    const lock = acquireEngineLock(repo, { pid: 999_998 });
    const log = openEventLog(repo, "run-1", lock);
    log.append(pauseEvent);
    const usurper = acquireEngineLock(repo, { isAlive: () => false });
    expect(() => log.append(pauseEvent)).toThrow(EngineLockedError);
    expect(() => openEventLog(repo, "run-1", lock)).toThrow(EngineLockedError);
    usurper.release();
  });
  it("rejects invalid events and never writes them", () => {
    const repo = tempDir();
    const lock = acquireEngineLock(repo);
    const log = openEventLog(repo, "run-1", lock);
    expect(() =>
      log.append({ type: "task.status_changed", actor: "engine", data: { from: "x" } }),
    ).toThrow();
    expect(log.nextSeq()).toBe(1);
    lock.release();
  });
  it("redacts secrets before anything reaches the git-tracked log (AD-18)", () => {
    const repo = tempDir();
    writeFileSync(join(repo, ".env"), "DB_PASSWORD=correct-horse-battery\n");
    const lock = acquireEngineLock(repo);
    const log = openEventLog(repo, "run-1", lock, {
      secrets: () => dotenvValues(readFileSync(join(repo, ".env"), "utf8")),
    });
    const token = `ghp_${"a1B2".repeat(9)}`;
    const event = log.append({
      type: "run.paused",
      actor: "human",
      data: { reason: `leaked ${token} and correct-horse-battery` },
    });
    const line = readFileSync(log.path, "utf8");
    expect(line).not.toContain(token);
    expect(line).not.toContain("correct-horse-battery");
    expect(line).toContain("[REDACTED:github_token]");
    expect(line).toContain("[REDACTED:known_value]");
    expect(event.data).toEqual({
      reason: "leaked [REDACTED:github_token] and [REDACTED:known_value]",
    });
    lock.release();
  });
  it("continues the seq after a restart and fences off a torn final line", () => {
    const repo = tempDir();
    let lock = acquireEngineLock(repo);
    const first = openEventLog(repo, "run-1", lock);
    first.append(pauseEvent);
    first.append(pauseEvent);
    lock.release();
    appendFileSync(first.path, '{"v":1,"seq":3,"ts"');
    lock = acquireEngineLock(repo);
    const reopened = openEventLog(repo, "run-1", lock);
    expect(reopened.recovered).toEqual({ invalidLines: [3], truncatedTail: true });
    expect(reopened.append(pauseEvent).seq).toBe(3);
    const parsed = parseEventLog(readFileSync(reopened.path, "utf8"));
    expect(parsed.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(parsed.invalidLines).toEqual([3]);
    expect(parsed.truncatedTail).toBe(false);
    lock.release();
  });
});

describe("engine discovery file (AD-12)", () => {
  const info = (repoRoot: string, pid = 4242) => ({
    v: 1 as const,
    pid,
    port: 47615,
    prototype_port: null,
    mcp_socket: `/home/u/.vtc/${engineSocketFile(repoRoot)}`,
    repo_root: repoRoot,
    started_at: NOW.toISOString(),
    engine_version: "0.0.0",
    contracts_version: "3.0.0",
  });
  it("publishes port and socket in ~/.vtc/engines/<repo-key>.json, mode 0600, no token", () => {
    const home = tempDir();
    const repo = tempDir();
    const path = writeEngineDiscovery(home, info(repo));
    expect(path).toBe(join(home, "engines", `${engineRepoKey(repo)}.json`));
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(raw).toEqual(info(repo));
    expect(Object.keys(raw)).not.toContain("token");
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readEngineDiscovery(home, repo)).toEqual(info(repo));
  });
  it("ignores missing or invalid files and only removes its own record", () => {
    const home = tempDir();
    const repo = tempDir();
    expect(readEngineDiscovery(home, repo)).toBeNull();
    const path = writeEngineDiscovery(home, info(repo, 1111));
    removeEngineDiscovery(home, repo, 2222);
    expect(readEngineDiscovery(home, repo)?.pid).toBe(1111);
    removeEngineDiscovery(home, repo, 1111);
    expect(readEngineDiscovery(home, repo)).toBeNull();
    writeFileSync(path, "{not json");
    expect(readEngineDiscovery(home, repo)).toBeNull();
  });
});
