# CLAUDE.md

## Project Overview

Coherence App (package name: `productivity-hub`) is a full-stack productivity platform built with React 19, TypeScript, tRPC, Express, and MySQL. It integrates 20+ third-party services (Google, Tesla, Todoist, OpenAI, SolarEdge, Enphase, Zendesk, Clockify, Whoop, Samsung Health, etc.) into a unified dashboard experience.

## Tech Stack

- **Frontend:** React 19, TypeScript 5.9, Tailwind CSS 4, shadcn/ui, Wouter (routing), TanStack React Query, Tiptap (rich text), Framer Motion, Recharts
- **Backend:** Express 4, tRPC 11, Drizzle ORM, MySQL/TiDB, Jose (JWT auth)
- **Build:** Vite 7 (client), esbuild (server), pnpm
- **Testing:** Vitest
- **Validation:** Zod 4
- **Serialization:** Superjson

## Quick Commands

```bash
pnpm dev          # Start dev server (tsx watch, port 3000)
pnpm build        # Build client (Vite) + server (esbuild)
pnpm start        # Run production build
pnpm check        # TypeScript type checking (tsc --noEmit)
pnpm format       # Prettier format all files
pnpm test         # Run Vitest tests
pnpm db:push      # Generate + run Drizzle migrations
```

## Project Structure

```
coherence-app/
├── client/src/
│   ├── pages/              # Route components (Dashboard, Settings, Notebook, etc.)
│   ├── components/
│   │   ├── ui/             # shadcn/ui primitives (40+ components)
│   │   ├── layout/         # AppShell, AppSidebar, CommandPalette
│   │   ├── dashboard/      # Dashboard-specific widgets
│   │   ├── notebook/       # Note editor components
│   │   └── ...             # Feature-specific component groups
│   ├── lib/                # Client utilities (trpc client, helpers)
│   ├── hooks/              # Custom React hooks
│   ├── contexts/           # React context providers (ThemeContext)
│   ├── App.tsx             # Route definitions (Wouter Switch/Route)
│   ├── main.tsx            # Entry point (tRPC + QueryClient setup)
│   └── index.css           # Global Tailwind styles + CSS variables
├── server/
│   ├── _core/              # Framework core (Express init, security, auth, tRPC setup)
│   ├── routers.ts          # Main tRPC procedures (auth, integrations, CRUD)
│   ├── db.ts               # Database helpers and queries
│   ├── services/           # External API integrations (21 service files)
│   ├── helpers/            # Server utilities (token refresh, etc.)
│   ├── oauth-routes.ts     # Express OAuth callback handlers
│   └── storage.ts          # S3 storage config
├── shared/                 # Shared types, constants, utilities
├── schema.ts               # Drizzle database schema (all tables)
├── drizzle/                # Database migrations
├── drizzle.config.ts       # Drizzle Kit configuration
├── vite.config.ts          # Vite build configuration
├── vitest.config.ts        # Test configuration
└── docs/                   # Additional documentation
```

## Architecture Patterns

### API Layer (tRPC)
- Server router defined in `server/routers.ts` (large file - ~6500 lines)
- tRPC context created in `server/_core/context.ts` (includes user from JWT)
- Client configured in `client/src/lib/trpc.ts` with batch link + Superjson
- QueryClient defaults: 60s stale time, 30min cache time

### Database (Drizzle + MySQL)
- Schema defined in root `schema.ts` using Drizzle's MySQL dialect
- IDs generated with `nanoid`
- All tables use `createdAt`/`updatedAt` timestamps
- Connection via `DATABASE_URL` env var with SSL support
- Run `pnpm db:push` to generate and apply migrations

### Authentication
- JWT-based auth via Jose library
- Manus OAuth integration (`server/_core/oauth.ts`)
- Optional PIN gate (`server/_core/pinGate.ts`)
- 2FA support with TOTP + recovery codes
- Client redirects to login on 401 responses

### Routing (Client)
- Uses Wouter (not React Router or Next.js)
- Lazy-loaded page components with React Suspense
- Routes defined in `client/src/App.tsx`

### Styling
- Tailwind CSS 4 with utility classes
- shadcn/ui component library in `client/src/components/ui/`
- CSS variables for theming (light/dark mode via ThemeContext)
- `cn()` utility from `client/src/lib/utils.ts` for class merging

## Path Aliases

Configured in `tsconfig.json`:
- `@/*` -> `./client/src/*`
- `@shared/*` -> `./shared/*`

## Code Conventions

### Formatting (Prettier)
- Double quotes (no single quotes)
- Semicolons enabled
- Trailing commas: ES5
- Print width: 80
- Tab width: 2
- Arrow parens: avoid

### Naming
- **Components/Pages:** PascalCase filenames (e.g., `Dashboard.tsx`)
- **Utilities/Services:** camelCase filenames (e.g., `trpc.ts`, `google.ts`)
- **Database columns:** camelCase in schema and queries
- **Test files:** `*.test.ts` suffix, colocated in `server/`

### TypeScript
- Strict mode enabled
- No emit (type checking only via `pnpm check`)
- Bundler module resolution
- Test files excluded from type checking

## Testing

- Framework: Vitest
- Tests are server-side only, in `server/**/*.test.ts`
- Run with `pnpm test`
- Large test suites exist for settlement engine, scheduling, note saving, and portal integrations

## Environment Variables

Key variables (see `.env.example`):
- `DATABASE_URL` - MySQL connection string
- `JWT_SECRET` - JWT signing secret
- `OPENAI_API_KEY` / `OPENAI_API_URL` / `OPENAI_MODEL` - OpenAI config
- `VITE_APP_ID`, `VITE_APP_TITLE` - App identity (VITE_ prefix = client-accessible)
- `VITE_OAUTH_PORTAL_URL`, `OAUTH_SERVER_URL` - OAuth endpoints
- `DEV_BYPASS_AUTH` - Skip auth in development
- `APP_ACCESS_PIN` - Optional PIN protection
- `PORT` - Server port (default 3000)

## Important Notes

- `server/_core/` contains framework infrastructure - modify with caution
- `server/routers.ts` is the main API file and is very large (~6500 lines); changes here should be targeted
- `server/db.ts` contains database helpers (~1700 lines)
- The wouter dependency is patched via `patches/wouter@3.7.1.patch`
- No CI/CD pipelines configured; no ESLint setup
- No Docker configuration; deploys as a Node.js process
- pnpm is the only supported package manager
