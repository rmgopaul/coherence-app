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

## 2026-04-20 — `local.properties` is a convention, not a Gradle source

### What the user experienced

Google OAuth failed the moment they tapped "Sign in" on the
Android app — their Chrome-resident `@carbonsolutionsgroup.com`
account was shown at the top of the error page but the request
was rejected. User was convinced it was a test-user list issue
and screenshotted the Google Cloud Console audience screen with
the email clearly listed.

### Actual root cause

`app/build.gradle.kts` was reading all five of its secrets via
`project.findProperty("GOOGLE_CLIENT_ID")`. That API consults
`gradle.properties`, `~/.gradle/gradle.properties`, and `-P`
CLI flags — but NOT `local.properties`. The file `local.properties`
is an Android Studio convention, injected through the IDE's
Gradle-tooling hook, not through Gradle itself.

Every `./gradlew assembleDebug` on the command line produced an
APK with:
- `GOOGLE_CLIENT_ID = ""`
- `SYNC_KEY = "REPLACE_ME_SYNC_KEY"` (the fallback sentinel)

Android Studio builds worked because the IDE bridges the gap.
Claude never noticed because the build "succeeded" and the APK
installed fine — the failure only surfaced on the device when
OAuth 404'd and the webhook 401'd.

### Prevention

1. `build.gradle.kts` now explicitly loads `local.properties` at
   configuration time via `Properties().load()` and a small `prop()`
   helper that prefers `local.properties` over `findProperty`.
2. A `verifyBuildConfigSecrets` inline println prints one redacted
   status line per secret at every build:
   ```
   [coherence:buildconfig] GOOGLE_CLIENT_ID ✓ (72 chars)
   [coherence:buildconfig] SYNC_KEY ✗ MISSING — add to local.properties
   ```
   No secret values are ever printed — presence + length only.

**Rule of thumb:** any Gradle template that uses `project.findProperty`
for secrets MUST also explicitly load `local.properties`, AND must
surface presence/absence at build time. If neither is true, the
template is broken for command-line builds.

---

## 2026-04-20 — Permissions outlive reinstalls; edge-detection doesn't

### What the user experienced

