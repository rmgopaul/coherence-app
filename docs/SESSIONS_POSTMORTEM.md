# Session Post-mortems

Chronological record of sessions where Claude went seriously off-track,
what the actual root cause was, and the specific prevention added to
CLAUDE.md / docs so it doesn't repeat.

Each entry is a hard-won lesson paid for in hours of debugging. Don't
let them be wasted.

---

## 2026-04-10 — Schedule B scanner: eight hours chasing the wrong file

### What the user experienced

1. User uploaded a folder of 500 Schedule B PDFs to the Delivery Tracker.
2. Scanner claimed to process files, but the tracker UI showed
   `Server processed N files, 0 result rows in DB`.
3. Over ~10 commits and ~4 hours, Claude shipped race-condition fixes,
   persistence fixes, migration fixes, a pdfjs font-loading fix, and
   eventually a total teardown-and-rebuild of the runner mirroring the
   working Contract Scraper. **Every single server-side change went to
   the wrong file.** The user's production server was running the
   original pre-session code for every test.
4. User became understandably frustrated, demanded a total reset.
5. Claude re-read its own CLAUDE.md, discovered the warning
   "`server/_core/` is framework code managed by the platform — avoid
   modifying these files", concluded the file it had been editing was
   dead, and ported every fix to `server/routers.ts`.
6. The rebuild finally worked. Raw DB state confirmed
   `successCount: 4, resultRowTotal: 4` with valid GATS IDs extracted.

### Actual root cause — the dual-router trap

The project has **two tRPC routers** both of which expose a
`solarRecDashboard.*` sub-router with overlapping procedure names:

| File | Exported as | When it's live | Who calls it |
|---|---|---|---|
| `productivity-hub/server/routers.ts` | `appRouter` | `/api/trpc` (main app) and `/solar-rec/api/main-trpc` (solar-rec app) | `trpc` client in `client/src/lib/trpc.ts` — used by `SolarRecDashboard.tsx` and its children (`ScheduleBImport` included). This is THE live file for Schedule B. |
| `productivity-hub/server/_core/solarRecRouter.ts` | `solarRecAppRouter` | `/solar-rec/api/trpc` | `solarRecTrpc` client in `client/src/solar-rec/solarRecTrpc.ts` — used ONLY by `MonitoringDashboard`, `MonitoringOverview`, `SolarRecSettings`, and they only call `trpc.monitoring.*` and `trpc.users.*`. The `solarRecDashboard` sub-router inside this file is **dead code** — no client actually calls it. |

The HTTP dispatcher at `server/_core/index.ts:146` routes
`/solar-rec/api/trpc/solarRecDashboard.*` to `_core/solarRecRouter.ts`,
but no client is configured to hit that URL for `solarRecDashboard.*`
procedures. It's a legacy artifact.

### What Claude got wrong

1. **Read the CLAUDE.md bullet and took it too literally.** The rule
   was "`server/_core/` is framework code managed by the platform —
   avoid modifying these files". Claude interpreted this as "don't
   touch _core/ at all" without first verifying whether any routes
   actually pointed at it. In reality, `_core/` has a mix of
   legitimate live code (solar-rec auth, monitoring, express
   middleware setup) AND dead code (the duplicated
   solarRecDashboard sub-router).

2. **Never verified the HTTP route path.** When the client calls
   `trpc.solarRecDashboard.getScheduleBImportStatus`, which file on
   the server actually executes? Claude never traced the client's
   tRPC URL config → server mount point → router file. Instead it
   inferred based on file names and directory structure, which is
   how it ended up editing the wrong file.

3. **Didn't add a version marker or debug endpoint early.** The
   single most useful diagnostic — "is my code even running?" —
   was the last thing Claude added (commit `90a8231`), after ~10
   commits of chasing symptoms. Had it been the FIRST thing, the
   entire session would have been 30 minutes instead of 8 hours.
   The raw DB state button + `_runnerVersion` marker that finally
   proved the scanner working should have been step 1, not step N.

4. **Chased stderr noise (pdfjs font warnings) as if they were
   fatal errors.** The Contract Scraper uses identical pdfjs config
   against the same fonts and parses PDFs fine. The warnings
   `TT: undefined function: 32` and
   `UnknownErrorException: Unable to load font data` are emitted
   by pdfjs for any PDF with embedded TrueType fonts and do NOT
   affect text extraction. Claude burned multiple commits adding
   `standardFontDataUrl` + `cMapUrl` config that wasn't needed.

