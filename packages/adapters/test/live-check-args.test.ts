import { describe, expect, it } from "vitest";
import { parseLiveCheckArgs } from "../scripts/live-check-args.js";

describe("parseLiveCheckArgs", () => {
  it("defaults to the Codex usage read, a read-only profile and no recording", () => {
    expect(parseLiveCheckArgs([])).toEqual({
      target: "codex-usage",
      resume: false,
      profile: "read_only",
      signedOut: false,
    });
  });

  it("reads every flag a recording run needs", () => {
    expect(
      parseLiveCheckArgs([
        "claude-code",
        "--resume",
        "--model",
        "haiku",
        "--profile",
        "code_sandboxed",
        "--plugin-dir",
        "dist/claude-plugin",
        "--record",
        "out/stream.jsonl",
        "--max-turns",
        "1",
        "--kill-after",
        "4000",
      ]),
    ).toEqual({
      target: "claude-code",
      resume: true,
      model: "haiku",
      profile: "code_sandboxed",
      pluginDir: "dist/claude-plugin",
      record: "out/stream.jsonl",
      maxTurns: 1,
      killAfterMs: 4000,
      signedOut: false,
    });
    expect(parseLiveCheckArgs(["codex", "--signed-out", "--record", "a.jsonl"])).toMatchObject({
      target: "codex",
      signedOut: true,
      record: "a.jsonl",
    });
  });

  it("refuses an unknown target, an unknown profile, a flag without its value and a bad number", () => {
    expect(() => parseLiveCheckArgs(["claude"])).toThrow(/unknown target/);
    expect(() => parseLiveCheckArgs(["codex", "--profile", "full"])).toThrow(/profile/);
    expect(() => parseLiveCheckArgs(["codex", "--record"])).toThrow(/--record needs a value/);
    expect(() => parseLiveCheckArgs(["codex", "--max-turns", "0"])).toThrow(/positive integer/);
    expect(() => parseLiveCheckArgs(["codex", "--kill-after", "soon"])).toThrow(/positive integer/);
    expect(() => parseLiveCheckArgs(["codex", "--yolo"])).toThrow(/unknown flag --yolo/);
  });

  it("refuses a turn cap on Codex, which has none of its own (§12.1)", () => {
    expect(() => parseLiveCheckArgs(["codex", "--max-turns", "1"])).toThrow(
      /Codex has no turn cap/,
    );
  });
});
