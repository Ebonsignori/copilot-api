import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { webSearchEnabled } from "~/lib/web-search"
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"

import {
  type AnthropicMessagesPayload,
  type AnthropicStreamState,
} from "./anthropic-types"
import { handleNativePassthrough } from "./native-passthrough"
import {
  translateToAnthropic,
  translateToOpenAI,
} from "./non-stream-translation"
import { translateChunkToAnthropicEvents } from "./stream-translation"
import { anthropicResponseToStreamEvents } from "./synthesize-stream"
import { buildSearchBlocks } from "./web-search-blocks"
import { runWebSearchLoop } from "./web-search-loop"

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
  consola.debug("Anthropic request payload:", JSON.stringify(anthropicPayload))

  if (state.manualApprove) {
    await awaitApproval()
  }

  // When the request carries Anthropic's server-side web_search tool and a
  // broker is configured, run the search loop entirely server-side (emulating
  // Anthropic's hosted behavior) and return a finished answer. Claude Code's
  // built-in WebSearch then "just works" through the proxy. This pre-branch
  // depends on the OpenAI translate path and runs regardless of the passthrough
  // flag (it has no native-endpoint equivalent yet).
  if (webSearchEnabled(anthropicPayload.tools)) {
    const openAIPayload = translateToOpenAI(anthropicPayload)
    consola.debug(
      "Translated OpenAI request payload (web_search):",
      JSON.stringify(openAIPayload),
    )
    return handleWebSearch(c, anthropicPayload, openAIPayload)
  }

  // Default: forward straight to Copilot's native Anthropic endpoint so native
  // `thinking` blocks, signatures, and token-by-token streaming survive intact.
  if (state.anthropicPassthrough) {
    consola.debug("Forwarding to native Anthropic endpoint (passthrough)")
    return handleNativePassthrough(c, anthropicPayload)
  }

  // Legacy path (kill-switch off): translate through OpenAI /chat/completions.
  // Drops `thinking` for Claude, but kept as a fast revert.
  const openAIPayload = translateToOpenAI(anthropicPayload)
  consola.debug(
    "Translated OpenAI request payload (legacy):",
    JSON.stringify(openAIPayload),
  )
  const response = await createChatCompletions(openAIPayload)

  if (isNonStreaming(response)) {
    consola.debug(
      "Non-streaming response from Copilot:",
      JSON.stringify(response).slice(-400),
    )
    const anthropicResponse = translateToAnthropic(response)
    consola.debug(
      "Translated Anthropic response:",
      JSON.stringify(anthropicResponse),
    )
    return c.json(anthropicResponse)
  }

  consola.debug("Streaming response from Copilot")
  return streamSSE(c, async (stream) => {
    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
    }

    for await (const rawEvent of response) {
      consola.debug("Copilot raw stream event:", JSON.stringify(rawEvent))
      if (rawEvent.data === "[DONE]") {
        break
      }

      if (!rawEvent.data) {
        continue
      }

      const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
      const events = translateChunkToAnthropicEvents(chunk, streamState)

      for (const event of events) {
        consola.debug("Translated Anthropic event:", JSON.stringify(event))
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        })
      }
    }
  })
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")

// Pull the web_search tool's max_uses (if the client set one) to bound the loop.
function webSearchMaxUses(
  payload: AnthropicMessagesPayload,
): number | undefined {
  const tool = payload.tools?.find(
    (t): t is typeof t & { max_uses?: number } => t.name === "web_search",
  )
  const raw = (tool as { max_uses?: number } | undefined)?.max_uses
  return typeof raw === "number" && raw > 0 ? raw : undefined
}

// Service the request's web_search tool server-side, then return the finished
// answer to the client — as JSON for a non-streaming request, or as a
// synthesized SSE stream for a streaming one. Either way the client receives a
// normal assistant turn (text, or a passed-through client-side tool_use) and
// never a dangling web_search tool_use. The searches the proxy ran are emitted
// as faithful server_tool_use + web_search_tool_result blocks so Claude Code
// shows the search count and clickable sources.
async function handleWebSearch(
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  openAIPayload: ReturnType<typeof translateToOpenAI>,
) {
  consola.debug("Handling web_search via broker loop")
  const { response, searches } = await runWebSearchLoop(
    openAIPayload,
    webSearchMaxUses(anthropicPayload),
  )
  const anthropicResponse = translateToAnthropic(response)

  // Prepend the search blocks (in execution order) before the model's text, and
  // record the search count in usage so Claude Code's "Did N searches" is right.
  const searchBlocks = buildSearchBlocks(searches, anthropicResponse.id)
  if (searchBlocks.length > 0) {
    anthropicResponse.content = [...searchBlocks, ...anthropicResponse.content]
    anthropicResponse.usage.server_tool_use = {
      web_search_requests: searches.length,
    }
  }

  if (!anthropicPayload.stream) {
    return c.json(anthropicResponse)
  }

  // Synthesize the streaming form from the finished message so streaming
  // clients (Claude Code) get the SSE event sequence they expect.
  return streamSSE(c, async (stream) => {
    for (const event of anthropicResponseToStreamEvents(anthropicResponse)) {
      await stream.writeSSE({ event: event.type, data: JSON.stringify(event) })
    }
  })
}
