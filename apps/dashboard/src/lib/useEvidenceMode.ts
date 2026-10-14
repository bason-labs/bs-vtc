"use client";

import { useSyncExternalStore } from "react";
import { evidenceModeOf, type EvidenceMode } from "./evidence-mode";
import { subscribeLocation } from "./router";

const snapshot = (): EvidenceMode => evidenceModeOf(window.location.search);
const serverSnapshot = (): EvidenceMode => "off";

/** The evidence mode of the current address (`?evidence=1|upstream`), `off` in the prerender. */
export function useEvidenceMode(): EvidenceMode {
  return useSyncExternalStore(subscribeLocation, snapshot, serverSnapshot);
}
