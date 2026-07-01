import { describe, test, expect } from "bun:test"

import { state } from "../src/lib/state"
import { isServerWebSearchTool, webSearchEnabled } from "../src/lib/web-search"

// The discriminator that fixes the thinking-loss bug: only Anthropic's HOSTED
// server-side web_search tool should trigger the emulation loop (which translates
// through OpenAI and drops thinking). A client-defined tool that merely happens to
// be named "web_search" — like nexus's, which ships an input_schema — must be left
// in the payload and forwarded to the native endpoint (thinking preserved).

// Run `fn` with the search broker configured, restoring state afterward.
const withBroker = <T>(fn: () => T): T => {
  const url = state.searchServiceUrl
  const token = state.searchServiceToken
  state.searchServiceUrl = "http://127.0.0.1:8123"
  state.searchServiceToken = "test-token"
  try {
    return fn()
  } finally {
    state.searchServiceUrl = url
    state.searchServiceToken = token
  }
}

describe("isServerWebSearchTool", () => {
  test("TRUE for the dated server-tool type (Claude Code's WebSearch)", () => {
    expect(
      isServerWebSearchTool({
        type: "web_search_20250305",
        name: "web_search",
      }),
    ).toBe(true)
  })

  test("TRUE for a newer dated server-tool type", () => {
    expect(
      isServerWebSearchTool({
        type: "web_search_20260209",
        name: "web_search",
      }),
    ).toBe(true)
  })

  test("TRUE for a name-only web_search with no input_schema (older server-tool)", () => {
    expect(isServerWebSearchTool({ name: "web_search" })).toBe(true)
  })

  test("TRUE for a name-only web_search with an EMPTY input_schema", () => {
    expect(
      isServerWebSearchTool({ name: "web_search", input_schema: {} }),
    ).toBe(true)
  })

  test("FALSE for a CLIENT tool named web_search WITH a real input_schema (nexus)", () => {
    expect(
      isServerWebSearchTool({
        name: "web_search",
        input_schema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      }),
    ).toBe(false)
  })

  test("FALSE for a differently-named client tool", () => {
    expect(
      isServerWebSearchTool({
        name: "search_web",
        input_schema: {
          type: "object",
          properties: { query: { type: "string" } },
        },
      }),
    ).toBe(false)
  })

  test("FALSE for an unrelated tool", () => {
    expect(
      isServerWebSearchTool({
        name: "read_note",
        input_schema: { type: "object" },
      }),
    ).toBe(false)
  })
})

describe("webSearchEnabled", () => {
  test("TRUE when a server-tool is present and a broker is configured", () => {
    withBroker(() => {
      expect(
        webSearchEnabled([{ type: "web_search_20250305", name: "web_search" }]),
      ).toBe(true)
    })
  })

  test("FALSE for a client tool named web_search (the bug fix — nexus turns)", () => {
    withBroker(() => {
      expect(
        webSearchEnabled([
          {
            name: "web_search",
            input_schema: {
              type: "object",
              properties: { query: { type: "string" } },
            },
          },
        ]),
      ).toBe(false)
    })
  })

  test("FALSE for a mixed toolset with only client tools", () => {
    withBroker(() => {
      expect(
        webSearchEnabled([
          { name: "read_note", input_schema: { type: "object" } },
          {
            name: "web_search",
            input_schema: { type: "object", properties: { query: {} } },
          },
        ]),
      ).toBe(false)
    })
  })

  test("FALSE when no broker is configured even for a server-tool", () => {
    const url = state.searchServiceUrl
    const token = state.searchServiceToken
    state.searchServiceUrl = undefined
    state.searchServiceToken = undefined
    try {
      expect(
        webSearchEnabled([{ type: "web_search_20250305", name: "web_search" }]),
      ).toBe(false)
    } finally {
      state.searchServiceUrl = url
      state.searchServiceToken = token
    }
  })

  test("FALSE for undefined / empty tools", () => {
    withBroker(() => {
      expect(webSearchEnabled(undefined)).toBe(false)
      expect(webSearchEnabled([])).toBe(false)
    })
  })
})
