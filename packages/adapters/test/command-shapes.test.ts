/**
 * D-cs (spine §5 reading 221): each adapter's `parseEvents` fills `ParsedStream.commandShapes`
 * from the run's shell calls (Claude `Bash` `tool_use`, Codex `command_execution`), through
 * `commandShapes` from `@vtc/shared`, in order, and keeps nothing of the raw command.
 */
import { readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CommandShapeSchema, type CommandShape } from "@vtc/shared";
import { createClaudeCodeAdapter, createCodexAdapter } from "../src/index.js";
import { shellCallShapes } from "../src/common/command-shapes.js";
import { fixtureLines } from "./support/fixtures.js";

const claude = createClaudeCodeAdapter();
const codex = createCodexAdapter();

/** The `flags` hash `commandShapes` gives a set of flag names. */
const flags = (...names: string[]): string =>
  createHash("sha256")
    .update([...new Set(names)].sort().join("\n"))
    .digest("hex")
    .slice(0, 12);
const shape = (program: string, subcommand?: string, ...names: string[]): CommandShape => ({
  program,
  ...(subcommand === undefined ? {} : { subcommand }),
  flags: flags(...names),
});

/**
 * Every value, path and secret the synthetic streams put into a shell call. None sits right after
 * a program as a plain lower-case word, which `commandShapes` keeps as the subcommand (the shared
 * contract's known limit, pinned below).
 */
const NEVER_KEPT = [
  "/Users/alice",
  "alice",
  "ghp_FAKE",
  "sk-ant-FAKE",
  "sk-proj-FAKE",
  "secret",
  "hunter2",
  "prod",
  "acme",
  "api.example.com",
  "Authorization",
  "Bearer",
  "/tmp/out.json",
  "@vtc/adapters",
  "rotate",
  "deploy.sh",
];

const expectNothingRaw = (shapes: readonly CommandShape[]): void => {
  const text = JSON.stringify(shapes);
  for (const raw of NEVER_KEPT) expect(text, raw).not.toContain(raw);
  for (const s of shapes) expect(CommandShapeSchema.parse(s)).toEqual(s);
};

describe("shellCallShapes: one host command field → shapes only", () => {
  it("unwraps a shell wrapper, so the shapes are the script's, not the shell's", () => {
    expect(shellCallShapes("bash -lc ls")).toEqual([shape("ls")]);
    expect(shellCallShapes("/bin/zsh -lc 'git status --short'")).toEqual([
      shape("git", "status", "--short"),
    ]);
    expect(shellCallShapes('/bin/bash -c "git log --oneline -n 3"')).toEqual([
      shape("git", "log", "--oneline", "-n"),
    ]);
    expect(shellCallShapes(["bash", "-lc", "npm run build --silent"])).toEqual([
      shape("npm", "run", "--silent"),
    ]);
  });

  it("shapes the commands after a wrapper on the same line too, never the wrapper's own arguments", () => {
    expect(shellCallShapes("bash -lc ls && rm -rf x")).toEqual([
      shape("ls"),
      shape("rm", undefined, "-rf"),
    ]);
    expect(shellCallShapes("bash -lc 'ls' ; rm -rf build")).toEqual([
      shape("ls"),
      shape("rm", undefined, "-rf"),
    ]);
    expect(shellCallShapes("bash -lc 'git status'\nmake test")).toEqual([
      shape("git", "status"),
      shape("make"),
    ]);
    // `$0`, positional arguments and redirections belong to the wrapper and name no command
    expect(shellCallShapes("bash -c 'make build' runner extra")).toEqual([shape("make")]);
    expect(shellCallShapes("bash -lc 'ls -la' 2>&1 | tee log")).toEqual([
      shape("ls", undefined, "-la"),
      shape("tee"),
    ]);
    expect(shellCallShapes("bash -lc 'ls'>out.txt")).toEqual([shape("ls")]);
    expect(shellCallShapes("bash -lc ls &>log")).toEqual([shape("ls")]);
  });

  it("keeps a non-wrapper command as it is: a shell named by path with no -c, or another program", () => {
    expect(shellCallShapes("bash ./scripts/x.sh")).toEqual([shape("bash")]);
    expect(shellCallShapes("bash -l")).toEqual([shape("bash", undefined, "-l")]);
    expect(shellCallShapes("python3 -c 'print(1)'")).toEqual([shape("python3", undefined, "-c")]);
  });

  it("joins an argv array with spaces, an argument with spaces staying one word", () => {
    expect(shellCallShapes(["git", "commit", "-m", "a message --not-a-flag"])).toEqual([
      shape("git", "commit", "-m"),
    ]);
    expect(shellCallShapes(["echo", "it's"])).toEqual([shape("echo")]);
  });

  it("keeps no argument value as a subcommand: only a program with subcommands has one (contracts 5.5.0)", () => {
    // `commandShapes` (@vtc/shared) keeps the word after the program only for the programs in
    // COMMAND_SHAPE_SUBCOMMAND_PROGRAMS (spine §5 reading 228, amending 221(1))
    expect(shellCallShapes("echo hunter2")).toEqual([shape("echo")]);
    expect(shellCallShapes("cd work/secret-project && cat secrets")).toEqual([
      shape("cd"),
      shape("cat"),
    ]);
    expect(shellCallShapes("git status")).toEqual([shape("git", "status")]);
    // a path, an upper-case or quoted word, or anything with a dot or slash is never kept
    expect(shellCallShapes("cat ./secrets 'hunter2' Hunter2 api.example.com")).toEqual([
      shape("cat"),
    ]);
  });

  it("gives no shape for anything that is not a command", () => {
    for (const value of [undefined, null, 42, {}, ["git", 1], "", "   "]) {
      expect(shellCallShapes(value)).toEqual([]);
    }
  });
});

