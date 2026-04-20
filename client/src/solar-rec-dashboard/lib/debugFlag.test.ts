import { describe, it, expect, afterEach } from "vitest";
import { isSolarRecDebugEnabled } from "./debugFlag";

describe("isSolarRecDebugEnabled", () => {
  afterEach(() => {
    // Reset between tests — we're mutating global state.
    delete (globalThis as unknown as { window?: { __solarRecDebug?: boolean } })
      .window?.__solarRecDebug;
  });

  it("returns false when window.__solarRecDebug is unset", () => {
    (globalThis as unknown as { window: { __solarRecDebug?: boolean } }).window = {};
    expect(isSolarRecDebugEnabled()).toBe(false);
  });

  it("returns true only for literal true", () => {
    const win = (globalThis as unknown as { window: { __solarRecDebug?: unknown } })
      .window ?? ((globalThis as unknown as { window: { __solarRecDebug?: unknown } }).window = {});

    win.__solarRecDebug = true;
    expect(isSolarRecDebugEnabled()).toBe(true);

    win.__solarRecDebug = false;
    expect(isSolarRecDebugEnabled()).toBe(false);

    win.__solarRecDebug = "true"; // common typo
    expect(isSolarRecDebugEnabled()).toBe(false);

    win.__solarRecDebug = 1;
    expect(isSolarRecDebugEnabled()).toBe(false);

    win.__solarRecDebug = undefined;
    expect(isSolarRecDebugEnabled()).toBe(false);
  });
});
