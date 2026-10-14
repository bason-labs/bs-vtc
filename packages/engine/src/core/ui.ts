/**
 * Which work has screens the deterministic visual stack checks (spec §7.5, §9; spine AD-24):
 * frontend tasks of a run with UI, and the screens of `screens.yaml` whose `reqs` they cover.
 * Engine core sends them as `GateRunRequest.visual` (a task's screens; all of them at Final
 * Review step 5).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DESIGN_SCREENS_PATH,
  DesignScreensFileSchema,
  parsePersisted,
  type DesignScreen,
  type Task,
} from "@vtc/shared";
import type { RunState } from "./state.js";
import { parseYaml } from "./yaml.js";

/** A task with screens: a frontend task of a run with UI (native mobile is out of scope, §1.2). */
export const taskHasUi = (state: RunState, task: Pick<Task, "discipline">): boolean =>
  state.run.has_ui && task.discipline === "frontend";

/** A feature with screens: one of its tasks has them. */
export const featureHasUi = (state: RunState, featureId: string): boolean =>
  (state.features.get(featureId)?.tasks ?? []).some((id) => {
    const task = state.tasks.get(id);
    return task !== undefined && task.status !== "dropped" && taskHasUi(state, task);
  });

/** `.vtc/design/screens.yaml` as the Designer froze it at G2; `[]` when absent or invalid. */
export const designScreens = (repoRoot: string): DesignScreen[] => {
  try {
    const parsed = parsePersisted(
      DesignScreensFileSchema,
      parseYaml(readFileSync(join(repoRoot, DESIGN_SCREENS_PATH), "utf8")),
    );
    return parsed.success ? parsed.data.screens : [];
  } catch {
    return [];
  }
};

/** The screens whose `reqs` a task covers (a screen covering `REQ-1.AC-2` counts for `REQ-1`). */
export const screensFor = (repoRoot: string, task: Pick<Task, "covers">): string[] =>
  designScreens(repoRoot)
    .filter((s) =>
      s.reqs.some((r) =>
        task.covers.some((c) => r === c || r.startsWith(`${c}.`) || c.startsWith(`${r}.`)),
      ),
    )
    .map((s) => s.id);
