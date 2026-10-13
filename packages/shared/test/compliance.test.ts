import { describe, expect, it } from "vitest";
import {
  AD9_FORBIDDEN_MARKERS,
  findForbiddenHostArgs,
  gateAllowlistFile,
  HIDDEN_TESTS,
  HOST_CREDENTIAL_DENY_READ,
  hostCredentialDenyReadPaths,
  isHostCredentialDenyRead,
  ROLE_DENIED_VTC,
} from "../src/index.js";

const CLAUDE_CRED = "/home/u/.claude/.credentials.json";
const CODEX_CRED = "/home/u/.codex/auth.json";

describe("hostCredentialDenyReadPaths (D-ad)", () => {
  it("joins each resolved host config directory with its credential files", () => {
    expect(
      hostCredentialDenyReadPaths({ "claude-code": "/home/u/.claude/", codex: "/home/u/.codex" }),
    ).toEqual([CLAUDE_CRED, CODEX_CRED]);
    expect(hostCredentialDenyReadPaths({ codex: "/srv/codex home" })).toEqual([
      "/srv/codex home/auth.json",
    ]);
    expect(hostCredentialDenyReadPaths({})).toEqual([]);
  });
  it("refuses a relative or backslashed directory", () => {
    expect(() => hostCredentialDenyReadPaths({ codex: ".codex" })).toThrow(TypeError);
    expect(() => hostCredentialDenyReadPaths({ codex: "C:\\Users\\u\\.codex" })).toThrow(TypeError);
  });
  it("names only files the AD-9 marker list already forbids", () => {
    for (const { files } of Object.values(HOST_CREDENTIAL_DENY_READ)) {
      for (const file of files) {
        expect(AD9_FORBIDDEN_MARKERS.some((m) => file.includes(m))).toBe(true);
      }
    }
  });
});

describe("isHostCredentialDenyRead", () => {
  it.each([
    CLAUDE_CRED,
    `Read(/${CLAUDE_CRED})`,
    `Read(${CODEX_CRED})`,
    "~/.claude/.credentials.json",
  ])("accepts the deny entry %s", (entry) => {
    expect(isHostCredentialDenyRead(entry)).toBe(true);
  });
  it.each([
    ".claude/.credentials.json",
    "/home/u/**/.credentials.json",
    "/home/u/.codex/auth.json/../x",
    "/home/u/.codex/auth.json.bak",
    "Read(/home/u/.codex/auth.json,Bash)",
    "Edit(/home/u/.codex/auth.json)",
    "/home/u/.codex/auth.json ",
  ])("rejects %s", (entry) => {
    expect(isHostCredentialDenyRead(entry)).toBe(false);
  });
});

describe("findForbiddenHostArgs: credential read-denies are exempt only in deny lists", () => {
  const settings = (extra: Record<string, unknown> = {}) => ({
    permissions: {
      defaultMode: "dontAsk",
      deny: [`Read(/${CLAUDE_CRED})`, "Read(//home/u/.vtc/token)"],
      ...extra,
    },
    sandbox: { enabled: true, filesystem: { denyRead: [CLAUDE_CRED, CODEX_CRED] } },
  });
  it("passes settings whose only markers are the sanctioned denies", () => {
    expect(findForbiddenHostArgs([JSON.stringify(settings())])).toEqual([]);
    expect(findForbiddenHostArgs(["--settings", JSON.stringify(settings())])).toEqual([]);
  });
  it("still flags the same path in an allow list or outside JSON settings", () => {
    const allowed = JSON.stringify(settings({ allow: [`Read(/${CLAUDE_CRED})`] }));
    expect(findForbiddenHostArgs([allowed])).toEqual([allowed]);
    expect(findForbiddenHostArgs(["--add-dir", CLAUDE_CRED])).toEqual([CLAUDE_CRED]);
    const nested = JSON.stringify({ env: { deny: [CODEX_CRED] } });
    expect(findForbiddenHostArgs([nested])).toEqual([nested]);
  });
  it("still flags any other marker next to the sanctioned denies", () => {
    const bypass = JSON.stringify({ ...settings(), mode: "bypassPermissions" });
    expect(findForbiddenHostArgs([bypass])).toEqual([bypass]);
    const wildcard = JSON.stringify({
      sandbox: { filesystem: { denyRead: ["/home/u/**/auth.json"] } },
    });
    expect(findForbiddenHostArgs([wildcard])).toEqual([wildcard]);
  });
  it("treats malformed JSON as a plain argument", () => {
    const broken = `{"permissions":{"deny":["${CLAUDE_CRED}"]}`;
    expect(findForbiddenHostArgs([broken])).toEqual([broken]);
  });
});

describe("ROLE_DENIED_VTC (D-w)", () => {
  it("covers the allowlist, the hidden tests and the scanner database", () => {
    const allowlistDir = gateAllowlistFile("/repo").split("/")[0] ?? "";
    expect(ROLE_DENIED_VTC.homeWriteDeny).toContain(`${allowlistDir}/**`);
    expect(ROLE_DENIED_VTC.homeWriteDeny).toContain(`${HIDDEN_TESTS.homeDir}/**`);
    expect(ROLE_DENIED_VTC.homeWriteDeny).toContain("osv-db/**");
    expect(ROLE_DENIED_VTC.subcommands).toEqual(["calibrate"]);
  });
});
