import { describe, expect, it } from "vitest";

import {
  selectEgaugeConnection,
  type EgaugeConnectionConfig,
} from "./providerMetadata";

function buildConnection(
  overrides: Partial<EgaugeConnectionConfig>
): EgaugeConnectionConfig {
  return {
    id: overrides.id ?? "conn-1",
    name: overrides.name ?? "Connection 1",
    meterId: overrides.meterId ?? "meter-1",
    baseUrl: overrides.baseUrl ?? "https://example.egauge.net",
    accessType: overrides.accessType ?? "portfolio_login",
    username: overrides.username ?? "user",
    password: overrides.password ?? "pass",
    createdAt: overrides.createdAt ?? "2026-04-23T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-04-23T00:00:00.000Z",
  };
}

describe("selectEgaugeConnection", () => {
  it("returns the requested connection when one is provided", () => {
    const first = buildConnection({ id: "first", name: "First" });
    const second = buildConnection({ id: "second", name: "Second" });

    const result = selectEgaugeConnection(
      {
        activeConnectionId: "first",
        connections: [first, second],
      },
      "second"
    );

    expect(result?.id).toBe("second");
    expect(result?.name).toBe("Second");
  });

  it("falls back to the active connection when no request id is provided", () => {
    const first = buildConnection({ id: "first", name: "First" });
    const second = buildConnection({ id: "second", name: "Second" });

    const result = selectEgaugeConnection({
      activeConnectionId: "second",
      connections: [first, second],
    });

    expect(result?.id).toBe("second");
    expect(result?.name).toBe("Second");
  });

  it("returns null when the requested connection does not exist", () => {
    const first = buildConnection({ id: "first", name: "First" });

    const result = selectEgaugeConnection(
      {
        activeConnectionId: "first",
        connections: [first],
      },
      "missing"
    );

    expect(result).toBeNull();
  });
});
