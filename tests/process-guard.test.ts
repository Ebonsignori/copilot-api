import { describe, expect, it } from "bun:test"

import { isTransientNetworkError } from "../src/lib/process-guard"

describe("isTransientNetworkError", () => {
  it("matches the undici ECONNRESET shape that crashed the proxy", () => {
    // The exact shape from the crash log: TypeError: terminated with a nested
    // ECONNRESET cause, no application frames.
    const cause = Object.assign(new Error("read ECONNRESET"), {
      code: "ECONNRESET",
    })
    const err = Object.assign(new TypeError("terminated"), { cause })
    expect(isTransientNetworkError(err)).toBe(true)
  })

  it("matches a bare undici 'fetch failed' wrapper", () => {
    const err = new TypeError("fetch failed")
    expect(isTransientNetworkError(err)).toBe(true)
  })

  it("matches AbortSignal.timeout aborts (TimeoutError / AbortError)", () => {
    expect(
      isTransientNetworkError(
        Object.assign(new Error("timeout"), { name: "TimeoutError" }),
      ),
    ).toBe(true)
    expect(
      isTransientNetworkError(
        Object.assign(new Error("aborted"), { name: "AbortError" }),
      ),
    ).toBe(true)
  })

  it("matches connection-refused / no-route errno codes", () => {
    for (const code of [
      "ECONNREFUSED",
      "EHOSTUNREACH",
      "ENETUNREACH",
      "ENOTFOUND",
      "UND_ERR_CONNECT_TIMEOUT",
    ]) {
      expect(
        isTransientNetworkError(Object.assign(new Error(code), { code })),
      ).toBe(true)
    }
  })

  it("does NOT swallow genuine programmer errors", () => {
    expect(isTransientNetworkError(new TypeError("x is not a function"))).toBe(
      false,
    )
    expect(
      isTransientNetworkError(new ReferenceError("foo is not defined")),
    ).toBe(false)
    expect(
      isTransientNetworkError(new Error("Failed to get Copilot token")),
    ).toBe(false)
  })

  it("is safe on non-Error and cyclic-cause values", () => {
    expect(isTransientNetworkError(undefined)).toBe(false)
    expect(isTransientNetworkError("nope")).toBe(false)
    const a = new Error("a") as Error & { cause?: unknown }
    const b = new Error("b") as Error & { cause?: unknown }
    a.cause = b
    b.cause = a
    expect(isTransientNetworkError(a)).toBe(false)
  })
})
