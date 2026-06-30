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

// Translate one Gemini content turn into the OpenAI messages it maps to: an
// assistant tool_calls message (function calls), tool-result messages (function
// responses, keyed by per-name occurrence so the ids match the call side), and a
// text/image message. Pulled out of geminiToCompletions to keep that function's
// branching below the complexity cap.
function contentToMessages(content: GeminiContent): Array<Message> {
  const messages: Array<Message> = []
  const role = content.role === "model" ? "assistant" : "user"

  const functionCallParts = content.parts.filter((p) => p.functionCall)
  const functionResponseParts = content.parts.filter((p) => p.functionResponse)
  const textParts = content.parts.filter(
    (p) => !p.functionCall && !p.functionResponse,
  )

  if (functionCallParts.length > 0) {
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: functionCallParts.flatMap((p, i) => {
        const call = p.functionCall
        if (!call) return []
        return [
          {
            id: `call_${call.name}_${i}`,
            type: "function" as const,
            function: {
              name: call.name,
              arguments: JSON.stringify(call.args),
            },
          },
        ]
      }),
    })
  }

  // Function response parts → tool messages. Track occurrence count per function
  // name so the ids match the call-side generation: call_<name>_<i> where i is
  // the per-name occurrence index.
  const responseOccurrences = new Map<string, number>()
  for (const part of functionResponseParts) {
    const fnResponse = part.functionResponse
    if (!fnResponse) continue
    const occurrence = responseOccurrences.get(fnResponse.name) ?? 0
    responseOccurrences.set(fnResponse.name, occurrence + 1)
    messages.push({
      role: "tool",
      tool_call_id: `call_${fnResponse.name}_${occurrence}`,
      content: JSON.stringify(fnResponse.response),
    })
  }

  if (textParts.length > 0) {
    const hasImage = textParts.some((p) => p.inlineData)
    if (hasImage) {
      messages.push({
        role,
        content: textParts.map((p) =>
          p.inlineData ?
            {
              type: "image_url" as const,
              image_url: {
                url: `data:${p.inlineData.mimeType};base64,${p.inlineData.data}`,
              },
            }
          : { type: "text" as const, text: p.text ?? "" },
        ),
      })
    } else {
      const text = textParts.map((p) => p.text ?? "").join("\n\n")
      messages.push({ role, content: text })
    }
  }

  return messages
}

// Resolve the OpenAI tools array + tool_choice from a Gemini request's tool
// declarations and function-calling config. Extracted to keep geminiToCompletions
// under the complexity cap.
function resolveTools(payload: GeminiGenerateContentRequest): {
  tools: Array<Tool> | undefined
  toolChoice: ChatCompletionsPayload["tool_choice"]
} {
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

  const modeMap: Record<string, ChatCompletionsPayload["tool_choice"]> = {
    AUTO: "auto",
    ANY: "required",
    NONE: "none",
  }
  const fcMode =
    payload.toolConfig?.functionCallingConfig?.mode
    ?? (tools?.length ? "AUTO" : undefined)
  const toolChoice = fcMode ? modeMap[fcMode] : undefined

  return { tools: tools && tools.length > 0 ? tools : undefined, toolChoice }
}

export function geminiToCompletions(
  payload: GeminiGenerateContentRequest,
  model: string,
): ChatCompletionsPayload {
  const messages: Array<Message> = []

  // System instruction
  if (payload.systemInstruction) {
    const systemText = payload.systemInstruction.parts
      .map((p) => p.text)
      .join("\n\n")
    if (systemText) {
      messages.push({ role: "system", content: systemText })
    }
  }

  // Conversation contents
  for (const content of payload.contents) {
    messages.push(...contentToMessages(content))
  }

  const { tools, toolChoice } = resolveTools(payload)

  return {
    model,
    messages,
    stream: true,
    tools,
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
    usageMetadata: toUsageMetadata(response.usage),
    modelVersion: response.model,
  }
}

function mapFinishReason(
  reason: string | null,
): GeminiGenerateContentResponse["candidates"][0]["finishReason"] {
  switch (reason) {
    case "stop": {
      return "STOP"
    }
    case "length": {
      return "MAX_TOKENS"
    }
    case "content_filter": {
      return "SAFETY"
    }
    default: {
      return "FINISH_REASON_UNSPECIFIED"
    }
  }
}

// --- Streaming translation: Chat Completions chunks → Gemini SSE ---

export function createGeminiStreamState(): GeminiStreamState {
  return {
    firstChunk: true,
    toolCallsInProgress: new Map(),
  }
}

// Fold one chunk's streamed tool_call deltas into the in-progress accumulator
// (keyed by tool-call index). Pulled out of completionsChunkToGeminiResponse to
// keep it under the complexity cap.
function accumulateToolCalls(
  toolCalls: NonNullable<
    ChatCompletionChunk["choices"][number]["delta"]["tool_calls"]
  >,
  state: GeminiStreamState,
): void {
  for (const tc of toolCalls) {
    const key = String(tc.index)
    const inProgress = state.toolCallsInProgress.get(key) ?? {
      name: "",
      argsAccum: "",
    }
    if (!state.toolCallsInProgress.has(key)) {
      state.toolCallsInProgress.set(key, inProgress)
    }
    if (tc.function?.name) inProgress.name = tc.function.name
    if (tc.function?.arguments) inProgress.argsAccum += tc.function.arguments
  }
}

// Map an OpenAI usage block to Gemini's usageMetadata shape. Shared by the
// streaming and non-streaming translators (both emit the same fields).
function toUsageMetadata(
  usage:
    | {
        prompt_tokens: number
        completion_tokens: number
        total_tokens: number
        prompt_tokens_details?: { cached_tokens: number }
      }
    | undefined,
): GeminiGenerateContentResponse["usageMetadata"] {
  if (!usage) return undefined
  return {
    promptTokenCount: usage.prompt_tokens,
    candidatesTokenCount: usage.completion_tokens,
    totalTokenCount: usage.total_tokens,
    cachedContentTokenCount: usage.prompt_tokens_details?.cached_tokens,
  }
}

export function completionsChunkToGeminiResponse(
  chunk: ChatCompletionChunk,
  _state: GeminiStreamState,
): GeminiGenerateContentResponse | null {
  // choices is empty on a usage-only terminal chunk, so the element is genuinely
  // optional at runtime even though the array type doesn't say so.
  const choice = chunk.choices.at(0)
  if (!choice && !chunk.usage) return null

  const parts: GeminiGenerateContentResponse["candidates"][0]["content"]["parts"] =
    []

  if (choice?.delta.content) {
    parts.push({ text: choice.delta.content })
  }

  // Accumulate and emit tool calls on finish
  if (choice?.delta.tool_calls) {
    accumulateToolCalls(choice.delta.tool_calls, _state)
  }

  const finishReason = choice?.finish_reason ?? null
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
    usageMetadata: finishReason ? toUsageMetadata(chunk.usage) : undefined,
    modelVersion: chunk.model,
  }
}
