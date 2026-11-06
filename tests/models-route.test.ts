import { describe, expect, test } from "bun:test"

import type { Model } from "~/services/copilot/get-models"

import { state } from "~/lib/state"

import { modelRoutes, toModelEntry } from "../src/routes/models/route"

// Trimmed from Copilot's catalog (2026-11-05).
const vision = {
  max_prompt_image_size: 3145728,
  max_prompt_images: 1,
  supported_media_types: ["image/jpeg", "image/png"],
}
const opus = {
  id: "claude-opus-5.5",
  name: "Claude Opus 5.5",
  vendor: "Anthropic",
  version: "claude-opus-5.5",
  object: "model",
  preview: false,
  model_picker_enabled: true,
  supported_endpoints: ["/v1/messages", "/chat/completions"],
  billing: {
    auto_discount: 0.1,
    restricted_to: ["pro_plus", "business"],
    token_prices: {
      batch_size: 1000000,
      default: {
        input_price: 400,
        output_price: 2000,
        cache_read_price: 20,
        cache_write_price: 500,
        max_prompt_tokens: 200000,
      },
      long_context: {
        input_price: 400,
        output_price: 2000,
        cache_read_price: 20,
        cache_write_price: 500,
        max_prompt_tokens: 1000000,
      },
    },
  },
  capabilities: {
    family: "claude-opus-5.5",
    object: "model_capabilities",
    tokenizer: "o200k_base",
    type: "chat",
    limits: {
      max_context_window_tokens: 1000000,
      max_non_streaming_output_tokens: 16000,
      max_output_tokens: 128000,
      max_prompt_tokens: 1000000,
      vision,
    },
    supports: {
      adaptive_thinking: true,
      parallel_tool_calls: true,
      reasoning_effort: ["low", "medium", "high", "xhigh", "max"],
      streaming: true,
      structured_outputs: true,
      tool_calls: true,
      vision: true,
    },
  },
} satisfies Model
const gemini = {
  ...opus,
  id: "gemini-4-argon",
  name: "Gemini 4 Argon",
  vendor: "Google",
  supported_endpoints: ["/chat/completions", "/interactions"],
  capabilities: {
    ...opus.capabilities,
    family: "gemini-4-argon",
    limits: { max_output_tokens: 65536, max_prompt_tokens: 983040 },
    supports: {
      reasoning_effort: ["low", "medium", "high"],
      tool_calls: true,
    },
  },
} satisfies Model
// Older models list no endpoints.
const old = {
  ...opus,
  id: "gpt-4o",
  name: "GPT-4o",
  vendor: "Azure OpenAI",
  supported_endpoints: undefined,
  billing: undefined,
  capabilities: {
    ...opus.capabilities,
    limits: { max_output_tokens: 4096, max_prompt_tokens: 64000 },
    supports: { tool_calls: true },
  },
} satisfies Model

describe("toModelEntry", () => {
  test("keeps the fields the route has always returned, as they were", () => {
    const entry = toModelEntry(opus)
    expect({
      id: entry.id,
      object: entry.object,
      type: entry.type,
      created: entry.created,
      created_at: entry.created_at,
      owned_by: entry.owned_by,
      display_name: entry.display_name,
    }).toEqual({
      id: "claude-opus-5.5",
      object: "model",
      type: "model",
      created: 0,
      created_at: "1970-01-01T00:00:00.000Z",
      owned_by: "Anthropic",
      display_name: "Claude Opus 5.5",
    })
  })

  test("adds the endpoints and Copilot's capabilities, limits and supports included", () => {
    const entry = toModelEntry(gemini)
    expect(entry.supported_endpoints).toEqual([
      "/chat/completions",
      "/interactions",
    ])
    expect(entry.copilot_capabilities.limits).toEqual({
      max_output_tokens: 65536,
      max_prompt_tokens: 983040,
    })
    expect(entry.copilot_capabilities.supports.reasoning_effort).toEqual([
      "low",
      "medium",
      "high",
    ])
    expect(toModelEntry(opus).copilot_capabilities.limits.vision).toEqual(
      vision,
    )
    expect(toModelEntry(opus).copilot_capabilities.supports.vision).toBe(true)
  })

  test("adds the price tiers, and only them of the billing", () => {
    expect(toModelEntry(opus).copilot_billing).toEqual({
      token_prices: opus.billing.token_prices,
    })
    expect(toModelEntry(old).copilot_billing).toBeUndefined()
  })

  test("adds nothing under the names Anthropic's ModelInfo gives other shapes", () => {
    const entry = toModelEntry(opus)
    expect(entry).not.toHaveProperty("capabilities")
    expect(entry).not.toHaveProperty("max_input_tokens")
    expect(entry).not.toHaveProperty("max_tokens")
  })
})

describe("GET /v1/models", () => {
  test("lists every model with the old fields and the new ones", async () => {
    state.models = { object: "list", data: [opus, gemini, old] }
    const res = await modelRoutes.request("/")
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      object: string
      has_more: boolean
      data: Array<Record<string, unknown>>
    }
    expect(body.object).toBe("list")
    expect(body.has_more).toBe(false)
    expect(body.data.map((m) => m.id)).toEqual([
      "claude-opus-5.5",
      "gemini-4-argon",
      "gpt-4o",
    ])
    expect(Object.keys(body.data[0])).toEqual([
      "id",
      "object",
      "type",
      "created",
      "created_at",
      "owned_by",
      "display_name",
      "supported_endpoints",
      "copilot_capabilities",
      "copilot_billing",
    ])
    expect(body.data[0].copilot_capabilities).toEqual(opus.capabilities)
    // A model the catalog lists no endpoints or prices for has no key for them.
    expect(body.data[2]).not.toHaveProperty("supported_endpoints")
    expect(body.data[2]).not.toHaveProperty("copilot_billing")
  })
})
