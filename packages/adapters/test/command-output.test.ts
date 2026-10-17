/** Short host commands whose whole output the adapter reads (`src/common/command-output.ts`). */
import { describe, expect, it } from "vitest";
import { createCommandOutputRunner } from "../src/common/command-output.js";
import { fakeSpawner } from "./support/fake-spawner.js";

const COMMAND = { command: "codex", args: ["mcp", "list", "--json"], env: {} };

describe("createCommandOutputRunner", () => {
  it("returns the exit code and both streams, run in the given cwd with stdin closed", async () => {
    const { spawner, processes } = fakeSpawner((p) => {
      p.emit("[]");
      p.writeStderr("note\n");
      p.exit(3);
    });
    const runner = createCommandOutputRunner({ spawner, timeoutMs: 1000, maxChars: 100 });
    expect(await runner.run(COMMAND, "/work")).toEqual({
      kind: "exited",
      code: 3,
      stdout: "[]\n",
      stderr: "note\n",
      truncated: false,
    });
    expect(processes[0]!.options).toEqual({ cwd: "/work", stdin: "closed" });
  });

  it("keeps at most maxChars of a stream and says it cut the rest", async () => {
    const { spawner } = fakeSpawner((p) => {
      p.emit("x".repeat(30));
      p.exit(0);
    });
    const runner = createCommandOutputRunner({ spawner, timeoutMs: 1000, maxChars: 10 });
    const output = await runner.run(COMMAND, "/work");
    expect(output).toMatchObject({ kind: "exited", stdout: "x".repeat(10), truncated: true });
  });

  it("a command that cannot start, is killed by the timeout or by dispose() has failed", async () => {
    const failing = fakeSpawner((p) => {
      p.failToStart(new Error("ENOENT"));
    });
    expect(
      await createCommandOutputRunner({
        spawner: failing.spawner,
        timeoutMs: 1000,
        maxChars: 10,
      }).run(COMMAND, "/work"),
    ).toEqual({ kind: "failed" });
    const throwing = createCommandOutputRunner({
      spawner: () => {
        throw new Error("spawn failed");
      },
      timeoutMs: 1000,
      maxChars: 10,
    });
    expect(await throwing.run(COMMAND, "/work")).toEqual({ kind: "failed" });
    const hanging = fakeSpawner();
    const timed = createCommandOutputRunner({
      spawner: hanging.spawner,
      timeoutMs: 10,
      maxChars: 10,
    });
    expect(await timed.run(COMMAND, "/work")).toEqual({ kind: "failed", timedOut: true });
    expect(hanging.processes[0]!.signals).toEqual(["SIGKILL"]);
    const stopped = fakeSpawner();
    const disposed = createCommandOutputRunner({
      spawner: stopped.spawner,
      timeoutMs: 60_000,
      maxChars: 10,
    });
    const pending = disposed.run(COMMAND, "/work");
    disposed.dispose();
    expect(await pending).toEqual({ kind: "failed" });
  });
});
