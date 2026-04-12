# Wouter Patch Evaluation (Phase 1)

## Date

- 2026-04-12

## Current Patch

- File: `productivity-hub/patches/wouter@3.7.1.patch`
- Purpose: injects route-path collection into `Switch` by writing to `window.__WOUTER_ROUTES__`.

## Evaluation Result

- Latest published version checked: `wouter@3.9.0`.
- `Switch` implementation in `wouter@3.9.0` (`src/index.js`) does **not** include the route collection behavior from the patch.
- Conclusion: upgrading to latest does **not** make this patch obsolete.

## Workaround Decision

- Keep the patched dependency mapping for now:
  - `wouter@3.7.1` patched via `productivity-hub/patches/wouter@3.7.1.patch`.
- Do not remove the patch in this phase.

## Forward Path (Optional)

1. Replace global `window.__WOUTER_ROUTES__` usage with an app-level route registry in client code.
2. After registry migration and QA pass, remove the patch and upgrade to `wouter@latest`.
