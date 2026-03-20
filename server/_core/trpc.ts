import { NOT_ADMIN_ERR_MSG, UNAUTHED_ERR_MSG, TWO_FACTOR_REQUIRED_MSG } from '@shared/const';
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure;

// Requires a valid session but does NOT require 2FA verification.
// Used for 2FA status/verify routes that need to run before 2FA is complete.
const requireUserOnly = t.middleware(async opts => {
  const { ctx, next } = opts;

  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  }

  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
    },
  });
});

export const twoFactorPendingProcedure = t.procedure.use(requireUserOnly);

// Requires a valid session AND 2FA verification (if enabled).
const requireUserAnd2FA = t.middleware(async opts => {
  const { ctx, next } = opts;

  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  }

  if (!ctx.twoFactorVerified) {
    throw new TRPCError({ code: "FORBIDDEN", message: TWO_FACTOR_REQUIRED_MSG });
  }

  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
    },
  });
});

export const protectedProcedure = t.procedure.use(requireUserAnd2FA);

export const adminProcedure = t.procedure.use(
  t.middleware(async opts => {
    const { ctx, next } = opts;

    if (!ctx.user || ctx.user.role !== 'admin') {
      throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
    }

    if (!ctx.twoFactorVerified) {
      throw new TRPCError({ code: "FORBIDDEN", message: TWO_FACTOR_REQUIRED_MSG });
    }

    return next({
      ctx: {
        ...ctx,
        user: ctx.user,
      },
    });
  }),
);
