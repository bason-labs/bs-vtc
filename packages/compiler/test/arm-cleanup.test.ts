/**
 * Replay arm plugins (D-cg, spine §5 reading 201): what a failure part-way through the write
 * leaves behind. `node:fs`'s `openSync` is wrapped so a test can fail or tamper with the write at
 * a chosen file; everything else is the real file system.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import type * as Fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COMPILE_TARGETS,
  compilePlugins,
  createArmPluginCompiler,
  writeTargets,
} from "../src/index.js";
import { fixtureFiles } from "./fixtures.js";

/** Called with each path `openSync` is about to open, before it opens it. */
const hook = vi.hoisted(() => ({ beforeOpen: undefined as ((path: string) => void) | undefined }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof Fs>();
  const openSync = ((...args: Parameters<typeof actual.openSync>) => {
    hook.beforeOpen?.(String(args[0]));
    return actual.openSync(...args);
  }) as typeof actual.openSync;
  return { ...actual, openSync, default: { ...actual, openSync } };
});

const temps: string[] = [];
const temp = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "vtc-arm-cleanup-")));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  hook.beforeOpen = undefined;
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const basePlugin = (): string => {
  const result = compilePlugins(fixtureFiles());
  if (!result.ok) throw new Error(result.errors.map((e) => e.message).join("\n"));
  const root = temp();
  writeTargets(result.output, root);
  return join(root, COMPILE_TARGETS["claude-code"]);
};

const compileArm = (outDir: string) =>
  createArmPluginCompiler({ pluginDir: basePlugin() }).compileArm({
    host: "claude-code",
    agent: "vtc-engineer",
    editable: "Prefer the smallest diff that passes the acceptance tests.",
    outDir,
  });

/** Every entry under `dir`, files and directories, by path relative to it. */
const entries = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, encoding: "utf8" }).sort();

describe("createArmPluginCompiler: a failure part-way through the write", () => {
  it("removes every file and directory it created and leaves outDir empty", async () => {
    const out = join(temp(), "arm");
    let opened = 0;
    hook.beforeOpen = (path) => {
      if (!path.startsWith(`${out}/`)) return;
      opened += 1;
      // Fail well into the tree, after files in several directories exist.
      if (opened === 12) throw new Error("simulated write failure");
    };
    await expect(compileArm(out)).rejects.toThrow(/simulated write failure/);
    expect(opened).toBe(12);
    expect(entries(out)).toEqual([]);
  });

  it("stops when a directory it created is replaced, and leaves the replacement alone", async () => {
    const out = join(temp(), "arm");
    const moved = join(temp(), "moved");
    const agents = join(out, "agents");
    let inAgents = 0;
    hook.beforeOpen = (path) => {
      if (!path.startsWith(`${agents}/`)) return;
      inAgents += 1;
      // Before the second agent file opens, swap `agents` for a directory this call did not make.
      if (inAgents === 2) {
        renameSync(agents, moved);
        mkdirSync(agents);
      }
    };
    await expect(compileArm(out)).rejects.toThrow(/changed while the arm was written/);
    // The second file went into the replacement (its identity was checked just before the swap);
    // the third was refused. Nothing in the replacement is removed, and the replacement stays.
    expect(existsSync(agents)).toBe(true);
    expect(readdirSync(agents)).toHaveLength(1);
    expect(readdirSync(moved)).toHaveLength(1);
    // Everything else this call created is gone.
    expect(entries(out).filter((p) => !p.startsWith("agents"))).toEqual([]);
  });
});
