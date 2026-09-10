import { describe, test, expect } from "bun:test"

import type { State } from "~/lib/state"
import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"
import type { ResponsesApiResponse } from "~/routes/responses/types"

import {
  buildResponsesRequest,
  isResponsesOnlyModel,
} from "../src/routes/messages/responses-bridge"
import {
  createResponsesStreamState,
  translateResponsesEventToAnthropicEvents,
  type ResponsesStreamEvent,
} from "../src/routes/messages/responses-stream-translation"
import {
  anthropicToResponsesPayload,
  responsesResponseToAnthropic,
} from "../src/routes/messages/responses-translation"

function fakeState(overrides: Partial<State> = {}): State {
  return {
    accountType: "individual",
    manualApprove: false,
    rateLimitWait: false,
    showToken: false,
    anthropicPassthrough: true,
    responsesBridge: true,
    copilotToken: "tid=test-token",
    vsCodeVersion: "1.104.3",
    ...overrides,
  }
}

// Mirrors the real catalog shape: Claude is dual-endpoint, GPT is /responses-only.
function stateWithCatalog(): State {
  return fakeState({
    models: {
      object: "list",
      data: [
        {
          id: "gpt-6-astra",
          supported_endpoints: ["/responses", "ws:/responses"],
        },
        {
          id: "claude-opus-5",
          supported_endpoints: ["/v1/messages", "/chat/completions"],
        },
        { id: "mystery-model" },
      ] as State["models"] extends infer M ?
        M extends { data: infer D } ?
          D
        : never
      : never,
    } as State["models"],
  })
}

function basePayload(
  overrides: Partial<AnthropicMessagesPayload> = {},
): AnthropicMessagesPayload {
  return {
    model: "gpt-6-astra",
    max_tokens: 1024,
    messages: [{ role: "user", content: "hi" }],
    ...overrides,
  }
}

describe("isResponsesOnlyModel", () => {
  test("routes a /responses-only model to the bridge", () => {
    expect(isResponsesOnlyModel("gpt-6-astra", stateWithCatalog())).toBe(true)
  })

  test("leaves a model that also serves /v1/messages alone", () => {
    expect(isResponsesOnlyModel("claude-opus-5", stateWithCatalog())).toBe(
      false,
    )
  })

  test("never guesses when the catalog lacks the capability list", () => {
    expect(isResponsesOnlyModel("mystery-model", stateWithCatalog())).toBe(
      false,
    )
  })

  test("never guesses when the catalog is missing entirely", () => {
    expect(isResponsesOnlyModel("gpt-6-astra", fakeState())).toBe(false)
  })
})

describe("buildResponsesRequest", () => {
  test("targets /responses on the account's base url", () => {
    const req = buildResponsesRequest(basePayload(), fakeState())
    expect(req.url).toBe("https://api.githubcopilot.com/responses")
  })

  test("marks a first user turn as user and a tool round-trip as agent", () => {
    const user = buildResponsesRequest(basePayload(), fakeState())
    expect(user.headers["X-Initiator"]).toBe("user")

    const agent = buildResponsesRequest(
      basePayload({
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "thinking" },
        ],
      }),
      fakeState(),
    )
    expect(agent.headers["X-Initiator"]).toBe("agent")
  })
})

