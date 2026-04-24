import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getIntegrationByProvider: vi.fn(),
  upsertIntegration: vi.fn(),
  getOAuthCredential: vi.fn(),
  refreshGoogleToken: vi.fn(),
  refreshWhoopToken: vi.fn(),
}));

vi.mock("../db", () => ({
  getIntegrationByProvider: mocks.getIntegrationByProvider,
  upsertIntegration: mocks.upsertIntegration,
  getOAuthCredential: mocks.getOAuthCredential,
}));

vi.mock("../services/integrations/google", () => ({
  refreshGoogleToken: mocks.refreshGoogleToken,
}));

vi.mock("../services/integrations/whoop", () => ({
  refreshWhoopToken: mocks.refreshWhoopToken,
}));

describe("getValidGoogleToken", () => {
  beforeEach(async () => {
    // Reset the single-flight map between tests by reloading the module.
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("coalesces 10 concurrent refresh callers into one refreshFn invocation", async () => {
    mocks.getIntegrationByProvider.mockResolvedValue({
      id: 1,
      userId: 1,
      provider: "google",
      accessToken: "stale-access",
      refreshToken: "rt",
      expiresAt: new Date(Date.now() - 60_000), // expired 1 min ago
    });
    mocks.getOAuthCredential.mockResolvedValue({
      clientId: "cid",
      clientSecret: "csec",
    });
    mocks.upsertIntegration.mockResolvedValue(undefined);
    // Delay the refresh so all 10 callers race into the inflight check
    // before the first one settles.
    mocks.refreshGoogleToken.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return {
        access_token: "fresh-access",
        expires_in: 3600,
        refresh_token: "rt-rotated",
      };
    });

    const { getValidGoogleToken } = await import("./tokenRefresh");

    const results = await Promise.all(
      Array.from({ length: 10 }, () => getValidGoogleToken(1))
    );

    expect(mocks.refreshGoogleToken).toHaveBeenCalledTimes(1);
    expect(mocks.upsertIntegration).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(10);
    for (const token of results) {
      expect(token).toBe("fresh-access");
    }
  });

  it("returns the existing token without calling refresh when not near expiry", async () => {
    mocks.getIntegrationByProvider.mockResolvedValue({
      id: 1,
      userId: 1,
      provider: "google",
      accessToken: "still-valid",
      refreshToken: "rt",
      expiresAt: new Date(Date.now() + 60 * 60_000), // 1h from now
    });

    const { getValidGoogleToken } = await import("./tokenRefresh");
    const token = await getValidGoogleToken(1);

    expect(token).toBe("still-valid");
    expect(mocks.refreshGoogleToken).not.toHaveBeenCalled();
  });

  it("releases the inflight slot on failure so the next call can retry", async () => {
    mocks.getIntegrationByProvider.mockResolvedValue({
      id: 1,
      userId: 1,
      provider: "google",
      accessToken: "stale",
      refreshToken: "rt",
      expiresAt: new Date(Date.now() - 1000),
    });
    mocks.getOAuthCredential.mockResolvedValue({
      clientId: "cid",
      clientSecret: "csec",
    });
    mocks.refreshGoogleToken.mockRejectedValueOnce(new Error("boom"));
    mocks.refreshGoogleToken.mockResolvedValueOnce({
      access_token: "second-try-token",
      expires_in: 3600,
    });
    mocks.upsertIntegration.mockResolvedValue(undefined);

    const { getValidGoogleToken } = await import("./tokenRefresh");

    await expect(getValidGoogleToken(1)).rejects.toThrow(
      /Failed to refresh Google token/
    );
    // Second call should get a fresh attempt (map cleared after first failure).
    const token = await getValidGoogleToken(1);
    expect(token).toBe("second-try-token");
    expect(mocks.refreshGoogleToken).toHaveBeenCalledTimes(2);
  });
});
