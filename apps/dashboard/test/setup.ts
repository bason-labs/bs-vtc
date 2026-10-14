import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";

// Script tests (the dev proxy) run in node, without a DOM.
if (typeof window !== "undefined") {
  // A file's first render loads React Flow and the whole app; with every file running in
  // parallel that can pass the default 1 s of the find* queries without anything being wrong.
  configure({ asyncUtilTimeout: 5000 });

  afterEach(() => {
    cleanup();
    window.sessionStorage.clear();
    window.localStorage.clear();
  });

  // jsdom does not implement scrolling.
  window.scrollTo = () => undefined;

  // jsdom lacks these browser APIs; React Flow and the theme provider use them.
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  if (!("ResizeObserver" in globalThis)) {
    globalThis.ResizeObserver = ResizeObserverStub;
  }

  if (typeof window.matchMedia !== "function") {
    window.matchMedia = (query: string): MediaQueryList =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }) as MediaQueryList;
  }
}
