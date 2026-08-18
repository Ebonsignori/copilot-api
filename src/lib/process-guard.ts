import consola from "consola"

// A single flaky dependency must never take the whole proxy down.
//
// undici's `fetch` has a footgun: when a request is aborted (e.g. our
// AbortSignal.timeout fires because an upstream is unreachable) or the socket
// resets, the *awaited* promise rejects — and we handle that — but undici ALSO
// rejects a second, internal promise on the aborted request that no code awaits.
// That dangling rejection has no application frames in its stack, so there is no
// try/catch anywhere that can catch it; left alone Node promotes it to an
// uncaughtException and kills the process. That is exactly how an outage of the
// Tailscale-only search broker (unreachable when off-tailnet) crash-looped the
// entire API until the supervisor gave up respawning it.
//
// These handlers keep the server alive through transient network failures while
// still letting genuine programmer errors crash loudly, so real bugs stay visible
// instead of being silently swallowed.

// Node/undici error `code`s and undici `UND_ERR_*` codes that mean "a network
// peer went away / never answered" — always safe to survive.
const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "ENETUNREACH",
  "ENETDOWN",
  "EHOSTUNREACH",
  "EHOSTDOWN",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_ABORTED",
])

// The wrapper messages undici/node use for the same transport failures, for cases
// where the `code` is absent (e.g. the bare `TypeError: terminated` / `fetch
// failed` undici raises around an aborted or reset connection).
const TRANSIENT_MESSAGES = [
  "terminated",
  "fetch failed",
  "other side closed",
  "socket hang up",
  "the operation was aborted",
]

// Message text for an arbitrary thrown/rejected value, without ever relying on
// Object's default "[object Object]" stringification.
function messageOf(value: unknown): string {
  if (value instanceof Error) return value.message
  if (typeof value === "string") return value
  return ""
}

// True for transport-level failures we want to survive. Walks the `cause` chain
// (undici nests the real errno under `TypeError.cause`) with cycle protection.
export function isTransientNetworkError(reason: unknown): boolean {
  const seen = new Set<unknown>()
  let err: unknown = reason
  while (err !== null && err !== undefined && !seen.has(err)) {
    seen.add(err)

    if (
      err instanceof Error
      && (err.name === "AbortError" || err.name === "TimeoutError")
    ) {
      return true
    }

    const code = (err as { code?: unknown }).code
    if (typeof code === "string" && TRANSIENT_CODES.has(code)) return true

    const message = messageOf(err).toLowerCase()
    if (message && TRANSIENT_MESSAGES.some((m) => message.includes(m))) {
      return true
    }

    err = (err as { cause?: unknown }).cause
  }
  return false
}

// Render a nested `cause` for the log line, safely.
function describeCause(cause: unknown): string {
  if (cause === undefined || cause === null) return ""
  if (cause instanceof Error) {
    return ` (cause: ${cause.name}: ${cause.message})`
  }
  const text = messageOf(cause)
  return text ? ` (cause: ${text})` : " (cause: [non-Error value])"
}

function describe(reason: unknown): string {
  if (!(reason instanceof Error)) {
    return messageOf(reason) || "[non-Error value]"
  }
  const cause = (reason as { cause?: unknown }).cause
  return `${reason.name}: ${reason.message}${describeCause(cause)}`
}

let installed = false

// Install once, as early as possible in the server process. Idempotent so tests /
// repeated calls don't stack listeners.
export function installProcessGuards(): void {
  if (installed) return
  installed = true

  process.on("unhandledRejection", (reason) => {
    if (isTransientNetworkError(reason)) {
      consola.warn(
        `Survived a transient upstream network failure (unhandled rejection): ${describe(reason)}`,
      )
      return
    }
    // Not a network blip — a real bug. Surface it and exit so the supervisor
    // restarts a clean process rather than leaving us wedged in an unknown state.
    consola.error("Fatal unhandled rejection — exiting:", reason)
    process.exit(1)
  })

  process.on("uncaughtException", (error) => {
    if (isTransientNetworkError(error)) {
      consola.warn(
        `Survived a transient upstream network failure (uncaught exception): ${describe(error)}`,
      )
      return
    }
    consola.error("Fatal uncaught exception — exiting:", error)
    process.exit(1)
  })
}
