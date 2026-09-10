// Anthropic /v1/messages -> Copilot /responses bridge.
//
// Copilot serves every recent GPT (5.5, 5.6-*, gpt-6-astra) ONLY on /responses, so
// neither the native Anthropic passthrough nor the legacy /chat/completions path can
// reach them -- both return `no_available_model_endpoints`. This module is the third
// outbound path: translate in, call /responses, translate out.
//
// Structured like native-passthrough.ts: a pure request builder (unit-testable with
// no network or token) separated from the fetch.
import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"

import consola from "consola"
import { events } from "fetch-event-stream"
import { streamSSE } from "hono/streaming"

import type { ResponsesApiResponse } from "~/routes/responses/types"

import { copilotBaseUrl, copilotHeaders } from "~/lib/api-config"
import { state } from "~/lib/state"

import type { AnthropicMessagesPayload } from "./anthropic-types"

import { isAgentCall } from "./native-passthrough"
import {
  createResponsesStreamState,
  translateResponsesEventToAnthropicEvents,
  type ResponsesStreamEvent,
} from "./responses-stream-translation"
import {
  anthropicToResponsesPayload,
  responsesResponseToAnthropic,
} from "./responses-translation"

// Route on the catalog's own capability list rather than a name pattern, so new
// families (Gemini, Grok, whatever ships next) are handled without a code change.
// If the catalog is unavailable we return false and let the caller fall through to
// existing behavior -- never guess.
export function isResponsesOnlyModel(
  modelId: string,
  currentState: typeof state,
): boolean {
  const model = currentState.models?.data.find((m) => m.id === modelId)
  const endpoints = model?.supported_endpoints
  if (!endpoints || endpoints.length === 0) return false
  return endpoints.includes("/responses") && !endpoints.includes("/v1/messages")
}

// The shared image check in native-passthrough only scans top-level message blocks.
// An image returned INSIDE a tool_result -- a screenshot tool's output, which is the
// usual way images enter an agentic session -- therefore never sets the vision
// header, and Copilot drops the image silently: no error, just a model that says it
// received nothing. Scan nested tool_result content as well.
//
// NOTE: the native passthrough has the same blind spot on the Claude path; left alone
// here rather than changing behavior that isn't part of this bridge.
export function payloadHasImage(payload: AnthropicMessagesPayload): boolean {
  return payload.messages.some((message) => {
    if (!Array.isArray(message.content)) return false
    return message.content.some((block) => {
      if (block.type === "image") return true
      if (block.type !== "tool_result") return false
      const nested = (block as { content?: unknown }).content
      return (
        Array.isArray(nested)
        && nested.some((part) => (part as { type?: string }).type === "image")
      )
    })
  })
}

// The effort levels this model actually accepts, straight from the catalog. Used to
// clamp: gpt-5.5 and gpt-5.4 reject "max" with a 400, so an unclamped /effort max
// would lock a user out of those models entirely.
export function supportedEfforts(
  modelId: string,
  currentState: typeof state,
): Array<string> | undefined {
  return currentState.models?.data.find((m) => m.id === modelId)?.capabilities
    .supports.reasoning_effort
}

// Copilot reports failures as an OpenAI-shaped body, and often double-encodes it -- a
// JSON string nested inside error.message. Forwarded verbatim it reaches the client as
// an escaped blob instead of a readable sentence. Unwrap to the innermost message and
// re-emit in Anthropic's envelope so clients render it properly.
export function toAnthropicError(
  status: number,
  body: string,
): { type: "error"; error: { type: string; message: string } } {
  let message = body
  for (let depth = 0; depth < 3; depth++) {
    try {
      const parsed = JSON.parse(message) as unknown
      const errorField = (parsed as { error?: { message?: unknown } }).error
      const inner = errorField?.message
      if (typeof inner === "string") {
        message = inner
        continue
      }
      if (typeof parsed === "string") {
        message = parsed
        continue
      }
    } catch {
      break
    }
    break
  }

  const byStatus: Record<number, string> = {
    400: "invalid_request_error",
    401: "authentication_error",
    403: "permission_error",
    404: "not_found_error",
    413: "request_too_large",
    429: "rate_limit_error",
  }
  return {
    type: "error",
    error: {
      type: byStatus[status] ?? (status >= 500 ? "api_error" : "api_error"),
      message: message.trim(),
    },
  }
}

export interface ResponsesBridgeRequest {
  url: string
  headers: Record<string, string>
  body: string
}

export function buildResponsesRequest(
  payload: AnthropicMessagesPayload,
  currentState: typeof state,
): ResponsesBridgeRequest {
  const responsesPayload = anthropicToResponsesPayload(
    payload,
    supportedEfforts(payload.model, currentState),
  )
  return {
    url: `${copilotBaseUrl(currentState)}/responses`,
    headers: {
      ...copilotHeaders(currentState, payloadHasImage(payload)),
      "X-Initiator": isAgentCall(payload.messages) ? "agent" : "user",
      ...(payload.stream === true && { accept: "text/event-stream" }),
    },
    body: JSON.stringify(responsesPayload),
  }
}

export async function handleResponsesBridge(
  c: Context,
  payload: AnthropicMessagesPayload,
) {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const req = buildResponsesRequest(payload, state)
  consola.debug("Responses bridge request:", req.body.slice(0, 400))

  const response = await fetch(req.url, {
    method: "POST",
    headers: req.headers,
    body: req.body,
  })

  if (!response.ok) {
    const body = await response.text()
    const shaped = toAnthropicError(response.status, body)
    consola.error(
      `Copilot /responses ${response.status}: ${shaped.error.message}`,
    )
    return c.json(shaped, response.status as ContentfulStatusCode)
  }

  if (!payload.stream) {
    const json = (await response.json()) as ResponsesApiResponse
    const anthropicResponse = responsesResponseToAnthropic(json)
    consola.debug(
      "Responses bridge (non-streaming) ->",
      JSON.stringify(anthropicResponse).slice(0, 400),
    )
    return c.json(anthropicResponse)
  }

  return streamSSE(c, async (stream) => {
    const streamState = createResponsesStreamState()

    for await (const chunk of events(response)) {
      if (chunk.data === "[DONE]") break
      if (!chunk.data) continue

      let parsed: ResponsesStreamEvent
      try {
        parsed = JSON.parse(chunk.data) as ResponsesStreamEvent
      } catch {
        consola.debug("Skipping unparseable Responses chunk")
        continue
      }
      // The envelope repeats its name inside `data.type`; prefer it and fall back
      // to the SSE event name.
      const event: ResponsesStreamEvent = {
        ...parsed,
        type: parsed.type || (chunk.event ?? ""),
      }

      for (const out of translateResponsesEventToAnthropicEvents(
        event,
        streamState,
      )) {
        await stream.writeSSE({ event: out.type, data: JSON.stringify(out) })
      }
    }
  })
}
