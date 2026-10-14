import { describe, expect, it } from "vitest";
import { NoveltyReportSchema } from "@vtc/shared";
import {
  checkNovelty,
  dhash,
  hammingDistance,
  readDesignLibrary,
  recordDesignChoice,
  tokenDistance,
  tokenVector,
  TOKEN_VECTOR_LENGTH,
} from "../../../src/gates/visual/novelty.js";
import { encodePng, type RgbaImage } from "../../../src/gates/visual/png.js";
import { parseDesignTokens } from "../../../src/gates/visual/tokens.js";
import { tempDir } from "../../helpers/repo.js";

/** A 90×80 image: a horizontal gradient, optionally flipped, with a dark block. */
const image = (flip: boolean, block = false): RgbaImage => {
  const width = 90;
  const height = 80;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let v = Math.round(((flip ? width - 1 - x : x) / (width - 1)) * 255);
      if (block && x > 10 && x < 40 && y > 10 && y < 40) v = 0;
      data.set([v, v, v, 255], (y * width + x) * 4);
    }
  }
  return { width, height, data };
};

const warm = parseDesignTokens(
  JSON.stringify({
    color: { $type: "color", bg: { $value: "#f5efe6" }, accent: { $value: "#c2410c" } },
    font: {
      heading: { $type: "fontFamily", $value: "Fraunces" },
      body: { $type: "fontFamily", $value: "Inter" },
    },
    radius: { $type: "dimension", m: { $value: "12px" } },
    space: { $type: "dimension", m: { $value: "16px" } },
  }),
);
const cold = parseDesignTokens(
  JSON.stringify({
    color: { $type: "color", bg: { $value: "#0b1020" }, accent: { $value: "#22d3ee" } },
    font: {
      heading: { $type: "fontFamily", $value: "Söhne Breit" },
      body: { $type: "fontFamily", $value: "Söhne" },
    },
    radius: { $type: "dimension", m: { $value: "2px" } },
    space: { $type: "dimension", m: { $value: "8px" } },
  }),
);

describe("perceptual hash", () => {
  it("is stable for one image and far for a mirrored one", () => {
    const a = dhash(image(false));
    expect(a).toMatch(/^[a-f0-9]{16}$/);
    expect(dhash(image(false))).toBe(a);
    expect(hammingDistance(a, a)).toBe(0);
    expect(hammingDistance(a, dhash(image(true)))).toBeGreaterThan(40);
    expect(hammingDistance(a, dhash(image(false, true)))).toBeLessThan(20);
  });
});

describe("token vector", () => {
  it("has a fixed length and separates different token sets", () => {
    const v = tokenVector(warm);
    expect(v).toHaveLength(TOKEN_VECTOR_LENGTH);
    expect(tokenDistance(v, tokenVector(warm))).toBe(0);
    expect(tokenDistance(v, tokenVector(cold))).toBeGreaterThan(0.25);
  });
});

describe("checkNovelty", () => {
  const png = encodePng(image(false));
  const entry = {
    v: 1 as const,
    id: "acme-billing",
    project_key: "abc123",
    direction: "warm-editorial",
    phash: dhash(image(false)),
    token_vector: tokenVector(warm),
    chosen_at: "2026-10-01T00:00:00.000Z",
  };

  it("is too_similar only when both the hash and the tokens are close", () => {
    const same = checkNovelty({
      direction: "a",
      firstViewport: png,
      tokens: warm,
      library: [entry],
    });
    expect(NoveltyReportSchema.parse(same)).toEqual(same);
    expect(same.verdict).toBe("too_similar");
    expect(same.nearest[0]).toEqual({
      entry: "acme-billing",
      phash_distance: 0,
      token_distance: 0,
    });
    const newTokens = checkNovelty({
      direction: "b",
      firstViewport: png,
      tokens: cold,
      library: [entry],
    });
    expect(newTokens.verdict).toBe("novel");
    const newLayout = checkNovelty({
      direction: "c",
      firstViewport: encodePng(image(true)),
      tokens: warm,
      library: [entry],
    });
    expect(newLayout.verdict).toBe("novel");
    expect(
      checkNovelty({ direction: "d", firstViewport: png, tokens: warm, library: [] }).verdict,
    ).toBe("novel");
  });

  it("judges every library entry, not only the ten nearest by combined score", () => {
    // Ten decoys a bit off in layout with the same tokens (score 1, not under the hash threshold)
    // rank before one entry under both thresholds (score 64 × the token distance).
    const flip = (hex: string, bit: number): string => {
      const value = BigInt(`0x${hex}`) ^ (1n << BigInt(bit));
      return value.toString(16).padStart(16, "0");
    };
    const decoys = Array.from({ length: 10 }, (_, i) => ({
      ...entry,
      id: `decoy-${String(i)}`,
      phash: flip(entry.phash, i),
      token_vector: tokenVector(cold),
    }));
    const similar = { ...entry, id: "similar", token_vector: tokenVector(warm) };
    const thresholds = { phash_distance: 1, token_distance: 10 };
    const report = checkNovelty({
      direction: "a",
      firstViewport: png,
      tokens: cold,
      library: [...decoys, similar],
      thresholds,
    });
    expect(report.verdict).toBe("too_similar");
    expect(report.nearest).toHaveLength(10);
    expect(report.nearest[0]?.entry).toBe("similar");
  });

  it("is unchecked without a readable first viewport", () => {
    const r = checkNovelty({ direction: "a", firstViewport: null, tokens: warm, library: [entry] });
    expect(r.verdict).toBe("unchecked");
    expect(
      checkNovelty({
        direction: "a",
        firstViewport: new Uint8Array([1]),
        tokens: warm,
        library: [],
      }).verdict,
    ).toBe("unchecked");
  });

  it("records chosen directions per client scope and reads them back", () => {
    const home = tempDir("vtc-home-");
    expect(readDesignLibrary(home, "acme")).toEqual([]);
    recordDesignChoice(home, "acme", entry);
    expect(readDesignLibrary(home, "acme")).toEqual([entry]);
    expect(readDesignLibrary(home, "other")).toEqual([]);
    expect(() => recordDesignChoice(home, "../escape", entry)).toThrow();
  });
});
