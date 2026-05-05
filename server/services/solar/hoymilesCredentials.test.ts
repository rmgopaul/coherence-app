import { describe, expect, it } from "vitest";

import {
  extractHoymilesCredentialProfiles,
  maskHoymilesUsername,
  selectHoymilesCredentialProfile,
} from "./hoymilesCredentials";

describe("Hoymiles credential profiles", () => {
  it("parses a simple Solar REC team credential", () => {
    const profiles = extractHoymilesCredentialProfiles({
      id: "cred-1",
      connectionName: "Primary",
      metadata: JSON.stringify({
        username: "user@example.com",
        password: "secret",
        baseUrl: "https://neapi.hoymiles.com",
      }),
    });

    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({
      id: "cred-1",
      credentialId: "cred-1",
      sourceConnectionId: null,
      name: "Primary",
      username: "user@example.com",
      password: "secret",
      baseUrl: "https://neapi.hoymiles.com",
    });
    expect(profiles[0].context).toEqual({
      username: "user@example.com",
      password: "secret",
      baseUrl: "https://neapi.hoymiles.com",
    });
  });

  it("parses migrated multi-profile metadata and selects by compound or source id", () => {
    const profiles = extractHoymilesCredentialProfiles({
      id: "cred-1",
      metadata: JSON.stringify({
        baseUrl: "https://root.example.test",
        connections: [
          {
            id: "legacy-a",
            name: "Legacy A",
            username: "a@example.com",
            password: "pass-a",
          },
          {
            id: "legacy-b",
            name: "Legacy B",
            username: "b@example.com",
            password: "pass-b",
            baseUrl: "https://override.example.test",
          },
        ],
      }),
    });

    expect(profiles.map(profile => profile.id)).toEqual([
      "cred-1:legacy-a",
      "cred-1:legacy-b",
    ]);
    expect(
      selectHoymilesCredentialProfile(profiles, "cred-1:legacy-b")?.name
    ).toBe("Legacy B");
    expect(selectHoymilesCredentialProfile(profiles, "legacy-a")?.name).toBe(
      "Legacy A"
    );
    expect(profiles[0].baseUrl).toBe("https://root.example.test");
    expect(profiles[1].baseUrl).toBe("https://override.example.test");
  });

  it("uses the access token as a password fallback for legacy rows", () => {
    const profiles = extractHoymilesCredentialProfiles({
      id: "cred-1",
      accessToken: "token-password",
      metadata: JSON.stringify({
        username: "legacy-user",
      }),
    });

    expect(profiles).toHaveLength(1);
    expect(profiles[0].password).toBe("token-password");
  });

  it("masks usernames without exposing full values", () => {
    expect(maskHoymilesUsername("user@example.com")).toBe("us***@example.com");
    expect(maskHoymilesUsername("abcd1234")).toBe("ab***34");
    expect(maskHoymilesUsername("abc")).toBe("****");
  });
});
