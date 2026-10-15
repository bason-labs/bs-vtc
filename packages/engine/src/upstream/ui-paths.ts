/**
 * Whether an automatic run touches UI (D-ct; spine §5 reading 223): its `has_ui` comes from the
 * repo-relative paths its issue touches (`touchesUi`), not always false, so the run's Final Review
 * records UI before/after evidence for its PR.
 * - A project item: the location its finding, escaped defect or Final Review leftover names
 *   (`project_problem.path`); none known touches no UI.
 * - A VTC-repo item: its VTC stack frames (`<package>/<file>:<function>`), mapped to VTC's own
 *   tree: `dashboard/` is `apps/dashboard/`, every other package `packages/<package>/`. A frame
 *   carries no extension (a release and a dev checkout agree on it), so a frame in the dashboard,
 *   VTC's only UI package, counts as UI whatever its file.
 */
import { touchesUi, VtcFrameSchema } from "@vtc/shared";

/** VTC's UI package as a repo-relative directory. */
export const VTC_UI_DIR = "apps/dashboard/";

/** Pure: the repo-relative path a VTC frame points into (its `:<function>` dropped). */
export const vtcFramePath = (frame: string): string => {
  const file = frame.slice(0, frame.lastIndexOf(":"));
  const slash = file.indexOf("/");
  const pkg = file.slice(0, slash);
  const rest = file.slice(slash + 1);
  return pkg === "dashboard" ? `${VTC_UI_DIR}${rest}` : `packages/${pkg}/${rest}`;
};

/** Pure: whether a project issue's touched paths hold UI (`touchesUi`). */
export const projectTouchesUi = (paths: readonly string[]): boolean => touchesUi(paths);

/** Pure: whether a VTC-repo issue's frames point into UI (see the module note). */
export const framesTouchUi = (frames: readonly string[]): boolean => {
  const paths = frames.filter((f) => VtcFrameSchema.safeParse(f).success).map(vtcFramePath);
  return touchesUi(paths) || paths.some((p) => p.startsWith(VTC_UI_DIR));
};

/**
 * Pure: the VTC frames an upstream issue's body lists (the "VTC frames" block the module renders),
 * each one checked against `VtcFrameSchema`; anything else on a line is ignored. The body is as
 * listed from GitHub, so a frame only ever decides `has_ui`, nothing else.
 */
export const framesFromIssueBody = (body: string | undefined): string[] =>
  (body ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => VtcFrameSchema.safeParse(line).success);