5. **Didn't ask "what does the contract scraper do differently?"
   until the user explicitly demanded it.** The Contract Scraper
   worked reliably against the exact same infrastructure
   (pdfjs-dist, Node, the same DB). Its pattern was the obvious
   template from session 1. Claude didn't read it for comparison
   until hour ~7.

### Prevention added

1. **CLAUDE.md rewritten** — the `server/_core/` bullet is gone.
   Replaced with a loud top-of-file warning about the dual-router
   trap, a "before editing a tRPC procedure" checklist, and a
   pointer at `docs/server-routing.md` for the canonical URL→file
   map.

2. **`docs/server-routing.md` created** — documents every tRPC
   mount point, which client configures which URL, which server
   router handles it, and how the dispatcher at
   `server/_core/index.ts:146` decides.

3. **Dead `solarRecDashboard` sub-router in `_core/solarRecRouter.ts`
   marked as legacy** with a banner comment at the top. The
   dispatcher entry for `"solarRecDashboard"` in
   `SOLAR_REC_ROUTER_ROOTS` was removed so any future call to
   `/solar-rec/api/trpc/solarRecDashboard.*` routes to
   `server/routers.ts` (the live file) instead of the dead copy.

4. **Debug endpoint stays as infrastructure.**
   `debugScheduleBImportRaw` in `server/routers.ts` is not deleted
   — it's the "raw DB state" escape hatch that ended the debugging
   session. Future sessions should reach for the equivalent
   pattern earlier: add a debug endpoint + version marker BEFORE
   shipping any "fix" that you can't verify locally.

### Follow-up: migration ledger repair shipped + executed

After the main Schedule B postmortem above, the user's automated
review caught migration ledger drift (0012-0015 missing from
`__drizzle_migrations`, plus a schema change needed for
`monitoringApiRuns` uniqueness). Rather than trying to run DDL
against production from a Claude session with no DB creds, I
shipped a one-shot `adminProcedure repairScheduleBMigrationLedger`
in `server/routers.ts` plus a `Run migration repair` button on
the Schedule B card (commits `f539cb5`, `95c0f6f`).

The user clicked the button on 2026-04-10 and the report came
back clean: 14 steps, 9 applied, 5 skipped (already present),
0 failed. Full per-step output is recorded in
`productivity-hub/docs/db-migration-repair.md`.

Prevention lesson from this follow-up: **for DB-mutating
operations where Claude can't execute directly, write an
idempotent admin endpoint + trigger button instead of a raw
SQL plan the user has to copy-paste.** The endpoint pattern:
- `adminProcedure` guard
- Per-step `StepReport {name, status, detail?, error?}` records
- Every mutation wrapped in a prior-existence check
  (`information_schema` for DDL, ledger SELECT for hash inserts)
- Each step in its own try/catch so a partial failure doesn't
  abort the rest
- Structured JSON response rendered in the UI with a dismiss
  button so the user sees the outcome without going to logs

That pattern turned a scary manual DB operation into a single
button click that ran successfully the first time, with an
audit trail in the report.

### Personal checklist Claude should follow next time

Before shipping any server-side change to a shared codebase that
can't be locally end-to-end tested:

- [ ] **Grep for the procedure name.** If it shows up in more than
      one file, stop and figure out which file the live URL points at
      before editing either.
- [ ] **Trace the HTTP request.** Client code calls
      `trpc.FOO.BAR.X`. What URL does that resolve to? Which server
      mount point handles that URL? Which router file does the mount
      point use? Write it down before editing.
- [ ] **Add a version marker on the first commit.** Every server
      response the client polls should include a `_version: "..."`
      field with a unique string. The client displays it in the UI.
      If the marker doesn't show up after deploy, the code isn't
      running — don't waste time debugging other theories.
- [ ] **Add a raw-state debug endpoint on the first commit.** One
      tRPC query that returns the minimum raw DB state needed to
      verify the feature. One button in the UI that calls it and
      dumps the JSON. Invaluable.
- [ ] **Read the working equivalent first.** If the user mentions
      "X works, why doesn't Y", read X's code BEFORE touching Y.
      Compare the structural patterns. Don't patch Y's symptoms
      when the real question is "why is Y structured differently
      from X".
