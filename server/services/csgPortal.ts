export type CsgPortalCredentials = {
  email: string;
  password: string;
  baseUrl?: string;
};

export type CsgPortalFetchResult = {
  csgId: string;
  systemPageUrl: string;
  pdfUrl: string | null;
  pdfFileName: string | null;
  pdfData: Uint8Array | null;
  error: string | null;
};

type RequestResult = {
  status: number;
  url: string;
  text: string;
  headers: Headers;
};

function clean(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function normalizeBaseUrl(value: string | undefined): string {
  const normalized = clean(value) || "https://portal2.carbonsolutionsgroup.com";
  return normalized.replace(/\/+$/, "");
}

function getSetCookieValues(headers: Headers): string[] {
  const anyHeaders = headers as Headers & {
    getSetCookie?: () => string[];
    raw?: () => Record<string, string[]>;
  };

  if (typeof anyHeaders.getSetCookie === "function") {
    return anyHeaders.getSetCookie();
  }

  const raw = typeof anyHeaders.raw === "function" ? anyHeaders.raw() : null;
  if (raw?.["set-cookie"]?.length) {
    return raw["set-cookie"];
  }

  const single = headers.get("set-cookie");
  if (!single) return [];

  // Some fetch implementations collapse multiple Set-Cookie values into one header string.
  // Split on commas that look like cookie boundaries, while preserving commas in Expires.
  return single.split(/,(?=\s*[A-Za-z0-9_.-]+=)/g).map((value) => clean(value)).filter(Boolean);
}

function parseCookiePair(setCookieHeader: string): { name: string; value: string } | null {
  const firstPart = setCookieHeader.split(";")[0];
  const separatorIndex = firstPart.indexOf("=");
  if (separatorIndex < 1) return null;
  const name = clean(firstPart.slice(0, separatorIndex));
  const value = clean(firstPart.slice(separatorIndex + 1));
  if (!name) return null;
  return { name, value };
}

function parseCsrfToken(html: string): string | null {
  const inputMatch =
    html.match(/name=["']_token["'][^>]*value=["']([^"']+)["']/i) ??
    html.match(/value=["']([^"']+)["'][^>]*name=["']_token["']/i);
  if (inputMatch) return clean(inputMatch[1]);

  const metaMatch = html.match(/<meta[^>]*name=["']csrf-token["'][^>]*content=["']([^"']+)["']/i);
  return metaMatch ? clean(metaMatch[1]) : null;
}

function extractFileNameFromContentDisposition(headerValue: string | null): string | null {
  if (!headerValue) return null;
  const utf8Match = headerValue.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match) {
    return decodeURIComponent(clean(utf8Match[1]));
  }
  const simpleMatch = headerValue.match(/filename="?([^";]+)"?/i);
  return simpleMatch ? clean(simpleMatch[1]) : null;
}

function resolveUrl(baseUrl: string, pathOrUrl: string): string {
  try {
    return new URL(pathOrUrl, `${baseUrl}/`).toString();
  } catch {
    return `${baseUrl}/${pathOrUrl.replace(/^\/+/, "")}`;
  }
}

function findHrefCandidates(html: string): string[] {
  const candidates: string[] = [];
  const regex = /href=["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html)) !== null) {
    const href = clean(match[1]);
    if (!href) continue;
    candidates.push(href);
  }
  return candidates;
}

function extractRecContractPdfUrl(baseUrl: string, html: string): string | null {
  const lower = html.toLowerCase();
  const anchor = lower.indexOf("rec contract (pdf)");

  const pick = (candidates: string[]): string | null => {
    const preferred = candidates.find((href) => /\.pdf($|[?#])/i.test(href));
    if (preferred) return resolveUrl(baseUrl, preferred);
    const fallback = candidates.find((href) => /download|file|upload/i.test(href));
    return fallback ? resolveUrl(baseUrl, fallback) : null;
  };

  if (anchor >= 0) {
    const snippet = html.slice(Math.max(0, anchor - 4000), Math.min(html.length, anchor + 12000));
    const fromSnippet = pick(findHrefCandidates(snippet));
    if (fromSnippet) return fromSnippet;
  }

  const fromFull = pick(findHrefCandidates(html));
  if (fromFull) return fromFull;

  return null;
}

function looksLikeLoginPage(url: string, html: string): boolean {
  const normalizedUrl = url.toLowerCase();
  if (normalizedUrl.includes("/admin/login")) return true;
  return /action=["'][^"']*\/admin\/login["']/i.test(html) && /name=["']password["']/i.test(html);
}

function containsCredentialFailureMessage(html: string): boolean {
  const normalized = html.toLowerCase();
  return (
    normalized.includes("credentials do not match") ||
    normalized.includes("provided credentials are incorrect") ||
    normalized.includes("invalid credentials") ||
    normalized.includes("incorrect password") ||
    normalized.includes("login failed")
  );
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

export class CsgPortalClient {
  private readonly baseUrl: string;
  private readonly cookies = new Map<string, string>();

  constructor(private readonly credentials: CsgPortalCredentials) {
    this.baseUrl = normalizeBaseUrl(credentials.baseUrl);
  }

  private buildCookieHeader(): string {
    return Array.from(this.cookies.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }

  private storeCookiesFromResponse(response: Response): void {
    const setCookieValues = getSetCookieValues(response.headers);
    setCookieValues.forEach((header) => {
      const parsed = parseCookiePair(header);
      if (!parsed) return;
      this.cookies.set(parsed.name, parsed.value);
    });
  }

  private async request(pathOrUrl: string, init?: RequestInit): Promise<RequestResult> {
    const maxRedirects = 10;
    let currentUrl = resolveUrl(this.baseUrl, pathOrUrl);
    let redirectCount = 0;
    const useManualRedirects = (init?.redirect ?? "follow") === "follow";

    while (true) {
      const headers = new Headers(init?.headers ?? {});
      if (!headers.has("Accept")) {
        headers.set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
      }
      if (!headers.has("User-Agent")) {
        headers.set("User-Agent", "Mozilla/5.0 (Codex ABP Settlement Bot)");
      }

      const cookieHeader = this.buildCookieHeader();
      if (cookieHeader) {
        headers.set("Cookie", cookieHeader);
      }

      const response = await fetch(currentUrl, {
        ...init,
        headers,
        redirect: "manual",
      });

      this.storeCookiesFromResponse(response);

      // If caller wants manual redirect handling, or this isn't a redirect, return as-is
      if (!useManualRedirects || !isRedirectStatus(response.status)) {
        return {
          status: response.status,
          url: currentUrl,
          text: await response.text(),
          headers: response.headers,
        };
      }

      // Follow redirect manually to preserve cookies
      const location = clean(response.headers.get("location"));
      if (!location) {
        return {
          status: response.status,
          url: currentUrl,
          text: await response.text(),
          headers: response.headers,
        };
      }

      redirectCount += 1;
      if (redirectCount > maxRedirects) {
        throw new Error(`Too many redirects (>${maxRedirects}) while requesting ${pathOrUrl}`);
      }

      currentUrl = resolveUrl(this.baseUrl, location);
      // Follow redirects as GET
      init = { ...init, method: "GET", body: undefined };
    }
  }

  private async requestBinary(pathOrUrl: string, init?: RequestInit): Promise<{
    status: number;
    url: string;
    data: Uint8Array;
    headers: Headers;
  }> {
    const maxRedirects = 10;
    let currentUrl = resolveUrl(this.baseUrl, pathOrUrl);
    let redirectCount = 0;

    while (true) {
      const headers = new Headers(init?.headers ?? {});
      if (!headers.has("Accept")) {
        headers.set("Accept", "application/pdf,*/*");
      }
      if (!headers.has("User-Agent")) {
        headers.set("User-Agent", "Mozilla/5.0 (Codex ABP Settlement Bot)");
      }

      const cookieHeader = this.buildCookieHeader();
      if (cookieHeader) {
        headers.set("Cookie", cookieHeader);
      }

      const response = await fetch(currentUrl, {
        ...init,
        headers,
        redirect: "manual",
      });

      this.storeCookiesFromResponse(response);

      if (!isRedirectStatus(response.status)) {
        const buffer = new Uint8Array(await response.arrayBuffer());
        return {
          status: response.status,
          url: currentUrl,
          data: buffer,
          headers: response.headers,
        };
      }

      const location = clean(response.headers.get("location"));
      if (!location) {
        const buffer = new Uint8Array(await response.arrayBuffer());
        return {
          status: response.status,
          url: currentUrl,
          data: buffer,
          headers: response.headers,
        };
      }

      redirectCount += 1;
      if (redirectCount > maxRedirects) {
        throw new Error(`Too many redirects (>${maxRedirects}) while requesting ${pathOrUrl}`);
      }

      currentUrl = resolveUrl(this.baseUrl, location);
      init = { ...init, method: "GET", body: undefined };
    }
  }

  async login(): Promise<void> {
    const loginPage = await this.request("/admin/login");
    if (loginPage.status >= 400) {
      throw new Error(`Portal login page request failed (${loginPage.status}).`);
    }

    const csrfToken = parseCsrfToken(loginPage.text);
    if (!csrfToken) {
      throw new Error("Could not extract CSRF token from portal login page.");
    }

    const form = new URLSearchParams();
    form.set("_token", csrfToken);
    form.set("email", this.credentials.email);
    form.set("password", this.credentials.password);
    form.set("remember", "1");

    const xsrfToken = this.cookies.get("XSRF-TOKEN");
    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: this.baseUrl,
      Referer: `${this.baseUrl}/admin/login`,
    };
    if (xsrfToken) {
      headers["X-XSRF-TOKEN"] = decodeURIComponent(xsrfToken);
    }

    const loginAttempt = await this.request("/admin/login", {
      method: "POST",
      headers,
      body: form.toString(),
      redirect: "manual",
    });

    if (loginAttempt.status === 419) {
      throw new Error("Portal login failed with HTTP 419 (CSRF/session mismatch). Please retry.");
    }

    if (isRedirectStatus(loginAttempt.status)) {
      const redirectLocation = clean(loginAttempt.headers.get("location"));
      if (!redirectLocation) {
        throw new Error(`Portal login returned redirect ${loginAttempt.status} without a location header.`);
      }

      const resolvedRedirect = resolveUrl(this.baseUrl, redirectLocation);
      if (/\/admin\/login\b/i.test(resolvedRedirect)) {
        throw new Error("Portal login failed. Please verify portal email/password.");
      }

      const landingPage = await this.request(resolvedRedirect, {
        method: "GET",
        headers: {
          Referer: `${this.baseUrl}/admin/login`,
        },
      });

      if (looksLikeLoginPage(landingPage.url, landingPage.text)) {
        if (containsCredentialFailureMessage(landingPage.text)) {
          throw new Error("Portal login failed. Please verify portal email/password.");
        }
        throw new Error("Portal login did not establish an authenticated session. Please retry.");
      }

      return;
    }

    if (looksLikeLoginPage(loginAttempt.url, loginAttempt.text)) {
      if (containsCredentialFailureMessage(loginAttempt.text)) {
        throw new Error("Portal login failed. Please verify portal email/password.");
      }
      throw new Error("Portal login did not complete. Please retry.");
    }
  }

  async fetchRecContractPdf(csgId: string): Promise<CsgPortalFetchResult> {
    const systemPageUrl = resolveUrl(this.baseUrl, `/admin/solar_panel_system/${encodeURIComponent(csgId)}?step=1.6`);

    try {
      let page = await this.request(systemPageUrl, {
        headers: {
          Referer: `${this.baseUrl}/admin`,
        },
      });

      if (looksLikeLoginPage(page.url, page.text)) {
        // Retry once by re-authenticating in case session cookies rotated/expired.
        await this.login();
        page = await this.request(systemPageUrl, {
          headers: {
            Referer: `${this.baseUrl}/admin`,
          },
        });
        if (looksLikeLoginPage(page.url, page.text)) {
          return {
            csgId,
            systemPageUrl,
            pdfUrl: null,
            pdfFileName: null,
            pdfData: null,
            error: "Session is not authenticated while fetching system page.",
          };
        }
      }

      if (page.status >= 400) {
        return {
          csgId,
          systemPageUrl,
          pdfUrl: null,
          pdfFileName: null,
          pdfData: null,
          error: `System page request failed (${page.status}).`,
        };
      }

      const pdfUrl = extractRecContractPdfUrl(this.baseUrl, page.text);
      if (!pdfUrl) {
        return {
          csgId,
          systemPageUrl,
          pdfUrl: null,
          pdfFileName: null,
          pdfData: null,
          error: "Could not locate a Rec Contract (PDF) link on the system page.",
        };
      }

      const pdf = await this.requestBinary(pdfUrl, {
        headers: {
          Referer: systemPageUrl,
        },
      });

      if (pdf.status >= 400) {
        return {
          csgId,
          systemPageUrl,
          pdfUrl,
          pdfFileName: null,
          pdfData: null,
          error: `PDF download failed (${pdf.status}).`,
        };
      }

      const contentType = clean(pdf.headers.get("content-type")).toLowerCase();
      if (!contentType.includes("pdf") && !pdfUrl.toLowerCase().includes(".pdf")) {
        return {
          csgId,
          systemPageUrl,
          pdfUrl,
          pdfFileName: null,
          pdfData: null,
          error: "Downloaded file is not a PDF.",
        };
      }

      const fileNameFromHeader = extractFileNameFromContentDisposition(pdf.headers.get("content-disposition"));
      const fallbackFileName = (() => {
        try {
          const pathname = new URL(pdf.url).pathname;
          const base = pathname.split("/").filter(Boolean).pop() ?? "contract.pdf";
          return base.toLowerCase().endsWith(".pdf") ? base : `${base}.pdf`;
        } catch {
          return `contract-${csgId}.pdf`;
        }
      })();

      return {
        csgId,
        systemPageUrl,
        pdfUrl,
        pdfFileName: fileNameFromHeader || fallbackFileName,
        pdfData: pdf.data,
        error: null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown portal error.";
      return {
        csgId,
        systemPageUrl,
        pdfUrl: null,
        pdfFileName: null,
        pdfData: null,
        error: message,
      };
    }
  }
}

export async function testCsgPortalCredentials(credentials: CsgPortalCredentials): Promise<void> {
  const client = new CsgPortalClient(credentials);
  await client.login();
}

export async function fetchRecContractsForCsgIds(input: {
  credentials: CsgPortalCredentials;
  csgIds: string[];
}): Promise<CsgPortalFetchResult[]> {
  const client = new CsgPortalClient(input.credentials);
  await client.login();

  const uniqueIds = Array.from(new Set(input.csgIds.map((id) => clean(id)).filter(Boolean)));
  const results: CsgPortalFetchResult[] = [];

  for (const csgId of uniqueIds) {
    // Sequential by default to reduce account lock risk and portal load.
    results.push(await client.fetchRecContractPdf(csgId));
  }

  return results;
}
