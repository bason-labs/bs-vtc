/**
 * Running short-lived tools (`process.ts`): on Windows (a spec target, §4.4) npm installs the host
 * CLIs as `.cmd` shims, which only `cmd.exe` can run; they run through `cmd /d /s /c` with
 * arguments that hold no shell metacharacter, and anything else is spawned without a shell.
 */
import { describe, expect, it } from "vitest";
import { exec, windowsInvocation } from "../src/process.js";

const env = {
  Path: "C:\\Windows\\system32;C:\\Users\\u\\AppData\\Roaming\\npm",
  PATHEXT: ".COM;.EXE;.BAT;.CMD",
  ComSpec: "C:\\Windows\\system32\\cmd.exe",
};
const onDisk =
  (...files: string[]) =>
  (path: string): boolean =>
    files.includes(path);

describe("windowsInvocation", () => {
  it("finds an npm .cmd shim on PATH and runs it through cmd.exe with checked arguments", () => {
    const shim = "C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd";
    expect(windowsInvocation("claude", ["auth", "status", "--json"], env, onDisk(shim))).toEqual({
      file: "C:\\Windows\\system32\\cmd.exe",
      args: ["/d", "/s", "/c", `""${shim}" auth status --json"`],
      verbatim: true,
    });
  });

  it("spawns an .exe directly, and a name it cannot find as is", () => {
    const git = "C:\\Windows\\system32\\git.exe";
    expect(windowsInvocation("git", ["--version"], env, onDisk(git))).toEqual({
      file: git,
      args: ["--version"],
      verbatim: false,
    });
    expect(windowsInvocation("gh", ["--version"], env, onDisk())).toEqual({
      file: "gh",
      args: ["--version"],
      verbatim: false,
    });
  });

  it("refuses to hand cmd.exe an argument it would interpret", () => {
    const shim = "C:\\Users\\u\\AppData\\Roaming\\npm\\codex.cmd";
    for (const arg of ["%PATH%", "a&b", "a|b", "x y", '"q"', "a^b", "!x!", "<in"])
      expect(windowsInvocation("codex", [arg], env, onDisk(shim))).toHaveProperty("error");
    expect(windowsInvocation("codex", ["login", "status"], env, onDisk(shim))).toHaveProperty(
      "verbatim",
      true,
    );
  });
});

describe("exec's environment", () => {
  it.skipIf(process.platform === "win32")(
    "inherits by default, and passes only env with inheritEnv false",
    async () => {
      process.env.VTC_TEST_INHERITED = "yes";
      try {
        const script =
          "process.stdout.write(JSON.stringify([process.env.VTC_TEST_INHERITED ?? null, process.env.ONLY ?? null]))";
        const inherited = await exec(process.execPath, ["-e", script], { env: { ONLY: "1" } });
        expect(JSON.parse(inherited.stdout)).toEqual(["yes", "1"]);
        const alone = await exec(process.execPath, ["-e", script], {
          env: { ONLY: "1" },
          inheritEnv: false,
        });
        expect(JSON.parse(alone.stdout)).toEqual([null, "1"]);
      } finally {
        delete process.env.VTC_TEST_INHERITED;
      }
    },
  );
});
