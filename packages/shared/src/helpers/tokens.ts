/**
 * Cheap, deterministic token estimate used for contract guards (e.g. RoleResult.summary
 * <= 1.5k tokens, §5.1). Real token accounting comes from host stream events (§11).
 */
export const CHARS_PER_TOKEN = 4;

export const estimateTokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN);

/** Return cap for any role result summary (§5.1, §11). */
export const RETURN_CAP_TOKENS = 1500;
