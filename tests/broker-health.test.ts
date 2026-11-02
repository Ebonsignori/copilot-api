import { beforeEach, describe, expect, test } from "bun:test"

import {
  brokerUnavailableMessage,
  checkBrokerHealth,
  isTailnetAddress,
  markBrokerUnreachable,
  resetBrokerHealthCache,
  type BrokerHealth,
} from "../src/lib/broker-health"
import { state } from "../src/lib/state"

// The broker sits on a Tailscale-only host. Off-tailnet its name still resolves
// (to a 100.64.0.0/10 address) so requests hang for the full 15s search timeout
// and then degrade silently. These tests pin the preflight that turns that into a
// fast, actionable failure.

const TAILNET_IP = "100.112.253.21"

const okFetch = (() =>
  Promise.resolve(new Response("ok"))) as unknown as typeof globalThis.fetch

const unreachableFetch = (() =>
  Promise.reject(
    Object.assign(new Error("connect EHOSTUNREACH 100.112.253.21:443"), {
      code: "EHOSTUNREACH",
    }),
  )) as unknown as typeof globalThis.fetch

const lookupTailnet = () => Promise.resolve({ address: TAILNET_IP })
const lookupPublic = () => Promise.resolve({ address: "93.184.216.34" })

beforeEach(() => {
  resetBrokerHealthCache()
  state.searchServiceUrl = "https://nexus.evan.bio/search-broker"
  state.searchServiceToken = "test-token"
})

describe("isTailnetAddress", () => {
  test("covers the 100.64.0.0/10 boundaries", () => {
    expect(isTailnetAddress("100.63.255.255")).toBe(false)
    expect(isTailnetAddress("100.64.0.0")).toBe(true)
    expect(isTailnetAddress(TAILNET_IP)).toBe(true)
    expect(isTailnetAddress("100.127.255.255")).toBe(true)
    expect(isTailnetAddress("100.128.0.0")).toBe(false)
  })

  test("rejects non-tailnet and malformed addresses", () => {
    expect(isTailnetAddress("10.0.0.1")).toBe(false)
    expect(isTailnetAddress("192.168.1.68")).toBe(false)
    expect(isTailnetAddress("999.64.0.1")).toBe(false)
    expect(isTailnetAddress("100.64.0")).toBe(false)
    expect(isTailnetAddress("")).toBe(false)
    expect(isTailnetAddress("nexus.evan.bio")).toBe(false)
  })
})

describe("checkBrokerHealth", () => {
  test("reachable when the origin answers at all", async () => {
    const health = await checkBrokerHealth({
      fetch: okFetch,
      lookup: lookupTailnet,
    })
    expect(health.reachable).toBe(true)
    expect(health.host).toBe("nexus.evan.bio")
    expect(health.address).toBe(TAILNET_IP)
  })

  test("unreachable, and flags tailnet, when the connection fails", async () => {
    const health = await checkBrokerHealth({
      fetch: unreachableFetch,
      lookup: lookupTailnet,
    })
    expect(health.reachable).toBe(false)
    expect(health.tailnet).toBe(true)
    expect(health.transient).toBe(true)
    expect(health.detail).toContain("EHOSTUNREACH")
  })

  test("a non-tailnet broker is not blamed on Tailscale", async () => {
    const health = await checkBrokerHealth({
      fetch: unreachableFetch,
      lookup: lookupPublic,
    })
    expect(health.reachable).toBe(false)
    expect(health.tailnet).toBe(false)
  })

  test("still reports a verdict when DNS itself fails", async () => {
    const health = await checkBrokerHealth({
      fetch: unreachableFetch,
      lookup: () => Promise.reject(new Error("getaddrinfo ENOTFOUND")),
    })
    expect(health.reachable).toBe(false)
    expect(health.address).toBe("")
    expect(health.tailnet).toBe(false)
  })

  test("caches a healthy verdict for 60s, then re-probes", async () => {
    let clock = 1_000
    let calls = 0
    const counting = (() => {
      calls++
      return Promise.resolve(new Response("ok"))
    }) as unknown as typeof globalThis.fetch
    const deps = {
      fetch: counting,
      lookup: lookupTailnet,
      now: () => clock,
    }

    await checkBrokerHealth(deps)
    await checkBrokerHealth(deps)
    clock += 59_000
    await checkBrokerHealth(deps)
    expect(calls).toBe(1)

    clock += 2_000 // past the 60s healthy TTL
    await checkBrokerHealth(deps)
    expect(calls).toBe(2)
  })

  test("caches an unhealthy verdict for only 15s so recovery is automatic", async () => {
    let clock = 1_000
    let calls = 0
    const counting = (() => {
      calls++
      return Promise.reject(new Error("fetch failed"))
    }) as unknown as typeof globalThis.fetch
    const deps = { fetch: counting, lookup: lookupTailnet, now: () => clock }

    await checkBrokerHealth(deps)
    clock += 14_000
    // A client retrying the 503 must not re-run the probe.
    await checkBrokerHealth(deps)
    expect(calls).toBe(1)

    clock += 2_000 // past the 15s unhealthy TTL
    await checkBrokerHealth(deps)
    expect(calls).toBe(2)
  })
})

describe("markBrokerUnreachable", () => {
  test("short-circuits the next check without probing", async () => {
    let clock = 1_000
    const deps = { fetch: okFetch, lookup: lookupTailnet, now: () => clock }

    // Resolve once so the failure path knows the address is on the tailnet.
    await checkBrokerHealth(deps)
    markBrokerUnreachable("read ECONNRESET", { now: () => clock })

    const health = await checkBrokerHealth(deps)
    expect(health.reachable).toBe(false)
    expect(health.tailnet).toBe(true)
    expect(health.detail).toBe("read ECONNRESET")

    clock += 16_000 // TTL expires, the broker is probed again and recovers
    expect((await checkBrokerHealth(deps)).reachable).toBe(true)
  })

  test("falls back to the configured host when nothing resolved yet", () => {
    markBrokerUnreachable("terminated")
    const message = brokerUnavailableMessage({
      reachable: false,
      host: "nexus.evan.bio",
      address: "",
      tailnet: false,
      transient: true,
      detail: "terminated",
    })
    expect(message).toContain("nexus.evan.bio")
  })
})

describe("brokerUnavailableMessage", () => {
  const base: BrokerHealth = {
    reachable: false,
    host: "nexus.evan.bio",
    address: TAILNET_IP,
    tailnet: true,
    transient: true,
    detail: "connect EHOSTUNREACH",
  }

  test("names Tailscale as the fix for an unreachable tailnet broker", () => {
    const message = brokerUnavailableMessage(base)
    expect(message).toContain("Tailscale")
    expect(message).toContain("Start Tailscale and retry")
    expect(message).toContain("nexus.evan.bio")
    expect(message).toContain(TAILNET_IP)
    expect(message).toContain("connect EHOSTUNREACH")
  })

  test("does NOT blame Tailscale for a broker that is merely down", () => {
    const message = brokerUnavailableMessage({
      ...base,
      address: "93.184.216.34",
      tailnet: false,
    })
    expect(message).not.toContain("Tailscale")
    expect(message).toContain("could not be reached")
  })
})
