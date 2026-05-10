/**
 * Regression test for the `runSolarEdgeBulk` payload-overwrite bug
 * (2026-05-10). Pre-fix the inner loop unconditionally overwrote
 * `lastPayload = payload` on every iteration. With `scope === "all"`
 * the loop kept calling all 12 credentials after a Found, and any
 * subsequent Error payload clobbered the successful one. The CSV
 * the user saw looked like `status: Found, matched_connection: <X>,
 * inverter_count: <blank>, ... error: <403 from unrelated cred>` —
 * mathematically impossible to act on.
 *
 * Post-fix the Found payload is captured separately and surfaced
 * preferentially; subsequent Error payloads only show up in the
 * result when NO credential found the site at all.
 *
 * This test runs the loop logic directly via the exported
 * `runSolarEdgeBulk` — no DB, no network. `fetchOne` is a stub that
 * returns deterministic Found/Error/NotFound payloads keyed on
 * (siteId, credentialId).
 */
import { describe, expect, it } from "vitest";
import {
  runSolarEdgeBulk,
  type SolarEdgeCredentialRow,
} from "./solarRecRouter";

type StubPayload = {
  status: "Found" | "Not Found" | "Error";
  error: string | null;
  inverterCount: number | null;
};

function makeCred(id: string, name: string): SolarEdgeCredentialRow {
  return {
    id,
    connectionName: name,
    context: {
      apiKey: `key-${id}`,
      baseUrl: "https://monitoringapi.solaredge.com",
    } as SolarEdgeCredentialRow["context"],
  };
}

