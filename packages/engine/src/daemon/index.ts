/**
 * Daemon composition (AD-19; owner: engine-core team, sub-project 1). Implements the frozen
 * seam from @vtc/shared: `runDaemon` takes the engine lock, wires core to the injected Gate
 * Runner, host adapters, storage, assets and timer, serves MCP on the local socket and HTTP/SSE
 * on 127.0.0.1, and publishes discovery (AD-12); `serveSnapshot` serves the committed `.vtc/`
 * read-only for `vtc dashboard` (AD-5 rule 7). It may import the core, git, http and mcp entries;
 * it never imports gates (the Gate Runner arrives in `EngineDeps`) and never loads a storage
 * driver (the cli injects `openStorage`).
 */
import type { RunDaemon, ServeSnapshot } from "@vtc/shared";

const notYet = (what: string): Error =>
  new Error(`${what} is not implemented yet (engine core, sub-project 1)`);

export const runDaemon: RunDaemon = () => Promise.reject(notYet("runDaemon"));

export const serveSnapshot: ServeSnapshot = () => Promise.reject(notYet("serveSnapshot"));
