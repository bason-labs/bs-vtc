/**
 * Owner: cli+binary team. `vtc lookback approve|pin|rollback` (spec §13 steps 4–6; spine AD-21
 * rule 3, §5 readings 103 and 196): the human gestures that move Lookback's prompt pins in
 * `~/.vtc/lookback/pins.yaml`, for the repo the command runs in (`engineRepoKey`), on this machine
 * only. Since D-cb (reading 196) a replay verdict `improve` opens a bs-vtc PR on its own, and the
 * human's review and merge of that PR is the promotion for everyone, in the next VTC release;
 * `approve` starts a local canary on this machine, and `pin` pins a version here. Like
 * `vtc calibrate` they write the file directly after a yes at an interactive terminal; no MCP tool
 * or HTTP route writes it, and a `pins.yaml` inside a repo is never read. The Lead shows the
 * proposal and its replay result in chat and gives the human the command.
 *
 *   vtc lookback approve  --role <role> [--mode <mode>] --host <host> --version <sha> [--reason <text>]
 *   vtc lookback pin      --role <role> [--mode <mode>] --host <host> --version <sha> [--reason <text>]
 *   vtc lookback rollback --role <role> [--mode <mode>] --host <host> [--reason <text>]
 *
 * The planning is `lookback-pins.ts`. A version is checked as the engine checks it against the
 * locked core of this vtc's bundled plugin (`plugin:<host>`, `rolePromptAssetPath(<agent>,
 * "locked")`; not read from the host's own plugin directory, which can lag a vtc upgrade until the
 * plugin is reinstalled). A canary starts only from a replay result whose bytes match the hash its
 * `lookback.replay_finished` event recorded, when it recorded one (spine §5 reading 128), and is
 * promoted only when its arms, counted from the repo's event logs, say `promotable`.
 *
 * `pin` and `approve` warn when the target cannot take a pin (spine §5 reading 176): its agent is
 * not `editable_in_pack` in the bundled plugin's manifest and its host's runs load the compiled
 * agent (Claude Code), so the version would reach no run and each dispatch records a
 * `prompt_selection` incident. A Codex target that is not `editable_in_pack` gets a note: the pin
 * reaches its headless runs only. The gesture still goes ahead after the human's yes.
 *
 * `approve` also warns, while no canary of the target is running, when no replay of it can run
 * (`replayGraderFor`, spine §5 readings 201 and 202): a role that changes no file and that no
 * verdict grader scores. Every file-writing role replays on either host (each Claude arm runs its
 * own plugin, D-cg) and the Spec Verifier through the verdict grader (D-ch). A canary starts only
 * from a replay, so the warning says so and points at `vtc lookback pin`. It also warns for any
 * Claude Code target, `editable_in_pack` or not, while this build has no arm plugin compiler
 * (`shippedArmPluginCompilerFactory`, merge note of `automation-wiring.ts`): every Claude replay
 * arm runs its own compiled plugin (reading 201), which the daemon then cannot build, so the
 * replay waits for the next RETRO.
 */
import { join } from "node:path";
import { core, git } from "@vtc/engine";
import {
  agentNameFor,
  engineRepoKey,
  HostIdSchema,
  redactSecrets,
  replayGraderFor,
  RoleIdSchema,
  rolePromptAssetPath,
  SlugSchema,
  type AssetBundle,
} from "@vtc/shared";
import { shippedArmPluginCompilerFactory } from "../automation-wiring.js";
import {
  defaultGestureDeps,
  EXIT_NOT_CONFIRMED,
  needsTerminal,
  type GestureDeps,
} from "../human-gesture.js";
import {
  bytesSha256,
  checkLockedCore,
  describeTarget,
  findPromptVersion,
  pinReach,
  planGesture,
  readCanary,
  readPinsFile,
  readRegularFile,
  readRepoEvents,
  replayRecorded,
  withPinsLock,
  writePins,
  type Gesture,
  type PinTarget,
} from "../lookback-pins.js";
import { requireRepoRoot, requireVtcProject, UsageError } from "../repo.js";
import { runtime } from "../runtime.js";
import type { CommandSpec } from "./types.js";
import { EXIT, guarded, parseFlags } from "./util.js";

