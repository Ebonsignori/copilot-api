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

import consola from "consola"
import { events } from "fetch-event-stream"
import { streamSSE } from "hono/streaming"

import type { ResponsesApiResponse } from "~/routes/responses/types"

import { copilotBaseUrl, copilotHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

import type { AnthropicMessagesPayload } from "./anthropic-types"

import { hasImageBlock, isAgentCall } from "./native-passthrough"
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

export interface ResponsesBridgeRequest {
  url: string
  headers: Record<string, string>
  body: string
}

export function buildResponsesRequest(
  payload: AnthropicMessagesPayload,
  currentState: typeof state,
): ResponsesBridgeRequest {
  const responsesPayload = anthropicToResponsesPayload(payload)
  return {
    url: `${copilotBaseUrl(currentState)}/responses`,
    headers: {
      ...copilotHeaders(currentState, hasImageBlock(payload)),
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
    throw new HTTPError("Failed to call Copilot /responses", response)
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
