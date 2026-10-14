/**
 * Free text the evidence recorder paints out (spine AD-27 rule 6, §5 reading 208): prompts,
 * diffs, logs, env, file contents, terminal output, tokens and ids. Spread it onto the element
 * that holds such text; in evidence mode (`?evidence=`) the dashboard paints it out too
 * (`globals.css`), and the recorder's DOM text scan skips it. Tagged in every mode, so a capture
 * never depends on the mode being read correctly.
 */
export const REDACT = { "data-vtc-redact": "" } as const;
