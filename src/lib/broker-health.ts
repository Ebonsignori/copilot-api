import consola from "consola"
import { lookup } from "node:dns/promises"

import { isTransientNetworkError } from "./process-guard"
import { state } from "./state"

// The search broker (`SEARCH_SERVICE_URL`) lives on a Tailscale-only host. Its
// DNS name resolves fine off-tailnet — it just points at a 100.64.0.0/10 address
// nothing can route to — so every request hung for the full 15s AbortSignal
// timeout in web-search.ts and then silently degraded to "search unavailable".
// With runWebSearchLoop's HARD_CAP of 8 rounds that produced the 445s and 696s
// requests in the proxy log, and gave no hint that the fix was "start Tailscale".
//
// This module preflights the broker cheaply and caches the verdict, so a dead
// tunnel fails in ~2s with an actionable message instead of minutes with none.

const PROBE_TIMEOUT_MS = 2_000
const HEALTHY_TTL_MS = 60_000
// Deliberately short: the moment Tailscale comes back up, the next request after
// this window recovers on its own with no restart.
const UNHEALTHY_TTL_MS = 15_000

// Tailscale hands out addresses from the CGNAT block 100.64.0.0/10 — i.e. 100.64.*
// through 100.127.*. A broker in that range that we cannot reach means the tunnel
// is down, which is a different (and user-fixable) problem from the broker itself
// being broken.
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

export function isTailnetAddress(address: string): boolean {
  const match = IPV4_RE.exec(address)
  if (!match) return false
  const octets = match.slice(1).map(Number)
  if (octets.some((n) => n > 255)) return false
  return octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127
}

export interface BrokerHealth {
  reachable: boolean
  // Hostname from SEARCH_SERVICE_URL, for the operator-facing message.
  host: string
  // Resolved address, or "" when DNS itself failed.
  address: string
  // True when `address` is in Tailscale's CGNAT range.
  tailnet: boolean
  // True when the failure was transport-level (as opposed to, say, a bad URL).
  transient: boolean
  // Human-readable cause; "" when reachable.
  detail: string
}

// Injectable seams for tests, mirroring the `deps` pattern in web-search-loop.ts.
export interface BrokerHealthDeps {
  fetch?: typeof globalThis.fetch
  lookup?: (host: string) => Promise<{ address: string }>
  now?: () => number
}

interface CacheEntry {
  health: BrokerHealth
  expiresAt: number
}

let cache: CacheEntry | undefined
// Bumped on every write to `cache`. A probe that started before someone else
// recorded a verdict must not overwrite that newer observation with its own
// stale one — see checkBrokerHealth.
let generation = 0
// Last successful DNS resolution, so markBrokerUnreachable() can still produce the
// Tailscale-specific message without redoing a lookup on the failure path.
let lastResolved:
  | { host: string; address: string; tailnet: boolean }
  | undefined

// Exported for tests.
export function resetBrokerHealthCache(): void {
  cache = undefined
  lastResolved = undefined
  generation = 0
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause
    if (cause instanceof Error) return `${error.message}: ${cause.message}`
    return error.message
  }
  if (typeof error === "string") return error
  return "unknown error"
}

function hostOf(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname
  } catch {
    return rawUrl
  }
}

async function probe(deps: BrokerHealthDeps): Promise<BrokerHealth> {
  const fetchImpl = deps.fetch ?? globalThis.fetch
  const lookupImpl = deps.lookup ?? ((host: string) => lookup(host))

  const baseUrl = state.searchServiceUrl ?? ""
  const host = hostOf(baseUrl)

  let address = ""
  let tailnet = false
  try {
    const resolved = await lookupImpl(host)
    address = resolved.address
    tailnet = isTailnetAddress(address)
    lastResolved = { host, address, tailnet }
  } catch (error) {
    // DNS failure is itself a reachability failure, but we still probe so the
    // detail names the real symptom.
    consola.debug(
      `Broker DNS lookup failed for ${host}: ${describeError(error)}`,
    )
  }

  // Probe the ORIGIN, not /search — we only need to know whether packets get
  // there. Any HTTP status (404, 401, …) proves reachability; only a transport
  // failure counts as unreachable.
  let origin = baseUrl
  try {
    origin = new URL(baseUrl).origin
  } catch {
    // Leave origin as-is; fetch will reject and we report that.
  }

  try {
    await fetchImpl(origin, {
      method: "GET",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    return {
      reachable: true,
      host,
      address,
      tailnet,
      transient: false,
      detail: "",
    }
  } catch (error) {
    return {
      reachable: false,
      host,
      address,
      tailnet,
      transient: isTransientNetworkError(error),
      detail: describeError(error),
    }
  }
}

// Is the search broker reachable right now? Cached (60s healthy / 15s unhealthy)
// so this costs nothing on the hot path, and so a client retrying a 503 gets an
// instant answer instead of re-running the probe each time.
export async function checkBrokerHealth(
  deps: BrokerHealthDeps = {},
): Promise<BrokerHealth> {
  const now = deps.now ?? Date.now
  const current = cache
  if (current && now() < current.expiresAt) return current.health

  const startedAt = generation
  const health = await probe(deps)

  // If markBrokerUnreachable() (or a concurrent probe) recorded a verdict while
  // this probe was in flight, that observation is newer than ours — publishing
  // ours would resurrect a broker someone just watched fail. Ours still stands
  // as this call's return value; it just doesn't become the cached truth.
  if (generation === startedAt) {
    generation++
    // The generation check above IS the atomicity guard the rule is asking for;
    // it can't see that, so the flag here is a false positive.
    // eslint-disable-next-line require-atomic-updates
    cache = {
      health,
      expiresAt: now() + (health.reachable ? HEALTHY_TTL_MS : UNHEALTHY_TTL_MS),
    }
  }

  if (!health.reachable) {
    consola.warn(`Search broker unreachable: ${health.detail}`)
  }
  return health
}

// Record a transport failure observed by an actual search call, so the remaining
// rounds of an in-flight web_search loop fail fast instead of each burning the
// full 15s broker timeout.
export function markBrokerUnreachable(
  detail: string,
  deps: BrokerHealthDeps = {},
): void {
  const now = deps.now ?? Date.now
  const known = lastResolved
  generation++
  cache = {
    health: {
      reachable: false,
      host: known?.host ?? hostOf(state.searchServiceUrl ?? ""),
      address: known?.address ?? "",
      tailnet: known?.tailnet ?? false,
      transient: true,
      detail,
    },
    expiresAt: now() + UNHEALTHY_TTL_MS,
  }
}

// The operator-facing message. When the broker sits on the tailnet and we can't
// reach it, name Tailscale explicitly — that is the actual fix, and it is not
// something the caller can infer from "search unavailable".
export function brokerUnavailableMessage(health: BrokerHealth): string {
  const where =
    health.address ? `${health.host} (${health.address})` : health.host

  if (health.tailnet && health.transient) {
    return (
      `web_search is unavailable: the search broker at ${where} is reachable`
      + ` only over Tailscale, which is not connected on this machine.`
      + ` Start Tailscale and retry. (${health.detail})`
    )
  }

  return (
    `web_search is unavailable: the search broker at ${where} could not be`
    + ` reached. (${health.detail})`
  )
}
