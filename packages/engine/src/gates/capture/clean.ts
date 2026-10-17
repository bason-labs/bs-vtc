/**
 * Reasons that may leave the machine (AD-27 rule 6): no secret, no `denyText` value, bounded.
 */
import { redactSecrets } from "@vtc/shared";
import { DENY_SUBSTRING_MIN } from "./protocol.js";

const MAX_REASON = 300;

/**
 * Every place `value` shows in a text, case-insensitively: as a substring, or as a whole word when
 * it is shorter than {@link DENY_SUBSTRING_MIN} and holds no `/` (spine §5 reading 212(12)).
 */
export const deniedPattern = (value: string): RegExp => {
  const escaped = value.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
  return value.length >= DENY_SUBSTRING_MIN || value.includes("/")
    ? new RegExp(escaped, "gi")
    : new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, "gi");
};

/** A reason with no secret and no `denyText` value in it. */
export const cleanReason = (text: string, denyText: readonly string[]): string => {
  let out = redactSecrets(text, denyText);
  for (const value of denyText) {
    const v = value.trim();
    if (v === "") continue;
    out = out.replace(deniedPattern(v), "[REDACTED]");
  }
  return out.length > MAX_REASON ? `${out.slice(0, MAX_REASON - 1)}…` : out;
};
