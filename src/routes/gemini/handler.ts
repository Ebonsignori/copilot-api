import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"

import type { GeminiGenerateContentRequest } from "./gemini-types"
import {
  completionsChunkToGeminiResponse,
  completionsToGemini,
  createGeminiStreamState,
  geminiToCompletions,
} from "./translation"

export async function handleGenerateContent(c: Context) {
  await checkRateLimit(state)

  const model = c.req.param("model")
  const payload = await c.req.json<GeminiGenerateContentRequest>()
  const isStreaming = c.req.path.includes("streamGenerateContent")

  consola.debug(
    `Gemini ${isStreaming ? "stream" : ""}generateContent for model: ${model}`,
  )
  consola.debug("Gemini request payload:", JSON.stringify(payload).slice(0, 400))

  const openAIPayload = geminiToCompletions(payload, model)
  openAIPayload.stream = isStreaming

  consola.debug(
    "Translated Chat Completions payload:",
    JSON.stringify(openAIPayload).slice(0, 400),
  )

  if (state.manualApprove) {
    await awaitApproval()
  }

  const response = await createChatCompletions(openAIPayload)

  // Non-streaming
  if (isNonStreaming(response)) {
    consola.debug("Non-streaming response from Copilot")
    return c.json(completionsToGemini(response))
  }

  // Streaming — Gemini CLI expects SSE: `data: <json>\n\n`
  consola.debug("Streaming Gemini response")
  return streamSSE(c, async (stream) => {
    const streamState = createGeminiStreamState()

    for await (const rawEvent of response) {
      consola.debug("Raw SSE chunk:", JSON.stringify(rawEvent))

      if (rawEvent.data === "[DONE]") break
      if (!rawEvent.data) continue

      const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
      const geminiResponse = completionsChunkToGeminiResponse(chunk, streamState)

      if (geminiResponse) {
        consola.debug("Gemini stream chunk:", JSON.stringify(geminiResponse))
        await stream.writeSSE({ data: JSON.stringify(geminiResponse) })
      }
    }
  })
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")
