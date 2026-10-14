import { describe, expect, it } from "vitest";
import { recordPath, redactRecording } from "../scripts/recording.js";

const context = {
  home: "/Users/someone",
  cwd: ["/var/folders/xy/T/vtc-live-abc", "/private/var/folders/xy/T/vtc-live-abc"],
  user: "someone",
};

describe("redactRecording (live-check --record)", () => {
  it("replaces session, thread and event ids with the fixtures' placeholders", () => {
    const out = redactRecording(
      [
        '{"type":"system","subtype":"init","session_id":"0b6f3c1e-1111-2222-3333-444455556666","uuid":"9a9a9a9a-1111-2222-3333-444455556666"}',
        '{"type":"thread.started","thread_id":"019a0000-aaaa-bbbb-cccc-ddddeeeeffff"}',
      ],
      context,
    );
    expect(out.map((line) => JSON.parse(line) as unknown)).toEqual([
      { type: "system", subtype: "init", session_id: "<session-id>", uuid: "<uuid>" },
      { type: "thread.started", thread_id: "<thread-id>" },
    ]);
  });

  it("replaces the temp repo (by either spelling), the home directory and the user name", () => {
    const [line] = redactRecording(
      [
        JSON.stringify({
          cwd: "/private/var/folders/xy/T/vtc-live-abc",
          plugin: "/Users/someone/.vtc/plugins/claude-code",
          note: "ran in /var/folders/xy/T/vtc-live-abc/notes as someone",
        }),
      ],
      context,
    );
    expect(JSON.parse(line ?? "")).toEqual({
      cwd: "<cwd>",
      plugin: "<home>/.vtc/plugins/claude-code",
      note: "ran in <cwd>/notes as <user>",
    });
  });

  it("removes e-mail addresses and every known token format, in nested values too", () => {
    const [line] = redactRecording(
      [
        JSON.stringify({
          account: { email: "owner@example.com" },
          errors: ["Bearer abcdefghijklmnopqrstuvwxyz0123456789"],
        }),
      ],
      context,
    );
    expect(line).not.toContain("owner@example.com");
    expect(line).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
    expect(JSON.parse(line ?? "")).toEqual({
      account: { email: "<email>" },
      errors: ["Bearer [REDACTED:bearer_token]"],
    });
  });

  it("redacts a line that is not JSON as text, and drops blank lines", () => {
    expect(
      redactRecording(["Reading additional input from /Users/someone/x", "", "  "], context),
    ).toEqual(["Reading additional input from <home>/x"]);
  });

  it("keeps the event shape: numbers, booleans and nulls are copied", () => {
    const line =
      '{"type":"result","subtype":"error_max_turns","num_turns":2,"is_error":true,"total_cost_usd":0.01,"result":null}';
    expect(redactRecording([line], context)).toEqual([line]);
  });

  it("does not treat a short user name as a path fragment inside other words", () => {
    const [line] = redactRecording(['{"text":"the agent said ok"}'], { ...context, user: "ag" });
    expect(JSON.parse(line ?? "")).toEqual({ text: "the agent said ok" });
  });
});

describe("redactRecording: what names the owner's own setup (closing round, spine §7)", () => {
  it("replaces the init event's plugins (but vtc's own), skills, commands, memory paths and messaging socket with a placeholder", () => {
    const [line] = redactRecording(
      [
        JSON.stringify({
          type: "system",
          subtype: "init",
          session_id: "s",
          tools: ["Read", "StructuredOutput"],
          agents: ["Explore", "vtc:vtc-qa-judge"],
          plugins: [
            { name: "private-plugin", path: "/opt/private/plugin", source: "x@y" },
            { name: "vtc", path: "/Users/someone/arms/a", source: "vtc@inline", version: "0.1.0" },
          ],
          skills: ["private-skill", "vtc:architect"],
          slash_commands: ["private-command"],
          memory_paths: { auto: "/somewhere/memory/" },
          messaging_socket_path: "/tmp/cc-socks/1.sock",
          apiKeySource: "none",
        }),
      ],
      context,
    );
    expect(JSON.parse(line ?? "")).toEqual({
      type: "system",
      subtype: "init",
      session_id: "<session-id>",
      tools: ["Read", "StructuredOutput"],
      agents: ["Explore", "vtc:vtc-qa-judge"],
      // the vtc plugin's entry is what a replay arm's load proof reads (D-cg): it stays
      plugins: [
        "<redacted>",
        { name: "vtc", path: "<home>/arms/a", source: "vtc@inline", version: "0.1.0" },
      ],
      skills: "<redacted>",
      slash_commands: "<redacted>",
      memory_paths: "<redacted>",
      messaging_socket_path: "<redacted>",
      apiKeySource: "none",
    });
    expect(line).not.toContain("private");
  });

  it("keeps built-in and vtc: agents and a built-in output style, and replaces the owner's own agents, style and terminal commands", () => {
    const [line] = redactRecording(
      [
        JSON.stringify({
          type: "system",
          subtype: "init",
          agents: ["claude", "Explore", "private-agent", "vtc:vtc-qa-judge", "other:private"],
          output_style: "private-style",
          terminal_slash_commands: ["doctor", "private-command"],
        }),
      ],
      context,
    );
    expect(JSON.parse(line ?? "")).toEqual({
      type: "system",
      subtype: "init",
      agents: ["claude", "Explore", "<redacted>", "vtc:vtc-qa-judge", "<redacted>"],
      output_style: "<redacted>",
      terminal_slash_commands: "<redacted>",
    });
    expect(line).not.toContain("private");
    const [builtIn] = redactRecording(
      [JSON.stringify({ type: "system", subtype: "init", output_style: "default" })],
      context,
    );
    expect(JSON.parse(builtIn ?? "")).toEqual({
      type: "system",
      subtype: "init",
      output_style: "default",
    });
  });

  it("replaces a hook's output text (it can name the owner's plugins and paths), keeping the rest of the event", () => {
    const [line] = redactRecording(
      [
        JSON.stringify({
          type: "system",
          subtype: "hook_response",
          hook_name: "SessionStart:startup",
          output: "private context",
          stdout: "private context",
          stderr: "",
          exit_code: 0,
          outcome: "success",
        }),
      ],
      context,
    );
    expect(JSON.parse(line ?? "")).toEqual({
      type: "system",
      subtype: "hook_response",
      hook_name: "SessionStart:startup",
      output: "<redacted>",
      stdout: "<redacted>",
      stderr: "",
      exit_code: 0,
      outcome: "success",
    });
  });

  it("replaces opaque thinking signatures, wherever they sit", () => {
    const [line] = redactRecording(
      [
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "thinking", thinking: "", signature: "CAQSabc" }] },
        }),
      ],
      context,
    );
    expect(JSON.parse(line ?? "")).toEqual({
      type: "assistant",
      message: { content: [{ type: "thinking", thinking: "", signature: "<signature>" }] },
    });
  });

  it("leaves the same keys alone in events of other types", () => {
    const line = '{"type":"result","subtype":"success","skills":["x"],"output":"y"}';
    expect(redactRecording([line], context)).toEqual([line]);
  });
});

describe("recordPath", () => {
  it("writes the first run to the given file and a resumed run beside it", () => {
    expect(recordPath("out/stream-max-turns.jsonl", false)).toBe("out/stream-max-turns.jsonl");
    expect(recordPath("out/stream-max-turns.jsonl", true)).toBe(
      "out/stream-max-turns.resume.jsonl",
    );
    expect(recordPath("out/stream", true)).toBe("out/stream.resume");
  });
});
