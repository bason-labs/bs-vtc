/**
 * What the engine decides for a pack instead of a model (§6.2, §8.3, §9.1 step 2: variation comes
 * from code, not the model): the Architect's depth, DISCOVER's research depth, and the Designer's
 * constraints, dealt by a local RNG seeded by project and run (no network, no telemetry), so a
 * re-dispatch of the same direction gets the same deal.
 */
import { createHash } from "node:crypto";
import {
  engineRepoKey,
  type ArchitectDepth,
  type ColourStrategy,
  type DesignConstraints,
  type ResearchDepth,
  type Track,
} from "@vtc/shared";

/**
 * §8.3 depth L triggers in the spec's text: PII, payments, regulated data, ≥99.9% availability,
 * several integrations or teams, a large codebase.
 */
const DEPTH_L =
  /\b(PII|personal data|personally identifiable|payments?|card data|PCI|HIPAA|GDPR|regulated|99\.9\d*\s*%|multiple teams|integrations?\b.*\b(three|four|five|[3-9])\b)/i;

/**
 * The Architect's depth (§8.3), from the spec's attributes, bounded by the track (§6.2): quick
 * fix S; feature S/M; new project M/L. `M` is the default; a spec with at most one requirement
 * is S on the feature track.
 */
export const architectDepth = (
  track: Track,
  spec: string,
  requirements: number,
): ArchitectDepth => {
  if (track === "quick_fix") return "S";
  const wanted: ArchitectDepth = DEPTH_L.test(spec) ? "L" : requirements <= 1 ? "S" : "M";
  if (track === "feature") return wanted === "L" ? "M" : wanted;
  return wanted === "S" ? "M" : wanted;
};

/** DISCOVER's research depth (§6.2): light for a feature, full for a new project. */
export const researchDepth = (track: Track): ResearchDepth =>
  track === "new_project" ? "full" : "light";

/** The curated pools the lottery deals from (§9.1 step 2). */
export const LOTTERY_POOLS = {
  colour_strategy: [
    "restrained",
    "committed",
    "full",
    "drenched",
  ] as const satisfies readonly ColourStrategy[],
  type_pairing: [
    "grotesque display + humanist text",
    "high-contrast serif display + neutral sans text",
    "geometric sans throughout, two weights",
    "slab serif headings + grotesque text",
    "monospace accents + humanist sans text",
    "condensed sans display + book serif text",
  ],
  density_grid: [
    "airy, 12-column, wide gutters",
    "dense, 8-pt baseline, compact tables",
    "editorial, asymmetric 5-column",
    "single column, generous measure",
    "modular cards on a 4-column grid",
  ],
  radius_elevation: [
    "square corners, flat, hairline borders",
    "small radius, one soft elevation",
    "large radius, layered elevation",
    "pill controls, no shadows",
  ],
  motion: [
    "still: state changes only",
    "quick functional fades (≤150 ms)",
    "spring transitions on navigation",
    "staggered reveals on first view",
  ],
  signature_interaction: [
    "inline editing in place",
    "command palette",
    "drag to reorder",
    "progressive disclosure on hover",
    "split view with live preview",
    "keyboard-first navigation",
  ],
} as const;

/** A deterministic RNG over SHA-256 of the seed and a counter (uniform in [0, 1)). */
const seeded = (seed: string): (() => number) => {
  let counter = 0;
  return () => {
    const digest = createHash("sha256")
      .update(`${seed}:${String(counter)}`)
      .digest();
    counter += 1;
    return digest.readUInt32BE(0) / 2 ** 32;
  };
};

const pick = <T>(random: () => number, pool: readonly T[]): T =>
  pool[Math.floor(random() * pool.length)] as T;

/** The constraints of one Designer direction, seeded by project (repo) and run (§9.1 step 2). */
export const dealDesignConstraints = (
  repoRoot: string,
  run: string,
  direction: number,
): DesignConstraints => {
  const random = seeded(`${engineRepoKey(repoRoot)}:${run}:${String(direction)}`);
  return {
    colour_strategy: pick(random, LOTTERY_POOLS.colour_strategy),
    type_pairing: pick(random, LOTTERY_POOLS.type_pairing),
    density_grid: pick(random, LOTTERY_POOLS.density_grid),
    radius_elevation: pick(random, LOTTERY_POOLS.radius_elevation),
    motion: pick(random, LOTTERY_POOLS.motion),
    signature_interaction: pick(random, LOTTERY_POOLS.signature_interaction),
  };
};
