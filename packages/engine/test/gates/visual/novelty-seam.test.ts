/**
 * The novelty check's seam on the Gate Runner (spine §5 reading 127, contracts 4.6.0):
 * `GateRunner.checkNovelty` reads the direction's first viewport from the repo and the project's
 * tokens, and compares them with the design library of the request's `ResearchScope`;
 * `recordDesignChoice` adds the chosen direction to that scope's library.
 */
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { constants, deflateRawSync, inflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { DESIGN_LIBRARY_DIR, NoveltyReportSchema, type DesignLibraryEntry } from "@vtc/shared";
import { createGitOps } from "../../../src/git/index.js";
import { createGateRunnerWith } from "../../../src/gates/index.js";
import { dhash, tokenVector } from "../../../src/gates/visual/novelty.js";
import { encodePng, type RgbaImage } from "../../../src/gates/visual/png.js";
import { parseDesignTokens } from "../../../src/gates/visual/tokens.js";
import { cleanupDirs, tempDir, writeFile } from "../../helpers/repo.js";

afterEach(cleanupDirs);

/**
 * A zlib stream of `size` zero bytes (a multiple of 1 MiB), built without deflating them (D-cz:
 * deflating 256 MiB took seconds of one core and 256 MiB of memory on every run): one MiB of
 * zeros deflated to a byte-aligned, non-final block run, repeated (its back-references only reach
 * zeros, so each copy inflates alike), then an empty final block and the Adler-32 of the zeros.
 */
const zeroStream = (size: number): Buffer => {
  const mib = 1024 * 1024;
  const block = deflateRawSync(Buffer.alloc(mib), { finishFlush: constants.Z_SYNC_FLUSH });
  const adler = Buffer.alloc(4);
  adler.writeUInt32BE((((size % 65521) << 16) | 1) >>> 0);
  return Buffer.concat([
    Buffer.from([0x78, 0x9c]),
    ...Array.from({ length: size / mib }, () => block),
    Buffer.from([0x03, 0x00]),
    adler,
  ]);
};

const gradient = (flip: boolean): RgbaImage => {
  const width = 90;
  const height = 80;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const v = Math.round(((flip ? width - 1 - x : x) / (width - 1)) * 255);
      data.set([v, v, v, 255], (y * width + x) * 4);
    }
  }
  return { width, height, data };
};

const TOKENS = JSON.stringify({
  color: { $type: "color", bg: { $value: "#f5efe6" }, accent: { $value: "#c2410c" } },
  font: {
    heading: { $type: "fontFamily", $value: "Fraunces" },
    body: { $type: "fontFamily", $value: "Inter" },
  },
  radius: { $type: "dimension", m: { $value: "12px" } },
});
const VIEWPORT = ".vtc/design/prototype/directions/warm/first-viewport.png";

const setup = () => {
  const repo = tempDir("vtc-repo-");
  const home = tempDir("vtc-home-");
  mkdirSync(join(repo, ".vtc/design/prototype/directions/warm"), { recursive: true });
  writeFileSync(join(repo, VIEWPORT), encodePng(gradient(false)));
  writeFile(repo, ".vtc/design/tokens.json", TOKENS);
  const runner = createGateRunnerWith(
    { repoRoot: repo, vtcHome: home, git: createGitOps({ repoRoot: repo }) },
    { detectSandbox: () => null },
  );
  const entry: DesignLibraryEntry = {
    v: 1,
    id: "acme-billing",
    project_key: "0123456789abcdef",
    direction: "warm",
    phash: dhash(gradient(false)),
    token_vector: tokenVector(parseDesignTokens(TOKENS)),
    chosen_at: "2026-10-01T00:00:00.000Z",
  };
  return { repo, home, runner, entry };
};