- [ ] **Don't trust stderr warnings as cause.** Verify they
      actually affect behavior before treating them as the root
      cause. A grep of the working equivalent for the same
      warning usually proves they're noise.

---

## 2026-04-19 — Samsung Health rewrite: the Gradle `versionName` that never moved

### What the user experienced

1. User asked for a code review of the broken Health Connect
   integration. Claude shipped a complete rewrite over a series of
   commits: `0af3c54` → `dbc89bf` → `a4c2e73` → `2b7ded1` → `185aedb`
   → `2d9de20`. All verified locally via `./gradlew
   :app:compileDebugKotlin --rerun-tasks`, `tsc --noEmit`, and
   `vitest run`.
2. Over ~8 commits Claude repeatedly told the user "rebuild the APK
   and reinstall" to verify each fix. User reported the same
   symptoms every time — no data, same rate-limit error, same
   "Backfill queued" stuck state.
3. Eventually the user lost patience and asked Claude to control the
   debugging directly via adb. First real diagnostic:
   ```
   $ adb shell dumpsys package com.coherence.samsunghealth | grep versionName
   versionName=0.2.0
   ```
4. Claude had changed the internal `APP_VERSION` constant in
   `HealthConnectPayloadMapper.kt` three times (0.3.0 → 0.3.1 → 0.3.2)
   without ever touching `versionCode` or `versionName` in
   `app/build.gradle.kts`. Those stayed at `versionCode = 2,
   versionName = "0.2.0"` the entire time. Gradle's `installDebug`
   silently no-ops when a same-versionCode APK is already installed
   — no warning, no error, exit 0.
5. The user's phone had been running the **original reflection-era
   v0.2.0 APK** through every "install the new APK" instruction.
   All of Claude's rewrites were on the host filesystem and on
   `main`, but zero of them had ever actually run on the device.

### Actual root cause

`APP_VERSION` in Kotlin is a metadata string that only shows up in
webhook payloads (`payload.source.appVersion`). It has **zero**
effect on the Android-level version the OS uses to decide whether
an APK upgrade is needed. Those are two different fields:

| Field | File | What it affects |
|---|---|---|
| `APP_VERSION` (Kotlin const) | `HealthConnectPayloadMapper.kt` | Debug endpoint payload shape, human-readable |
| `versionName` | `app/build.gradle.kts` | "About" screen, `dumpsys package`, Play Store display |
| `versionCode` | `app/build.gradle.kts` | Whether `installDebug` replaces an existing APK |

Bumping only `APP_VERSION` while leaving `versionCode = 2` meant
every `installDebug` call produced a correctly-compiled APK that
Gradle then refused to replace the existing device install with.
The logs read "Installed on 1 device" because Gradle treats
"already up to date" as success.

### What Claude got wrong

1. **Confused internal version markers with the OS-visible version.**
   Similar to the `_runnerVersion` pattern from the Schedule B
   postmortem, but with a fatal twist: the marker Claude was bumping
   only surfaces AFTER a successful sync. If the APK never installs,
   no sync happens, and the marker check is meaningless. The
   analogous Android-specific marker is `versionName` in
   `build.gradle.kts`, which shows up in `dumpsys package` regardless
   of whether the app has run.

2. **Told the user "install the new APK" without a way to verify
   the install actually took.** For server code, "check the
   `_runnerVersion` field in the debug endpoint response" verifies
   the deploy. For Android, the equivalent is:
   ```
   adb shell dumpsys package <package> | grep versionName
   ```
   Claude never asked the user to run this until the session had
   already burned multiple hours.

3. **`installDebug`'s exit code is a trap.** It's 0 when:
   - The APK was replaced ✓
   - The APK was already at the same versionCode (no-op) ✗ (this bit us)
   - The device isn't connected but the build artifact was produced ✗
   Never assume `BUILD SUCCESSFUL` means "the new code is running."

### Prevention added

1. **`versionName`/`versionCode` must be bumped in the same commit
   that bumps `APP_VERSION`.** Add a pre-push hook or CI check that
   fails when the `APP_VERSION` string in
   `HealthConnectPayloadMapper.kt` doesn't match `versionName` in
   `app/build.gradle.kts`. (Deferred — see 2026-04-19 pre-push
   hook entry below for the web-side analog.)

2. **Android debug-verify recipe.** Every "install the new APK"
   instruction should be paired with the adb verification command:
   ```bash
   adb shell dumpsys package com.coherence.healthconnect \
     | grep -E 'versionName|versionCode'
   ```
   If `versionName` isn't the expected value, the install didn't
   take — probably versionCode conflict, probably need to bump.