const USAGE = [
  "usage: vtc lookback approve  --role <role> [--mode <mode>] --host <host> --version <sha> [--reason <text>]",
  "       vtc lookback pin      --role <role> [--mode <mode>] --host <host> --version <sha> [--reason <text>]",
  "       vtc lookback rollback --role <role> [--mode <mode>] --host <host> [--reason <text>]",
  "  approve   start a local canary, on this machine, of a version whose replay says improve;",
  "            again, once the canary is promotable (its window passed with no trigger), to pin",
  "            it here. Promotion for everyone is merging the bs-vtc PR VTC opens for an improve",
  "            verdict (reading 196)",
  "  pin       pin a version outright (ends a canary; the override before a canary window passes)",
  "  rollback  end the canary, or move the pin back to the version it replaced",
  "  --reason  why, recorded (secrets redacted) in the pins.yaml history",
].join("\n");

const GESTURES: readonly Gesture[] = ["approve", "pin", "rollback"];

/** Whether a canary of the target runs on this project (a pins file that cannot be read: no). */
const canaryRunning = (vtcHome: string, repoKey: string, target: PinTarget): boolean => {
  try {
    return (readPinsFile(vtcHome).pins.projects[repoKey]?.canaries ?? []).some(
      (c) =>
        c.role === target.role &&
        c.host === target.host &&
        (c.mode ?? null) === (target.mode ?? null),
    );
  } catch {
    return false;
  }
};

/** The locked core this vtc's bundled plugin carries for the target's agent, or `undefined`. */
export type LockedCoreOf = (target: PinTarget) => string | undefined;

export const installedLockedCore: LockedCoreOf = (target) => {
  const bytes = runtime().assets.read(
    `plugin:${target.host}`,
    rolePromptAssetPath(agentNameFor(target.role, target.mode), "locked"),
  );
  return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
};

/**
 * Whether this vtc's bundled plugin marks the target's agent `editable_in_pack` (its manifest,
 * `core.pluginManifest`), so the engine renders a pinned editable section in the task pack. No
 * manifest, no entry or a broken manifest reads as `false`: the gesture then warns.
 */
export type EditableInPackOf = (target: PinTarget) => boolean;

/** {@link EditableInPackOf} over an asset bundle's plugin manifests. */
export const editableInPackOf =
  (assets: () => AssetBundle): EditableInPackOf =>
  (target) => {
    try {
      const agent = agentNameFor(target.role, target.mode);
      return (
        core.pluginManifest(assets(), target.host)?.agents.find((a) => a.name === agent)
          ?.editable_in_pack === true
      );
    } catch {
      return false;
    }
  };

export const installedEditableInPack: EditableInPackOf = editableInPackOf(() => runtime().assets);

/**
 * Whether the target's role changes files in its mode (`core.roleChangesFiles` over this vtc's
 * bundled role contracts, `core.compiledRoleContracts`), or `undefined` when that cannot be told
 * (no such role, or no readable contracts): the gesture then does not warn on it.
 */
export type ChangesFilesOf = (target: PinTarget) => boolean | undefined;

/** {@link ChangesFilesOf} over an asset bundle's compiled role contracts. */
export const changesFilesOf =
  (assets: () => AssetBundle): ChangesFilesOf =>
  (target) => {
    try {
      const contract = core.compiledRoleContracts(assets()).find((c) => c.id === target.role);
      return contract === undefined ? undefined : core.roleChangesFiles(contract, target.mode);
    } catch {
      return undefined;
    }
  };

export const installedChangesFiles: ChangesFilesOf = changesFilesOf(() => runtime().assets);

/**
 * Why `approve` cannot start a canary of the target, or `undefined` (readings 201 and 202): no
 * replay can grade it (`replayGraderFor`), and a canary starts only from one. Whether the role
 * changes files unknown: no warning. Every replay arm on Claude Code, `editable_in_pack` or not,
 * runs headless from its own compiled plugin (D-cg, reading 201; `EngineDeps.armPlugins`), so
 * without an arm plugin compiler in this build (`armPlugins: false`) no replay of a Claude Code
 * target can run either and it waits for the next RETRO. A Codex replay needs no arm plugin.
 */
