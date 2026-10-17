/**
 * `vtc doctor` in the wave-3 closing round (spine §5 readings 165, 170, 171, 173 and 156): the
 * Node minimum (D-bk), the user hooks and plugins headless Claude role runs load (D-bp, a §7
 * accepted residual), the API-key billing warning (D-bq), whether yt-dlp is there for YouTube
 * transcripts (D-bs) and where research search runs (H-3). Fakes only: no test reads the real
 * home or runs a host.
 */
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { API_KEY_BILLING_WARNING, type HostAuthStatus, type UserConfig } from "@vtc/shared";
import { checkClaudeUserSettings, claudeUserExtensionsOf } from "../src/claude-user-settings.js";
import { createDoctorCommand, type DoctorCommandEnv } from "../src/commands/doctor.js";
import { checkHostBilling, checkRuntime, MIN_NODE } from "../src/doctor-checks.js";
import type { Exec } from "../src/process.js";
import { checkResearchSearch, checkYtDlp, findYtDlp } from "../src/research-checks.js";
import { readClaudeUserSettings } from "../src/session-sandbox.js";
import type { UserConfigRead } from "../src/user-config.js";
import { capture, cleanupDirs, tempDir } from "./helpers.js";

afterEach(cleanupDirs);

const quiet: Exec = () => Promise.resolve({ code: 0, stdout: "", stderr: "" });
const NODE = { node: "22.17.1" };

const doctor = async (env: Partial<DoctorCommandEnv>): Promise<{ code: number; text: string }> => {
  const { ctx, out } = capture("/w", "/h");
  const code = await createDoctorCommand(() => ({ exec: quiet, versions: NODE, ...env })).run(
    [],
    ctx,
  );
  return { code, text: out.join("\n") };
};

describe("the Node minimum follows .nvmrc (D-bk, reading 165)", () => {
  it("needs node 22.14 or later; the binary's Bun always passes", () => {
    expect(MIN_NODE).toEqual([22, 14]);
    expect(checkRuntime({ node: "22.13.1" })).toEqual({
      name: "runtime",
      status: "fail",
      detail: "node 22.13.1: VTC needs node >= 22.14",
    });
    expect(checkRuntime({ node: "22.14.0" }).status).toBe("ok");
    expect(checkRuntime({ node: "23.0.0" }).status).toBe("ok");
    expect(checkRuntime({ node: "21.99.0" }).status).toBe("fail");
    expect(checkRuntime({ node: "22.13.1", bun: "1.4.3" }).status).toBe("ok");
  });
});

