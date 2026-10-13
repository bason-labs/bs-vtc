/** One `vtc` subcommand. Each lives in its own file, owned by the team that implements it (AD-15). */
export interface CommandSpec {
  readonly name: string;
  readonly summary: string;
}
