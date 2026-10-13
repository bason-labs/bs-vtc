/**
 * AD-9 markers: host permission-bypass flags and host credential locations VTC must never use
 * (§12.5, §15). `eslint.config.js` builds its AD-9 lint rule from the same list (a test keeps
 * them equal). Adapter contract tests run `findForbiddenHostArgs` on every command and installed
 * file; compiler and repo tests run `findForbiddenInText` on role, skill and plugin sources and
 * on every emitted plugin file (AD-9).
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
  // credential environment variables (VTC runs on the user's own signed-in host, D2)
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
] as const;

/** Every argument that contains a forbidden marker (case-insensitive). */
export const findForbiddenHostArgs = (args: readonly string[]): string[] =>
  args.filter((arg) => {
    const lower = arg.toLowerCase();
    return AD9_FORBIDDEN_MARKERS.some((marker) => lower.includes(marker.toLowerCase()));
  });

/** One marker hit in a text file. */
export interface ForbiddenMarkerHit {
  /** 1-based line number. */
  readonly line: number;
  readonly marker: string;
}

/** Every line of `text` that contains a forbidden marker (case-insensitive), with the marker. */
export const findForbiddenInText = (text: string): ForbiddenMarkerHit[] => {
  const hits: ForbiddenMarkerHit[] = [];
  text.split("\n").forEach((content, index) => {
    const lower = content.toLowerCase();
    for (const marker of AD9_FORBIDDEN_MARKERS) {
      if (lower.includes(marker.toLowerCase())) hits.push({ line: index + 1, marker });
    }
  });
  return hits;
};
