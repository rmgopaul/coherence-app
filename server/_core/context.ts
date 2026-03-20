import { COOKIE_NAME } from "@shared/const";
import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import { parse as parseCookieHeader } from "cookie";
import type { User } from "../../drizzle/schema";
import { sdk } from "./sdk";

const isTruthyEnvFlag = (value: string | undefined): boolean =>
  typeof value === "string" && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());

const isAuthBypassEnabled = (): boolean =>
  isTruthyEnvFlag(process.env.AUTH_BYPASS) || isTruthyEnvFlag(process.env.DEV_BYPASS_AUTH);

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
    twoFactorVerified = session?.twoFactorVerified ?? true;
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
