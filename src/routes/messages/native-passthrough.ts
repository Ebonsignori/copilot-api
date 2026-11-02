// Native Anthropic passthrough for POST /v1/messages.
//
// Instead of the lossy Anthropic -> OpenAI -> Copilot /chat/completions -> OpenAI
// -> Anthropic round-trip (which silently drops `thinking` blocks for Claude — see
// non-stream-translation's "GitHub Copilot doesn't generate thinking blocks"), we
// forward the request to Copilot's native Anthropic endpoint
// (`{copilotBaseUrl}/v1/messages`) with only the newer fields the Copilot upstream
// rejects (e.g. `context_management`) stripped or rewritten. That endpoint returns real `thinking` blocks +
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
export function isAgentCall(messages: Array<AnthropicMessage>): boolean {
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

// Top-level fields that newer Anthropic betas add. Copilot's native endpoint
// accepts each one only when the request carries its beta flag in
// `anthropic-beta` (forwarded below). Without the flag it rejects the field with
// `400 invalid_request_error: "<field>: Extra inputs are not permitted"`, so a
// field is dropped only when its beta wasn't sent. Everything else is forwarded
// verbatim. (Per-message `output_config` from the per-turn-control beta works
// the same way, and needs nothing here: Claude Code always sends that beta.)
// An entry without a betaPrefix is rejected whatever betas are sent: Claude Code
// adds `safeguards` (auto-mode classifier context), and when it's rejected it
// retries the turn without it, so dropping it up front saves that round trip.
const BETA_GATED_TOP_LEVEL_FIELDS: ReadonlyArray<{
  field: string
  betaPrefix?: string
}> = [
  { field: "context_management", betaPrefix: "context-management-" },
  { field: "safeguards" },
]

// `thinking.display` values the endpoint accepts, with or without betas.
// Interactive Claude Code also sends "highlights", rejected with
// `thinking.adaptive.display: Input should be 'summarized', 'omitted'`. Anything
// else becomes "summarized", the closest accepted value: the client still gets
// readable thinking back.
const SUPPORTED_THINKING_DISPLAYS: ReadonlySet<unknown> = new Set([
  "summarized",
  "omitted",
])
const FALLBACK_THINKING_DISPLAY = "summarized"

// Strip or rewrite what the endpoint rejects, on a copy of the payload, leaving
// the original untouched. `anthropicBeta` is the client's anthropic-beta header.
// Returns the sanitized payload and what was changed (for debug logging).
export function sanitizeNativeAnthropicPayload(
  payload: AnthropicMessagesPayload,
  anthropicBeta?: string,
): { payload: AnthropicMessagesPayload; removed: Array<string> } {
  const betas = (anthropicBeta ?? "").split(",").map((beta) => beta.trim())
  const source = payload as unknown as Record<string, unknown>
  const removed: Array<string> = BETA_GATED_TOP_LEVEL_FIELDS.filter(
    ({ field, betaPrefix }) =>
      field in source
      && (betaPrefix === undefined
        || !betas.some((beta) => beta.startsWith(betaPrefix))),
  ).map(({ field }) => field)
  const sanitized = Object.fromEntries(
    Object.entries(source).filter(([key]) => !removed.includes(key)),
  )

  const thinking = payload.thinking
  if (
    thinking?.display !== undefined
    && !SUPPORTED_THINKING_DISPLAYS.has(thinking.display)
  ) {
    sanitized.thinking = { ...thinking, display: FALLBACK_THINKING_DISPLAY }
    removed.push(`thinking.display=${JSON.stringify(thinking.display)}`)
  }

  return {
    payload: sanitized as unknown as AnthropicMessagesPayload,
    removed,
  }
}

// Pure: build the verbatim forward request to Copilot's native Anthropic endpoint.
// Kept separate from the fetch so it can be unit-tested without network or token.
export function buildNativeAnthropicRequest(
  payload: AnthropicMessagesPayload,
  currentState: typeof state,
  anthropicBeta?: string,
): NativeAnthropicRequest {
  const { payload: sanitized } = sanitizeNativeAnthropicPayload(
    payload,
    anthropicBeta,
  )
  return {
    url: `${copilotBaseUrl(currentState)}/v1/messages`,
    headers: {
      ...copilotHeaders(currentState, hasImageBlock(sanitized)),
      "anthropic-version": ANTHROPIC_VERSION,
      // The client's betas gate fields the endpoint otherwise rejects (see
      // BETA_GATED_TOP_LEVEL_FIELDS) and features like the 1M context window.
      ...(anthropicBeta ? { "anthropic-beta": anthropicBeta } : {}),
      "X-Initiator": isAgentCall(sanitized.messages) ? "agent" : "user",
    },
    // Forward the inbound payload (model included — see header note) minus what
    // the sanitizer above strips or rewrites.
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

  const anthropicBeta = c.req.header("anthropic-beta")
  const { removed } = sanitizeNativeAnthropicPayload(payload, anthropicBeta)
  if (removed.length > 0) {
    consola.debug(
      `Sanitized unsupported field(s) before native forward: ${removed.join(", ")}`,
    )
  }

  const req = buildNativeAnthropicRequest(payload, state, anthropicBeta)
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
