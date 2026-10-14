"use client";

import { ENGINE_HTTP } from "@vtc/shared";
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { pinPosition, type DesignPin } from "@/lib/design";
import { cn } from "@/lib/cn";
import { useEvidenceMode } from "@/lib/useEvidenceMode";

export interface DraftPin {
  readonly x_pct: number;
  readonly y_pct: number;
}

export interface PrototypeFrameProps {
  readonly src: string;
  readonly title: string;
  readonly width: number;
  readonly height: number;
  readonly pins: readonly DesignPin[];
  readonly draft: DraftPin | null;
  /** Pin mode: a click on the frame places the draft pin instead of reaching the prototype. */
  readonly placing: boolean;
  readonly onPlace: (pin: DraftPin) => void;
}

/** Measures the width available to the frame, so a wide viewport is scaled down to fit. */
function useAvailableWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(() => {
      setWidth(el.clientWidth);
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, []);
  return { ref, width };
}

const marker =
  "absolute grid size-6 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full text-[11px] font-semibold text-white shadow-glow ring-2 ring-white tabular";

/**
 * The Designer's prototype (spec §17) from its own loopback origin (AD-5 rule 9), only ever in
 * `<iframe sandbox="allow-scripts">` (`ENGINE_HTTP.prototype.iframeSandbox`, never
 * `allow-same-origin`): agent-written HTML runs with an opaque origin and cannot reach this page.
 * The frame renders at the chosen viewport width and is scaled to fit; pins sit on top of it at
 * percentages of the frame, so they line up at any scale. Evidence mode loads no prototype (no
 * request outside the page's origin, AD-27 rule 6).
 */
export function PrototypeFrame({
  src,
  title,
  width,
  height,
  pins,
  draft,
  placing,
  onPlace,
}: PrototypeFrameProps) {
  const { ref, width: available } = useAvailableWidth();
  // Evidence mode: no request leaves the page's own origin, so the prototype is not loaded.
  const evidence = useEvidenceMode() !== "off";
  const scale = available > 0 ? Math.min(1, available / width) : 1;
  const place = (event: MouseEvent<HTMLButtonElement>) => {
    // A keyboard press (detail 0) has no point: start in the middle; the form can move it.
    if (event.detail === 0) {
      onPlace({ x_pct: 50, y_pct: 50 });
      return;
    }
    onPlace(pinPosition(event.currentTarget.getBoundingClientRect(), event.clientX, event.clientY));
  };
  return (
    <div ref={ref} className="w-full">
      <div
        className="relative mx-auto overflow-hidden rounded-2xl border border-border bg-surface-2"
        style={{ width: width * scale, height: height * scale }}
      >
        {evidence ? (
          <p
            className="grid h-full place-items-center p-4 text-center text-xs text-muted-fg"
            data-testid="prototype-not-loaded"
          >
            The prototype runs on its own origin, so evidence mode does not load it.
          </p>
        ) : (
          <iframe
            src={src}
            title={title}
            sandbox={ENGINE_HTTP.prototype.iframeSandbox}
            referrerPolicy="no-referrer"
            width={width}
            height={height}
            className="origin-top-left border-0 bg-white"
            style={{ transform: `scale(${String(scale)})` }}
          />
        )}
        <div aria-hidden className="pointer-events-none absolute inset-0" data-testid="pins">
          {pins.map((p) => (
            <span
              key={p.n}
              data-testid={`pin-${String(p.n)}`}
              title={p.comment}
              className={cn(marker, "bg-brand")}
              style={{ left: `${String(p.x_pct)}%`, top: `${String(p.y_pct)}%` }}
            >
              {p.n}
            </span>
          ))}
          {draft === null ? null : (
            <span
              data-testid="pin-draft"
              className={cn(marker, "bg-accent")}
              style={{ left: `${String(draft.x_pct)}%`, top: `${String(draft.y_pct)}%` }}
            >
              +
            </span>
          )}
        </div>
        {placing ? (
          <button
            type="button"
            onClick={place}
            className="absolute inset-0 cursor-crosshair bg-brand/5 outline-offset-[-4px]"
            aria-label="Place the pin here (click a point in the frame; Enter places it in the middle)"
          />
        ) : null}
      </div>
      {scale < 1 ? (
        <p className="mt-1 text-center text-[11px] text-muted-fg tabular">
          {width} px shown at {Math.round(scale * 100)}%
        </p>
      ) : null}
    </div>
  );
}