describe("the user hooks and plugins headless Claude role runs load (D-bp, reading 170)", () => {
  const settings = {
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: "~/bin/greet.sh" }] }],
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            {
              type: "command",
              command: "audit --token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123",
            },
            { type: "prompt", prompt: "is this safe?" },
          ],
        },
      ],
      Stop: "not a list",
    },
    enabledPlugins: {
      "superpowers@claude-plugins-official": true,
      "old@m": false,
      "vtc@vtc-local": true,
    },
    apiKeyHelper: "/usr/local/bin/key-helper",
    env: { ANTHROPIC_API_KEY: "sk-ant-secret" },
  };

  it("lists each hook by event and matcher, and the enabled plugins", () => {
    expect(claudeUserExtensionsOf(settings)).toEqual({
      hooksDisabled: false,
      hooks: [
        { event: "SessionStart", matcher: null, what: "~/bin/greet.sh" },
        { event: "PreToolUse", matcher: "Bash", what: "audit --token [REDACTED:anthropic_key]" },
        { event: "PreToolUse", matcher: "Bash", what: "a prompt hook" },
      ],
      plugins: ["superpowers@claude-plugins-official", "vtc@vtc-local"],
    });
    expect(claudeUserExtensionsOf({})).toEqual({ hooksDisabled: false, hooks: [], plugins: [] });
    expect(
      claudeUserExtensionsOf({ disableAllHooks: true, hooks: settings.hooks }).hooksDisabled,
    ).toBe(true);
  });

  it("phrases them as an accepted residual, never echoing other settings", () => {
    const checks = checkClaudeUserSettings({
      kind: "ok",
      path: "/u/.claude/settings.json",
      settings,
    });
    expect(checks.map((c) => [c.name, c.status])).toEqual([
      ["user hooks", "info"],
      ["user plugins", "info"],
    ]);
    const [hooks, plugins] = checks;
    expect(hooks?.detail).toMatch(
      /^3 user hooks in \/u\/\.claude\/settings\.json run in headless Claude role runs \(--setting-sources user\): SessionStart: ~\/bin\/greet\.sh; PreToolUse\(Bash\): audit --token \[REDACTED:anthropic_key\]; PreToolUse\(Bash\): a prompt hook\. /,
    );
    expect(hooks?.detail).toMatch(
      /accepted residual \(spine §7\): role runs stay bounded by their tools, every deny rule and the engine's write-scope check/,
    );
    expect(plugins?.detail).toMatch(
      /^2 enabled user plugins load in headless Claude role runs, with their skills and hooks: superpowers@claude-plugins-official, vtc@vtc-local\. /,
    );
    const text = checks.map((c) => c.detail).join("\n");
    expect(text).not.toContain("sk-ant");
    expect(text).not.toContain("key-helper");
    expect(text).not.toContain("old@m");
  });

  it("says when nothing loads, when hooks are off, and when the file cannot be read", () => {
    const none = checkClaudeUserSettings({ kind: "ok", path: "/u/s.json", settings: {} });
    expect(none).toEqual([
      {
        name: "user hooks",
        status: "ok",
        detail: "no user hooks in /u/s.json, so none run in headless Claude role runs",
      },
      {
        name: "user plugins",
        status: "ok",
        detail: "no user plugins enabled in /u/s.json, so none load in headless Claude role runs",
      },
    ]);
    const off = checkClaudeUserSettings({
      kind: "ok",
      path: "/u/s.json",
      settings: { disableAllHooks: true, hooks: settings.hooks },
    });
    expect(off[0]).toEqual({
      name: "user hooks",
      status: "ok",
      detail:
        "disableAllHooks is on in /u/s.json, so no hook runs in headless Claude role runs (VTC's own plugin hooks included)",
    });
    expect(checkClaudeUserSettings({ kind: "absent", path: "/u/s.json" })).toEqual([
      {
        name: "user hooks",
        status: "ok",
        detail:
          "no Claude user settings (/u/s.json), so no user hooks or plugins load in headless Claude role runs",
      },
    ]);
    expect(
      checkClaudeUserSettings({ kind: "unreadable", path: "/u/s.json", error: "Unexpected token" }),
    ).toEqual([
      {
        name: "user hooks",
        status: "warn",
        detail:
          "/u/s.json cannot be read (Unexpected token), so doctor cannot list the user hooks and plugins headless Claude role runs load",
      },
    ]);
  });

  it("reads only the settings file it is given", () => {
    const dir = tempDir();
    const path = join(dir, "settings.json");
    expect(readClaudeUserSettings(path)).toEqual({ kind: "absent", path });
    writeFileSync(path, JSON.stringify({ enabledPlugins: { "a@b": true } }));
    expect(readClaudeUserSettings(path)).toEqual({
      kind: "ok",
      path,
      settings: { enabledPlugins: { "a@b": true } },
    });
    writeFileSync(path, "[1]");
    expect(readClaudeUserSettings(path)).toMatchObject({ kind: "unreadable" });
  });

  it("is reported by vtc doctor and never fails it", async () => {
    const r = await doctor({
      claudeUserSettings: () => ({ kind: "ok", path: "/u/s.json", settings }),
    });
    expect(r.code).toBe(0);
    expect(r.text).toMatch(/info +user hooks +3 user hooks in \/u\/s\.json/);
    expect(r.text).toMatch(/info +user plugins +2 enabled user plugins/);
  });
});

describe("API-key billing is a warning, not a refusal (D-bq, reading 171)", () => {
  const at = "2026-10-14T10:00:00.000Z";
  const s = (
    host: HostAuthStatus["host"],
    billing?: HostAuthStatus["billing"],
  ): HostAuthStatus => ({
    host,
    logged_in: true,
    method: billing === "api_key" ? "API key" : "ChatGPT",
    ...(billing === undefined ? {} : { billing }),
    checked_at: at,
  });

  it("warns with API_KEY_BILLING_WARNING for each api_key host", () => {
    expect(checkHostBilling([s("codex", "subscription"), s("claude-code")])).toBeNull();
    expect(checkHostBilling([s("codex", "api_key"), s("claude-code", null)])).toEqual({
      name: "billing",
      status: "warn",
      detail: `codex: ${API_KEY_BILLING_WARNING}. Role runs still run; to bill your subscription instead, log codex in with it`,
    });
  });

  it("shows in vtc doctor, which still passes", async () => {
    const r = await doctor({ hostAuth: () => Promise.resolve([s("codex", "api_key")]) });
    expect(r.code).toBe(0);
    expect(r.text).toContain(`warn  billing      codex: ${API_KEY_BILLING_WARNING}`);
    expect(r.text).toMatch(/ok +host auth +codex logged in \(API key\)/);
  });

  it("words a Claude apiKeyHelper setup the same way", async () => {
    const exec: Exec = (command, args) =>
      Promise.resolve({
        code: 0,
        stderr: "",
        stdout:
          `${command} ${args.join(" ")}` === "claude --version"
            ? "2.1.296 (Claude Code)\n"
            : `${command} ${args.join(" ")}` === "claude auth status --json"
              ? JSON.stringify({ loggedIn: true, authMethod: "apiKeyHelper" })
              : "",
      });
    const r = await doctor({ exec });
    expect(r.code).toBe(0);
    expect(r.text).toContain(
      `warn  claude-code  2.1.296 (Claude Code): ${API_KEY_BILLING_WARNING} (an apiKeyHelper in your user settings, which headless role runs load). Role runs still run; to bill your subscription instead, remove apiKeyHelper and log in (run claude, then /login)`,
    );
  });
});

