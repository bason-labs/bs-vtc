/**
 * Human gestures that write a file directly (spine §5 readings 43 and 103): `vtc calibrate`'s
 * allowlist, `vtc lookback approve|pin|rollback` and `vtc merge-level restore`. They go through no
 * MCP tool or HTTP route; what proves a human is a yes typed at an interactive terminal, which an
 * agent's shell, a pipe or a script never is.
 */
import { interactiveTerminal, ttyConfirm } from "./confirm.js";

/** Exit code when the human did not confirm, or could not (no terminal). */
export const EXIT_NOT_CONFIRMED = 3;

export interface GestureDeps {
  /** stdin and stdout are both terminals. */
  readonly interactive: () => boolean;
  /** Asks the human `question [y/N]`. */
  readonly confirm: (question: string) => Promise<boolean>;
  readonly now: () => Date;
}

export const defaultGestureDeps = (): GestureDeps => ({
  interactive: interactiveTerminal,
  confirm: ttyConfirm,
  now: () => new Date(),
});

/** The refusal shown without a terminal. */
export const needsTerminal = (what: string): string =>
  `${what} is a human decision: run it yourself in an interactive terminal (an agent's shell or a pipe cannot confirm it)`;