3. **Observable-on-device state beats in-payload markers for
   Android debugging.** Before trusting "the new code is running",
   verify against the most OS-integrated signal available:
   - `dumpsys package` for version
   - `run-as $pkg cat shared_prefs/foo.xml` for state
   - `logcat --pid=$(pidof $pkg)` for runtime behavior
   These can't be faked by a caching server or a stale client build.

---

## 2026-04-19 — Parallel Claude sessions racing on `.git/index`

### What the user experienced

Mid-way through the Samsung Health rewrite the user had multiple
Claude Code sessions open against the same working tree (different
conversations, different tasks). Staging operations that Claude
thought it controlled were being mutated by the other sessions
between `git add` and `git commit`.

Concrete incident: Claude ran `git add server/_core/pinGate.ts
server/oauth-routes.ts` (expecting 2 files staged), then
`git commit -m "..."`. The resulting commit contained **6 files**:
the 2 Claude staged plus 4 solar-rec files staged by a parallel
session in between. The commit's stat claimed "feat(samsung-health):
..." but it actually contained a solar-rec component extraction.

### Actual root cause

`.git/index` is a single shared file. Any `git add` / `git rm --cached`
/ `git reset` operation from any process mutates it. When two
Claude sessions run concurrently against the same working tree,
their staging operations interleave without any locking. The
committing session sees whatever is in `.git/index` at the instant
its `git commit` reads it — not what it just staged.

`git commit -- path1 path2` would have scoped the commit to those
two paths, but Claude (old habit) ran the bare `git commit` which
takes everything from the index.

### What Claude got wrong

1. **Ran `git add` and `git commit` as separate commands with a
   time gap between them.** Any gap is enough for another process
   to mutate the index. Fine for solo human use, fatal with
   concurrent automation.

2. **Didn't notice multiple Claude processes were running until
   forensics later.** `ps aux | grep claude` would have shown the
   other sessions from the start. Claude could have asked the user
   to pause them before committing.

3. **`git reset --mixed HEAD~1` as a recovery didn't get us back
   to a known state.** Because the other session was STILL active,
   the reset exposed whatever files they had since staged — the
   working tree looked different after reset than before the bad
   commit.

### Prevention added

1. **Atomic stage-verify-commit chain.** The pattern that
   eventually worked — and that every subsequent commit in this
   session used:
   ```bash
   git add -- "${FILES[@]}" \
     && STAGED=$(git diff --cached --name-only) \
     && COUNT=$(echo "$STAGED" | wc -l | tr -d ' ') \
     && [ "$COUNT" = "EXPECTED" ] \
     && UNEXPECTED=$(echo "$STAGED" | grep -vE "ALLOWED_PATHS" || true) \
     && [ -z "$UNEXPECTED" ] \
     && git commit -m "..." \
     && git push origin main
   ```
   If another session mutates the index between the `git add` and
   the `git commit`, the count check or the pattern check fires
   before the commit goes out, and the bash chain aborts instead
   of producing a wrong-scope commit.

2. **Check `ps aux | grep claude` before committing.** If more
   than one Claude process is running, ask the user to pause
   others or switch to a dedicated branch before committing.

3. **Pre-push fetch + ancestor check.** Before `git push origin
   main`, fetch and verify `HEAD~1 == origin/main` — if origin
   moved, bail and rebase rather than force-push. Every push in
   this session used this pattern after the initial incident.

4. **Don't amend across suspected races.** `git commit --amend`
   re-reads the index, which reintroduces any interleaved changes.
   When the working tree is shared, prefer a fresh commit that
   cleanly reverts + re-stages to an `--amend`.

### Personal checklist Claude should follow next time

- [ ] **Is more than one Claude session running against this
      working tree?** `ps aux | grep -c claude` — if > 1 and you
      plan to commit, pause the others or use a branch.
- [ ] **Every `git add` must be immediately followed by a
      `git diff --cached --name-only` verification** before any
      subsequent mutation. Count AND pattern must match.
- [ ] **Every `git push` must be preceded by `git fetch` + an
      ancestor check.** Don't assume `origin/main` is where you
      left it between your last fetch and your push.
