import dns from "node:dns";

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

type BinaryRequestResult = {
  status: number;
  url: string;
  data: Uint8Array;
  headers: Headers;
};

const CSG_PORTAL_REQUEST_TIMEOUT_MS = 45_000;
let CSG_DNS_IPV4_FIRST_CONFIGURED = false;

function ensureIpv4FirstDnsOrder(): void {
  if (CSG_DNS_IPV4_FIRST_CONFIGURED) return;
  try {
    // Cloudflare-backed hosts often return AAAA first. In runtimes with no IPv6 route,
    // this can throw ENETUNREACH. Force IPv4-first for outbound portal requests.
    dns.setDefaultResultOrder("ipv4first");
    CSG_DNS_IPV4_FIRST_CONFIGURED = true;
  } catch {
    // Best effort; if this fails, requests still proceed with Node defaults.
  }
}

function containsNetUnreachableError(error: unknown): boolean {
  const seen = new Set<unknown>();
  const stack: unknown[] = [error];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || seen.has(current)) continue;
    seen.add(current);

    if (typeof current === "string") {
      if (current.includes("ENETUNREACH")) return true;
      continue;
    }

    if (typeof current !== "object") continue;

    const anyCurrent = current as {
      code?: unknown;
      message?: unknown;
      cause?: unknown;
      errors?: unknown;
    };

    if (anyCurrent.code === "ENETUNREACH") return true;
    if (typeof anyCurrent.message === "string" && anyCurrent.message.includes("ENETUNREACH")) {
      return true;
    }

    if (anyCurrent.cause) stack.push(anyCurrent.cause);
    if (Array.isArray(anyCurrent.errors)) {
      anyCurrent.errors.forEach((nested) => stack.push(nested));
    }
  }

  return false;
}

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

