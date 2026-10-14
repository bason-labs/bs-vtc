/*
 * Derived from impeccable (https://github.com/pbakaus/impeccable) at
 * 2f98774f86bc05563876643db37e6c37c322850f, crates/live/assets/antipatterns.json.
 * Copyright 2025 Paul Bakaus. Licensed under the Apache License, Version 2.0
 * (THIRD_PARTY/impeccable/LICENSE). Modified by VTC: rule ids renamed to `vtc-design/<id>`,
 * descriptions rewritten, and the catalog reduced to the source-level rules VTC ports.
 */

/**
 * The design detector's rules (§9.1 "the forked detector runs in the deterministic lint layer";
 * AD-24 rule 7). Each is a slop rule: its findings carry `vtc-design/<id>` and route to the
 * Designer (`routeForFinding`). `advisory` rules report with SARIF level `note` and never fail
 * the visual step on their own. `derivedFrom` names the upstream rule each one ports.
 */
export interface DetectorRule {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly advisory: boolean;
  readonly derivedFrom: string;
}

const rule = (id: string, name: string, description: string, advisory = false): DetectorRule => ({
  id,
  name,
  description,
  advisory,
  derivedFrom: `impeccable:${id}`,
});

export const DETECTOR_RULES: readonly DetectorRule[] = [
  rule(
    "side-tab",
    "Side-stripe accent border",
    "A thick coloured border on one side of a card is a common generated-UI tell. Use a subtler accent or none.",
  ),
  rule(
    "border-accent-on-rounded",
    "Accent border on a rounded element",
    "A thick top or bottom accent border fights the rounded corners of the same element. Drop the border or the radius.",
  ),
  rule(
    "overused-font",
    "Overused font",
    "This face is used by so many generated interfaces that it no longer says anything about the product. Choose a face from the product's own world.",
  ),
  rule(
    "gradient-text",
    "Gradient text",
    "Gradient-filled text is decoration, not meaning, especially on headings and figures. Use a solid colour.",
  ),
  rule(
    "ai-color-palette",
    "Default generated palette",
    "Purple, violet or indigo headings and purple-to-blue gradients are the default generated look. Derive the palette from the product.",
  ),
  rule(
    "bounce-easing",
    "Bounce or elastic easing",
    "Bounce and elastic easing feel dated; real objects decelerate smoothly. Use an exponential ease-out.",
  ),
  rule(
    "monotonous-spacing",
    "Monotonous spacing",
    "One spacing value used almost everywhere leaves no rhythm. Group related items tightly and separate sections generously.",
    true,
  ),
  rule(
    "em-dash-overuse",
    "Em-dash saturation",
    "Many em-dashes at a high density read as a generated cadence. Advisory: people use em-dashes too.",
    true,
  ),
  rule(
    "marketing-buzzword",
    "Marketing buzzword",
    "Generic marketing phrases say nothing about what the product does. Name the specific action and object.",
  ),
  rule(
    "aphoristic-cadence",
    "Aphoristic cadence",
    'Three or more short rebuttals ("X. No Y.", "Not a feature. A platform.") read as a generated cadence, not a voice.',
    true,
  ),
  rule(
    "marquee",
    "Auto-scrolling marquee",
    "Continuously scrolling content demands attention it has not earned and hides half of itself. Let readers move at their own pace.",
  ),
  rule(
    "theater-slop-phrase",
    "Theater framing copy",
    'Dismissing something as "theater" is a recurring generated-copy habit. Say plainly what the thing does or does not do.',
  ),
];

export const detectorRule = (id: string): DetectorRule | undefined =>
  DETECTOR_RULES.find((r) => r.id === id);
