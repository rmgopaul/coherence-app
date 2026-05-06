// Storage helpers:
// 1) Forge proxy when BUILT_IN_FORGE_API_URL + BUILT_IN_FORGE_API_KEY are present.
// 2) Local filesystem fallback when Forge credentials are missing.

import { openAsBlob } from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { getBandwidthLogThresholdBytes } from "./_core/bandwidthDiagnostics";
import { ENV } from "./_core/env";

type StorageConfig = { baseUrl: string; apiKey: string };

export const LOCAL_STORAGE_ROUTE_PREFIX = "/_local_uploads";
const DEFAULT_LOCAL_STORAGE_ROOT = path.resolve(process.cwd(), ".local_uploads");

function normalizeEnvValue(value: string | undefined): string {
  const normalized = (value ?? "").trim();
  if (!normalized) return "";
  if (/^(undefined|null|none|false)$/i.test(normalized)) return "";
  return normalized;
}

function hasValidStorageProxyConfig(): boolean {
  const baseUrl = normalizeEnvValue(ENV.forgeApiUrl);
  const apiKey = normalizeEnvValue(ENV.forgeApiKey);
  if (!baseUrl || !apiKey) return false;
  try {
    new URL(ensureTrailingSlash(baseUrl));
    return true;
  } catch {
    return false;
  }
}

export function isStorageProxyConfigured(): boolean {
  return hasValidStorageProxyConfig();
}

export function getLocalStorageRoot(): string {
  const configured = process.env.LOCAL_STORAGE_ROOT?.trim();
  return configured && configured.length > 0 ? path.resolve(configured) : DEFAULT_LOCAL_STORAGE_ROOT;
}

function getStorageConfig(): StorageConfig {
  const baseUrl = normalizeEnvValue(ENV.forgeApiUrl);
  const apiKey = normalizeEnvValue(ENV.forgeApiKey);

  if (!baseUrl || !apiKey) {
    throw new Error(
      "Storage proxy credentials missing: set BUILT_IN_FORGE_API_URL and BUILT_IN_FORGE_API_KEY"
    );
  }

  try {
    new URL(ensureTrailingSlash(baseUrl));
  } catch {
    throw new Error(
      "Storage proxy URL is invalid: check BUILT_IN_FORGE_API_URL"
    );
  }

  return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey };
}

function buildUploadUrl(baseUrl: string, relKey: string): URL {
  const url = new URL("v1/storage/upload", ensureTrailingSlash(baseUrl));
  url.searchParams.set("path", normalizeKey(relKey));
  return url;
}

async function buildDownloadUrl(
  baseUrl: string,
  relKey: string,
  apiKey: string
): Promise<string> {
  const downloadApiUrl = new URL(
    "v1/storage/downloadUrl",
    ensureTrailingSlash(baseUrl)
  );
  downloadApiUrl.searchParams.set("path", normalizeKey(relKey));
  const response = await fetch(downloadApiUrl, {
    method: "GET",
    headers: buildAuthHeaders(apiKey),
  });
  return (await response.json()).url;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function normalizeKey(relKey: string): string {
  return relKey
    .replace(/^\/+/, "")
    .replace(/\\/g, "/")
    .replace(/\.\.(\/|\\)/g, "");
}

function keyToLocalUrl(key: string): string {
  const encoded = key
    .split("/")
    .filter((part) => part.length > 0)
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `${LOCAL_STORAGE_ROUTE_PREFIX}/${encoded}`;
}

export function resolveLocalStorageAbsolutePath(relKey: string): string {
  const key = normalizeKey(relKey);
  return path.join(getLocalStorageRoot(), key);
}

function toFormData(
  data: Buffer | Uint8Array | string,
  contentType: string,
  fileName: string
): FormData {
  const blob =
    typeof data === "string"
      ? new Blob([data], { type: contentType })
      : new Blob([data as any], { type: contentType });
  const form = new FormData();
  form.append("file", blob, fileName || "file");
  return form;
}

function buildAuthHeaders(apiKey: string): HeadersInit {
  return { Authorization: `Bearer ${apiKey}` };
}

function dataByteLength(data: Buffer | Uint8Array | string): number {
  if (typeof data === "string") return Buffer.byteLength(data);
  return data.byteLength;
}

function logLargeStorageTransfer(
  event: "storage-put" | "storage-read",
  payload: Record<string, unknown> & { bytes: number }
): void {
  if (process.env.BANDWIDTH_DIAGNOSTICS_DISABLED === "1") return;
  if (payload.bytes < getBandwidthLogThresholdBytes()) return;
  console.warn(`[bandwidth:${event}] ${JSON.stringify(payload)}`);
}

export async function storagePut(
  relKey: string,
  data: Buffer | Uint8Array | string,
  contentType = "application/octet-stream"
): Promise<{ key: string; url: string }> {
  const key = normalizeKey(relKey);
  const bytes = dataByteLength(data);
  const startedAt = Date.now();

  if (!isStorageProxyConfigured()) {
    const root = getLocalStorageRoot();
    const absolutePath = path.join(root, key);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, data);
    logLargeStorageTransfer("storage-put", {
      key,
      bytes,
      contentType,
      mode: "local",
      durationMs: Date.now() - startedAt,
    });
    return { key, url: keyToLocalUrl(key) };
  }

  const { baseUrl, apiKey } = getStorageConfig();
  const uploadUrl = buildUploadUrl(baseUrl, key);
  const formData = toFormData(data, contentType, key.split("/").pop() ?? key);
  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: buildAuthHeaders(apiKey),
    body: formData,
  });

  if (!response.ok) {
    const message = await response.text().catch(() => response.statusText);
    throw new Error(
      `Storage upload failed (${response.status} ${response.statusText}): ${message}`
    );
  }
  const url = (await response.json()).url;
  logLargeStorageTransfer("storage-put", {
    key,
    bytes,
    contentType,
    mode: "proxy",
    durationMs: Date.now() - startedAt,
  });
  return { key, url };
}

