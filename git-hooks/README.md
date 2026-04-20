# Git hooks

Committed git hooks that catch classes of bugs that our TypeScript
type-checker and Vitest suite miss. Activated by the `prepare`
script in `package.json` on `pnpm install`, which runs:

```bash
git config core.hooksPath git-hooks
```

## Currently shipped

### `pre-push`

Runs `tsc --noEmit --incremental false` and `vite build` before
allowing a push to any remote. Blocks the push if either fails.

**Why this exists.** On 2026-04-19 a Claude-Code session pushed
commit `a97d28e` that renamed `Dashboard.tsx` → `DashboardLegacy.tsx`
and added imports of `@/features/supplements/supplements.helpers` —
but never `git add`ed the helpers file. The commit passed every
on-developer-machine check (the file existed on that developer's
disk), tsc passed (same reason), vitest passed (same reason),
gradle passed (Android-only). Render's fresh-clone build was the
first machine to actually try to resolve the import against the
git tree, and it blew up:

```
[vite:load-fallback] Could not load
  /opt/render/project/src/client/src/features/supplements/supplements.helpers
  (imported by client/src/features/dashboard/DashboardLegacy.tsx):
  ENOENT: no such file or directory
```

`vite build` — which is what Render runs — WOULD have caught this
locally. It wasn't run. This hook makes it get run.

## Bypass

Emergency: `git push --no-verify`. Don't make a habit of it.

## Opt-out

If you need hooks disabled permanently for this checkout:

```bash
git config --unset core.hooksPath
```

Next `pnpm install` will re-enable them unless you also remove the
`prepare` script from `package.json`.
