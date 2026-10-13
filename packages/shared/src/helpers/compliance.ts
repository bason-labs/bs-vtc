/**
 * AD-9 markers: host permission-bypass flags and host credential locations VTC must never use
 * (§12.5, §15). `eslint.config.js` builds its AD-9 lint rule from the same list (a test keeps
 * them equal), and adapter contract tests run `findForbiddenHostArgs` on every argv they build.
 */
export const AD9_FORBIDDEN_MARKERS = [
  // permission / sandbox bypass flags and modes
  "dangerously-skip-permissions",
  "dangerously-bypass-approvals-and-sandbox",
  "bypassPermissions",
  "--yolo",
  "danger-full-access",
  // host credentials
  ".credentials.json",
  "auth.json",
  "find-generic-password",
  "Claude Code-credentials",
] as const;

/** Every argument that contains a forbidden marker (case-insensitive). */
export const findForbiddenHostArgs = (args: readonly string[]): string[] =>
  args.filter((arg) => {
    const lower = arg.toLowerCase();
    return AD9_FORBIDDEN_MARKERS.some((marker) => lower.includes(marker.toLowerCase()));
  });
