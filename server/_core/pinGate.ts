import type express from "express";
import { parse as parseCookieHeader } from "cookie";
import crypto from "crypto";
import { ONE_YEAR_MS } from "@shared/const";

const PIN_COOKIE_NAME = "coherence_pin_gate";

function getConfiguredPin(): string | null {
  const pin = process.env.APP_ACCESS_PIN?.trim();
  return pin && pin.length > 0 ? pin : null;
}

function hashPin(pin: string): string {
  return crypto.createHash("sha256").update(`coherence-pin:${pin}`).digest("hex");
}

function getCookieValue(req: express.Request, name: string): string | null {
  const cookies = parseCookieHeader(req.headers.cookie ?? "");
  const value = cookies[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isPinUnlocked(req: express.Request, configuredPin: string): boolean {
  const cookieValue = getCookieValue(req, PIN_COOKIE_NAME);
  if (!cookieValue) return false;

  const expected = hashPin(configuredPin);
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

function isAllowedWithoutPin(path: string): boolean {
  if (path === "/api/pin/status") return true;
  if (path === "/api/pin/verify") return true;
  if (path === "/api/pin/logout") return true;
  if (path === "/api/webhooks/samsung-health") return true;
  if (path === "/api/webhooks/whoop") return true;
  if (path.startsWith("/solar-rec/")) return true; // Solar REC has its own auth
  return false;
}

export function registerPinGate(app: express.Express) {
  app.get("/api/pin/status", (req, res) => {
    const configuredPin = getConfiguredPin();
    if (!configuredPin) {
      return res.json({ enabled: false, unlocked: true });
    }

    return res.json({
      enabled: true,
      unlocked: isPinUnlocked(req, configuredPin),
    });
  });

  app.post("/api/pin/verify", (req, res) => {
    const configuredPin = getConfiguredPin();
    if (!configuredPin) {
      return res.json({ enabled: false, unlocked: true });
    }

    const submittedPin = typeof req.body?.pin === "string" ? req.body.pin.trim() : "";
    if (!submittedPin) {
      return res.status(400).json({ error: "PIN is required" });
    }

    const submittedHash = hashPin(submittedPin);
    const expectedHash = hashPin(configuredPin);
    const submittedBuf = Buffer.from(submittedHash, "utf8");
    const expectedBuf = Buffer.from(expectedHash, "utf8");
    const isMatch =
      submittedBuf.length === expectedBuf.length &&
      crypto.timingSafeEqual(submittedBuf, expectedBuf);

    if (!isMatch) {
      return res.status(401).json({ error: "Invalid PIN" });
    }

    res.cookie(PIN_COOKIE_NAME, expectedHash, {
      httpOnly: true,
      sameSite: "lax",
      secure: shouldUseSecureCookie(req),
      path: "/",
      maxAge: ONE_YEAR_MS,
    });

    return res.json({ enabled: true, unlocked: true });
  });

  app.post("/api/pin/logout", (req, res) => {
    res.clearCookie(PIN_COOKIE_NAME, {
      path: "/",
      sameSite: "lax",
      secure: shouldUseSecureCookie(req),
    });
    return res.json({ success: true });
  });

  app.use((req, res, next) => {
    const configuredPin = getConfiguredPin();
    if (!configuredPin) return next();

    if (isAllowedWithoutPin(req.path)) return next();
    if (isPinUnlocked(req, configuredPin)) return next();

    if (req.path.startsWith("/api/")) {
      return res.status(423).json({
        error: "PIN_REQUIRED",
        message: "Enter PIN to unlock API access",
      });
    }

    return next();
  });
}