describe("anthropicToResponsesPayload", () => {
  test("always requests encrypted reasoning and never stores the turn", () => {
    const p = anthropicToResponsesPayload(basePayload())
    expect(p.include).toEqual(["reasoning.encrypted_content"])
    expect(p.store).toBe(false)
    expect(p.max_output_tokens).toBe(1024)
  })

  test("maps the system prompt to instructions", () => {
    const p = anthropicToResponsesPayload(basePayload({ system: "be terse" }))
    expect(p.instructions).toBe("be terse")
  })

  test("lifts tool_result out of the user message into a top-level item", () => {
    const p = anthropicToResponsesPayload(
      basePayload({
        messages: [
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "call_1", content: "42" },
            ],
          },
        ],
      }),
    )
    expect(p.input).toEqual([
      { type: "function_call_output", call_id: "call_1", output: "42" },
    ])
  })

  test("turns a tool_use block into a function_call with stringified args", () => {
    const p = anthropicToResponsesPayload(
      basePayload({
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "call_9",
                name: "calc",
                input: { expr: "1+1" },
              },
            ],
          },
        ],
      }),
    )
    expect(p.input[0]).toEqual({
      type: "function_call",
      call_id: "call_9",
      name: "calc",
      arguments: '{"expr":"1+1"}',
    })
  })

  test("rebuilds a reasoning item from a thinking block's signature", () => {
    const p = anthropicToResponsesPayload(
      basePayload({
        messages: [
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "summary", signature: "ENCRYPTED" },
            ],
          },
        ],
      }),
    )
    expect(p.input[0]).toEqual({
      type: "reasoning",
      encrypted_content: "ENCRYPTED",
      summary: [{ type: "summary_text", text: "summary" }],
    })
  })

  test("drops a thinking block with no signature rather than sending a stub", () => {
    const p = anthropicToResponsesPayload(
      basePayload({
        messages: [
          { role: "assistant", content: [{ type: "thinking", thinking: "x" }] },
        ],
      }),
    )
    expect(p.input).toEqual([])
  })

  test("filters Anthropic's schema-less server tools out of the tool list", () => {
    const p = anthropicToResponsesPayload(
      basePayload({
        tools: [
          { name: "web_search" } as never,
          { name: "calc", input_schema: { type: "object" } },
        ],
      }),
    )
    expect(p.tools).toEqual([
      {
        type: "function",
        name: "calc",
        description: undefined,
        strict: false,
        parameters: { type: "object" },
      },
    ])
  })

  test("maps tool_choice, including the pinned-tool form", () => {
    expect(
      anthropicToResponsesPayload(basePayload({ tool_choice: { type: "any" } }))
        .tool_choice,
    ).toBe("required")
    expect(
      anthropicToResponsesPayload(
        basePayload({ tool_choice: { type: "tool", name: "calc" } }),
      ).tool_choice,
    ).toEqual({ type: "function", name: "calc" })
  })

  test("buckets a thinking budget into a reasoning effort", () => {
    const low = anthropicToResponsesPayload(
      basePayload({ thinking: { type: "enabled", budget_tokens: 1024 } }),
    )
    expect(low.reasoning?.effort).toBe("low")
    const high = anthropicToResponsesPayload(
      basePayload({ thinking: { type: "enabled", budget_tokens: 32000 } }),
    )
    expect(high.reasoning?.effort).toBe("high")
  })
})

function apiResponse(
  overrides: Partial<ResponsesApiResponse> = {},
): ResponsesApiResponse {
  return {
    id: "resp_1",
    object: "response",
    created_at: 0,
    status: "completed",
    model: "gpt-6-astra",
    output: [],
    ...overrides,
  }
}

describe("responsesResponseToAnthropic", () => {
  test("carries encrypted_content back out as the thinking signature", () => {
    const r = responsesResponseToAnthropic(
      apiResponse({
        output: [
          {
            type: "reasoning",
            encrypted_content: "ENC",
            summary: [{ type: "summary_text", text: "pondering" }],
          },
        ],
      }),
    )
    expect(r.content[0]).toEqual({
      type: "thinking",
      thinking: "pondering",
      signature: "ENC",
    })
  })

  test("converts a function_call to tool_use and reports stop_reason tool_use", () => {
    const r = responsesResponseToAnthropic(
      apiResponse({
        output: [
          {
            type: "function_call",
            call_id: "call_2",
            name: "calc",
            arguments: '{"expr":"17*23"}',
          },
        ],
      }),
    )
    expect(r.content[0]).toEqual({
      type: "tool_use",
      id: "call_2",
      name: "calc",
      input: { expr: "17*23" },
    })
    expect(r.stop_reason).toBe("tool_use")
  })

  test("survives truncated tool arguments", () => {
    const r = responsesResponseToAnthropic(
      apiResponse({
        output: [
          {
            type: "function_call",
            call_id: "c",
            name: "calc",
            arguments: '{"expr":',
          },
        ],
      }),
    )
    expect(r.content[0]).toMatchObject({ type: "tool_use", input: {} })
  })

  test("reports max_tokens for an incomplete turn", () => {
    expect(
      responsesResponseToAnthropic(apiResponse({ status: "incomplete" }))
        .stop_reason,
    ).toBe("max_tokens")
  })

  test("splits cached tokens out of the input count", () => {
    const r = responsesResponseToAnthropic(
      apiResponse({
        usage: {
          input_tokens: 100,
          input_tokens_details: { cached_tokens: 30 },
          output_tokens: 12,
          total_tokens: 112,
        },
      }),
    )
    expect(r.usage.input_tokens).toBe(70)
    expect(r.usage.cache_read_input_tokens).toBe(30)
    expect(r.usage.output_tokens).toBe(12)
  })
})

