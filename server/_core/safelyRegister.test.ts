/**
 * Unit rails for `safelyRegisterBuildStep`. The helper is a
 * boot-time wrapper around the five `register*BuildStep()` calls
 * in `_core/index.ts`. Its contract:
 *
 *   - If the wrapped fn throws, log a structured error naming the
 *     build step + the underlying error message, then return
 *     normally (do NOT propagate).
 *   - If the wrapped fn returns normally, just call it. No
 *     logging, no transformation.
 *
 * The wrapping exists because `startServer()` is wired with
 * `.catch(console.error)` at the bottom of `index.ts`; a sync
 * throw from any register call would abort the entire boot
 * sequence, the server would never `listen()`, and the user would
 * see only one stderr line — no health-check alarm, no diagnostic.
 *
 * See the JSDoc on `safelyRegisterBuildStep` for the full motivation.
 */
import { describe, expect, it, vi } from "vitest";

import { safelyRegisterBuildStep } from "./safelyRegister";

describe("safelyRegisterBuildStep", () => {
  it("invokes the function when it does not throw", () => {
    const fn = vi.fn();
    safelyRegisterBuildStep("test", fn);
    expect(fn).toHaveBeenCalledOnce();
  });

  it("logs an error but does not throw when the registration function throws an Error", () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const throwingFn = () => {
      throw new Error("boom");
    };

    expect(() =>
      safelyRegisterBuildStep("test", throwingFn)
    ).not.toThrow();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("failed to register test")
    );
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("boom"));

    errorSpy.mockRestore();
  });

  it("coerces non-Error throwables to a string before logging", () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const throwingFn = () => {
      // Deliberately throw a non-Error to exercise the String(err)
      // fallback branch in safelyRegisterBuildStep.
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw "raw-string-failure";
    };

    expect(() =>
      safelyRegisterBuildStep("noErrorClass", throwingFn)
    ).not.toThrow();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("failed to register noErrorClass")
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("raw-string-failure")
    );

    errorSpy.mockRestore();
  });

  it("mentions the runner's 0-step guard in the error message so operators know the catch-net path", () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    safelyRegisterBuildStep("test", () => {
      throw new Error("boom");
    });

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("0-step guard")
    );

    errorSpy.mockRestore();
  });
});
