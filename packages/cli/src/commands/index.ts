/**
 * The `vtc` command registry (§4.1, §4.4). One import line per command file; the cli+binary
 * team owns this list, every other team owns only its own command file (AD-15).
 */
import { command as automation } from "./automation.js";
import { command as calibrate } from "./calibrate.js";
import { command as config } from "./config.js";
import { command as dashboard } from "./dashboard.js";
import { command as doctor } from "./doctor.js";
import { command as engine } from "./engine.js";
import { command as hook } from "./hook.js";
import { command as init } from "./init.js";
import { command as install } from "./install.js";
import { command as lookback } from "./lookback.js";
import { command as mergeLevel } from "./merge-level.js";
import { command as pause } from "./pause.js";
import { command as resume } from "./resume.js";
import { command as status } from "./status.js";
import { command as statuslineTee } from "./statusline-tee.js";
import type { CommandSpec } from "./types.js";
import { command as version } from "./version.js";

export type { CommandSpec } from "./types.js";

export const COMMANDS: readonly CommandSpec[] = [
  init,
  calibrate,
  dashboard,
  pause,
  resume,
  status,
  install,
  doctor,
  config,
  lookback,
  automation,
  mergeLevel,
  engine,
  statuslineTee,
  hook,
  version,
];