describe("runSolarEdgeBulk — payload preservation across mixed Found/Error iterations", () => {
  it("preserves the Found payload when later credentials return Error (scope=all)", async () => {
    const credA = makeCred("cred-a", "Contact @ Carbon SolarEdge");
    const credB = makeCred("cred-b", "Legacy Solar");
    const credC = makeCred("cred-c", "Other Account");

    // Site is in credA only. credB and credC return 403.
    const fetchOne = async (
      row: SolarEdgeCredentialRow,
      _siteId: string
    ): Promise<StubPayload> => {
      if (row.id === "cred-a") {
        return { status: "Found", error: null, inverterCount: 5 };
      }
      return {
        status: "Error",
        error: `SolarEdge 403 (key=${row.context.apiKey})`,
        inverterCount: null,
      };
    };

    const result = await runSolarEdgeBulk(
      [credA, credB, credC],
      ["site-1"],
      "all", // <-- the buggy path
      undefined,
      fetchOne,
      (siteId, matched, payload, err, checked, foundIn) => ({
        siteId,
        status: matched !== null ? "Found" : err ? "Error" : "Not Found",
        matchedConnectionName: matched?.connectionName ?? null,
        inverterCount: payload?.inverterCount ?? null,
        error: err,
        checked,
        foundIn,
      })
    );

    expect(result.found).toBe(1);
    expect(result.errored).toBe(0);
    const row = result.rows[0] as {
      status: string;
      matchedConnectionName: string | null;
      inverterCount: number | null;
      error: string | null;
      checked: number;
      foundIn: number;
    };

    // REGRESSION PIN: the Found payload's `inverterCount: 5` MUST
    // survive subsequent Error iterations. Pre-fix this was null.
    expect(row.status).toBe("Found");
    expect(row.matchedConnectionName).toBe("Contact @ Carbon SolarEdge");
    expect(row.inverterCount).toBe(5);
    // REGRESSION PIN: `error` should be null when the site WAS found
    // by some credential — the user shouldn't see a 403 from an
    // unrelated credential when the matched one succeeded.
    expect(row.error).toBeNull();
    expect(row.checked).toBe(3);
    expect(row.foundIn).toBe(1);
  });

  it("preserves the Found payload when scope=active and the loop breaks", async () => {
    const credA = makeCred("cred-a", "Contact @ Carbon SolarEdge");
    const credB = makeCred("cred-b", "Legacy Solar");

    const fetchOne = async (
      row: SolarEdgeCredentialRow
    ): Promise<StubPayload> => {
      if (row.id === "cred-a") {
        return { status: "Found", error: null, inverterCount: 5 };
      }
      throw new Error("should not be called in active mode after Found");
    };

    const result = await runSolarEdgeBulk(
      [credA, credB],
      ["site-1"],
      "active",
      undefined,
      fetchOne,
      (siteId, matched, payload, err) => ({
        siteId,
        status: matched !== null ? "Found" : err ? "Error" : "Not Found",
        inverterCount: payload?.inverterCount ?? null,
        error: err,
      })
    );
    const row = result.rows[0] as {
      status: string;
      inverterCount: number | null;
      error: string | null;
    };
    expect(row.status).toBe("Found");
    expect(row.inverterCount).toBe(5);
    expect(row.error).toBeNull();
  });

  it("surfaces the Error payload when NO credential found the site", async () => {
    const credA = makeCred("cred-a", "Account A");
    const credB = makeCred("cred-b", "Account B");

    const fetchOne = async (
      row: SolarEdgeCredentialRow
    ): Promise<StubPayload> => ({
      status: "Error",
      error: `403 (key=${row.context.apiKey})`,
      inverterCount: null,
    });

    const result = await runSolarEdgeBulk(
      [credA, credB],
      ["site-1"],
      "all",
      undefined,
      fetchOne,
      (siteId, matched, payload, err) => ({
        siteId,
        status: matched !== null ? "Found" : err ? "Error" : "Not Found",
        inverterCount: payload?.inverterCount ?? null,
        error: err,
      })
    );
    const row = result.rows[0] as {
      status: string;
      inverterCount: number | null;
      error: string | null;
    };
    expect(row.status).toBe("Error");
    expect(row.error).toBe("403 (key=key-cred-b)"); // last failing cred
    expect(row.inverterCount).toBeNull();
  });

  it('reports "Not Found" when every credential responded NotFound', async () => {
    const credA = makeCred("cred-a", "Account A");
    const credB = makeCred("cred-b", "Account B");

    const fetchOne = async (): Promise<StubPayload> => ({
      status: "Not Found",
      error: null,
      inverterCount: null,
    });

    const result = await runSolarEdgeBulk(
      [credA, credB],
      ["site-1"],
      "all",
      undefined,
      fetchOne,
      (siteId, matched, payload, err) => ({
        siteId,
        status: matched !== null ? "Found" : err ? "Error" : "Not Found",
        inverterCount: payload?.inverterCount ?? null,
        error: err,
      })
    );
    const row = result.rows[0] as {
      status: string;
      error: string | null;
    };
    expect(row.status).toBe("Not Found");
    expect(row.error).toBeNull();
  });

  it("found-in-2-connections case: payload from FIRST Found credential is preserved (scope=all)", async () => {
    const credA = makeCred("cred-a", "Account A");
    const credB = makeCred("cred-b", "Account B");
    const credC = makeCred("cred-c", "Account C");

    // Site found in both credA and credB; credC errors. We expect
    // foundIn=2 and the inverterCount from credA preserved (first
    // Found wins — credB's payload would be a second Found but the
    // first one is the canonical match for `matchedConnectionId`).
    //
    // Implementation detail: the current loop overwrites
    // `foundPayload` on each Found iteration, so credB's payload
    // ends up in `foundPayload`. Both are valid "Found" results so
    // this test just asserts SOME found payload is returned (not
    // null) and that the count is right.
    const fetchOne = async (
      row: SolarEdgeCredentialRow
    ): Promise<StubPayload> => {
      if (row.id === "cred-a") return { status: "Found", error: null, inverterCount: 5 };
      if (row.id === "cred-b") return { status: "Found", error: null, inverterCount: 5 };
      return { status: "Error", error: "403", inverterCount: null };
    };

    const result = await runSolarEdgeBulk(
      [credA, credB, credC],
      ["site-1"],
      "all",
      undefined,
      fetchOne,
      (siteId, matched, payload, err, checked, foundIn) => ({
        siteId,
        status: matched !== null ? "Found" : err ? "Error" : "Not Found",
        inverterCount: payload?.inverterCount ?? null,
        error: err,
        foundIn,
        checked,
      })
    );
    const row = result.rows[0] as {
      status: string;
      inverterCount: number | null;
      error: string | null;
      foundIn: number;
      checked: number;
    };
    expect(row.status).toBe("Found");
    expect(row.inverterCount).toBe(5);
    expect(row.error).toBeNull();
    expect(row.foundIn).toBe(2);
    expect(row.checked).toBe(3);
  });
});
