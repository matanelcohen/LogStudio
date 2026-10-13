import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

function mediaQuery(query: string): MediaQueryList {
  return {
    matches: false, media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn()
  };
}
// uPlot subscribes to pixel-density changes when its module is imported.
Object.defineProperty(window, "matchMedia", { configurable: true, writable: true, value: mediaQuery });

beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("matchMedia", mediaQuery);
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
