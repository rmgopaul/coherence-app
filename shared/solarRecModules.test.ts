import { describe, expect, it } from "vitest";
import {
  MODULES,
  MODULE_KEYS,
  PERMISSION_LEVELS,
  getModule,
  isModuleKey,
  permissionAtLeast,
} from "./solarRecModules";

describe("solarRecModules", () => {
  it("every MODULE_KEYS entry has a matching descriptor", () => {
    for (const key of MODULE_KEYS) {
      const descriptor = MODULES.find((m) => m.key === key);
      expect(descriptor, `missing descriptor for ${key}`).toBeDefined();
    }
    expect(MODULES.length).toBe(MODULE_KEYS.length);
  });

  it("all module descriptors declare unique keys", () => {
    const seen = new Set<string>();
    for (const m of MODULES) {
      expect(seen.has(m.key)).toBe(false);
      seen.add(m.key);
    }
  });

  it("isModuleKey narrows unknown strings", () => {
    expect(isModuleKey("contract-scanner")).toBe(true);
    expect(isModuleKey("does-not-exist")).toBe(false);
  });

  it("getModule returns the canonical descriptor", () => {
    const descriptor = getModule("din-scrape-manager");
    expect(descriptor.key).toBe("din-scrape-manager");
    expect(descriptor.label).toMatch(/DIN/);
  });

  it("permissionAtLeast respects the documented ordering", () => {
    // read+ calls
    expect(permissionAtLeast("read", "read")).toBe(true);
    expect(permissionAtLeast("edit", "read")).toBe(true);
    expect(permissionAtLeast("admin", "read")).toBe(true);
    expect(permissionAtLeast("none", "read")).toBe(false);

    // edit+ calls
    expect(permissionAtLeast("edit", "edit")).toBe(true);
    expect(permissionAtLeast("admin", "edit")).toBe(true);
    expect(permissionAtLeast("read", "edit")).toBe(false);

    // admin+ calls
    expect(permissionAtLeast("admin", "admin")).toBe(true);
    expect(permissionAtLeast("edit", "admin")).toBe(false);
  });

  it("PERMISSION_LEVELS matches the enum in the schema migration", () => {
    expect(PERMISSION_LEVELS).toEqual(["none", "read", "edit", "admin"]);
  });

  it("team-permissions module is present so admins can manage the matrix", () => {
    expect(MODULE_KEYS).toContain("team-permissions");
  });
});
