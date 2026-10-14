/**
 * Owner: cli+binary team. `vtc lookback approve|pin|rollback` (spec §13 steps 4–6; spine AD-21
 * rule 3, §5 reading 103): the human gestures that move Lookback's prompt pins in
 * `~/.vtc/lookback/pins.yaml`, for the repo the command runs in (`engineRepoKey`). Like
 * `vtc calibrate` they write the file directly after a yes at an interactive terminal; no MCP tool
 * or HTTP route writes it, and a `pins.yaml` inside a repo is never read. The Lead shows the
 * proposal and its replay result in chat and gives the human the command.
 *
 *   vtc lookback approve  --role <role> [--mode <mode>] --host <host> --version <sha>
 *   vtc lookback pin      --role <role> [--mode <mode>] --host <host> --version <sha>
 *   vtc lookback rollback --role <role> [--mode <mode>] --host <host>
 *
 * The planning is `lookback-pins.ts`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "@vtc/engine";
import { engineRepoKey, HostIdSchema, redactSecrets, RoleIdSchema, SlugSchema } from "@vtc/shared";
import {
  defaultGestureDeps,
  EXIT_NOT_CONFIRMED,
  needsTerminal,
  type GestureDeps,
} from "../human-gesture.js";
import {
  findPromptVersion,
  planGesture,
  readPins,
  withPinsLock,
  writePins,
  type Gesture,
  type PinTarget,
} from "../lookback-pins.js";
import { requireRepoRoot, requireVtcProject, UsageError } from "../repo.js";
import type { CommandSpec } from "./types.js";
import { EXIT, guarded, parseFlags } from "./util.js";

const USAGE = [
  "usage: vtc lookback approve  --role <role> [--mode <mode>] --host <host> --version <sha>",
  "       vtc lookback pin      --role <role> [--mode <mode>] --host <host> --version <sha>",
  "       vtc lookback rollback --role <role> [--mode <mode>] --host <host>",
  "  approve   start a canary of a version whose replay says improve; again to promote it",
  "  pin       pin a version outright (ends a canary)",
  "  rollback  end the canary, or move the pin back to the version it replaced",
].join("\n");

const GESTURES: readonly Gesture[] = ["approve", "pin", "rollback"];

export const createLookbackCommand = (
  deps: () => GestureDeps = defaultGestureDeps,
): CommandSpec => ({
  name: "lookback",
  summary:
    "Approve, pin or roll back a Lookback prompt version for this repo (you confirm at the terminal)",
  run: (args, ctx) =>
    guarded("lookback", ctx, async () => {
      const { values, positionals } = parseFlags(
        args,
        {
          role: { type: "string" },
          mode: { type: "string" },
          host: { type: "string" },
          version: { type: "string" },
          reason: { type: "string" },
          help: { type: "boolean", short: "h" },
        },
        true,
      );
      if (values.help === true) {
        ctx.io.out(USAGE);
        return EXIT.ok;
      }
      const gesture = GESTURES.find((g) => g === positionals[0]);
      if (gesture === undefined || positionals.length !== 1) throw new UsageError(USAGE);
      const role = RoleIdSchema.safeParse(values.role);
      const host = HostIdSchema.safeParse(values.host);
      const mode = values.mode === undefined ? undefined : SlugSchema.safeParse(values.mode);
      if (!role.success || !host.success || mode?.success === false)
        throw new UsageError(
          `--role, --host (claude-code|codex) and --mode name the prompt\n${USAGE}`,
        );
      const needsVersion = gesture !== "rollback";
      if (needsVersion !== (values.version !== undefined))
        throw new UsageError(
          needsVersion
            ? `${gesture} needs --version\n${USAGE}`
            : `rollback takes no --version\n${USAGE}`,
        );
      const target: PinTarget = {
        role: role.data,
        ...(mode?.success === true ? { mode: mode.data } : {}),
        host: host.data,
      };
      const d = deps();
      const repoRoot = await requireRepoRoot(ctx.cwd);
      requireVtcProject(repoRoot);
      const repoKey = engineRepoKey(repoRoot);
      const version =
        values.version === undefined
          ? undefined
          : findPromptVersion(ctx.vtcHome, target, values.version);
      const reason = (values.reason ?? "").trim() || `vtc lookback ${gesture} at the terminal`;
      const plan = (now: Date) =>
        planGesture(readPins(ctx.vtcHome), {
          gesture,
          repoKey,
          target,
          ...(version === undefined ? {} : { version }),
          // a repo file roles can write: never through a link, and the summary shows its numbers
          replay: (rel) => {
            git.assertNoSymlinks(repoRoot, rel);
            return JSON.parse(readFileSync(join(repoRoot, rel), "utf8")) as unknown;
          },
          reason: redactSecrets(reason).slice(0, 500),
          now,
        });
      const first = plan(d.now());
      if (!first.ok) {
        ctx.io.err(`vtc lookback: ${first.reason}`);
        return EXIT.failed;
      }
      ctx.io.out(first.summary);
      if (!d.interactive()) {
        ctx.io.err(`vtc lookback: ${needsTerminal(`lookback ${gesture}`)}`);
        return EXIT_NOT_CONFIRMED;
      }
      if (!(await d.confirm("Is this your decision?"))) {
        ctx.io.out("Not confirmed: the pins are unchanged.");
        return EXIT_NOT_CONFIRMED;
      }
      // re-plan under the lock: the engine may have rolled a canary back meanwhile
      const written = await withPinsLock(ctx.vtcHome, () => {
        const again = plan(d.now());
        if (!again.ok) return again;
        if (again.summary !== first.summary)
          return { ok: false as const, reason: "the pins changed while you decided; run it again" };
        return { ok: true as const, path: writePins(ctx.vtcHome, again.pins) };
      });
      if (!written.ok) {
        ctx.io.err(`vtc lookback: ${written.reason}`);
        return EXIT.failed;
      }
      ctx.io.out(`Wrote ${written.path}.`);
      return EXIT.ok;
    }),
});

export const command = createLookbackCommand();
