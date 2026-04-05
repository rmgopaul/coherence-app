const TRUTHY_ENV_FLAGS = new Set(["1", "true", "yes", "on"]);
const DISALLOWED_JWT_SECRETS = new Set([
  "your-jwt-secret-change-in-production",
  "changeme",
  "change-me",
  "password",
  "secret",
]);

export const MIN_JWT_SECRET_LENGTH = 24;

const isTruthyEnvFlag = (value: string | undefined): boolean =>
  typeof value === "string" && TRUTHY_ENV_FLAGS.has(value.trim().toLowerCase());

export const ENV = {
  appId: process.env.VITE_APP_ID ?? "",
  cookieSecret: process.env.JWT_SECRET ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  oAuthServerUrl: process.env.OAUTH_SERVER_URL ?? "",
  ownerOpenId: process.env.OWNER_OPEN_ID ?? "",
  isProduction: process.env.NODE_ENV === "production",
  forgeApiUrl: process.env.BUILT_IN_FORGE_API_URL ?? "",
  forgeApiKey: process.env.BUILT_IN_FORGE_API_KEY ?? "",
  publishedUrl: process.env.PUBLISHED_URL ?? "",
};

export const isAuthBypassEnabled = (): boolean => {
  const enabled =
    isTruthyEnvFlag(process.env.AUTH_BYPASS) ||
    isTruthyEnvFlag(process.env.DEV_BYPASS_AUTH);

  if (enabled && ENV.isProduction) {
    throw new Error(
      "AUTH_BYPASS/DEV_BYPASS_AUTH cannot be enabled when NODE_ENV=production."
    );
  }

  return enabled;
};

export const getValidatedJwtSecret = (): string => {
  const secret = ENV.cookieSecret.trim();

  if (secret.length < MIN_JWT_SECRET_LENGTH) {
    throw new Error(
      `JWT_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters.`
    );
  }

  if (DISALLOWED_JWT_SECRETS.has(secret.toLowerCase())) {
    throw new Error(
      "JWT_SECRET is using an insecure placeholder. Set a strong random value."
    );
  }

  return secret;
};

export const assertServerRuntimeSafety = (): void => {
  if (isAuthBypassEnabled()) {
    console.warn(
      "[Auth] DEV_BYPASS_AUTH/AUTH_BYPASS is enabled. Development bypass is active."
    );
  }

  getValidatedJwtSecret();
};
