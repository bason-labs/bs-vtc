import { git } from "../git/index.ts";
import { readFileSync } from "node:fs";
export const ok = [git, readFileSync];