New APK installed cleanly, OAuth login finally worked, user logged
in as themselves — and no health data ever appeared on the
dashboard. Force-stop, reinstall, reboot, nothing changed. The sync
worker wasn't running at all — `dumpsys jobscheduler | grep
com.coherence.healthconnect` showed only the `WidgetDataWorker`.

### Actual root cause

`HealthScreen.onStatusChanged` only called `AutoSyncScheduler.enable`
on the TRANSITION from missing-permissions to granted-permissions:

```kotlin
val wasIncomplete = hcStatus?.permissionsGranted == false
hcStatus = next
if (wasIncomplete && next.permissionsGranted) { enable(context) }
```

Android's Health Connect permission grants are owned by the OS, not
the app, and SURVIVE app reinstalls and data wipes. So on a
post-login fresh launch, `HealthConnectPermissionManager.getStatus()`
returned `permissionsGranted = true` from the very first callback —
the "missing" side of the transition had never existed inside this
session, so `wasIncomplete` was never `true`, and the scheduler was
never enabled. The `coherence_samsung_sync_prefs.xml` file didn't
exist at all.

The `MainActivity.onResume` path that was supposed to ensure the
worker kept running (`AutoSyncScheduler.ensureScheduledIfEnabled`)
short-circuited immediately because `isEnabled()` returned `false`.

### Prevention

1. Replaced edge-detection with state-comparison:
   ```kotlin
   if (next.permissionsGranted) {
     AutoSyncScheduler.enableIfNeeded(context)
   }
   ```
2. Added `AutoSyncScheduler.enableIfNeeded(context)` — idempotent,
   no-ops when already enabled. Callers no longer need to know the
   scheduler has an enabled/disabled state.

**Rule of thumb:** for boolean prefs whose initial-state-write is
driven by a UI event, prefer "derive from current observable state"
over "react to edge". Edge detection only works when both endpoints
are observable within one app session. OS-owned state (OAuth tokens,
permission grants, encrypted prefs) can cross session boundaries and
defeat edge detection silently.

---

## 2026-04-19 — Shipped-without-verification: two flavours of the same bug

Two separate incidents in the Samsung Health rewrite session shared
a root cause: Claude declared something shipped based on a signal
that didn't actually prove it was shipped. Both burned hours.
Consolidating them into one entry because the fix is the same rule.

### Incident A — the Gradle `versionName` that never moved

Claude bumped the internal `APP_VERSION` constant in Kotlin three
times (0.3.0 → 0.3.1 → 0.3.2) and told the user "install the new
APK" after each. The user reported the same symptoms every time —
no data, same rate-limit error. Eventually the first adb run
revealed the truth:

```
$ adb shell dumpsys package <pkg> | grep versionName
versionName=0.2.0
```

`versionCode` and `versionName` in `app/build.gradle.kts` were
never bumped. Gradle's `installDebug` silently no-ops when a
same-versionCode APK is already on the device (exit 0, "Installed
on 1 device" in the log). Every "new APK" install had actually
been a no-op. The phone ran the original v0.2.0 reflection-era
code the entire time.

**Root cause**: confusing the *internal marker* (`APP_VERSION`
string baked into payloads) with the *OS-visible version*
(`versionName` / `versionCode`). The internal marker only surfaces
after a sync succeeds. If the APK never installs, no sync runs,
the marker is meaningless.

### Incident B — the cooldown-never-engaged bug

After shipping the rate-limit cooldown feature, the user reported:
"cooldown banner never appears, SharedPrefs shows no cooldown
keys." The code was in source, the build included it, the install
was confirmed via `dumpsys` — but `markRateLimited()` was never
running.

```kotlin
for (attempt in 0 until MAX_ATTEMPTS) {
  try { ... return result }
  catch (error) {
    if (isRetryable) { delay(...); continue }
    warnings += "..."
    return emptyList()            // returns on EVERY non-retryable path
  }
}
// UNREACHABLE — loop always returns from inside
cooldown?.markRateLimited(lastErrorMessage)
```

On the final retry attempt, `isRetryable` evaluates false, the
`return emptyList()` inside the catch fires, and the `markRateLimited`
call below the for-loop never runs. Pure control-flow bug. The
compiler didn't warn.

**Root cause**: no unit test for the retry loop. "BUILD SUCCESSFUL"
covered "compiles" but not "actually runs the code path I wrote."

### The shared rule

A deploy is not "shipped" until an observable on-device or on-server
signal confirms the new behaviour. "Code committed" and "build
succeeded" are necessary but not sufficient. Before declaring
victory:

**For server deploys**: curl a `_runnerVersion` or `_checkpoint`
marker that the new code sets. If the string doesn't match what
you expect, the code isn't running — don't debug symptoms, debug
the deploy.

**For Android installs**: `adb shell dumpsys package <pkg> | grep
versionName` must match the new `versionName` in build.gradle.kts.
`installDebug`'s exit code is not enough — it returns 0 for "same
versionCode, skipping."

**For Kotlin control-flow changes**: write a unit test. A test that
fails on the pre-fix code and passes on the post-fix code is the
only thing that proves the runtime path you care about executed.
See `HealthConnectReaderTest.exhausted rate-limit retries mark the
cooldown` for the pattern.

Prevention for each flavour:

- **versionName drift**: every commit that bumps `APP_VERSION`
  must also bump `versionCode` and `versionName`. Consider a
  pre-commit check that reads both and fails if they diverge.
- **Unreachable branches**: every `state-mutating` call (cooldown
  mark, DB write, SharedPrefs put) gets paired with a `Log.w` /
  `println` / `console.log` that proves execution. If the log line
  isn't in the output, the code didn't run.
- **First-debug-step discipline**: when the user says "it doesn't
  work," the first diagnostic is `adb run-as $pkg cat
  shared_prefs/*.xml` + `adb shell dumpsys package $pkg` + the
  server debug endpoint. Ten seconds, answers "is my new code even
  running." Every other theory comes after.

---

## 2026-04-19 — Parallel Claude sessions racing on `.git/index`

Multiple Claude Code sessions running against the same working
tree mutate `.git/index` concurrently with no locking. A `git add`
that staged 2 files followed by `git commit` produced a commit
with 6 files — the 2 Claude staged plus 4 from a parallel
session's `git add` that landed between the two commands. The
commit's message described Claude's work; its payload was someone
else's.

`.git/index` is a single file. Any `git add` / `git rm --cached` /
`git reset` from any process mutates it. The committing session
sees whatever is in the index at the instant `git commit` reads
it — not what it just staged.

### What Claude got wrong

1. **Ran `git add` and `git commit` as separate commands** with a
   time gap between them. Fine for solo human use, fatal with
   concurrent automation.
2. **Didn't notice** other Claude processes were running until
   forensics. `ps aux | grep claude` would have shown them from
   the start.
3. **Used `git reset` as recovery** while the other session was
   still active — which exposed whatever new files it had since
   staged, making the working tree look different after reset
   than before the bad commit.

### Prevention

**Atomic stage-verify-commit chain.** The only pattern that
survives concurrent sessions:

```bash
git add -- "${FILES[@]}" \
  && STAGED=$(git diff --cached --name-only) \
  && COUNT=$(echo "$STAGED" | wc -l | tr -d ' ') \
  && [ "$COUNT" = "EXPECTED" ] \
  && UNEXPECTED=$(echo "$STAGED" | grep -vE "ALLOWED_PATHS" || true) \
  && [ -z "$UNEXPECTED" ] \
  && git commit -m "..." \
  && git push origin HEAD:refs/heads/main
```

If another session mutates the index between `git add` and
`git commit`, the count check or pattern check fires and the
chain aborts before the commit goes out.

### Personal checklist Claude should follow next time

- [ ] **Is more than one Claude session running against this
      working tree?** `ps aux | grep -c claude` — if > 1 and you
      plan to commit, pause the others or switch to a dedicated
      branch.
- [ ] **Every `git add` must be immediately followed by a
      `git diff --cached --name-only` verification** before any
      subsequent mutation. Count AND pattern must match.
- [ ] **Every `git push` must be preceded by `git fetch` + an
      ancestor check.** `HEAD~1 == origin/main` before pushing;
      if origin moved, bail and rebase.
- [ ] **Recovery operations are staging operations.** A
      `git stash pop` or `git reset` that runs while a parallel
      session is active can re-expose its staged files. Treat
      recovery with the same atomic-chain ceremony, not as "back
      to normal state."
- [ ] **Don't `git commit --amend` across a suspected race.** The
      amend re-reads the index, which reintroduces any interleaved
      changes. Push the wrong commit, then push a reverting commit.
      Cleaner than a reset loop.

---

## 2026-04-19 — BSD sed silently no-ops on `\b` word boundaries

When renaming `com.coherence.samsunghealth` → `com.coherence.healthconnect`
across 95 Android files, a sed command using `\b` word boundaries
failed silently on macOS:

```bash
find app/src -name '*.kt' -exec sed -i '' -e 's/\bSamsungHealthRepository\b/HealthConnectPayloadSource/g' {} \;
```

Zero files modified, exit code 0, no warning. `\b` is a GNU sed
extension; BSD sed (the one shipped on macOS) doesn't support it
and treats `\b` as a literal backspace escape. The pattern
matches nothing and sed happily reports success.

Caught only because the next step was a `grep -rc` verification.
If the script had chained directly to `git add` + commit, 95
files would have been renamed by the prior `git mv` step with
zero of their contents updated, and the build would have failed
mysteriously.

### Prevention

- **Don't trust sed's exit code as a behaviour signal.** Always
  follow a bulk sed with an independent `grep -rl '<old-pattern>'`
  to confirm the pattern is actually gone. Count before, count
  after.
- **Prefer explicit delimiters over `\b` for portable regex.**
  When a word is substring-adjacent-safe, use unanchored
  replacement. When it isn't, choose an ordering that disambiguates
  (longest match first: replace `FooBarQux` before `FooBar`).
- **On macOS, assume BSD sed.** No `\b`, no `\s`, no `-r`
  extended regex without `-E`, no `-i` without an empty backup
  string `-i ''`. Write portable or write `perl -pi -e`.
