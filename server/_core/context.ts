import { COOKIE_NAME } from "@shared/const";
import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import { parse as parseCookieHeader } from "cookie";
import type { User } from "../../drizzle/schema";
import { isAuthBypassEnabled } from "./env";
import { sdk } from "./sdk";

const buildBypassUser = (): User => {
  const now = new Date();
  return {
    id: 1,
    openId: "local-dev-openid",
    name: "Local Dev User",
    email: "local@example.com",
    loginMethod: "local",
    role: "admin",
    createdAt: now,
    updatedAt: now,
    lastSignedIn: now,
  };
};

export type TrpcContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
  user: User | null;
  twoFactorVerified: boolean;
};

export async function createContext(
  opts: CreateExpressContextOptions
): Promise<TrpcContext> {
  let user: User | null = null;
  let twoFactorVerified = true;

  if (isAuthBypassEnabled()) {
    user = buildBypassUser();
    return {
      req: opts.req,
      res: opts.res,
      user,
      twoFactorVerified: true,
    };
  }

  try {
    user = await sdk.authenticateRequest(opts.req);

    // Extract twoFactorVerified from the JWT payload
    const cookies = parseCookieHeader(opts.req.headers.cookie ?? "");
    const sessionCookie = cookies[COOKIE_NAME];
    const session = await sdk.verifySession(sessionCookie);

    if (session?.twoFactorVerified === true) {
      twoFactorVerified = true;
    } else if (session?.twoFactorVerified === false) {
      twoFactorVerified = false;
    } else {
      // JWT doesn't contain twoFactorVerified (old session).
      // Check DB: if user has 2FA enabled, treat as unverified.
      const { getTotpSecret } = await import("../db");
      const totp = await getTotpSecret(user.id);
      twoFactorVerified = !(totp?.verified === true);
    }
  } catch (error) {
    // Authentication is optional for public procedures.
    user = null;
  }

  return {
    req: opts.req,
    res: opts.res,
    user,
    twoFactorVerified,
  };
}
