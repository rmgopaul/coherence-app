import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchRecContractsForCsgIds, testCsgPortalCredentials } from "./services/csgPortal";

function htmlResponse(html: string, status = 200, extraHeaders?: Record<string, string>): Response {
  const headers = new Headers({ "content-type": "text/html; charset=utf-8", ...(extraHeaders ?? {}) });
  return new Response(html, { status, headers });
}

function loginPageResponse(): Response {
  const headers = new Headers({ "content-type": "text/html; charset=utf-8" });
  headers.append("set-cookie", "XSRF-TOKEN=token123; Path=/");
  headers.append("set-cookie", "laravel_session=session123; Path=/");
  return new Response(
    '<form action="/admin/login"><input type="hidden" name="_token" value="csrf123"><input name="password"></form>',
    {
      status: 200,
      headers,
    }
  );
}

function dashboardResponse(): Response {
  return htmlResponse("<html><body>Dashboard</body></html>");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("CSG portal login and contract fetch", () => {
  it("handles login token/cookie flow", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();

      if (url.endsWith("/admin/login") && method === "GET") {
        return loginPageResponse();
      }
      if (url.endsWith("/admin/login") && method === "POST") {
        return htmlResponse("<html>logged in</html>");
      }
      if (url.includes("/admin/solar_panel_system/1?step=1.6") && method === "GET") {
        return dashboardResponse();
      }

      return new Response("Not Found", { status: 404 });
    });

    vi.stubGlobal("fetch", fetchMock as typeof fetch);

    await expect(
      testCsgPortalCredentials({
        email: "service@example.com",
        password: "password123",
      })
    ).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const postCall = fetchMock.mock.calls.find((call) =>
      String(call[0]).endsWith("/admin/login") && String(call[1]?.method ?? "GET").toUpperCase() === "POST"
    );
    expect(postCall).toBeTruthy();
    expect(String(postCall?.[1]?.body ?? "")).toContain("_token=csrf123");
  });

  it("returns unauthorized error when login response includes credential failure", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();

      if (url.endsWith("/admin/login") && method === "GET") {
        return loginPageResponse();
      }
      if (url.endsWith("/admin/login") && method === "POST") {
        return htmlResponse(
          '<form action="/admin/login"><input name="password"><div>These credentials do not match our records.</div></form>'
        );
      }

      return new Response("Not Found", { status: 404 });
    });

    vi.stubGlobal("fetch", fetchMock as typeof fetch);

    await expect(
      testCsgPortalCredentials({
        email: "service@example.com",
        password: "wrong-password",
      })
    ).rejects.toThrow(/verify portal email\/password/i);
  });

  it("returns per-ID error when Rec Contract PDF link is missing", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();

      if (url.endsWith("/admin/login") && method === "GET") return loginPageResponse();
      if (url.endsWith("/admin/login") && method === "POST") return htmlResponse("ok");
      if (url.includes("/admin/solar_panel_system/1?step=1.6") && method === "GET") return dashboardResponse();
      if (url.includes("/admin/solar_panel_system/177418") && method === "GET") {
        return htmlResponse("<html><body>No file links here</body></html>");
      }

      return new Response("Not Found", { status: 404 });
    });

    vi.stubGlobal("fetch", fetchMock as typeof fetch);

    const results = await fetchRecContractsForCsgIds({
      credentials: {
        email: "service@example.com",
        password: "password123",
      },
      csgIds: ["177418"],
    });

    expect(results).toHaveLength(1);
    expect(results[0].csgId).toBe("177418");
    expect(results[0].error).toMatch(/Could not locate a Rec Contract \(PDF\) link/i);
    expect(results[0].pdfData).toBeNull();
  });

  it("downloads PDF successfully after login", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();

      if (url.endsWith("/admin/login") && method === "GET") return loginPageResponse();
      if (url.endsWith("/admin/login") && method === "POST") return htmlResponse("ok");
      if (url.includes("/admin/solar_panel_system/1?step=1.6") && method === "GET") return dashboardResponse();
      if (url.includes("/admin/solar_panel_system/177418") && method === "GET") {
        return htmlResponse(
          '<html><body><div>Rec Contract (PDF)</div><a href="/uploads/contract-177418.pdf">Download</a></body></html>'
        );
      }
      if (url.includes("/uploads/contract-177418.pdf") && method === "GET") {
        const headers = new Headers({
          "content-type": "application/pdf",
          "content-disposition": 'attachment; filename="contract-177418.pdf"',
        });
        return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers });
      }

      return new Response("Not Found", { status: 404 });
    });

    vi.stubGlobal("fetch", fetchMock as typeof fetch);

    const results = await fetchRecContractsForCsgIds({
      credentials: {
        email: "service@example.com",
        password: "password123",
      },
      csgIds: ["177418"],
    });

    expect(results).toHaveLength(1);
    expect(results[0].error).toBeNull();
    expect(results[0].pdfUrl).toContain("contract-177418.pdf");
    expect(results[0].pdfFileName).toBe("contract-177418.pdf");
    expect(results[0].pdfData?.length).toBe(4);
  });
});
