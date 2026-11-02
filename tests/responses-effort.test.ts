import { describe, test, expect } from "bun:test"

import type { State } from "~/lib/state"
import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"

import {
  buildResponsesRequest,
  payloadHasImage,
  supportedEfforts,
  toAnthropicError,
} from "../src/routes/messages/responses-bridge"
import {
  anthropicToResponsesPayload,
  clampEffort,
  stripSchemaPatterns,
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
    ...overrides,
  }
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

describe("stripSchemaPatterns", () => {
  test("drops only the dialects Copilot cannot compile", () => {
    for (const pattern of [
      String.raw`^[^\p{Cc}\p{Cf}]{1,200}$`,
      String.raw`^\P{L}+$`,
      "^(?<name>a)$",
    ]) {
      expect(stripSchemaPatterns({ type: "string", pattern })).toEqual({
        type: "string",
      })
    }
  })

  test("keeps patterns Copilot accepts, including lookaround", () => {
    for (const pattern of [
      "^[a-z]+$",
      "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$",
      "^(?!__.*__$)[a-z]{1,200}$",
      "^(?<=a)b$",
      "^(?<!a)b$",
      "^(?:abc)+$",
    ]) {
      const schema = { type: "string", pattern }
      expect(stripSchemaPatterns(schema)).toEqual(schema)
    }
  })

  test("leaves every other constraint intact", () => {
    const schema = {
      type: "string",
      minLength: 1,
      maxLength: 10,
      format: "uri",
      enum: ["a", "b"],
      description: "keep me",
    }
    expect(stripSchemaPatterns(schema)).toEqual(schema)
  })

  test("recurses through nested schemas and arrays", () => {
    expect(
      stripSchemaPatterns({
        type: "object",
        properties: {
          a: { type: "string", pattern: String.raw`^\p{L}+$` },
          b: { type: "array", items: [{ pattern: "^ok$", type: "string" }] },
        },
      }),
    ).toEqual({
      type: "object",
      properties: {
        a: { type: "string" },
        b: { type: "array", items: [{ pattern: "^ok$", type: "string" }] },
      },
    })
  })
})

describe("strict mode", () => {
  test("opts every tool out of strict mode so optional params stay optional", () => {
    const p = anthropicToResponsesPayload(
      basePayload({
        tools: [
          {
            name: "EnterWorktree",
            input_schema: {
              type: "object",
              properties: {
                name: { type: "string" },
                path: { type: "string" },
              },
            },
          },
        ],
      }),
    )
    // Without this, Copilot forces required:["name","path"] and the model cannot
    // satisfy "provide at most one of name or path".
    expect(p.tools?.[0]).toMatchObject({ strict: false })
  })
})

describe("clampEffort", () => {
  test("passes through when the model advertises the level", () => {
    expect(clampEffort("max", ["low", "medium", "high", "xhigh", "max"])).toBe(
      "max",
    )
  })

  test("clamps down to the strongest supported level", () => {
    expect(clampEffort("max", ["low", "medium", "high", "xhigh"])).toBe("xhigh")
    expect(clampEffort("xhigh", ["low", "medium", "high"])).toBe("high")
  })

  test("never guesses when the model advertises nothing", () => {
    expect(clampEffort("max", undefined)).toBe("max")
    expect(clampEffort("max", [])).toBe("max")
  })

  test("falls back to the weakest level when nothing is at or below", () => {
    expect(clampEffort("low", ["high", "max"])).toBe("high")
  })
})

describe("effort defaults", () => {
  test("sends explicit high when the client sets nothing", () => {
    // Anthropic's API default is high; Copilot's is medium. Omitting the field would
    // silently run a notch weaker than the same session on Claude.
    expect(anthropicToResponsesPayload(basePayload()).reasoning?.effort).toBe(
      "high",
    )
  })

  test("honors thinking disabled by dropping to the weakest level", () => {
    const p = anthropicToResponsesPayload(
      basePayload({ thinking: { type: "disabled" } }),
    )
    expect(p.reasoning?.effort).toBe("low")
  })

  test("caps effort on a tiny output budget to avoid a stalled turn", () => {
    const p = anthropicToResponsesPayload(
      basePayload({ max_tokens: 64, output_config: { effort: "max" } }),
    )
    expect(p.reasoning?.effort).toBe("high")
  })

  test("leaves a normal budget alone", () => {
    const p = anthropicToResponsesPayload(
      basePayload({ max_tokens: 32000, output_config: { effort: "max" } }),
    )
    expect(p.reasoning?.effort).toBe("max")
  })

  test("floors max_output_tokens at Copilot's minimum", () => {
    expect(
      anthropicToResponsesPayload(basePayload({ max_tokens: 1 }))
        .max_output_tokens,
    ).toBe(16)
  })
})