describe("Claude parseEvents: Bash tool_use → commandShapes (D-cs)", () => {
  const lines = fixtureLines("claude-code/stream-bash-calls.synthetic.jsonl");

  it("records each Bash call's shapes in order, a subagent's too, each block once, and no other tool", () => {
    const shapes = claude.parseEvents(lines).commandShapes;
    expect(shapes).toEqual([
      shape("cd"),
      shape("git", "status", "--porcelain"),
      shape("gh", "pr", "--repo", "--limit"),
      shape("curl", undefined, "-sS", "-H"),
      shape("jq"),
      shape("<path>", undefined, "--env", "--password"),
    ]);
  });

  it("keeps no argument value, path or secret of any command", () => {
    const shapes = claude.parseEvents(lines).commandShapes ?? [];
    expectNothingRaw(shapes);
  });

  it("grows as the stream grows (the engine re-reads the lines seen so far)", () => {
    expect(claude.parseEvents(lines.slice(0, 2)).commandShapes).toEqual([
      shape("cd"),
      shape("git", "status", "--porcelain"),
    ]);
    expect(claude.parseEvents([]).commandShapes).toEqual([]);
  });

  it("records nothing for the recorded runs, which made no Bash call", () => {
    const recorded = readdirSync(new URL("./fixtures/claude-code/", import.meta.url)).filter(
      (name) => name.endsWith(".jsonl") && !name.includes(".synthetic."),
    );
    expect(recorded.length).toBeGreaterThan(3);
    for (const name of recorded) {
      expect(claude.parseEvents(fixtureLines(`claude-code/${name}`)).commandShapes, name).toEqual(
        [],
      );
    }
    expect(
      claude.parseEvents(fixtureLines("claude-code/stream-killed.synthetic.jsonl")).commandShapes,
    ).toEqual([shape("pnpm", "test")]);
  });
});

describe("Codex parseEvents: command_execution → commandShapes (D-cs)", () => {
  const lines = fixtureLines("codex/exec-command-execution.synthetic.jsonl");

  it("records each command_execution item once (started, updated and completed are one call), unwrapping the shell", () => {
    expect(codex.parseEvents(lines).commandShapes).toEqual([
      // the documented sample, `bash -lc ls`
      shape("ls"),
      shape("cd"),
      shape("pnpm", undefined, "--filter", "--reporter"),
      // an argv array, joined with spaces
      shape("git", undefined, "-C", "-m"),
      shape("npm", "run", "--silent"),
    ]);
  });

  it("keeps no argument value, path or secret of any command", () => {
    expectNothingRaw(codex.parseEvents(lines).commandShapes ?? []);
  });

  it("counts a call still running (item.started only) at once, and an id-less item on completion only", () => {
    const started = lines.slice(0, 3);
    expect(codex.parseEvents(started).commandShapes).toEqual([shape("ls")]);
    const noId = { type: "command_execution", command: "make test" };
    expect(
      codex.parseEvents([
        JSON.stringify({ type: "item.started", item: noId }),
        JSON.stringify({ type: "item.completed", item: noId }),
      ]).commandShapes,
    ).toEqual([shape("make")]);
  });

  it("records nothing for the recorded runs, which ran no shell command", () => {
    const recorded = readdirSync(new URL("./fixtures/codex/", import.meta.url)).filter(
      (name) => name.endsWith(".jsonl") && !name.includes(".synthetic."),
    );
    expect(recorded.length).toBeGreaterThan(3);
    for (const name of recorded) {
      expect(codex.parseEvents(fixtureLines(`codex/${name}`)).commandShapes, name).toEqual([]);
    }
  });
});
