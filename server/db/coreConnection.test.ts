import { afterEach, describe, expect, it, vi } from "vitest";

const originalDatabaseUrl = process.env.DATABASE_URL;

function makePool(query: ReturnType<typeof vi.fn>) {
  return {
    end: vi.fn(),
    promise: vi.fn(() => ({ query })),
  };
}

async function loadCoreWithPool(pool: ReturnType<typeof makePool>) {
  vi.resetModules();
  const dbInstance = { marker: "db" };
  const createPool = vi.fn(() => pool);
  const drizzle = vi.fn(() => dbInstance);

  vi.doMock("mysql2", () => ({ createPool }));
  vi.doMock("drizzle-orm/mysql2", () => ({ drizzle }));

  process.env.DATABASE_URL = "mysql://user:pass@example.com:4000/app";
  const core = await import("./_core");
  return { core, createPool, drizzle, dbInstance };
}

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("mysql2");
  vi.doUnmock("drizzle-orm/mysql2");
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  delete process.env.DATABASE_CONNECT_TIMEOUT_MS;
  delete process.env.DATABASE_POOL_CONNECTION_LIMIT;
  delete process.env.DATABASE_POOL_MAX_IDLE;
  delete process.env.DATABASE_POOL_IDLE_TIMEOUT_MS;
  delete process.env.DATABASE_POOL_QUEUE_LIMIT;
});

describe("getDb", () => {
  it("single-flights concurrent pool initialization", async () => {
    let resolveQuery: ((value: unknown) => void) | undefined;
    const query = vi.fn(
      () =>
        new Promise(resolve => {
          resolveQuery = resolve;
        })
    );
    const pool = makePool(query);
    const { core, createPool, drizzle, dbInstance } =
      await loadCoreWithPool(pool);

    const calls = [core.getDb(), core.getDb(), core.getDb()];

    expect(createPool).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(1);
    expect(resolveQuery).toBeDefined();

    resolveQuery?.([]);
    await expect(Promise.all(calls)).resolves.toEqual([
      dbInstance,
      dbInstance,
      dbInstance,
    ]);
    expect(drizzle).toHaveBeenCalledTimes(1);
  });

  it("uses finite default pool waits so request bursts fail before proxy timeout", async () => {
    const query = vi.fn(async () => []);
    const pool = makePool(query);
    const { core, createPool } = await loadCoreWithPool(pool);

    await expect(core.getDb()).resolves.toBeTruthy();

    expect(createPool).toHaveBeenCalledWith(
      expect.objectContaining({
        connectTimeout: 5_000,
        connectionLimit: 10,
        enableKeepAlive: true,
        idleTimeout: 60_000,
        maxIdle: 10,
        queueLimit: 50,
      })
    );
  });
});
