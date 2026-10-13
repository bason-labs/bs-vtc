/** Owner: cli+binary team. `vtc version` (also `vtc --version`): what this build is wired with. */
import { HOST_CAPABILITIES } from "@vtc/adapters";
import { COMPILE_TARGETS } from "@vtc/compiler";
import { ENGINE_NAME } from "@vtc/engine";
import { CONTRACTS_VERSION } from "@vtc/shared";
import { runtime } from "../runtime.js";
import { VERSION } from "../version.js";
import type { CommandSpec } from "./types.js";
import { EXIT } from "./util.js";

export const versionLine = (): string =>
  `vtc ${VERSION} (${ENGINE_NAME}, contracts ${CONTRACTS_VERSION}, hosts ${Object.keys(HOST_CAPABILITIES).join("/")}, plugins ${Object.values(COMPILE_TARGETS).join(", ")}, ${runtime().kind === "binary" ? "binary" : "dev"} on ${process.versions.bun === undefined ? `node ${process.versions.node}` : `bun ${process.versions.bun}`})`;

export const command: CommandSpec = {
  name: "version",
  summary: "Print the vtc, engine and contracts versions",
  run: (_args, ctx) => {
    ctx.io.out(versionLine());
    return Promise.resolve(EXIT.ok);
  },
};
