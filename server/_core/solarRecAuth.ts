import type express from "express";
import { parse as parseCookieHeader } from "cookie";
import crypto from "crypto";
import { ONE_YEAR_MS, SOLAR_REC_SESSION_COOKIE } from "@shared/const";

function getSolarRecPassword(): string | null {
  const pw = process.env.SOLAR_REC_ACCESS_PASSWORD?.trim();
  return pw && pw.length > 0 ? pw : null;
}

function hashPassword(pw: string): string {
  return crypto.createHash("sha256").update(`solar-rec:${pw}`).digest("hex");
}

function getCookieValue(req: express.Request, name: string): string | null {
  const cookies = parseCookieHeader(req.headers.cookie ?? "");
  const value = cookies[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function isSolarRecAuthenticated(req: express.Request): boolean {
  const configuredPw = getSolarRecPassword();
  if (!configuredPw) return true; // No password configured = open access

  const cookieValue = getCookieValue(req, SOLAR_REC_SESSION_COOKIE);
  if (!cookieValue) return false;

  const expected = hashPassword(configuredPw);
  const provided = Buffer.from(cookieValue, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  if (provided.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(provided, expectedBuf);
}

function shouldUseSecureCookie(req: express.Request): boolean {
  if (process.env.NODE_ENV === "production") return true;
  if (req.secure) return true;
  const forwardedProto = req.header("x-forwarded-proto");
  return typeof forwardedProto === "string" && forwardedProto.split(",")[0].trim() === "https";
}

export function getSolarRecOwnerUserId(): number {
  const envValue = process.env.SOLAR_REC_OWNER_USER_ID;
  if (envValue) {
    const parsed = parseInt(envValue, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 1; // default
}

export function registerSolarRecAuth(app: express.Express) {
  app.get("/solar-rec/api/auth/status", (req, res) => {
    const configuredPw = getSolarRecPassword();
    if (!configuredPw) {
      return res.json({ enabled: false, authenticated: true });
    }

    return res.json({
      enabled: true,
      authenticated: isSolarRecAuthenticated(req),
    });
  });

  app.post("/solar-rec/api/auth/login", (req, res) => {
    const configuredPw = getSolarRecPassword();
    if (!configuredPw) {
      return res.json({ success: true });
    }

    const submitted = typeof req.body?.password === "string" ? req.body.password.trim() : "";
    if (!submitted) {
      return res.status(400).json({ error: "Password is required" });
    }

    const submittedHash = hashPassword(submitted);
    const expectedHash = hashPassword(configuredPw);
    const submittedBuf = Buffer.from(submittedHash, "utf8");
    const expectedBuf = Buffer.from(expectedHash, "utf8");
    const isMatch =
      submittedBuf.length === expectedBuf.length &&
      crypto.timingSafeEqual(submittedBuf, expectedBuf);

    if (!isMatch) {
      return res.status(401).json({ error: "Invalid password" });
    }

    res.cookie(SOLAR_REC_SESSION_COOKIE, expectedHash, {
      httpOnly: true,
      sameSite: "lax",
      secure: shouldUseSecureCookie(req),
      path: "/solar-rec/",
      maxAge: ONE_YEAR_MS,
    });

    return res.json({ success: true });
  });

  app.post("/solar-rec/api/auth/logout", (req, res) => {
    res.clearCookie(SOLAR_REC_SESSION_COOKIE, {
      path: "/solar-rec/",
      sameSite: "lax",
      secure: shouldUseSecureCookie(req),
    });
    return res.json({ success: true });
  });
}
