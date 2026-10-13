import { act, render, screen, within } from "@testing-library/react";
import { StrictMode } from "react";
import { FlowStudio } from "@/components/app/FlowStudio";
import { fixtureFetch, readEventLog, type FixtureFetch } from "../fixtures";

/** An SSE body that stays open (like a live engine) after sending `lines`. */
export const openStream = (lines: string[] = []): Response =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const l of lines) controller.enqueue(new TextEncoder().encode(l));
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );

export const eventLines = (): string[] =>
  readEventLog()
    .trim()
    .split("\n")
    .map((line) => {
      const e = JSON.parse(line) as { run: string; seq: number };
      return `id: ${e.run}:${String(e.seq)}\ndata: ${line}\n\n`;
    });

export interface RenderedApp {
  readonly requests: FixtureFetch["requests"];
}

/** Renders the whole app at `url` against the golden-run fixture. */
export const renderApp = (
  url: string,
  overrides: Parameters<typeof fixtureFetch>[0] = {},
  options: { readonly strict?: boolean } = {},
): RenderedApp => {
  window.history.replaceState(null, "", url);
  const f = fixtureFetch({ "/api/stream": () => openStream(), ...overrides });
  const serverPath = new URL(url, "http://127.0.0.1").pathname;
  const app = <FlowStudio serverPath={serverPath} fetchImpl={f.fetch} />;
  // `next dev` runs with reactStrictMode: effects run twice.
  render(options.strict === true ? <StrictMode>{app}</StrictMode> : app);
  return { requests: f.requests };
};

export { act, screen, within };
