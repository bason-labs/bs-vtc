import { readFileSync } from "node:fs";

export const fixtureText = (path: string): string =>
  readFileSync(new URL(`../fixtures/${path}`, import.meta.url), "utf8");

export const fixtureLines = (path: string): string[] => fixtureText(path).split("\n");

export const fixtureJson = (path: string): unknown => JSON.parse(fixtureText(path));
