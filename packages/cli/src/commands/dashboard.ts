import { pendingCommand } from "./types.js";

/** Owner: cli+binary team. Opens the running daemon's dashboard (`POST /api/session/nonce`, then the browser at `/#nonce=…`), or serves the committed .vtc/ snapshot read-only with `serveSnapshot` (AD-5, AD-12). */
export const command = pendingCommand(
  "dashboard",
  "Serve Flow Studio on 127.0.0.1 (live engine, or a read-only snapshot)",
);
