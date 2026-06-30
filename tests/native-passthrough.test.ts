import { describe, test, expect } from "bun:test"

import type { State } from "~/lib/state"
import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"

import {
  buildNativeAnthropicRequest,
  sanitizeNativeAnthropicPayload,
} from "../src/routes/messages/native-passthrough"

// A minimal individual-account state with a copilot token so copilotHeaders()
// produces the Authorization header.
function fakeState(overrides: Partial<State> = {}): State {
  return {
    accountType: "individual",
    manualApprove: false,
    rateLimitWait: false,
    showToken: false,
    anthropicPassthrough: true,
    copilotToken: "tid=test-token",
    vsCodeVersion: "1.104.3",
    ...overrides,
  }
}

function basePayload(
  overrides: Partial<AnthropicMessagesPayload> = {},
): AnthropicMessagesPayload {
  return {
    model: "claude-opus-4-8",
    max_tokens: 1024,
    messages: [{ role: "user", content: "hi" }],
    ...overrides,
  }
}

describe("buildNativeAnthropicRequest", () => {
  test("targets the native /v1/messages endpoint on the individual base url", () => {
    const req = buildNativeAnthropicRequest(basePayload(), fakeState())
    expect(req.url).toBe("https://api.githubcopilot.com/v1/messages")
  })

  test("targets the account-typed base url for non-individual accounts", () => {
    const req = buildNativeAnthropicRequest(
      basePayload(),
      fakeState({ accountType: "enterprise" }),
    )
    expect(req.url).toBe("https://api.enterprise.githubcopilot.com/v1/messages")
  })

  test("sets the anthropic-version header", () => {
    const req = buildNativeAnthropicRequest(basePayload(), fakeState())
    expect(req.headers["anthropic-version"]).toBe("2023-06-01")
  })

  test("carries the copilot Authorization header", () => {
    const req = buildNativeAnthropicRequest(basePayload(), fakeState())
    expect(req.headers.Authorization).toBe("Bearer tid=test-token")
  })

  test("forwards the model id VERBATIM (no collapse to claude-opus-4)", () => {
    // The native endpoint rejects the collapsed forms translateModelName makes
    // for the OpenAI path — so the full id must survive untouched.
    const req = buildNativeAnthropicRequest(
      basePayload({ model: "claude-opus-4-8" }),
      fakeState(),
    )
    const body = JSON.parse(req.body) as AnthropicMessagesPayload
    expect(body.model).toBe("claude-opus-4-8")
  })

  test("preserves the thinking parameter verbatim in the body", () => {
    const thinking = { type: "adaptive", display: "summarized" } as const
    const req = buildNativeAnthropicRequest(
      basePayload({ thinking: thinking as never }),
      fakeState(),
    )
    const body = JSON.parse(req.body) as Record<string, unknown>
    expect(body.thinking).toEqual(thinking)
  })

  test("X-Initiator is 'user' for a plain first user turn", () => {
    const req = buildNativeAnthropicRequest(basePayload(), fakeState())
    expect(req.headers["X-Initiator"]).toBe("user")
  })

  test("X-Initiator is 'agent' once an assistant message is present", () => {
    const req = buildNativeAnthropicRequest(
      basePayload({
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
          { role: "user", content: "more" },
        ],
      }),
      fakeState(),
    )
    expect(req.headers["X-Initiator"]).toBe("agent")
  })

  test("X-Initiator is 'agent' when a tool_result is being fed back", () => {
    const req = buildNativeAnthropicRequest(
      basePayload({
        messages: [
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "t1", content: "42" },
            ],
          },
        ],
      }),
      fakeState(),
    )
    expect(req.headers["X-Initiator"]).toBe("agent")
  })

  test("no vision header for a text-only request", () => {
    const req = buildNativeAnthropicRequest(basePayload(), fakeState())
    expect(req.headers["copilot-vision-request"]).toBeUndefined()
  })

  test("sets the vision header when a message carries an image block", () => {
    const req = buildNativeAnthropicRequest(
      basePayload({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "what is this" },
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: "abc",
                },
              },
            ],
          },
        ],
      }),
      fakeState(),
    )
    expect(req.headers["copilot-vision-request"]).toBe("true")
  })

  test("strips context_management (Copilot upstream rejects it as an extra input)", () => {
    const req = buildNativeAnthropicRequest(
      basePayload({
        context_management: {
          edits: [{ type: "clear_tool_uses_20250919" }],
        },
      } as never),
      fakeState(),
    )
    const body = JSON.parse(req.body) as Record<string, unknown>
    expect(body.context_management).toBeUndefined()
    // The rest of the payload must survive untouched.
    expect(body.model).toBe("claude-opus-4-8")
    expect(body.messages).toEqual([{ role: "user", content: "hi" }])
  })
})

describe("sanitizeNativeAnthropicPayload", () => {
  test("reports which unsupported fields it removed", () => {
    const { payload, removed } = sanitizeNativeAnthropicPayload(
      basePayload({ context_management: {} } as never),
    )
    expect(removed).toEqual(["context_management"])
    expect("context_management" in payload).toBe(false)
  })

  test("removes nothing and reports empty for a clean payload", () => {
    const { removed } = sanitizeNativeAnthropicPayload(basePayload())
    expect(removed).toEqual([])
  })

  test("does not mutate the original payload", () => {
    const original = basePayload({ context_management: {} } as never)
    sanitizeNativeAnthropicPayload(original)
    expect(
      (original as unknown as Record<string, unknown>).context_management,
    ).toBeDefined()
  })
})