export const noCanaryWarning = (
  target: PinTarget,
  changesFiles: boolean | undefined,
  armPlugins = true,
): string | undefined => {
  if (changesFiles === undefined) return undefined;
  const agent = agentNameFor(target.role, target.mode);
  if (replayGraderFor(target.role, changesFiles) === null)
    return `no canary of ${describeTarget(target)} can start in this version: ${agent} changes no file and no verdict grader scores it, so no replay can grade it (spine §5 readings 201 and 202). vtc lookback pin pins a version without a replay`;
  if (target.host === "claude-code" && !armPlugins)
    return `no canary of ${describeTarget(target)} can start with this vtc build: each Claude Code replay arm of ${agent} runs its own compiled plugin (D-cg, reading 201), and this build has no arm plugin compiler, so its replay waits for the next RETRO. vtc lookback pin pins a version without a replay`;
  return undefined;
};

export const createLookbackCommand = (
  deps: () => GestureDeps = defaultGestureDeps,
  lockedCore: LockedCoreOf = installedLockedCore,
  editableInPack: EditableInPackOf = installedEditableInPack,
  changesFiles: ChangesFilesOf = installedChangesFiles,
  armPlugins: boolean = shippedArmPluginCompilerFactory() !== undefined,
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
      if (version !== undefined) {
        const checked = await checkLockedCore(ctx.vtcHome, target, version, lockedCore(target));
        if (!checked.ok) {
          ctx.io.err(`vtc lookback: ${checked.reason}`);
          return EXIT.failed;
        }
        if (checked.note !== undefined) ctx.io.out(checked.note);
        // reading 176: say before the human decides when the pin cannot reach a run
        const inPack = editableInPack(target);
        const reach = pinReach(target, inPack);
        if (reach.warning !== undefined) ctx.io.err(`vtc lookback: warning: ${reach.warning}`);
        if (reach.note !== undefined) ctx.io.out(reach.note);
        // readings 201 and 202: say when no replay, so no canary, can start for the target
        if (gesture === "approve" && !canaryRunning(ctx.vtcHome, repoKey, target)) {
          const none = noCanaryWarning(target, changesFiles(target), armPlugins);
          if (none !== undefined) ctx.io.err(`vtc lookback: warning: ${none}`);
        }
      }
      const reason = (values.reason ?? "").trim() || `vtc lookback ${gesture} at the terminal`;
      const plan = (now: Date) => {
        const file = readPinsFile(ctx.vtcHome);
        return {
          text: file.text,
          plan: planGesture(file.pins, {
            gesture,
            repoKey,
            target,
            ...(version === undefined ? {} : { version }),
            // a repo file roles can write: never through a link, and the summary shows its numbers
            replay: (rel) => {
              git.assertNoSymlinks(repoRoot, rel);
              const bytes = readRegularFile(join(repoRoot, rel));
              if (bytes === undefined) throw new Error(`${rel} is not a regular file`);
              return {
                json: JSON.parse(bytes.toString("utf8")) as unknown,
                sha256: bytesSha256(bytes),
              };
            },
            replayRecord: (rel) => replayRecorded(readRepoEvents(repoRoot), rel),
            canary: (c) => readCanary(readRepoEvents(repoRoot), c),
            reason: redactSecrets(reason).slice(0, 500),
            now,
          }),
        };
      };
      const first = plan(d.now()).plan;
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
      // re-plan under the lock: the engine may have rolled a canary back meanwhile. The plan must
      // decide the same (a canary's counts may grow meanwhile; its verdict may not change), and
      // the write replaces the file only if it still holds what this plan read (the engine's
      // auto_rollback does not take the lock yet)
      const changed = {
        ok: false as const,
        reason: "the pins or the canary changed while you decided; run it again",
      };
      const written = await withPinsLock(ctx.vtcHome, () => {
        const again = plan(d.now());
        if (!again.plan.ok) return again.plan;
        if (again.plan.decision !== first.decision) return changed;
        const path = writePins(ctx.vtcHome, again.plan.pins, again.text);
        return path === null ? changed : { ok: true as const, path };
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