describe("supportedEfforts", () => {
  test("reads the advertised list off the catalog", () => {
    const st = fakeState({
      models: {
        object: "list",
        data: [
          {
            id: "gpt-6-astra",
            capabilities: { supports: { reasoning_effort: ["low", "high"] } },
          },
        ],
      } as never,
    })
    expect(supportedEfforts("gpt-6-astra", st)).toEqual(["low", "high"])
    expect(supportedEfforts("nope", st)).toBeUndefined()
  })
})

describe("toAnthropicError", () => {
  test("unwraps Copilot's double-encoded body into a readable message", () => {
    const body = JSON.stringify({
      error: {
        message: JSON.stringify({
          error: { message: "Unsupported value: 'max'", code: "bad" },
        }),
      },
    })
    expect(toAnthropicError(400, body)).toEqual({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "Unsupported value: 'max'",
      },
    })
  })

  test("maps status codes to Anthropic error types", () => {
    expect(toAnthropicError(429, "{}").error.type).toBe("rate_limit_error")
    expect(toAnthropicError(500, "{}").error.type).toBe("api_error")
  })

  test("passes plain text through untouched", () => {
    expect(toAnthropicError(400, "upstream exploded").error.message).toBe(
      "upstream exploded",
    )
  })
})

describe("tool_result content", () => {
  test("renames Anthropic block types Responses would reject", () => {
    const p = anthropicToResponsesPayload(
      basePayload({
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "call_A",
                content: [{ type: "text", text: "found 3 files" }],
              },
            ],
          },
        ],
      }),
    )
    expect(p.input[0]).toEqual({
      type: "function_call_output",
      call_id: "call_A",
      output: [{ type: "input_text", text: "found 3 files" }],
    })
  })

  test("still passes string content straight through", () => {
    const p = anthropicToResponsesPayload(
      basePayload({
        messages: [
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "c", content: "plain" },
            ],
          },
        ],
      }),
    )
    expect(p.input[0]).toMatchObject({ output: "plain" })
  })

  test("converts images in a tool result", () => {
    const p = anthropicToResponsesPayload(
      basePayload({
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "c",
                content: [
                  {
                    type: "image",
                    source: {
                      type: "base64",
                      media_type: "image/png",
                      data: "AAA",
                    },
                  },
                ],
              },
            ],
          },
        ],
      }),
    )
    expect(p.input[0]).toMatchObject({
      output: [{ type: "input_image", image_url: "data:image/png;base64,AAA" }],
    })
  })

  test("drops unknown block types instead of crashing or 400ing", () => {
    const p = anthropicToResponsesPayload(
      basePayload({
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "c",
                content: [
                  { type: "document", source: {} },
                  { type: "text", text: "kept" },
                ] as never,
              },
            ],
          },
        ],
      }),
    )
    expect(p.input[0]).toMatchObject({
      output: [{ type: "input_text", text: "kept" }],
    })
  })

  test("falls back to an empty string when nothing survives", () => {
    const p = anthropicToResponsesPayload(
      basePayload({
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "c",
                content: [{ type: "document", source: {} }] as never,
              },
            ],
          },
        ],
      }),
    )
    expect(p.input[0]).toMatchObject({ output: "" })
  })
})

describe("payloadHasImage", () => {
  const png = {
    type: "image" as const,
    source: {
      type: "base64" as const,
      media_type: "image/png" as const,
      data: "AAA",
    },
  }

  test("finds a direct image block", () => {
    expect(
      payloadHasImage(
        basePayload({ messages: [{ role: "user", content: [png] }] }),
      ),
    ).toBe(true)
  })

  test("finds an image nested inside a tool_result", () => {
    expect(
      payloadHasImage(
        basePayload({
          messages: [
            {
              role: "user",
              content: [
                { type: "tool_result", tool_use_id: "c", content: [png] },
              ],
            },
          ],
        }),
      ),
    ).toBe(true)
  })

  test("is false for text-only conversations", () => {
    expect(
      payloadHasImage(
        basePayload({
          messages: [
            {
              role: "user",
              content: [
                { type: "tool_result", tool_use_id: "c", content: "plain" },
              ],
            },
          ],
        }),
      ),
    ).toBe(false)
    expect(payloadHasImage(basePayload())).toBe(false)
  })

  test("sets the vision header for a nested image", () => {
    const req = buildResponsesRequest(
      basePayload({
        messages: [
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "c", content: [png] },
            ],
          },
        ],
      }),
      fakeState(),
    )
    expect(req.headers["copilot-vision-request"]).toBe("true")
  })
})
