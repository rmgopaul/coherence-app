// Storage helpers:
// 1) Forge proxy when BUILT_IN_FORGE_API_URL + BUILT_IN_FORGE_API_KEY are present.
// 2) Local filesystem fallback when Forge credentials are missing.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
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

export async function storagePut(
  relKey: string,
  data: Buffer | Uint8Array | string,
  contentType = "application/octet-stream"
): Promise<{ key: string; url: string }> {
  const key = normalizeKey(relKey);

  if (!isStorageProxyConfigured()) {
    const root = getLocalStorageRoot();
    const absolutePath = path.join(root, key);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, data);
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
  return { key, url };
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

export async function storageReadBytes(relKey: string): Promise<Uint8Array> {
  const key = normalizeKey(relKey);

  if (!isStorageProxyConfigured()) {
    const absolutePath = resolveLocalStorageAbsolutePath(key);
    const bytes = await readFile(absolutePath);
    return new Uint8Array(bytes);
  }

  const { url } = await storageGet(key);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Storage read failed (${response.status} ${response.statusText}).`);
  }
  return new Uint8Array(await response.arrayBuffer());
}
