/**
 * Dev-only proxy to a live engine (AD-5 rule 8); see `engine-proxy-lib.ts`.
 *
 *   pnpm dev:engine --repo /abs/path/to/target-repo      # proxy on http://127.0.0.1:4320
 *   VTC_DEV_API=http://127.0.0.1:4320 pnpm dev            # next dev sends /api/* to it
 *
 * Flags: --repo <abs path> (or $VTC_REPO; the repo whose engine to reach), --port <n> (4320).
 * The VTC home is $VTC_HOME or ~/.vtc. Binds 127.0.0.1 only; never part of the build.
 */
import { isAbsolute } from "node:path";
import { createEngineProxy, resolveVtcHome } from "./engine-proxy-lib.ts";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};
const repoRoot = flag("repo") ?? process.env.VTC_REPO;
const port = Number(flag("port") ?? "4320");

if (repoRoot === undefined || !isAbsolute(repoRoot)) {
  console.error("usage: pnpm dev:engine --repo <absolute path of the repo the engine runs on>");
  process.exit(2);
}

createEngineProxy({ vtcHome: resolveVtcHome(process.env), repoRoot }).listen(
  port,
  "127.0.0.1",
  () => {
    console.warn(`engine dev proxy on http://127.0.0.1:${String(port)}/ for ${repoRoot}`);
  },
);
