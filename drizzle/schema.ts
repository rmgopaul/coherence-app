/**
 * Schema entrypoint.
 *
 * Historically this was a single 1,453-line file. Tables are now split
 * by domain across `drizzle/schemas/{auth,core,integrations,solar}.ts`
 * with a barrel at `drizzle/schemas/index.ts`.
 *
 * This file remains as the published import path so that:
 *   - the 29 callsites that `import from "../drizzle/schema"` don't have
 *     to move, and
 *   - `drizzle-kit generate` (configured in `drizzle.config.ts` to scan
 *     `./drizzle/schema.ts`) still has a single entrypoint that
 *     transitively reaches every table.
 *
 * Add new tables to the matching split module, not here.
 */

export * from "./schemas";
