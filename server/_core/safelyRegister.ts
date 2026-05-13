/**
 * Boot-time wrapper for `register*BuildStep()` calls so a single
 * registration failure does NOT abort the entire server start
 * sequence (i.e. `server.listen()` would never fire).
 *
 * Context: PR #573 closed the boot-time registration race by
 * converting the five `register*BuildStep()` calls in
 * `_core/index.ts` from `void async()` to synchronous calls. The
 * fix is correct, but it left a follow-on gap: those calls run
 * inside `startServer()`, which is wired with
 * `.catch(console.error)` at the bottom of `index.ts`. A
 * synchronous throw from any of the 5 registers would abort the
 * entire boot sequence — the server never `listen()`s — with only
 * one stderr line and no health-check alarm.
 *
 * PR #573's stated goal was "fail loud" — but a silent boot abort
 * defeats that goal. The runner's 0-step guard (also added in
 * PR #573) would never fire because the server never starts.
 *
 * This helper wraps each register call in a try/catch that logs a
 * structured error message and lets the boot sequence continue.
 * The runner's 0-step guard then becomes the user-visible catch-net
 * on the next user-initiated build: a missing step surfaces as a
 * clear "no build steps registered" diagnostic instead of a silent
 * boot abort.
 */

/**
 * Invoke a boot-time registration function. If it throws, log a
 * structured error (`[dashboard:build-steps] failed to register …`)
 * naming the build step and the underlying error message, then
 * return normally so the rest of `startServer()` can finish.
 */
export function safelyRegisterBuildStep(
  name: string,
  fn: () => void
): void {
  try {
    fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[dashboard:build-steps] failed to register ${name}; ` +
        `the runner's 0-step guard will fire on the next ` +
        `user-initiated build with a diagnostic. Error: ${message}`
    );
  }
}
