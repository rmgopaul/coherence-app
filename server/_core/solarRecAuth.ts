import type express from "express";
import { parse as parseCookieHeader } from "cookie";
import axios from "axios";
import { SignJWT, jwtVerify } from "jose";
import { ONE_YEAR_MS, SOLAR_REC_SESSION_COOKIE, AXIOS_TIMEOUT_MS } from "@shared/const";
import { ENV, getValidatedJwtSecret } from "./env";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SolarRecSessionPayload = {
  solarRecUserId: number;
  email: string;
  role: string;
};

export type SolarRecAuthenticatedUser = {
  id: number;
  email: string;
  name: string | null;
  role: "owner" | "admin" | "operator" | "viewer";
  avatarUrl: string | null;
};

type GoogleUserInfo = {
  id: string;
  email: string;
  name: string;
  picture?: string;
};

// ---------------------------------------------------------------------------
// JWT helpers (reuse same JWT_SECRET as main app, but separate cookie)
// ---------------------------------------------------------------------------

function getSessionSecret() {
  const secret = getValidatedJwtSecret();
  return new TextEncoder().encode(secret);
}

async function createSolarRecSessionToken(
  payload: SolarRecSessionPayload
): Promise<string> {
  const issuedAt = Date.now();
  const expirationSeconds = Math.floor((issuedAt + ONE_YEAR_MS) / 1000);
  const secretKey = getSessionSecret();

  return new SignJWT({
    solarRecUserId: payload.solarRecUserId,
    email: payload.email,
    role: payload.role,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setExpirationTime(expirationSeconds)
    .sign(secretKey);
}

async function verifySolarRecSession(
  cookieValue: string | undefined | null
): Promise<SolarRecSessionPayload | null> {
  if (!cookieValue) return null;

  try {
    const secretKey = getSessionSecret();
    const { payload } = await jwtVerify(cookieValue, secretKey, {
      algorithms: ["HS256"],
    });

    const { solarRecUserId, email, role } = payload as Record<string, unknown>;
    if (
      typeof solarRecUserId !== "number" ||
      typeof email !== "string" ||
      typeof role !== "string"
    ) {
      return null;
    }

    return { solarRecUserId, email, role };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------

function getCookieValue(req: express.Request, name: string): string | null {
  const cookies = parseCookieHeader(req.headers.cookie ?? "");
  const value = cookies[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function shouldUseSecureCookie(req: express.Request): boolean {
  if (process.env.NODE_ENV === "production") return true;
  if (req.secure) return true;
  const forwardedProto = req.header("x-forwarded-proto");
  return typeof forwardedProto === "string" && forwardedProto.split(",")[0].trim() === "https";
}

function setSolarRecSessionCookie(
  res: express.Response,
  req: express.Request,
  token: string
) {
  res.cookie(SOLAR_REC_SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: shouldUseSecureCookie(req),
    path: "/solar-rec/",
    maxAge: ONE_YEAR_MS,
  });
}

function clearSolarRecSessionCookie(
  res: express.Response,
  req: express.Request
) {
  res.clearCookie(SOLAR_REC_SESSION_COOKIE, {
    path: "/solar-rec/",
    sameSite: "lax",
    secure: shouldUseSecureCookie(req),
  });
}

// ---------------------------------------------------------------------------
// Google OAuth helpers
// ---------------------------------------------------------------------------

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";

async function exchangeCodeForTokens(
  code: string,
  redirectUri: string
): Promise<{ access_token: string; id_token?: string }> {
  const { data } = await axios.post(
    GOOGLE_TOKEN_URL,
    new URLSearchParams({
      client_id: ENV.googleClientId,
      client_secret: ENV.googleClientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }).toString(),
    {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: AXIOS_TIMEOUT_MS,
    }
  );
  return data;
}

async function getGoogleUserInfo(accessToken: string): Promise<GoogleUserInfo> {
  const { data } = await axios.get<GoogleUserInfo>(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: AXIOS_TIMEOUT_MS,
  });
  return data;
}

// ---------------------------------------------------------------------------
// Public: authenticate a request by reading the solar-rec JWT cookie
// ---------------------------------------------------------------------------

export async function authenticateSolarRecRequest(
  req: express.Request
): Promise<SolarRecAuthenticatedUser | null> {
  const cookieValue = getCookieValue(req, SOLAR_REC_SESSION_COOKIE);
  const session = await verifySolarRecSession(cookieValue);
  if (!session) return null;

  // Load user from DB to get current role/active status
  const { getSolarRecUserById } = await import("../db");
  const user = await getSolarRecUserById(session.solarRecUserId);
  if (!user || !user.isActive) return null;

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role as SolarRecAuthenticatedUser["role"],
    avatarUrl: user.avatarUrl,
  };
}

// ---------------------------------------------------------------------------
// Deprecated: backward compat for existing solarRecRouter.ts import
// ---------------------------------------------------------------------------

export function getSolarRecOwnerUserId(): number {
  const envValue = process.env.SOLAR_REC_OWNER_USER_ID;
  if (envValue) {
    const parsed = parseInt(envValue, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 1;
}

const SOLAR_PROVIDER_HINTS = new Set([
  "enphase-v4",
  "enphase-v2",
  "solaredge-monitoring",
  "fronius-solar",
  "generac-pwrfleet",
  "hoymiles-smiles",
  "goodwe-sems",
  "solis-cloud",
  "locus-energy",
  "apsystems-ema",
  "solar-log",
  "growatt-server",
  "egauge-monitoring",
  "ennexos-cloud",
  "sunpower",
]);

let resolvedOwnerUserIdCache: number | null = null;
let resolvingOwnerUserIdPromise: Promise<number> | null = null;

/**
 * Resolve the default scope ID for the Solar REC dashboard.
 *
 * For now this is a 1:1 mapping from the owner user ID — single-scope
 * model. The scope ID is a stable string that will be used as the
 * tenancy key for all new normalized dataset tables. Using a dedicated
 * scope ID (rather than raw userId) gives us a migration path to
 * multi-scope without changing every query.
 */
export async function resolveSolarRecScopeId(): Promise<string> {
  const ownerUserId = await resolveSolarRecOwnerUserId();
  return `scope-user-${ownerUserId}`;
}

export async function resolveSolarRecOwnerUserId(): Promise<number> {
  const configured = getSolarRecOwnerUserId();
  if (process.env.SOLAR_REC_OWNER_USER_ID?.trim()) {
    return configured;
  }

  if (resolvedOwnerUserIdCache) return resolvedOwnerUserIdCache;
  if (resolvingOwnerUserIdPromise) return resolvingOwnerUserIdPromise;

  resolvingOwnerUserIdPromise = (async () => {
    try {
      const { listUsers, getUserIntegrations } = await import("../db");
      const users = await listUsers();
      if (users.length === 0) return configured;

      const scored = await Promise.all(
        users.map(async (user) => {
          const integrations = await getUserIntegrations(user.id);
          const score = integrations.reduce((total, integration) => {
            const provider = integration.provider ?? "";
            if (!provider) return total;
            if (SOLAR_PROVIDER_HINTS.has(provider)) return total + 3;
            const lower = provider.toLowerCase();
            if (
              lower.includes("solar") ||
              lower.includes("enphase") ||
              lower.includes("fronius") ||
              lower.includes("hoymiles") ||
              lower.includes("apsystems") ||
              lower.includes("growatt") ||
              lower.includes("solis") ||
              lower.includes("egauge") ||
              lower.includes("locus")
            ) {
              return total + 1;
            }
            return total;
          }, 0);

          return { userId: user.id, score };
        })
      );

      scored.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.userId - b.userId;
      });

      const winner = scored[0]?.userId ?? configured;
      resolvedOwnerUserIdCache = winner;
      return winner;
    } catch {
      return configured;
    } finally {
      resolvingOwnerUserIdPromise = null;
    }
  })();

  return resolvingOwnerUserIdPromise;
}

// ---------------------------------------------------------------------------
// Register Express routes for Solar REC auth
// ---------------------------------------------------------------------------

export function registerSolarRecAuth(app: express.Express) {

  // --- Status ---
  app.get("/solar-rec/api/auth/status", async (req, res) => {
    const user = await authenticateSolarRecRequest(req);
    if (user) {
      return res.json({
        authenticated: true,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          avatarUrl: user.avatarUrl,
        },
      });
    }
    return res.json({ authenticated: false, user: null });
  });

  // --- Google OAuth: redirect to consent screen ---
  app.get("/solar-rec/api/auth/google", (req, res) => {
    const protocol = shouldUseSecureCookie(req) ? "https" : req.protocol;
    const host = req.get("host") ?? "localhost:3000";
    const redirectUri = `${protocol}://${host}/solar-rec/api/auth/google/callback`;

    const params = new URLSearchParams({
      client_id: ENV.googleClientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid email profile",
      access_type: "online",
      prompt: "select_account",
      state: Buffer.from(redirectUri).toString("base64"),
    });

    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
  });

  // --- Google OAuth callback ---
  app.get("/solar-rec/api/auth/google/callback", async (req, res) => {
    try {
      const { code, state } = req.query;
      if (typeof code !== "string" || typeof state !== "string") {
        return res.status(400).send("Missing code or state parameter");
      }

      const redirectUri = Buffer.from(state, "base64").toString("utf8");
      const tokens = await exchangeCodeForTokens(code, redirectUri);
      const googleUser = await getGoogleUserInfo(tokens.access_token);
      const email = googleUser.email?.toLowerCase().trim();

      if (!email) {
        return res.status(400).send("Google account has no email address");
      }

      const {
        getSolarRecUserByEmail,
        getSolarRecUserByGoogleOpenId,
        createSolarRecUser,
        updateSolarRecUserLastSignIn,
        getSolarRecInviteByEmail,
        markSolarRecInviteUsed,
      } = await import("../db");

      // Try to find existing user by Google OpenID or email
      let user = await getSolarRecUserByGoogleOpenId(googleUser.id);
      if (!user) {
        user = await getSolarRecUserByEmail(email);
      }

      if (user) {
        if (!user.isActive) {
          return res.status(403).send("Account is deactivated. Contact an admin.");
        }
        // Update last sign-in and link Google OpenID if not yet set
        await updateSolarRecUserLastSignIn(user.id, googleUser.id, googleUser.name, googleUser.picture);
      } else {
        // No existing user — check for a pending invite
        const invite = await getSolarRecInviteByEmail(email);
        if (!invite) {
          return res.status(403).send(
            "You are not authorized to access Solar REC. Ask an admin for an invite."
          );
        }

        // Create the user from the invite
        user = await createSolarRecUser({
          email,
          name: googleUser.name,
          googleOpenId: googleUser.id,
          avatarUrl: googleUser.picture ?? null,
          role: invite.role as "admin" | "operator" | "viewer",
          invitedBy: invite.createdBy,
        });

        await markSolarRecInviteUsed(invite.id);
      }

      // Create JWT session
      const token = await createSolarRecSessionToken({
        solarRecUserId: user.id,
        email: user.email,
        role: user.role,
      });

      setSolarRecSessionCookie(res, req, token);
      res.redirect("/solar-rec/");
    } catch (error) {
      console.error("[SolarRecAuth] Google callback error:", error);
      res.status(500).send("Authentication failed. Please try again.");
    }
  });

  // --- Logout ---
  app.post("/solar-rec/api/auth/logout", (req, res) => {
    clearSolarRecSessionCookie(res, req);
    return res.json({ success: true });
  });
}
