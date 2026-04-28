/**
 * Phase E (2026-04-28) — tests for the Settings tab helpers.
 *
 * The numeric-input helper is also exercised here (it ships in the
 * same module) so a single suite covers the file's full surface.
 */
import { describe, expect, it } from "vitest";
import {
  parseOptionalNonNegativeNumber,
  parseSettingsTabFromHash,
} from "./settings.helpers";
import {
  SETTINGS_DEFAULT_TAB,
  SETTINGS_TABS,
} from "./settings.constants";

describe("parseSettingsTabFromHash", () => {
  it("returns the default tab for an empty hash", () => {
    expect(parseSettingsTabFromHash("")).toBe(SETTINGS_DEFAULT_TAB);
    expect(parseSettingsTabFromHash("#")).toBe(SETTINGS_DEFAULT_TAB);
  });

  it("returns the default tab for an unknown id", () => {
    expect(parseSettingsTabFromHash("#wat")).toBe(SETTINGS_DEFAULT_TAB);
    expect(parseSettingsTabFromHash("#section-1")).toBe(SETTINGS_DEFAULT_TAB);
  });

  it("matches a recognized tab id", () => {
    for (const tab of SETTINGS_TABS) {
      expect(parseSettingsTabFromHash(`#${tab.id}`)).toBe(tab.id);
    }
  });

  it("trims surrounding whitespace and a leading '#'", () => {
    expect(parseSettingsTabFromHash("  #integrations  ")).toBe(
      "integrations"
    );
    expect(parseSettingsTabFromHash("integrations")).toBe("integrations");
  });

  it("is case-insensitive", () => {
    expect(parseSettingsTabFromHash("#PROFILE")).toBe("profile");
    expect(parseSettingsTabFromHash("#Tracking")).toBe("tracking");
  });

  it("is robust to null / undefined / non-string-shaped input (defensive)", () => {
    expect(parseSettingsTabFromHash(null as unknown as string)).toBe(
      SETTINGS_DEFAULT_TAB
    );
    expect(parseSettingsTabFromHash(undefined as unknown as string)).toBe(
      SETTINGS_DEFAULT_TAB
    );
  });
});

describe("parseOptionalNonNegativeNumber", () => {
  it("returns null for an empty / whitespace string", () => {
    expect(parseOptionalNonNegativeNumber("", "x")).toBeNull();
    expect(parseOptionalNonNegativeNumber("   ", "x")).toBeNull();
  });

  it("parses a valid non-negative number", () => {
    expect(parseOptionalNonNegativeNumber("0", "x")).toBe(0);
    expect(parseOptionalNonNegativeNumber("3.5", "x")).toBe(3.5);
    expect(parseOptionalNonNegativeNumber("  100 ", "x")).toBe(100);
  });

  it("throws on a negative number", () => {
    expect(() => parseOptionalNonNegativeNumber("-1", "Dose")).toThrow(
      /Dose must be a valid non-negative number/
    );
  });

  it("throws on a non-finite / non-numeric input", () => {
    expect(() => parseOptionalNonNegativeNumber("abc", "Dose")).toThrow(
      /Dose must be a valid non-negative number/
    );
    expect(() => parseOptionalNonNegativeNumber("Infinity", "Dose")).toThrow(
      /Dose must be a valid non-negative number/
    );
  });
});