describe("yt-dlp for YouTube transcripts (D-bs, reading 173)", () => {
  const tool = (dir: string, name = "yt-dlp", mode = 0o755): string => {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    writeFileSync(path, "#!/bin/sh\nexit 0\n");
    chmodSync(path, mode);
    return path;
  };

  it("finds the user's own yt-dlp on an absolute PATH entry outside the repo", () => {
    const root = tempDir();
    const repo = join(root, "repo");
    const inRepo = tool(join(repo, "node_modules/.bin"));
    const user = tool(join(root, "bin"));
    tool(join(root, "noexec"), "yt-dlp", 0o644);
    const pathEnv = [
      "relative/bin",
      join(root, "noexec"),
      join(repo, "node_modules/.bin"),
      join(root, "empty"),
      join(root, "bin"),
    ].join(delimiter);
    expect(findYtDlp({ pathEnv, repoRoot: repo })).toBe(user);
    // outside a repo the repo's own entry is no exception
    expect(findYtDlp({ pathEnv: join(repo, "node_modules/.bin"), repoRoot: null })).toBe(inRepo);
    expect(findYtDlp({ pathEnv: join(repo, "node_modules/.bin"), repoRoot: repo })).toBeNull();
    // a link outside the repo into it does not count either
    const linked = join(root, "linked");
    mkdirSync(linked);
    symlinkSync(inRepo, join(linked, "yt-dlp"));
    expect(findYtDlp({ pathEnv: linked, repoRoot: repo })).toBeNull();
    expect(findYtDlp({ pathEnv: "", repoRoot: null })).toBeNull();
    // the probe is the youtube fetcher's own (reading 181), which names yt-dlp.exe on Windows
  });

  it("is an ok line when found and an info line when absent, never an install", async () => {
    expect(checkYtDlp("/opt/bin/yt-dlp")).toEqual({
      name: "yt-dlp",
      status: "ok",
      detail:
        "/opt/bin/yt-dlp: research's youtube fetcher runs it for video transcripts (your own install; VTC never installs or updates it)",
    });
    expect(checkYtDlp(null)).toEqual({
      name: "yt-dlp",
      status: "info",
      detail:
        "yt-dlp is not on PATH, so YouTube transcripts are unavailable to research (the youtube fetcher answers unavailable). VTC never installs it: install it yourself to enable them",
    });
    const r = await doctor({ ytDlp: () => Promise.resolve(null) });
    expect(r.code).toBe(0);
    expect(r.text).toMatch(/info +yt-dlp +yt-dlp is not on PATH/);
  });
});

describe("research search runs on the host's own web search (H-3, reading 156)", () => {
  const read = (research?: UserConfig["research"]): UserConfigRead => ({
    ok: true,
    path: "/h/config.yaml",
    config: { version: 1, env_passthrough: [], ...(research === undefined ? {} : { research }) },
  });
  const HOST_SEARCH =
    "research search uses the host's own web search (Claude Code WebSearch/WebFetch, Codex web search) in the Research Analyst's session: no search API key, no extra bill";

  it("is an info line by default, and names the keyed provider when one is configured", () => {
    expect(checkResearchSearch(read(), {})).toEqual({
      name: "research",
      status: "info",
      detail: `${HOST_SEARCH} (to add a keyed provider, set research.search_provider and research.api_keys.search in /h/config.yaml)`,
    });
    expect(checkResearchSearch(read({ api_keys: { search: "SEARCH_KEY" } }), {})).toEqual({
      name: "research",
      status: "info",
      detail: `${HOST_SEARCH}; research.api_keys.search is not used without research.search_provider (/h/config.yaml)`,
    });
    const keyed = read({ search_provider: "tavily", api_keys: { search: "SEARCH_KEY" } });
    expect(checkResearchSearch(keyed, { SEARCH_KEY: "k" })).toEqual({
      name: "research",
      status: "ok",
      detail: `${HOST_SEARCH}; the search fetcher also uses tavily with the key in $SEARCH_KEY (research.search_provider in /h/config.yaml)`,
    });
    expect(checkResearchSearch(keyed, {})).toEqual({
      name: "research",
      status: "warn",
      detail: `research.search_provider names tavily, but $SEARCH_KEY is not set, so the search fetcher stays unavailable and ${HOST_SEARCH.replace("research search uses", "research search falls back to")}`,
    });
    expect(checkResearchSearch(read({ search_provider: "exa", api_keys: {} }), {})).toEqual({
      name: "research",
      status: "warn",
      detail: `research.search_provider names exa, but research.api_keys.search names no variable in /h/config.yaml, so the search fetcher stays unavailable and ${HOST_SEARCH.replace("research search uses", "research search falls back to")}`,
    });
    // a file that does not parse is the env check's to report
    expect(checkResearchSearch({ ok: false, path: "/h/config.yaml", error: "bad" }, {})).toBeNull();
  });

  it("shows in vtc doctor, read from the user config", async () => {
    const r = await doctor({ userConfig: () => read() });
    expect(r.code).toBe(0);
    expect(r.text).toMatch(/info +research +research search uses the host's own web search/);
  });
});
