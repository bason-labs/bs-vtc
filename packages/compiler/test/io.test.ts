import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { COMPILE_TARGETS, compilePlugins, readSources, writeTargets } from "../src/index.js";
import { FIXTURE } from "./fixtures.js";

const temps: string[] = [];
const tempRoot = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "vtc-compiler-"));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const plant = (root: string, files: Readonly<Record<string, string>>): void => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
};

describe("readSources", () => {
  it("reads roles/, skills/ and plugins/ as sorted POSIX paths and skips OS litter", () => {
    const root = tempRoot();
    plant(root, { ...FIXTURE, "roles/.DS_Store": "x", "docs/ignored.md": "x" });
    const read = readSources(root);
    expect(read.files.map((f) => f.path)).toEqual(Object.keys(FIXTURE).sort());
    expect(read.errors).toEqual([]);
  });

  it("never follows a symbolic link and reports it", () => {
    const root = tempRoot();
    const outside = tempRoot();
    plant(root, FIXTURE);
    plant(outside, { "secret.txt": "outside the repo\n", "dir/x.md": "x\n" });
    symlinkSync(join(outside, "secret.txt"), join(root, "skills/stack-react-next/leak.md"));
    symlinkSync(join(outside, "dir"), join(root, "skills/stack-react-next/linked"));
    symlinkSync(join(root, "skills"), join(root, "skills/loop"));
    const read = readSources(root);
    expect(read.files.map((f) => f.path)).toEqual(Object.keys(FIXTURE).sort());
    expect(read.files.some((f) => f.text.includes("outside the repo"))).toBe(false);
    expect(read.errors.map((e) => e.path).sort()).toEqual([
      "skills/loop",
      "skills/stack-react-next/leak.md",
      "skills/stack-react-next/linked",
    ]);
    expect(read.errors[0]?.message).toContain("symbolic links are not compiled");
  });

  it("reports a file that is not UTF-8 text instead of re-encoding it", () => {
    const root = tempRoot();
    plant(root, FIXTURE);
    writeFileSync(join(root, "skills/stack-react-next/logo.png"), Buffer.from([0x89, 0xff, 0xfe]));
    expect(readSources(root).errors).toEqual([
      {
        path: "skills/stack-react-next/logo.png",
        message: "not UTF-8 text; sources are text files",
      },
    ]);
  });
});

describe("writeTargets", () => {
  it("writes both plugin trees under dist/ and removes stale files", () => {
    const root = tempRoot();
    plant(root, FIXTURE);
    plant(root, { [`${COMPILE_TARGETS["claude-code"]}/agents/stale.md`]: "old" });
    const result = compilePlugins(readSources(root).files);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    const written = writeTargets(result.output, root);
    expect(existsSync(join(root, COMPILE_TARGETS["claude-code"], "agents/stale.md"))).toBe(false);
    expect(
      readFileSync(join(root, COMPILE_TARGETS.codex, "agents/vtc-qa-judge.toml"), "utf8"),
    ).toContain('name = "vtc-qa-judge"');
    expect(written).toContain(`${COMPILE_TARGETS["claude-code"]}/.mcp.json`);
  });

  it("refuses to write outside a target directory and writes nothing then", () => {
    const root = tempRoot();
    plant(root, FIXTURE);
    const result = compilePlugins(readSources(root).files);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    const escaping = {
      targets: {
        ...result.output.targets,
        codex: [...result.output.targets.codex, { path: "../../escaped.txt", text: "x" }],
      },
    };
    expect(() => writeTargets(escaping, root)).toThrow(/outside dist\/codex-plugin/);
    expect(existsSync(join(root, "escaped.txt"))).toBe(false);
    expect(existsSync(join(root, COMPILE_TARGETS["claude-code"]))).toBe(false);
  });
});
