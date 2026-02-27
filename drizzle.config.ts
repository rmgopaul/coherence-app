import { defineConfig } from "drizzle-kit";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required to run drizzle commands");
}

const connectionUrl = new URL(connectionString);
const database = connectionUrl.pathname.replace(/^\//, "");
if (!database) {
  throw new Error("DATABASE_URL must include a database name");
}

const port = connectionUrl.port ? Number(connectionUrl.port) : 3306;
if (!Number.isFinite(port)) {
  throw new Error("DATABASE_URL contains an invalid port");
}

const sslEnabled = !["false", "0", "off"].includes(
  (process.env.DATABASE_SSL ?? "").trim().toLowerCase()
);
const sslRejectUnauthorized = !["false", "0", "off"].includes(
  (process.env.DATABASE_SSL_REJECT_UNAUTHORIZED ?? "").trim().toLowerCase()
);

export default defineConfig({
  schema: "./drizzle/schema.ts",
  out: "./drizzle",
  dialect: "mysql",
  dbCredentials: {
    host: connectionUrl.hostname,
    port,
    user: connectionUrl.username
      ? decodeURIComponent(connectionUrl.username)
      : undefined,
    password: connectionUrl.password
      ? decodeURIComponent(connectionUrl.password)
      : undefined,
    database,
    ...(sslEnabled
      ? {
          ssl: {
            minVersion: "TLSv1.2",
            rejectUnauthorized: sslRejectUnauthorized,
          },
        }
      : {}),
  },
});
