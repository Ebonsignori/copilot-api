import {
  type ChatCompletionChunk,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
  type Message,
  type Tool,
} from "~/services/copilot/create-chat-completions"

import {
  type GeminiContent,
  type GeminiGenerateContentRequest,
  type GeminiGenerateContentResponse,
  type GeminiStreamState,
} from "./gemini-types"

// --- Request translation: Gemini → Chat Completions ---

export function geminiToCompletions(
  payload: GeminiGenerateContentRequest,
  model: string,
): ChatCompletionsPayload {
  const messages: Array<Message> = []

  // System instruction
  if (payload.systemInstruction?.parts) {
    const systemText = payload.systemInstruction.parts
      .map((p) => p.text ?? "")
      .join("\n\n")
    if (systemText) {
      messages.push({ role: "system", content: systemText })
    }
  }

  // Conversation contents
  for (const content of payload.contents) {
    const role = content.role === "model" ? "assistant" : "user"

    // Function call parts → assistant tool_calls message
    const functionCallParts = content.parts.filter((p) => p.functionCall)
    const functionResponseParts = content.parts.filter(
      (p) => p.functionResponse,
    )
    const textParts = content.parts.filter(
      (p) => !p.functionCall && !p.functionResponse,
    )

    if (functionCallParts.length > 0) {
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: functionCallParts.map((p, i) => ({
          id: `call_${p.functionCall!.name}_${i}`,
          type: "function",
          function: {
            name: p.functionCall!.name,
            arguments: JSON.stringify(p.functionCall!.args),
          },
        })),
      })
    }

    // Function response parts → tool messages
    for (const part of functionResponseParts) {
      messages.push({
        role: "tool",
        tool_call_id: `call_${part.functionResponse!.name}_0`,
        content: JSON.stringify(part.functionResponse!.response),
      })
    }

    // Text/image parts
    if (textParts.length > 0) {
      const hasImage = textParts.some((p) => p.inlineData)

      if (!hasImage) {
        const text = textParts.map((p) => p.text ?? "").join("\n\n")
        messages.push({ role, content: text })
      } else {
        messages.push({
          role,
          content: textParts.map((p) => {
            if (p.inlineData) {
              return {
                type: "image_url" as const,
                image_url: {
                  url: `data:${p.inlineData.mimeType};base64,${p.inlineData.data}`,
                },
              }
            }
            return { type: "text" as const, text: p.text ?? "" }
          }),
        })
      }
    }
  }

  // Tools
  const tools: Array<Tool> | undefined = payload.tools
    ?.flatMap((t) => t.functionDeclarations ?? [])
    .map((fn) => ({
      type: "function" as const,
      function: {
        name: fn.name,
        description: fn.description,
        parameters: fn.parameters ?? {},
      },
    }))

  // Tool choice
  const modeMap: Record<string, ChatCompletionsPayload["tool_choice"]> = {
    AUTO: "auto",
    ANY: "required",
    NONE: "none",
  }
  const fcMode =
    payload.toolConfig?.functionCallingConfig?.mode ?? (tools?.length ? "AUTO" : undefined)
  const toolChoice = fcMode ? modeMap[fcMode] : undefined

  return {
    model,
    messages,
    stream: true,
    tools: tools && tools.length > 0 ? tools : undefined,
    tool_choice: toolChoice,
    temperature: payload.generationConfig?.temperature,
    top_p: payload.generationConfig?.topP,
    max_tokens: payload.generationConfig?.maxOutputTokens,
    stop: payload.generationConfig?.stopSequences,
  }
}

// --- Response translation: Chat Completions → Gemini (non-streaming) ---

export function completionsToGemini(
  response: ChatCompletionResponse,
): GeminiGenerateContentResponse {
  const choice = response.choices[0]
  const parts: GeminiGenerateContentResponse["candidates"][0]["content"]["parts"] =
    []

  if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
    for (const tc of choice.message.tool_calls) {
      parts.push({
        functionCall: {
          name: tc.function.name,
          args: JSON.parse(tc.function.arguments) as Record<string, unknown>,
        },
      })
    }
  } else {
    parts.push({ text: choice.message.content ?? "" })
  }

  return {
    candidates: [
      {
        content: { role: "model", parts },
        finishReason: mapFinishReason(choice.finish_reason),
        index: 0,
      },
    ],
    usageMetadata: response.usage
      ? {
          promptTokenCount: response.usage.prompt_tokens,
          candidatesTokenCount: response.usage.completion_tokens,
          totalTokenCount: response.usage.total_tokens,
          cachedContentTokenCount:
            response.usage.prompt_tokens_details?.cached_tokens,
        }
      : undefined,
    modelVersion: response.model,
  }
}

function mapFinishReason(
  reason: string | null,
): GeminiGenerateContentResponse["candidates"][0]["finishReason"] {
  switch (reason) {
    case "stop":
      return "STOP"
    case "length":
      return "MAX_TOKENS"
    case "content_filter":
      return "SAFETY"
    default:
      return "FINISH_REASON_UNSPECIFIED"
  }
}

// --- Streaming translation: Chat Completions chunks → Gemini SSE ---

export function createGeminiStreamState(): GeminiStreamState {
  return {
    firstChunk: true,
    toolCallsInProgress: new Map(),
  }
}

export function completionsChunkToGeminiResponse(
  chunk: ChatCompletionChunk,
  _state: GeminiStreamState,
): GeminiGenerateContentResponse | null {
  const choice = chunk.choices?.[0]
  if (!choice && !chunk.usage) return null

  const parts: GeminiGenerateContentResponse["candidates"][0]["content"]["parts"] =
    []

  if (choice?.delta.content) {
    parts.push({ text: choice.delta.content })
  }

  // Accumulate and emit tool calls on finish
  if (choice?.delta.tool_calls) {
    for (const tc of choice.delta.tool_calls) {
      const key = String(tc.index)
      if (!_state.toolCallsInProgress.has(key)) {
        _state.toolCallsInProgress.set(key, {
          name: tc.function?.name ?? "",
          argsAccum: "",
        })
      }
      const inProgress = _state.toolCallsInProgress.get(key)!
      if (tc.function?.name) inProgress.name += tc.function.name
      if (tc.function?.arguments) inProgress.argsAccum += tc.function.arguments
    }
  }

  const finishReason = choice?.finish_reason
  if (finishReason === "tool_calls") {
    for (const [, tc] of _state.toolCallsInProgress) {
      parts.push({
        functionCall: {
          name: tc.name,
          args: JSON.parse(tc.argsAccum) as Record<string, unknown>,
        },
      })
    }
    _state.toolCallsInProgress.clear()
  }

  if (parts.length === 0 && !finishReason && !chunk.usage) return null

  return {
    candidates: [
      {
        content: { role: "model", parts },
        finishReason: finishReason ? mapFinishReason(finishReason) : undefined,
        index: 0,
      },
    ],
    usageMetadata:
      finishReason && chunk.usage
        ? {
            promptTokenCount: chunk.usage.prompt_tokens,
            candidatesTokenCount: chunk.usage.completion_tokens,
            totalTokenCount: chunk.usage.total_tokens,
            cachedContentTokenCount:
              chunk.usage.prompt_tokens_details?.cached_tokens,
          }
        : undefined,
    modelVersion: chunk.model,
  }
}
