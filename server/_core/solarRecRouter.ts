import { initTRPC, TRPCError } from "@trpc/server";
import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import superjson from "superjson";
import { z } from "zod";
import { isSolarRecAuthenticated, getSolarRecOwnerUserId } from "./solarRecAuth";

type SolarRecContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
  userId: number;
};

export async function createSolarRecContext(
  opts: CreateExpressContextOptions
): Promise<SolarRecContext> {
  if (!isSolarRecAuthenticated(opts.req)) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Solar REC authentication required" });
  }

  return {
    req: opts.req,
    res: opts.res,
    userId: getSolarRecOwnerUserId(),
  };
}

const t = initTRPC.context<SolarRecContext>().create({
  transformer: superjson,
});

const solarRecProcedure = t.procedure;

export const solarRecAppRouter = t.router({
  solarRecDashboard: t.router({
    getState: solarRecProcedure.query(async ({ ctx }) => {
      const key = `solar-rec-dashboard/${ctx.userId}/state.json`;
      const dbStorageKey = "state";

      try {
        const { getSolarRecDashboardPayload } = await import("../db");
        const payload = await getSolarRecDashboardPayload(ctx.userId, dbStorageKey);
        if (payload) return { key, payload };
      } catch {
        // Fall back to storage proxy.
      }

      try {
        const { storageGet } = await import("../storage");
        const { url } = await storageGet(key);
        const response = await fetch(url);
        if (!response.ok) return null;
        const payload = await response.text();
        if (!payload) return null;
        return { key, payload };
      } catch {
        return null;
      }
    }),

    saveState: solarRecProcedure
      .input(z.object({ payload: z.string() }))
      .mutation(async ({ ctx, input }) => {
        const key = `solar-rec-dashboard/${ctx.userId}/state.json`;
        const dbStorageKey = "state";
        let persistedToDatabase = false;

        try {
          const { saveSolarRecDashboardPayload } = await import("../db");
          persistedToDatabase = await saveSolarRecDashboardPayload(ctx.userId, dbStorageKey, input.payload);
        } catch {
          persistedToDatabase = false;
        }

        try {
          const { storagePut } = await import("../storage");
          await storagePut(key, input.payload, "application/json");
          return { success: true, key, persistedToDatabase, storageSynced: true };
        } catch (storageError) {
          if (persistedToDatabase) {
            return { success: true, key, persistedToDatabase, storageSynced: false };
          }
          throw storageError;
        }
      }),

    getDataset: solarRecProcedure
      .input(z.object({ key: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/) }))
      .mutation(async ({ ctx, input }) => {
        const key = `solar-rec-dashboard/${ctx.userId}/datasets/${input.key}.json`;
        const dbStorageKey = `dataset:${input.key}`;

        try {
          const { getSolarRecDashboardPayload } = await import("../db");
          const payload = await getSolarRecDashboardPayload(ctx.userId, dbStorageKey);
          if (payload) return { key, payload };
        } catch {
          // Fall back to storage proxy.
        }

        try {
          const { storageGet } = await import("../storage");
          const { url } = await storageGet(key);
          const response = await fetch(url);
          if (!response.ok) return null;
          const payload = await response.text();
          if (!payload) return null;
          return { key, payload };
        } catch {
          return null;
        }
      }),

    saveDataset: solarRecProcedure
      .input(z.object({
        key: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
        payload: z.string(),
      }))
      .mutation(async ({ ctx, input }) => {
        const key = `solar-rec-dashboard/${ctx.userId}/datasets/${input.key}.json`;
        const dbStorageKey = `dataset:${input.key}`;
        let persistedToDatabase = false;

        try {
          const { saveSolarRecDashboardPayload } = await import("../db");
          persistedToDatabase = await saveSolarRecDashboardPayload(ctx.userId, dbStorageKey, input.payload);
        } catch {
          persistedToDatabase = false;
        }

        try {
          const { storagePut } = await import("../storage");
          await storagePut(key, input.payload, "application/json");
          return { success: true, key, persistedToDatabase, storageSynced: true };
        } catch (storageError) {
          if (persistedToDatabase) {
            return { success: true, key, persistedToDatabase, storageSynced: false };
          }
          throw storageError;
        }
      }),
  }),
});

export type SolarRecAppRouter = typeof solarRecAppRouter;
