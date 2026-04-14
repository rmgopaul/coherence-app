import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import type { Express, Request, Response } from "express";
import * as db from "../db";
import { getSessionCookieOptions } from "./cookies";
import { sdk } from "./sdk";

function getQueryParam(req: Request, key: string): string | undefined {
  const value = req.query[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Decode the OAuth state parameter.
 * Supports two formats:
 *  - Legacy: base64(redirectUri)
 *  - Extended: base64(JSON { r: redirectUri, p?: platform })
 */
function decodeOAuthState(state: string): {
  redirectUri: string;
  platform?: string;
} {
  const decoded = atob(state);
  try {
    const parsed = JSON.parse(decoded);
    if (typeof parsed === "object" && parsed !== null && typeof parsed.r === "string") {
      return {
        redirectUri: parsed.r,
        platform: typeof parsed.p === "string" ? parsed.p : undefined,
      };
    }
  } catch {
    // Not JSON — legacy format
  }
  return { redirectUri: decoded };
}

export function registerOAuthRoutes(app: Express) {
  app.get("/api/oauth/callback", async (req: Request, res: Response) => {
    const code = getQueryParam(req, "code");
    const state = getQueryParam(req, "state");

    if (!code || !state) {
      res.status(400).json({ error: "code and state are required" });
      return;
    }

    try {
      const { redirectUri, platform } = decodeOAuthState(state);
      const tokenResponse = await sdk.exchangeCodeForToken(code, redirectUri);
      const userInfo = await sdk.getUserInfo(tokenResponse.access_token);

      if (!userInfo.openId) {
        res.status(400).json({ error: "openId missing from user info" });
        return;
      }

      // Migration: if a user exists with this email but a different openId
      // (e.g., from a previous OAuth provider), update their openId to the
      // new Google one so all integrations carry over seamlessly.
      if (userInfo.email) {
        const existingByEmail = await db.getUserByEmail(userInfo.email);
        if (existingByEmail && existingByEmail.openId !== userInfo.openId) {
          // Also clean up any orphan record that may have been created with
          // the new openId from a prior login attempt.
          const orphan = await db.getUserByOpenId(userInfo.openId);
          if (orphan && orphan.id !== existingByEmail.id) {
            console.log(`[OAuth] Removing orphan user ${orphan.id} (openId: ${userInfo.openId})`);
            await db.deleteUser(orphan.id);
          }

          console.log(
            `[OAuth] Migrating user ${existingByEmail.id} openId: ${existingByEmail.openId} -> ${userInfo.openId}`
          );
          await db.updateUserOpenId(existingByEmail.id, userInfo.openId);
        }
      }

      await db.upsertUser({
        openId: userInfo.openId,
        name: userInfo.name || null,
        email: userInfo.email ?? null,
        loginMethod: userInfo.loginMethod,
        lastSignedIn: new Date(),
      });

      // Check if user has 2FA enabled to set twoFactorVerified in the JWT
      const user = await db.getUserByOpenId(userInfo.openId);
      const totpSecret = user ? await db.getTotpSecret(user.id) : undefined;
      const has2FA = totpSecret?.verified === true;

      const sessionToken = await sdk.createSessionToken(userInfo.openId, {
        name: userInfo.name || "",
        expiresInMs: ONE_YEAR_MS,
        twoFactorVerified: !has2FA, // false if 2FA enabled (requires verification)
      });

      if (platform === "android") {
        // Android app: redirect to custom scheme with token in URL
        const callbackUrl = `coherence://auth-callback?token=${encodeURIComponent(sessionToken)}`;
        res.redirect(302, callbackUrl);
      } else {
        // Web: set session cookie and redirect to dashboard
        const cookieOptions = getSessionCookieOptions(req);
        res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: ONE_YEAR_MS });
        res.redirect(302, "/");
      }
    } catch (error) {
      console.error("[OAuth] Callback failed", error);
      res.status(500).json({ error: "OAuth callback failed" });
    }
  });
}
