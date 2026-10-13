/**
 * Host config in worktrees (D-ao, spine §5 reading 72): `.codex/**`, `.claude/**` and `.mcp.json`
 * in an engine worktree are compared with the worktree's base commit and restored, whatever a
 * role left there (edited, added, deleted, committed, ignored, or a symlink out of the worktree).
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspace, HOST_CONFIG_PATHS, restoreHostConfig } from "../../src/git/index.js";
import { cleanupDirs, git, initRepo, tempDir, writeFile } from "../helpers/repo.js";

afterEach(cleanupDirs);

const setup = async (files: Record<string, string> = {}) => {
  const repo = initRepo({
    "README.md": "# app\n",
    ".claude/agents/helper.md": "base agent\n",
    ".codex/keep.toml": "model = 'x'\n",
    ".mcp.json": '{"mcpServers":{}}\n',
    ...files,
  });
  const ws = createWorkspace(repo);
  const base = await ws.resolve("HEAD");
  const { worktree } = await ws.ensureTaskWorktree("T-1", "vtc/T-1", base);
  return { repo, ws, base, worktree, root: join(repo, worktree) };
};

describe("restoreHostConfig (D-ao)", () => {
  it("names the host config locations it guards", () => {
    expect(HOST_CONFIG_PATHS).toEqual([".claude", ".codex", ".mcp.json"]);
  });
  it("changes nothing in a worktree that matches its base", async () => {
    const { repo, base, worktree, root } = await setup();
    expect(await restoreHostConfig(repo, worktree, base)).toEqual([]);
    expect(readFileSync(join(root, ".claude/agents/helper.md"), "utf8")).toBe("base agent\n");
  });
  it("restores edited, added, deleted and ignored files to the base, and reports each path", async () => {
    const { repo, base, worktree, root } = await setup();
    writeFile(root, ".claude/agents/helper.md", "planted agent\n");
    writeFile(root, ".claude/settings.local.json", '{"hooks":{}}\n');
    writeFile(root, ".codex/config.toml", "notify = ['sh', '-c', 'evil']\n");
    rmSync(join(root, ".codex/keep.toml"));
    writeFile(root, ".mcp.json", '{"mcpServers":{"vtc":{"command":"evil"}}}\n');
    // an ignored file is still loaded by the host: it is removed as well
    writeFile(root, ".gitignore", ".vtc/state/\n.claude/settings.local.json\n");
    expect(await restoreHostConfig(repo, worktree, base)).toEqual([
      ".claude/agents/helper.md",
      ".claude/settings.local.json",
      ".codex/config.toml",
      ".codex/keep.toml",
      ".mcp.json",
    ]);
    expect(readFileSync(join(root, ".claude/agents/helper.md"), "utf8")).toBe("base agent\n");
    expect(existsSync(join(root, ".claude/settings.local.json"))).toBe(false);
    expect(existsSync(join(root, ".codex/config.toml"))).toBe(false);
    expect(readFileSync(join(root, ".codex/keep.toml"), "utf8")).toBe("model = 'x'\n");
    expect(readFileSync(join(root, ".mcp.json"), "utf8")).toBe('{"mcpServers":{}}\n');
    // what is outside the host config is left alone
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toContain("settings.local.json");
    expect(await restoreHostConfig(repo, worktree, base)).toEqual([]);
  });
  it("compares with the base, not the worktree's head: a committed change is restored too", async () => {
    const { repo, base, worktree, root } = await setup();
    writeFile(root, ".mcp.json", '{"mcpServers":{"x":{"command":"x"}}}\n');
    git(root, "add", "--all");
    git(root, "commit", "--quiet", "-m", "role snapshot");
    expect(await restoreHostConfig(repo, worktree, base)).toEqual([".mcp.json"]);
    expect(readFileSync(join(root, ".mcp.json"), "utf8")).toBe('{"mcpServers":{}}\n');
  });
  it("removes symlinks without touching their targets, and restores what the base has", async () => {
    const { repo, base, worktree, root } = await setup();
    const outside = tempDir("vtc-outside-");
    writeFileSync(join(outside, "settings.json"), "outside\n");
    rmSync(join(root, ".claude"), { recursive: true });
    symlinkSync(outside, join(root, ".claude"));
    symlinkSync(join(outside, "settings.json"), join(root, ".mcp.json.tmp"));
    rmSync(join(root, ".mcp.json"));
    symlinkSync(join(outside, "settings.json"), join(root, ".mcp.json"));
    const restored = await restoreHostConfig(repo, worktree, base);
    expect(restored).toEqual([".claude", ".claude/agents/helper.md", ".mcp.json"]);
    expect(lstatSync(join(root, ".claude")).isDirectory()).toBe(true);
    expect(readFileSync(join(root, ".claude/agents/helper.md"), "utf8")).toBe("base agent\n");
    expect(lstatSync(join(root, ".mcp.json")).isFile()).toBe(true);
    expect(readFileSync(join(root, ".mcp.json"), "utf8")).toBe('{"mcpServers":{}}\n');
    expect(readFileSync(join(outside, "settings.json"), "utf8")).toBe("outside\n");
    // a file a symlink pointed to outside the guarded paths is not the engine's to remove
    expect(lstatSync(join(root, ".mcp.json.tmp")).isSymbolicLink()).toBe(true);
  });
  it("replaces a directory where the base has a file, and a file where it has a directory", async () => {
    const { repo, base, worktree, root } = await setup();
    rmSync(join(root, ".mcp.json"));
    mkdirSync(join(root, ".mcp.json/inner"), { recursive: true });
    writeFileSync(join(root, ".mcp.json/inner/x"), "x\n");
    rmSync(join(root, ".claude/agents"), { recursive: true });
    writeFileSync(join(root, ".claude/agents"), "not a dir\n");
    expect(await restoreHostConfig(repo, worktree, base)).toEqual([
      ".claude/agents",
      ".claude/agents/helper.md",
      ".mcp.json",
      ".mcp.json/inner/x",
    ]);
    expect(readFileSync(join(root, ".mcp.json"), "utf8")).toBe('{"mcpServers":{}}\n');
    expect(readFileSync(join(root, ".claude/agents/helper.md"), "utf8")).toBe("base agent\n");
  });
  it("keeps the base's executable bit and symlinks", async () => {
    const repo = initRepo({ "README.md": "# app\n", ".claude/hooks/run.sh": "#!/bin/sh\n" });
    chmodSync(join(repo, ".claude/hooks/run.sh"), 0o755);
    symlinkSync("hooks/run.sh", join(repo, ".claude/link.sh"));
    git(repo, "add", "--all");
    git(repo, "commit", "--quiet", "-m", "hooks");
    const ws = createWorkspace(repo);
    const base = await ws.resolve("HEAD");
    const { worktree } = await ws.ensureTaskWorktree("T-1", "vtc/T-1", base);
    const root = join(repo, worktree);
    expect(await restoreHostConfig(repo, worktree, base)).toEqual([]);
    chmodSync(join(root, ".claude/hooks/run.sh"), 0o644);
    rmSync(join(root, ".claude/link.sh"));
    symlinkSync("/etc/hosts", join(root, ".claude/link.sh"));
    expect(await restoreHostConfig(repo, worktree, base)).toEqual([
      ".claude/hooks/run.sh",
      ".claude/link.sh",
    ]);
    expect(statSync(join(root, ".claude/hooks/run.sh")).mode & 0o111).not.toBe(0);
    expect(readlinkSync(join(root, ".claude/link.sh"))).toBe("hooks/run.sh");
  });
  it("refuses a worktree path that is not an engine worktree", async () => {
    const { repo, base } = await setup();
    await expect(restoreHostConfig(repo, "../elsewhere", base)).rejects.toThrow(/worktree/);
    await expect(restoreHostConfig(repo, ".vtc/state/worktrees/T-1", "HEAD")).rejects.toThrow(
      /sha/,
    );
  });
});
