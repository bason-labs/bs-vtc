/**
 * The environment of every engine git call (spine §5 reading 23): a clean, controlled one, not
 * the daemon's whole environment. Only what git needs to find the user's own installation,
 * configuration, identity, signing setup and auth (AD-9) passes; every `GIT_*` variable the
 * daemon happened to inherit (`GIT_DIR`, `GIT_INDEX_FILE`, `GIT_CONFIG_PARAMETERS`,
 * `GIT_EXEC_PATH`, `GIT_ASKPASS`, …) is dropped, except the user's choice of global config file
 * and of ssh command for a push. Prompts are off: the engine runs unattended.
 */
const PASSED = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "TZ",
  "TMPDIR",
  "TEMP",
  "TMP",
  "XDG_CONFIG_HOME",
  "SSH_AUTH_SOCK",
  "GNUPGHOME",
  "GPG_TTY",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "COMSPEC",
  "PATHEXT",
  "WINDIR",
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "PROGRAMDATA",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
] as const;

/** The environment for an engine git call, with `extra` (identity, …) on top. */
export const gitEnv = (extra: Readonly<Record<string, string>> = {}): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const name of PASSED) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return {
    ...env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_EDITOR: "true",
    GIT_PAGER: "cat",
    GIT_OPTIONAL_LOCKS: "0",
    ...extra,
  };
};
