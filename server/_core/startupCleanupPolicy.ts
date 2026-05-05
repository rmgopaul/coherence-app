type StartupCleanupEnv = Record<string, string | undefined>;

export function shouldRunSolarRecStartupCleanup(
  env: StartupCleanupEnv = process.env
): boolean {
  const explicitOptIn = env.SOLAR_REC_STARTUP_DB_CLEANUP?.trim().toLowerCase();
  return (
    Boolean(env.RENDER) ||
    explicitOptIn === "1" ||
    explicitOptIn === "true" ||
    explicitOptIn === "yes"
  );
}