- [ ] **If a commit goes out with unexpected files, don't
      `--amend`.** Push the wrong commit, then immediately push
      a reverting commit that explicitly names what you meant to
      change. Cleaner history, no re-reading of a racing index.

---

## 2026-04-19 — `HealthConnectReader` cooldown: unreachable-code bug

### What the user experienced

After shipping the "rate-limit cooldown" fix (commit `185aedb`),
the user installed the new APK and reported: "I still keep hitting
the rate limit. The cooldown banner never appears. `adb shell run-as
... cat shared_prefs/coherence_samsung_sync_prefs.xml` shows only
`auto_sync_enabled=true` — the cooldown keys are missing."

The fix code was present in source, the build included it, the
install was confirmed (`versionName=0.3.2`), but `markRateLimited()`
was never executing.

### Actual root cause

```kotlin
for (attempt in 0 until MAX_ATTEMPTS) {
  try { ... return result }
  catch (error) {
    val isRetryable = isRateLimitError(error) && attempt < MAX_ATTEMPTS - 1
    if (isRetryable) { delay(...); continue }
    warnings += "..."
    return emptyList()            // ← returns on EVERY non-retryable path
  }
}
// ↓↓↓ UNREACHABLE — loop always returns from inside ↓↓↓
cooldown?.markRateLimited(lastErrorMessage)
```

On the final attempt (attempt == 2, MAX_ATTEMPTS == 3), the
condition `attempt < MAX_ATTEMPTS - 1` evaluates false → `isRetryable`
is false → the `if (isRetryable)` branch doesn't fire → the `return
emptyList()` below fires instead. Every path out of the loop is a
`return` from inside the catch. The `markRateLimited()` call after
the `for` block was never reached.

This was a pure control-flow bug the compiler can't catch without
a dead-code warning, and Kotlin's compiler didn't warn in this
configuration.

### What Claude got wrong

1. **Never ran the code on a real device before declaring it
   shipped.** The logic looked correct on a quick read. A unit test
   or even a single `adb` verification after the first install
   would have caught it immediately.

2. **Trusted the build-success signal as a behavior signal.**
   `BUILD SUCCESSFUL` means "compiles" and "tests pass (if any)".
   It doesn't mean "the code actually works when exercised." There
   were no tests for the cooldown path, so the build was green
   despite the dead-code bug.

3. **Didn't read the logs until forced to.** Once the user ran
   `adb logcat` under Claude's direction, the problem was obvious:
   22 "read failed" warnings in a row with zero "cooldown engaged"
   log lines. That signal was always available; Claude just wasn't
   looking at it.

### Prevention added

1. **Cooldown logic moved INSIDE the catch block.**
   ```kotlin
   if (rateLimited && attempt == MAX_ATTEMPTS - 1) {
     cooldown?.markRateLimited(combined)
     Log.w(TAG, "... cooldown engaged")
     warnings += "..."
   }
   return emptyList()
   ```
   The `Log.w` was added at the same time — if the cooldown is
   engaged, there's now a logcat line that proves it. Silent
   behavior is banned.

2. **JVM unit tests for `HealthConnectPayloadMapper` and
   `HealthConnectReader`.** See the 2026-04-19 mapper-tests entry.
   The reader's retry loop is exactly the kind of control-flow
   logic that unit tests catch in seconds but manual QA misses
   for days.

3. **Debug-endpoint-equivalent for Android state.**
   SharedPreferences contents, WorkManager job state, and
   permission grant state are all queryable via `adb run-as` and
   `adb shell dumpsys`. The equivalent of "curl the debug
   endpoint" for Android is a short shell snippet that dumps all
   three. Building that into the diagnostic checklist surfaces
   whether state is actually being mutated.

### Personal checklist Claude should follow next time

- [ ] **Unit test every non-trivial control-flow path.** If a
      method has retries, backoffs, or multi-step state mutations,
      it gets a test. "Obvious" bugs in retry logic are the
      single most common class of bug in this codebase.
- [ ] **Every `cooldown.markRateLimited()` / state-mutating call
      gets paired with a `Log.w(TAG, "...")` so its execution is
      observable without a debugger.** If the logcat line isn't
      there, the code didn't run — no matter what the payload
      says.
- [ ] **On-device SharedPrefs inspection is the first debug
      step, not the last.** `adb run-as $pkg cat shared_prefs/*.xml`
      takes 10 seconds and shows more about what the app actually
      did than 100 lines of server-side log parsing.
