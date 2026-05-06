import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

async function importStorageWithEnv(
  options: {
    forgeApiUrl?: string;
    forgeApiKey?: string;
    localStorageRoot?: string;
  } = {}
) {
  vi.resetModules();
  vi.stubEnv("BUILT_IN_FORGE_API_URL", options.forgeApiUrl ?? "");
  vi.stubEnv("BUILT_IN_FORGE_API_KEY", options.forgeApiKey ?? "");
  vi.stubEnv("LOCAL_STORAGE_ROOT", options.localStorageRoot ?? "");
  return import("./storage");
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("storageDelete", () => {
  it("removes a local file and treats an already-missing key as deleted", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "storage-delete-test-"));
    try {
      const { resolveLocalStorageAbsolutePath, storageDelete } =
        await importStorageWithEnv({ localStorageRoot: root });
      const key = "exports/test.csv";
      const absolutePath = resolveLocalStorageAbsolutePath(key);
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, "id,value\n1,ok\n", "utf8");

      await expect(readFile(absolutePath, "utf8")).resolves.toContain("ok");
      await expect(storageDelete(key)).resolves.toEqual({
        deleted: true,
        mode: "local",
      });
      await expect(stat(absolutePath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(storageDelete(key)).resolves.toEqual({
        deleted: true,
        mode: "local",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("calls the Forge proxy delete endpoint with auth and a normalized key", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const { storageDelete } = await importStorageWithEnv({
      forgeApiUrl: "https://forge.example/api",
      forgeApiKey: "secret-key",
    });

    await expect(
      storageDelete("/solar-rec-dashboard/scope-A/../exports\\job.csv")
    ).resolves.toEqual({ deleted: true, mode: "proxy" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe("/api/v1/storage/delete");
    expect(url.searchParams.get("path")).toBe(
      "solar-rec-dashboard/scope-A/exports/job.csv"
    );
    expect(init.method).toBe("DELETE");
    expect(init.headers).toEqual({ Authorization: "Bearer secret-key" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns false and logs when proxy delete returns a non-2xx response", async () => {
    const fetchMock = vi.fn(
      async () => new Response("delete route missing", { status: 404 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { storageDelete } = await importStorageWithEnv({
      forgeApiUrl: "https://forge.example",
      forgeApiKey: "secret-key",
    });

    await expect(storageDelete("exports/job.csv")).resolves.toEqual({
      deleted: false,
      mode: "proxy",
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[storage:delete] proxy delete failed")
    );
  });

  it("returns false and logs when proxy delete throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      })
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { storageDelete } = await importStorageWithEnv({
      forgeApiUrl: "https://forge.example",
      forgeApiKey: "secret-key",
    });

    await expect(storageDelete("exports/job.csv")).resolves.toEqual({
      deleted: false,
      mode: "proxy",
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("network down")
    );
  });
});
