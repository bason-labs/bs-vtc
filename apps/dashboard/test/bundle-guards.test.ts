import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const src = resolve(import.meta.dirname, "../src");

const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory()
      ? files(join(dir, d.name))
      : /\.(ts|tsx)$/.test(d.name)
        ? [join(dir, d.name)]
        : [],
  );

/**
 * D-o (spine §5 reading 35, AD-5 rules 2 and 8): only the dev-only `/api` proxy
 * (`scripts/engine-proxy*.ts`, `pnpm dev:engine`) reads `~/.vtc/token`. The shipped bundle is
 * built from `src/`, so nothing there may reach the file system, the VTC home or the token.
 */
describe("the shipped bundle never reads the install token", () => {
  const forbidden: readonly [string, RegExp][] = [
    ["a Node built-in", /from\s+["']node:|require\(\s*["']node:/],
    ["the token file name", /\btokenFile\b/],
    ["the home directory", /\bhomedir\b|\bVTC_HOME\b/],
    ["the token path", /\.vtc\/token/],
    ["the dev scripts", /from\s+["'][./]*scripts\//],
  ];

  it.each(forbidden)("no src file references %s", (_what, pattern) => {
    const hits = files(src)
      .filter((f) => pattern.test(readFileSync(f, "utf8")))
      .map((f) => relative(src, f));
    expect(hits).toEqual([]);
  });
});
