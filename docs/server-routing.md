# Server routing — canonical URL → file map

**If you are editing a tRPC procedure, READ THIS FIRST.** There are
two tRPC routers in this repo with overlapping procedure names. If
you edit the wrong one, your changes are invisible to the client and
you will waste hours debugging symptoms. See
[`SESSIONS_POSTMORTEM.md`](./SESSIONS_POSTMORTEM.md) for the story of how
this cost an 8-hour session.

## The two tRPC apps

The project serves TWO separate React apps out of the same Express
server, each with its own entry HTML and tRPC client:

### 1. Main app — `client/src/main.tsx`

- **URL**: anything under `app.coherence-rmg.com/` (the root)
- **tRPC client**: `client/src/lib/trpc.ts`, typed against
  `server/routers.ts` (`AppRouter`)
- **tRPC HTTP URL**: `/api/trpc`
- **Server mount**: `server/_core/index.ts:157`
  `app.use("/api/trpc", createExpressMiddleware({ router: appRouter, createContext }))`
- **Router file**: `server/routers.ts` → `appRouter`
- **Every page under `client/src/pages/` uses this.**

### 2. Solar-REC standalone app — `client/src/solar-rec-main.tsx`

- **URL**: anything under `app.coherence-rmg.com/solar-rec/...`
- **Served by**: `server/_core/vite.ts:26` — any request starting
  with `/solar-rec/` that isn't `/solar-rec/api/` is routed to the
  solar-rec HTML shell which boots `solar-rec-main.tsx`.

The solar-rec app mounts **TWO** tRPC providers:

| Client instance | Imported type | HTTP URL | Server handler | Router file | Used by |
|---|---|---|---|---|---|
| `trpc` (same one from `@/lib/trpc`) | `AppRouter` from `server/routers.ts` | `/solar-rec/api/main-trpc` | `solarRecMainTrpcHandler` | `server/routers.ts` (`appRouter`) | `SolarRecDashboard.tsx` + every child component, including `ScheduleBImport` |
| `solarRecTrpc` | `SolarRecAppRouter` from `server/_core/solarRecRouter.ts` | `/solar-rec/api/trpc` | `solarRecTrpcHandler` | `server/_core/solarRecRouter.ts` (`solarRecAppRouter`) | `MonitoringDashboard.tsx`, `MonitoringOverview.tsx`, `SolarRecSettings.tsx` |

### Legacy dispatcher at `/solar-rec/api/trpc`

`server/_core/index.ts:146` defines a compatibility dispatcher for
older bundles that still POST to `/solar-rec/api/trpc/...`:

```ts
const SOLAR_REC_ROUTER_ROOTS = new Set([
  "auth", "users", "credentials", "monitoring", "enphaseV2",
  // "solarRecDashboard" was here — removed 2026-04-10 because the
  // duplicate copy in _core/solarRecRouter.ts is dead code.
]);

app.use("/solar-rec/api/trpc", (req, res, next) => {
  const roots = getTrpcProcedureRoots(req.path);
  if (roots.length === 0 || roots.every((r) => SOLAR_REC_ROUTER_ROOTS.has(r))) {
    return solarRecTrpcHandler(req, res, next);   // → _core/solarRecRouter.ts
  }
  return solarRecMainTrpcHandler(req, res, next); // → server/routers.ts
});
```

Anything whose procedure root is in the set goes to
`_core/solarRecRouter.ts`. Anything else falls through to
`server/routers.ts`. A legacy client calling
`/solar-rec/api/trpc/solarRecDashboard.anything` therefore now ends
up at `server/routers.ts` — the same file the modern solar-rec app
hits via `/solar-rec/api/main-trpc`.

## Canonical map — "where does X live?"

| Client call | Resolves to file | Sub-router |
|---|---|---|
| `trpc.solarRecDashboard.*` (from any page) | **`server/routers.ts`** | inline at ~line 3260 |
| `trpc.monitoring.*` (main app) | `server/routers.ts` | |
| `trpc.users.*` (main app) | `server/routers.ts` | |
| `solarRecTrpc.monitoring.*` (solar-rec app) | `server/_core/solarRecRouter.ts` | `monitoringRouter` at line 1924 |
| `solarRecTrpc.users.*` (solar-rec app) | `server/_core/solarRecRouter.ts` | `usersRouter` at line 845 |
| `solarRecTrpc.auth.*` (solar-rec app) | `server/_core/solarRecRouter.ts` | `authRouter` at line 2102 |
| `solarRecTrpc.credentials.*` (solar-rec app) | `server/_core/solarRecRouter.ts` | `credentialsRouter` at line 1722 |
| `solarRecTrpc.enphaseV2.*` (solar-rec app) | `server/_core/solarRecRouter.ts` | `enphaseV2Router` at line 2163 |
| `solarRecTrpc.solarRecDashboard.*` | **Dead code.** No client uses this path. The sub-router exists at `_core/solarRecRouter.ts:121` (`dashboardRouter`) but nothing imports it. See the deprecation banner at the top of that file. |

## Decision tree: "I need to edit a tRPC procedure"

```
I need to edit trpc.FOO.BAR

1. Is FOO one of: monitoring, users, auth, credentials, enphaseV2?
   ↓
   Is the ONLY caller in client/src/solar-rec/pages/?
   ↓ YES → Edit server/_core/solarRecRouter.ts
   ↓ NO  → Edit server/routers.ts
           (and leave _core/solarRecRouter.ts alone even if it
            also defines FOO — that copy is only reachable via
            solarRecTrpc which only the 3 solar-rec pages use)

2. Is FOO anything else (solarRecDashboard, and ~40 other sub-routers)?
   ↓ → Edit server/routers.ts. _core/solarRecRouter.ts does not
       define these and should never need to.
```

## Verification recipe

If you just edited a tRPC procedure and want to verify your edit is
actually hitting production before you claim the fix works:

1. **Add a unique string to the response.** Just a literal, e.g.
   `_checkpoint: "edit-2026-04-10-tuesday-lunch"`. Something unique
   to THIS edit, not a generic version.
2. **Deploy.**
3. **Open devtools Network tab, find the request, check the
   response JSON for your checkpoint string.**
4. **If the string is not there**, your edit is not running. Stop
   debugging the feature. Debug the deployment or the routing.
5. **If the string is there**, the edit is live. Any remaining
   symptoms are actual bugs in your new code, not deployment
   problems.

Every tRPC procedure that matters should already have a `_version`
or `_runnerVersion` marker for exactly this reason (see
`getScheduleBImportStatus` in `server/routers.ts` for the pattern).