// Replays the exact event sequence captured live from Copilot for gpt-6-astra.
function drain(events: Array<ResponsesStreamEvent>) {
  const state = createResponsesStreamState()
  return events.flatMap((e) =>
    translateResponsesEventToAnthropicEvents(e, state),
  )
}

describe("streaming translation", () => {
  test("maps a reasoning + text turn to a well-formed Anthropic sequence", () => {
    const out = drain([
      { type: "response.created", response: apiResponse() },
      { type: "response.in_progress" },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "reasoning" },
      },
      { type: "response.reasoning_summary_part.added", output_index: 0 },
      {
        type: "response.reasoning_summary_text.delta",
        output_index: 0,
        delta: "think",
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: { type: "reasoning", encrypted_content: "ENC" },
      },
      { type: "response.content_part.added", output_index: 1 },
      { type: "response.output_text.delta", output_index: 1, delta: "hello" },
      { type: "response.content_part.done", output_index: 1 },
      { type: "response.completed", response: apiResponse() },
    ])

    expect(out.map((e) => e.type)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ])
    // thinking block is index 0, text block index 1, and the signature rides out
    // on the thinking block before it closes.
    expect(out[2]).toMatchObject({
      index: 0,
      delta: { type: "thinking_delta", thinking: "think" },
    })
    expect(out[3]).toMatchObject({
      index: 0,
      delta: { type: "signature_delta", signature: "ENC" },
    })
    expect(out[6]).toMatchObject({
      index: 1,
      delta: { type: "text_delta", text: "hello" },
    })
  })

  test("still emits the signature when reasoning produced no summary text", () => {
    const out = drain([
      { type: "response.created", response: apiResponse() },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "reasoning" },
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: { type: "reasoning", encrypted_content: "ENC" },
      },
    ])
    expect(out.map((e) => e.type)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
    ])
    expect(out[2]).toMatchObject({
      delta: { type: "signature_delta", signature: "ENC" },
    })
  })

  test("keeps parallel tool calls on distinct block indices", () => {
    const out = drain([
      { type: "response.created", response: apiResponse() },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "function_call",
          call_id: "a",
          name: "one",
          arguments: "",
        },
      },
      {
        type: "response.output_item.added",
        output_index: 1,
        item: {
          type: "function_call",
          call_id: "b",
          name: "two",
          arguments: "",
        },
      },
      {
        type: "response.function_call_arguments.delta",
        output_index: 1,
        delta: '{"x"',
      },
      {
        type: "response.function_call_arguments.delta",
        output_index: 0,
        delta: '{"y"',
      },
    ])
    const deltas = out.filter((e) => e.type === "content_block_delta")
    expect(deltas[0]).toMatchObject({
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"x"' },
    })
    expect(deltas[1]).toMatchObject({
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"y"' },
    })
  })

  test("closes a block the upstream left open before message_stop", () => {
    const out = drain([
      { type: "response.created", response: apiResponse() },
      { type: "response.content_part.added", output_index: 0 },
      { type: "response.output_text.delta", output_index: 0, delta: "x" },
      { type: "response.completed", response: apiResponse() },
    ])
    expect(out.map((e) => e.type).slice(-3)).toEqual([
      "content_block_stop",
      "message_delta",
      "message_stop",
    ])
  })
})

describe("effort", () => {
  test("passes output_config.effort straight through, including xhigh and max", () => {
    for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
      const p = anthropicToResponsesPayload(
        basePayload({ output_config: { effort } }),
      )
      expect(p.reasoning?.effort).toBe(effort)
    }
  })

  test("prefers an explicit effort over a thinking budget", () => {
    const p = anthropicToResponsesPayload(
      basePayload({
        output_config: { effort: "max" },
        thinking: { type: "enabled", budget_tokens: 1024 },
      }),
    )
    expect(p.reasoning?.effort).toBe("max")
  })

  test("still buckets a thinking budget when no effort is set", () => {
    const p = anthropicToResponsesPayload(
      basePayload({ thinking: { type: "enabled", budget_tokens: 1024 } }),
    )
    expect(p.reasoning?.effort).toBe("low")
  })
})