export async function storagePutFile(
  relKey: string,
  sourcePath: string,
  contentType = "application/octet-stream"
): Promise<{ key: string; url: string; bytes: number }> {
  const key = normalizeKey(relKey);
  const sourceStat = await stat(sourcePath);
  if (!sourceStat.isFile()) {
    throw new Error(`Storage upload source is not a file: ${sourcePath}`);
  }
  const bytes = sourceStat.size;
  const startedAt = Date.now();

  if (!isStorageProxyConfigured()) {
    const root = getLocalStorageRoot();
    const absolutePath = path.join(root, key);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await copyFile(sourcePath, absolutePath);
    logLargeStorageTransfer("storage-put", {
      key,
      bytes,
      contentType,
      mode: "local",
      durationMs: Date.now() - startedAt,
    });
    return { key, url: keyToLocalUrl(key), bytes };
  }

  const { baseUrl, apiKey } = getStorageConfig();
  const uploadUrl = buildUploadUrl(baseUrl, key);
  const fileName = key.split("/").pop() ?? key;
  const blob = await openAsBlob(sourcePath, { type: contentType });
  const formData = new FormData();
  formData.append("file", blob, fileName || "file");
  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: buildAuthHeaders(apiKey),
    body: formData,
  });

  if (!response.ok) {
    const message = await response.text().catch(() => response.statusText);
    throw new Error(
      `Storage upload failed (${response.status} ${response.statusText}): ${message}`
    );
  }
  const url = (await response.json()).url;
  logLargeStorageTransfer("storage-put", {
    key,
    bytes,
    contentType,
    mode: "proxy",
    durationMs: Date.now() - startedAt,
  });
  return { key, url, bytes };
}

export async function storageGet(relKey: string): Promise<{ key: string; url: string; }> {
  const key = normalizeKey(relKey);

  if (!isStorageProxyConfigured()) {
    return {
      key,
      url: keyToLocalUrl(key),
    };
  }

  const { baseUrl, apiKey } = getStorageConfig();
  return {
    key,
    url: await buildDownloadUrl(baseUrl, key, apiKey),
  };
}

export async function storageExists(relKey: string): Promise<boolean> {
  const key = normalizeKey(relKey);

  if (!isStorageProxyConfigured()) {
    try {
      await stat(resolveLocalStorageAbsolutePath(key));
      return true;
    } catch {
      return false;
    }
  }

  try {
    const { url } = await storageGet(key);
    const headResponse = await fetch(url, {
      method: "HEAD",
      signal: AbortSignal.timeout(10_000),
    });
    if (headResponse.ok) return true;
    if (headResponse.status !== 403 && headResponse.status !== 405) {
      return false;
    }
    const probeResponse = await fetch(url, {
      method: "GET",
      headers: { Range: "bytes=0-0" },
      signal: AbortSignal.timeout(10_000),
    });
    return probeResponse.ok || probeResponse.status === 206;
  } catch {
    return false;
  }
}

/**
 * Best-effort delete of a stored artifact.
 *
 * Local mode: removes the file under `getLocalStorageRoot()`. A
 * missing file is treated as success (the caller's intent — "this
 * key should not exist" — is satisfied either way).
 *
 * Proxy mode: the Forge proxy does not currently expose a DELETE
 * endpoint in this codebase (only `v1/storage/upload` and
 * `v1/storage/downloadUrl` are wired up). Returns
 * `{ deleted: false, mode: "proxy" }` and logs once at warn level
 * so the caller can surface the limitation. Proxy-side cleanup is
 * tracked as the next hardening step.
 *
 * Never throws — caller-side cleanup loops should never fail because
 * a single artifact couldn't be removed.
 */
export async function storageDelete(
  relKey: string
): Promise<{ deleted: boolean; mode: "local" | "proxy" }> {
  const key = normalizeKey(relKey);

  if (!isStorageProxyConfigured()) {
    const absolutePath = path.join(getLocalStorageRoot(), key);
    try {
      await unlink(absolutePath);
      return { deleted: true, mode: "local" };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { deleted: true, mode: "local" };
      console.warn(
        `[storage:delete] local unlink failed for key=${key}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      return { deleted: false, mode: "local" };
    }
  }

  // Forge proxy delete is not implemented; log + return without
  // touching the artifact so callers can keep operating.
  console.warn(
    `[storage:delete] proxy-mode delete not implemented for key=${key} (artifact will persist until lifecycle policy expires it)`
  );
  return { deleted: false, mode: "proxy" };
}

export async function storageReadBytes(relKey: string): Promise<Uint8Array> {
  const key = normalizeKey(relKey);
  const startedAt = Date.now();

  if (!isStorageProxyConfigured()) {
    const absolutePath = resolveLocalStorageAbsolutePath(key);
    const bytes = await readFile(absolutePath);
    const out = new Uint8Array(bytes);
    logLargeStorageTransfer("storage-read", {
      key,
      bytes: out.byteLength,
      mode: "local",
      durationMs: Date.now() - startedAt,
    });
    return out;
  }

  const { url } = await storageGet(key);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Storage read failed (${response.status} ${response.statusText}).`);
  }
  const out = new Uint8Array(await response.arrayBuffer());
  logLargeStorageTransfer("storage-read", {
    key,
    bytes: out.byteLength,
    mode: "proxy",
    durationMs: Date.now() - startedAt,
  });
  return out;
}