function findUrlCandidates(html: string): string[] {
  const candidates = new Set<string>();
  const attributeRegex = /(href|src|data)=["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;

  while ((match = attributeRegex.exec(html)) !== null) {
    const value = clean(match[2]);
    if (!value) continue;
    candidates.add(value);
  }

  return Array.from(candidates);
}

function extractAnyPdfLikeUrl(baseUrl: string, html: string): string | null {
  const candidates = findUrlCandidates(html);
  const explicitPdf = candidates.find((candidate) => /\.pdf($|[?#])/i.test(candidate));
  if (explicitPdf) return resolveUrl(baseUrl, explicitPdf);

  const fallback = candidates.find((candidate) => /download|file|upload|contract/i.test(candidate));
  return fallback ? resolveUrl(baseUrl, fallback) : null;
}

function extractScheduleBFileUrl(baseUrl: string, html: string): string | null {
  const lower = html.toLowerCase();
  const anchor = lower.indexOf("schedule b");

  const pick = (candidates: string[]): string | null => {
    const preferred = candidates.find((href) => /\.pdf($|[?#])/i.test(href));
    if (preferred) return resolveUrl(baseUrl, preferred);
    // Schedule B files can be images (JPEG, PNG, etc.) — also accept download/file/upload links
    const fallback = candidates.find((href) => /download|file|upload/i.test(href));
    return fallback ? resolveUrl(baseUrl, fallback) : null;
  };

  if (anchor >= 0) {
    const snippet = html.slice(Math.max(0, anchor - 4000), Math.min(html.length, anchor + 12000));
    const fromSnippet = pick(findHrefCandidates(snippet));
    if (fromSnippet) return fromSnippet;
  }

  return null;
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

function looksLikePdfBinary(data: Uint8Array): boolean {
  // Some portals return application/octet-stream without a .pdf URL, so inspect bytes directly.
  const signature = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
  const limit = Math.min(data.length - signature.length + 1, 2048);
  for (let index = 0; index < limit; index += 1) {
    let matches = true;
    for (let offset = 0; offset < signature.length; offset += 1) {
      if (data[index + offset] !== signature[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) return true;
  }
  return false;
}

function decodeBinaryAsText(data: Uint8Array): string {
  try {
    return new TextDecoder("utf-8").decode(data);
  } catch {
    return "";
  }
}

function looksLikeHtmlText(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;
  return (
    normalized.startsWith("<!doctype html") ||
    normalized.startsWith("<html") ||
    normalized.includes("<html") ||
    normalized.includes("<body") ||
    normalized.includes("<head")
  );
}

function derivePdfFileName(input: {
  responseUrl: string;
  contentDisposition: string | null;
  fallbackBaseName: string;
}): string {
  const fromHeader = extractFileNameFromContentDisposition(input.contentDisposition);
  if (fromHeader) return fromHeader.toLowerCase().endsWith(".pdf") ? fromHeader : `${fromHeader}.pdf`;

  try {
    const pathname = new URL(input.responseUrl).pathname;
    const base = pathname.split("/").filter(Boolean).pop() ?? input.fallbackBaseName;
    return base.toLowerCase().endsWith(".pdf") ? base : `${base}.pdf`;
  } catch {
    return input.fallbackBaseName.toLowerCase().endsWith(".pdf")
      ? input.fallbackBaseName
      : `${input.fallbackBaseName}.pdf`;
  }
}

export class CsgPortalClient {
  private readonly baseUrl: string;
  private readonly cookies = new Map<string, string>();

  constructor(private readonly credentials: CsgPortalCredentials) {
    this.baseUrl = normalizeBaseUrl(credentials.baseUrl);
    ensureIpv4FirstDnsOrder();
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

  private async fetchWithTimeout(
    currentUrl: string,
    init: RequestInit,
    requestLabel: string
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, CSG_PORTAL_REQUEST_TIMEOUT_MS);

    const upstreamSignal = init.signal;
    if (upstreamSignal) {
      if (upstreamSignal.aborted) {
        controller.abort();
      } else {
        upstreamSignal.addEventListener("abort", () => controller.abort(), { once: true });
      }
    }

    try {
      return await fetch(currentUrl, {
        ...init,
        signal: controller.signal,
      });
    } catch (error) {
      if (!controller.signal.aborted && containsNetUnreachableError(error)) {
        throw new Error(
          `Portal request failed with ENETUNREACH while requesting ${requestLabel}. ` +
            `The runtime cannot reach the target network path.`
        );
      }

      if (
        (error instanceof Error && error.name === "AbortError") ||
        String(error).toLowerCase().includes("aborted")
      ) {
        throw new Error(
          `Portal request timed out after ${Math.round(CSG_PORTAL_REQUEST_TIMEOUT_MS / 1000)}s while requesting ${requestLabel}.`
        );
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
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

      const response = await this.fetchWithTimeout(
        currentUrl,
        {
          ...init,
          headers,
          redirect: "manual",
        },
        pathOrUrl
      );

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

  private async requestBinary(pathOrUrl: string, init?: RequestInit): Promise<BinaryRequestResult> {
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

      const response = await this.fetchWithTimeout(
        currentUrl,
        {
          ...init,
          headers,
          redirect: "manual",
        },
        pathOrUrl
      );

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
    const systemPageUrl = resolveUrl(
      this.baseUrl,
      `/admin/solar_panel_system/${encodeURIComponent(csgId)}/edit?step=2.4`
    );

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

      const downloadAndValidatePdf = async (
        candidateUrl: string,
        referer: string
      ): Promise<
        | {
            ok: true;
            finalUrl: string;
            fileName: string;
            data: Uint8Array;
          }
        | {
            ok: false;
            error: string;
          }
      > => {
        const download = await this.requestBinary(candidateUrl, {
          headers: {
            Referer: referer,
          },
        });

        if (download.status >= 400) {
          return {
            ok: false,
            error: `PDF download failed (${download.status}).`,
          };
        }

        const contentType = clean(download.headers.get("content-type")).toLowerCase();
        const contentDisposition = download.headers.get("content-disposition");
        const fileName = derivePdfFileName({
          responseUrl: download.url,
          contentDisposition,
          fallbackBaseName: `contract-${csgId}.pdf`,
        });
        const explicitPdf =
          contentType.includes("pdf") ||
          candidateUrl.toLowerCase().includes(".pdf") ||
          fileName.toLowerCase().endsWith(".pdf");
        const binaryPdf = looksLikePdfBinary(download.data);

        if (explicitPdf || binaryPdf) {
          return {
            ok: true,
            finalUrl: candidateUrl,
            fileName,
            data: download.data,
          };
        }

        const asText = decodeBinaryAsText(download.data);
        if (asText && looksLikeHtmlText(asText)) {
          if (looksLikeLoginPage(download.url, asText)) {
            await this.login();
            const retry = await this.requestBinary(candidateUrl, {
              headers: {
                Referer: referer,
              },
            });
            const retryContentType = clean(retry.headers.get("content-type")).toLowerCase();
            if (retry.status < 400 && (retryContentType.includes("pdf") || looksLikePdfBinary(retry.data))) {
              const retryFileName = derivePdfFileName({
                responseUrl: retry.url,
                contentDisposition: retry.headers.get("content-disposition"),
                fallbackBaseName: `contract-${csgId}.pdf`,
              });
              return {
                ok: true,
                finalUrl: candidateUrl,
                fileName: retryFileName,
                data: retry.data,
              };
            }
          }

          const nestedPdfUrl = extractAnyPdfLikeUrl(this.baseUrl, asText);
          if (nestedPdfUrl && nestedPdfUrl !== candidateUrl) {
            const nested = await this.requestBinary(nestedPdfUrl, {
              headers: {
                Referer: candidateUrl,
              },
            });
            const nestedContentType = clean(nested.headers.get("content-type")).toLowerCase();
            if (nested.status < 400 && (nestedContentType.includes("pdf") || looksLikePdfBinary(nested.data))) {
              const nestedFileName = derivePdfFileName({
                responseUrl: nested.url,
                contentDisposition: nested.headers.get("content-disposition"),
                fallbackBaseName: `contract-${csgId}.pdf`,
              });
              return {
                ok: true,
                finalUrl: nestedPdfUrl,
                fileName: nestedFileName,
                data: nested.data,
              };
            }
          }
        }

        return {
          ok: false,
          error: `Downloaded file is not a PDF (content-type: ${contentType || "unknown"}).`,
        };
      };

      const pdfResult = await downloadAndValidatePdf(pdfUrl, systemPageUrl);

      if (!pdfResult.ok) {
        return {
          csgId,
          systemPageUrl,
          pdfUrl,
          pdfFileName: null,
          pdfData: null,
          error: pdfResult.error,
        };
      }

      return {
        csgId,
        systemPageUrl,
        pdfUrl: pdfResult.finalUrl,
        pdfFileName: pdfResult.fileName,
        pdfData: pdfResult.data,
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
  /**
   * Fetch the Schedule B file for a CSG system from the portal.
   * Similar to fetchRecContractPdf but anchors on the "Schedule B"
   * label instead of "REC Contract (PDF)". Returns error for
   * non-PDF files (images) since only PDFs can be parsed.
   */
  async fetchScheduleBFile(csgId: string): Promise<CsgPortalFetchResult> {
    const systemPageUrl = resolveUrl(
      this.baseUrl,
      `/admin/solar_panel_system/${encodeURIComponent(csgId)}/edit?step=2.4`
    );

    try {
      let page = await this.request(systemPageUrl, {
        headers: { Referer: `${this.baseUrl}/admin` },
      });

      if (looksLikeLoginPage(page.url, page.text)) {
        await this.login();
        page = await this.request(systemPageUrl, {
          headers: { Referer: `${this.baseUrl}/admin` },
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

      const fileUrl = extractScheduleBFileUrl(this.baseUrl, page.text);
      if (!fileUrl) {
        return {
          csgId,
          systemPageUrl,
          pdfUrl: null,
          pdfFileName: null,
          pdfData: null,
          error: "No Schedule B file link found on the system page.",
        };
      }

      const download = await this.requestBinary(fileUrl, {
        headers: { Referer: systemPageUrl },
      });

      if (download.status >= 400) {
        return {
          csgId,
          systemPageUrl,
          pdfUrl: fileUrl,
          pdfFileName: null,
          pdfData: null,
          error: `Schedule B file download failed (${download.status}).`,
        };
      }

      const contentType = clean(download.headers.get("content-type")).toLowerCase();
      const contentDisposition = download.headers.get("content-disposition");
      const fileName = derivePdfFileName({
        responseUrl: download.url,
        contentDisposition,
        fallbackBaseName: `csg-portal/schedule-b-${csgId}.pdf`,
      });

      // Check if it's a PDF
      if (
        contentType.includes("pdf") ||
        fileName.toLowerCase().endsWith(".pdf") ||
        looksLikePdfBinary(download.data)
      ) {
        return {
          csgId,
          systemPageUrl,
          pdfUrl: fileUrl,
          pdfFileName: fileName,
          pdfData: download.data,
          error: null,
        };
      }

      // If it's an image, we can't parse it
      if (/image\/(jpeg|jpg|png|heic|tiff|bmp|webp)/i.test(contentType)) {
        return {
          csgId,
          systemPageUrl,
          pdfUrl: fileUrl,
          pdfFileName: fileName,
          pdfData: null,
          error: `Schedule B file is an image (${contentType}), not a PDF. Only PDF files can be parsed.`,
        };
      }

      // If it's HTML (login redirect), retry after re-auth
      const asText = decodeBinaryAsText(download.data);
      if (asText && looksLikeLoginPage(download.url, asText)) {
        await this.login();
        const retry = await this.requestBinary(fileUrl, {
          headers: { Referer: systemPageUrl },
        });
        const retryContentType = clean(retry.headers.get("content-type")).toLowerCase();
        if (retry.status < 400 && (retryContentType.includes("pdf") || looksLikePdfBinary(retry.data))) {
          const retryFileName = derivePdfFileName({
            responseUrl: retry.url,
            contentDisposition: retry.headers.get("content-disposition"),
            fallbackBaseName: `csg-portal/schedule-b-${csgId}.pdf`,
          });
          return {
            csgId,
            systemPageUrl,
            pdfUrl: fileUrl,
            pdfFileName: retryFileName,
            pdfData: retry.data,
            error: null,
          };
        }
      }

      return {
        csgId,
        systemPageUrl,
        pdfUrl: fileUrl,
        pdfFileName: null,
        pdfData: null,
        error: `Downloaded file is not a PDF (content-type: ${contentType || "unknown"}).`,
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
