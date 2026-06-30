// Native Anthropic passthrough for POST /v1/messages.
//
// Instead of the lossy Anthropic -> OpenAI -> Copilot /chat/completions -> OpenAI
// -> Anthropic round-trip (which silently drops `thinking` blocks for Claude — see
// non-stream-translation's "GitHub Copilot doesn't generate thinking blocks"), we
// forward the request to Copilot's native Anthropic endpoint
// (`{copilotBaseUrl}/v1/messages`) with only newer top-level fields the Copilot
// upstream rejects (e.g. `context_management`) stripped out. That endpoint returns real `thinking` blocks +
// signatures and streams them per the Anthropic spec, so by piping its SSE straight
// back we preserve thinking_delta / signature_delta / tool_use and any future block
// type with zero translation.
//
// Verified live against Copilot's individual endpoint: the Copilot bearer token +
// copilotHeaders authenticate here, and the model id is accepted in its FULL form
// (`claude-opus-4-8`, `claude-sonnet-4-5-20250929`). The collapsed forms that
// translateModelName produces for the OpenAI path (`claude-opus-4`) are REJECTED
// here with 400 model_not_supported — so we deliberately forward `model` unchanged.
import type { Context } from "hono"

import consola from "consola"

import {
  ANTHROPIC_VERSION,
  copilotBaseUrl,
  copilotHeaders,
} from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

import {
  type AnthropicImageBlock,
  type AnthropicMessage,
  type AnthropicMessagesPayload,
} from "./anthropic-types"

// True if any message carries an Anthropic image block — drives the Copilot
// vision header, the same way create-chat-completions detects OpenAI image_url.
function hasImageBlock(payload: AnthropicMessagesPayload): boolean {
  return payload.messages.some(
    (msg) =>
      Array.isArray(msg.content)
      && msg.content.some(
        (block): block is AnthropicImageBlock => block.type === "image",
      ),
  )
}

// Agent vs user, for the X-Initiator header (mirrors create-chat-completions): a
// turn is "agent" once the assistant has spoken or a tool_result is being fed back.
function isAgentCall(messages: Array<AnthropicMessage>): boolean {
  return messages.some(
    (msg) =>
      msg.role === "assistant"
      || (Array.isArray(msg.content)
        && msg.content.some((block) => block.type === "tool_result")),
  )
}

export interface NativeAnthropicRequest {
  url: string
  headers: Record<string, string>
  body: string
}

// Top-level request fields that Claude Code (and other up-to-date Anthropic
// clients) send but Copilot's native /v1/messages endpoint rejects with
// `400 invalid_request_error: "<field>: Extra inputs are not permitted"`. These
// are newer Anthropic beta features the Copilot upstream doesn't model yet, so we
// drop them before forwarding. Everything else is forwarded verbatim.
const UNSUPPORTED_TOP_LEVEL_FIELDS = ["context_management"] as const

// Strip the unsupported top-level fields from a copy of the payload, leaving the
// original untouched. Returns the sanitized payload and the names of any fields
// that were removed (for debug logging).
export function sanitizeNativeAnthropicPayload(
  payload: AnthropicMessagesPayload,
): { payload: AnthropicMessagesPayload; removed: Array<string> } {
  const source = payload as unknown as Record<string, unknown>
  const removed = UNSUPPORTED_TOP_LEVEL_FIELDS.filter(
    (field) => field in source,
  )
  const sanitized = Object.fromEntries(
    Object.entries(source).filter(
      ([key]) =>
        !(UNSUPPORTED_TOP_LEVEL_FIELDS as ReadonlyArray<string>).includes(key),
    ),
  )
  return {
    payload: sanitized as unknown as AnthropicMessagesPayload,
    removed: [...removed],
  }
}

// Pure: build the verbatim forward request to Copilot's native Anthropic endpoint.
// Kept separate from the fetch so it can be unit-tested without network or token.
export function buildNativeAnthropicRequest(
  payload: AnthropicMessagesPayload,
  currentState: typeof state,
): NativeAnthropicRequest {
  const { payload: sanitized } = sanitizeNativeAnthropicPayload(payload)
  return {
    url: `${copilotBaseUrl(currentState)}/v1/messages`,
    headers: {
      ...copilotHeaders(currentState, hasImageBlock(sanitized)),
      "anthropic-version": ANTHROPIC_VERSION,
      "X-Initiator": isAgentCall(sanitized.messages) ? "agent" : "user",
    },
    // Forward the inbound payload (model included — see header note) minus the
    // unsupported top-level fields stripped above.
    body: JSON.stringify(sanitized),
  }
}

// I/O: forward to the native endpoint and return its response to the client. A
// streaming request gets its SSE body piped straight through (preserving the native
// Anthropic event sequence); a non-streaming request is returned as JSON. A non-2xx
// upstream throws HTTPError, which the route's forwardError maps to a client error.
export async function handleNativePassthrough(
  c: Context,
  payload: AnthropicMessagesPayload,
) {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const { removed } = sanitizeNativeAnthropicPayload(payload)
  if (removed.length > 0) {
    consola.debug(
      `Stripped unsupported top-level field(s) before native forward: ${removed.join(", ")}`,
    )
  }

  const req = buildNativeAnthropicRequest(payload, state)
  const response = await fetch(req.url, {
    method: "POST",
    headers: req.headers,
    body: req.body,
  })

  if (!response.ok) {
    throw new HTTPError(
      "Failed to forward to native Anthropic endpoint",
      response,
    )
  }

  if (payload.stream && response.body) {
    // Pipe the native Anthropic SSE straight back — no translation, so thinking_delta
    // / signature_delta / content_block_* arrive exactly as Copilot emits them.
    return new Response(response.body, {
      status: response.status,
      headers: {
        "content-type":
          response.headers.get("content-type") ?? "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        // Defeat any reverse-proxy buffering so events flush as they arrive.
        "x-accel-buffering": "no",
      },
    })
  }

  return c.json(await response.json())
}
