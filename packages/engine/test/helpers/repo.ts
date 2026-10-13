/** Temp git repositories for engine tests: a target repo, and a local bare repo as its remote. */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const dirs: string[] = [];

export const tempDir = (prefix = "vtc-test-"): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

export const cleanupDirs = (): void => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
};

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
};

export const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();

export const writeFile = (root: string, path: string, content: string): void => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
};

/** A repo on `main` with one commit, `.vtc/state/` ignored and a local identity. */
export const initRepo = (files: Record<string, string> = { "README.md": "# app\n" }): string => {
  const repo = tempDir("vtc-repo-");
  git(repo, "init", "--quiet", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "commit.gpgsign", "false");
  writeFile(repo, ".gitignore", ".vtc/state/\n");
  for (const [path, content] of Object.entries(files)) writeFile(repo, path, content);
  git(repo, "add", "--all");
  git(repo, "commit", "--quiet", "-m", "initial");
  return repo;
};

/** A bare repository registered as `origin` of `repo`. */
export const addBareRemote = (repo: string): string => {
  const bare = tempDir("vtc-remote-");
  git(bare, "init", "--quiet", "--bare", "-b", "main");
  git(repo, "remote", "add", "origin", bare);
  git(repo, "push", "--quiet", "origin", "main");
  return bare;
};
