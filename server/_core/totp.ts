import crypto from "crypto";
import * as OTPAuth from "otpauth";
import QRCode from "qrcode";

const APP_NAME = "Coherence";
const TOTP_DIGITS = 6;
const TOTP_PERIOD = 30;
const TOTP_ALGORITHM = "SHA1";
const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_LENGTH = 8;

export function generateTotpSecret(userEmail: string): {
  secret: string;
  otpauthUri: string;
} {
  const totp = new OTPAuth.TOTP({
    issuer: APP_NAME,
    label: userEmail || "user",
    algorithm: TOTP_ALGORITHM,
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD,
  });

  return {
    secret: totp.secret.base32,
    otpauthUri: totp.toString(),
  };
}

export function verifyTotpCode(secret: string, code: string): boolean {
  const totp = new OTPAuth.TOTP({
    issuer: APP_NAME,
    algorithm: TOTP_ALGORITHM,
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD,
    secret: OTPAuth.Secret.fromBase32(secret),
  });

  // window: 1 allows +/- 30s drift
  const delta = totp.validate({ token: code, window: 1 });
  return delta !== null;
}

export function generateRecoveryCodes(): string[] {
  const codes: string[] = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
    const buf = crypto.randomBytes(RECOVERY_CODE_LENGTH);
    // Generate alphanumeric codes like "A1B2C3D4"
    const code = buf
      .toString("base64url")
      .slice(0, RECOVERY_CODE_LENGTH)
      .toUpperCase();
    codes.push(code);
  }
  return codes;
}

export function hashRecoveryCode(code: string): string {
  return crypto
    .createHash("sha256")
    .update(`recovery:${code.toUpperCase().trim()}`)
    .digest("hex");
}

export async function generateQrDataUrl(otpauthUri: string): Promise<string> {
  return QRCode.toDataURL(otpauthUri, { width: 256, margin: 2 });
}