describe("GateRunner.checkNovelty / recordDesignChoice", () => {
  it("implements both optional methods", () => {
    const { runner } = setup();
    expect(typeof runner.checkNovelty).toBe("function");
    expect(typeof runner.recordDesignChoice).toBe("function");
  });

  it("is novel against an empty library and too_similar once the same direction is recorded", async () => {
    const { runner, entry } = setup();
    const request = { direction: "warm", firstViewport: VIEWPORT, scope: "client-acme" };
    const first = await runner.checkNovelty!(request);
    expect(NoveltyReportSchema.parse(first)).toEqual(first);
    expect(first.verdict).toBe("novel");
    expect(first.direction).toBe("warm");
    expect(first.phash).toBe(entry.phash);
    expect(first.token_vector).toEqual(entry.token_vector);

    await runner.recordDesignChoice!(entry, "client-acme");
    const second = await runner.checkNovelty!(request);
    expect(second.verdict).toBe("too_similar");
    expect(second.nearest[0]).toEqual({
      entry: "acme-billing",
      phash_distance: 0,
      token_distance: 0,
    });
  });

  it("never compares across scopes", async () => {
    const { runner, entry } = setup();
    await runner.recordDesignChoice!(entry, "client-acme");
    const shared = await runner.checkNovelty!({
      direction: "warm",
      firstViewport: VIEWPORT,
      scope: "_shared",
    });
    expect(shared.verdict).toBe("novel");
    expect(shared.nearest).toEqual([]);
  });

  it("records into the scope's own directory, `_shared` included", async () => {
    const { runner, entry, home } = setup();
    await runner.recordDesignChoice!(entry, "_shared");
    expect(existsSync(join(home, DESIGN_LIBRARY_DIR, "_shared", "acme-billing.json"))).toBe(true);
  });

  it("is unchecked when the first viewport is missing, outside the repo or behind a symlink", async () => {
    const { runner, repo } = setup();
    const outside = tempDir("vtc-outside-");
    writeFileSync(join(outside, "x.png"), encodePng(gradient(false)));
    symlinkSync(join(outside, "x.png"), join(repo, ".vtc/design/link.png"));
    for (const firstViewport of [".vtc/design/missing.png", "../x.png", ".vtc/design/link.png"]) {
      const report = await runner.checkNovelty!({
        direction: "warm",
        firstViewport,
        scope: "_shared",
      });
      expect(report.verdict, firstViewport).toBe("unchecked");
    }
  });

  it("builds the bomb's zlib stream cheaply, and it inflates to every byte it claims", () => {
    expect(inflateSync(zeroStream(3 * 1024 * 1024)).equals(Buffer.alloc(3 * 1024 * 1024))).toBe(
      true,
    );
  });

  it("is unchecked, without inflating it, when the first viewport is a decompression bomb", async () => {
    const { runner, repo } = setup();
    // A valid 1x1 RGBA PNG header whose IDAT inflates to 256 MiB: a few hundred KiB on disk.
    const header = encodePng({ width: 1, height: 1, data: new Uint8Array(4) });
    const ihdrEnd = 8 + 12 + 13;
    const idat = zeroStream(256 * 1024 * 1024);
    const chunk = new Uint8Array(12 + idat.length);
    new DataView(chunk.buffer).setUint32(0, idat.length);
    chunk.set([73, 68, 65, 84], 4);
    chunk.set(idat, 8);
    const iend = header.subarray(header.length - 12);
    writeFileSync(join(repo, VIEWPORT), Buffer.concat([header.subarray(0, ihdrEnd), chunk, iend]));
    const before = process.memoryUsage().arrayBuffers;
    const report = await runner.checkNovelty!({
      direction: "warm",
      firstViewport: VIEWPORT,
      scope: "_shared",
    });
    expect(report.verdict).toBe("unchecked");
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(64 * 1024 * 1024);
  });

  it("is unchecked, without blocking, when the first viewport is a FIFO", async () => {
    const { runner, repo } = setup();
    const fifo = ".vtc/design/fifo.png";
    execFileSync("mkfifo", [join(repo, fifo)]);
    const report = await runner.checkNovelty!({
      direction: "warm",
      firstViewport: fifo,
      scope: "_shared",
    });
    expect(report.verdict).toBe("unchecked");
  });

  it("still hashes the viewport when the project has no tokens yet", async () => {
    const { runner, repo } = setup();
    const { rmSync } = await import("node:fs");
    rmSync(join(repo, ".vtc/design/tokens.json"));
    const report = await runner.checkNovelty!({
      direction: "warm",
      firstViewport: VIEWPORT,
      scope: "_shared",
    });
    expect(report.verdict).toBe("novel");
  });

  it("rejects a malformed direction, scope or entry", async () => {
    const { runner, entry } = setup();
    await expect(
      runner.checkNovelty!({ direction: "../x", firstViewport: VIEWPORT, scope: "_shared" }),
    ).rejects.toThrow();
    await expect(
      runner.checkNovelty!({ direction: "warm", firstViewport: VIEWPORT, scope: "../escape" }),
    ).rejects.toThrow();
    await expect(runner.recordDesignChoice!(entry, "acme")).rejects.toThrow();
    await expect(
      runner.recordDesignChoice!({ ...entry, phash: "nope" }, "client-acme"),
    ).rejects.toThrow();
  });
});
