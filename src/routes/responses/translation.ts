import type {
  ChatCompletionChunk,
  ChatCompletionsPayload,
  Message,
  Tool,
} from "~/services/copilot/create-chat-completions"

import type {
  FunctionCallItem,
  MessageItem,
  ResponseItem,
  ResponsesApiPayload,
  ResponsesApiResponse,
  ResponsesStreamState,
  ToolCallInProgress,
} from "./types"

// --- Request translation: Responses API → Chat Completions ---

export function responsesPayloadToCompletions(
  payload: ResponsesApiPayload,
): ChatCompletionsPayload {
  const messages: Array<Message> = []

  // System prompt from top-level instructions
  if (payload.instructions) {
    messages.push({ role: "system", content: payload.instructions })
  }

  // Walk input items and translate to Chat Completions messages
  for (const item of payload.input) {
    switch (item.type) {
      case "message": {
        const role = item.role === "developer" ? "system" : item.role
        // Flatten content array
        const contentParts = item.content
        if (contentParts.length === 0) break
        if (
          contentParts.length === 1
          && contentParts[0].type === "input_text"
        ) {
          // Simple string content
          messages.push({ role, content: contentParts[0].text })
        } else {
          // Mixed content — map to Chat Completions content parts
          messages.push({
            role,
            content: contentParts.map((part) => {
              if (part.type === "input_text" || part.type === "output_text") {
                return { type: "text" as const, text: part.text }
              }
              // input_image
              return {
                type: "image_url" as const,
                image_url: { url: part.image_url },
              }
            }),
          })
        }
        break
      }

      case "function_call": {
        // Model's tool call from a prior turn
        messages.push({
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: item.call_id,
              type: "function",
              function: { name: item.name, arguments: item.arguments },
            },
          ],
        })
        break
      }

      case "function_call_output": {
        // Tool result
        const outputContent =
          typeof item.output === "string"
            ? item.output
            : item.output
                .map((p) => ("text" in p ? p.text : ""))
                .join("\n")
        messages.push({
          role: "tool",
          content: outputContent,
          tool_call_id: item.call_id,
        })
        break
      }

      // Unsupported item types — silently skip
      case "reasoning":
      case "local_shell_call":
      case "custom_tool_call":
      case "custom_tool_call_output":
        break
    }
  }

  // Translate tools — only function tools are supported by Chat Completions
  const tools: Array<Tool> | undefined = payload.tools
    ?.filter((t): t is { type: "function"; name: string; description?: string; strict?: boolean; parameters?: Record<string, unknown> } => t.type === "function")
    .map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters ?? {},
      },
    }))

  return {
    model: payload.model,
    messages,
    tools: tools && tools.length > 0 ? tools : undefined,
    tool_choice: (tools && tools.length > 0) ? "auto" : undefined,
    parallel_tool_calls: payload.parallel_tool_calls,
    stream: true, // codex-rs always streams; always forward as streaming
  }
}

// --- Response translation: Chat Completions → Responses API (non-streaming) ---

export function completionsResponseToResponses(
  response: {
    id: string
    model: string
    choices: Array<{
      message: { role: string; content: string | null; tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }> }
      finish_reason: string
    }>
    usage?: {
      prompt_tokens: number
      completion_tokens: number
      total_tokens: number
      prompt_tokens_details?: { cached_tokens: number }
    }
  },
): ResponsesApiResponse {
  const choice = response.choices[0]
  const output: Array<ResponseItem> = []

  if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
    for (const tc of choice.message.tool_calls) {
      output.push({
        type: "function_call",
        call_id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      } satisfies FunctionCallItem)
    }
  } else {
    output.push({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: choice.message.content ?? "" }],
    } satisfies MessageItem)
  }

  return {
    id: `resp_${response.id}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: response.model,
    output,
    usage: response.usage
      ? {
          input_tokens: response.usage.prompt_tokens,
          input_tokens_details: response.usage.prompt_tokens_details
            ? { cached_tokens: response.usage.prompt_tokens_details.cached_tokens }
            : undefined,
          output_tokens: response.usage.completion_tokens,
          total_tokens: response.usage.total_tokens,
        }
      : undefined,
    error: null,
  }
}

// --- Streaming translation: Chat Completions chunks → Responses API SSE events ---

export function createStreamState(responseId: string): ResponsesStreamState {
  return {
    responseId,
    firstChunk: true,
    outputItemOpen: false,
    textAccum: "",
    toolCallsInProgress: new Map<number, ToolCallInProgress>(),
  }
}

export interface ResponsesEvent {
  type: string
  [key: string]: unknown
}

export function completionsChunkToResponsesEvents(
  chunk: ChatCompletionChunk,
  state: ResponsesStreamState,
): Array<ResponsesEvent> {
  const events: Array<ResponsesEvent> = []
  const choice = chunk.choices?.[0]

  // First chunk — emit response.created
  if (state.firstChunk) {
    state.firstChunk = false
    events.push({
      type: "response.created",
      response: { id: state.responseId },
    })
  }

  if (!choice) {
    // May be a usage-only final chunk
    if (chunk.usage) {
      events.push(...flushAndComplete(state, chunk))
    }
    return events
  }

  const delta = choice.delta
  const finishReason = choice.finish_reason

  // Accumulate text content
  if (delta.content) {
    if (!state.outputItemOpen) {
      state.outputItemOpen = true
      events.push({
        type: "response.output_item.added",
        item: {
          type: "message",
          role: "assistant",
          id: `msg_${state.responseId}`,
          content: [{ type: "output_text", text: "" }],
        },
      })
    }
    state.textAccum += delta.content
    events.push({
      type: "response.output_text.delta",
      delta: delta.content,
    })
  }

  // Accumulate tool call fragments
  if (delta.tool_calls) {
    for (const tc of delta.tool_calls) {
      if (!state.toolCallsInProgress.has(tc.index)) {
        state.toolCallsInProgress.set(tc.index, {
          call_id: tc.id ?? `call_${tc.index}_${state.responseId}`,
          name: tc.function?.name ?? "",
          argsAccum: "",
        })
      }
      const inProgress = state.toolCallsInProgress.get(tc.index)!
      if (tc.id) inProgress.call_id = tc.id
      if (tc.function?.name) inProgress.name += tc.function.name
      if (tc.function?.arguments) inProgress.argsAccum += tc.function.arguments
    }
  }

  // On finish, emit done items and response.completed
  if (finishReason === "stop") {
    events.push(...flushAndComplete(state, chunk))
  } else if (finishReason === "tool_calls") {
    events.push(...flushToolCallsAndComplete(state, chunk))
  } else if (finishReason === "length" || finishReason === "content_filter") {
    events.push(...flushAndComplete(state, chunk))
  }

  return events
}

function flushAndComplete(
  state: ResponsesStreamState,
  chunk: ChatCompletionChunk,
): Array<ResponsesEvent> {
  const events: Array<ResponsesEvent> = []

  if (state.outputItemOpen) {
    events.push({
      type: "response.output_item.done",
      item: {
        type: "message",
        role: "assistant",
        id: `msg_${state.responseId}`,
        content: [{ type: "output_text", text: state.textAccum }],
      },
    })
    state.outputItemOpen = false
  }

  events.push({
    type: "response.completed",
    response: {
      id: state.responseId,
      output: [],
      usage: chunk.usage
        ? {
            input_tokens: chunk.usage.prompt_tokens,
            input_tokens_details: chunk.usage.prompt_tokens_details
              ? { cached_tokens: chunk.usage.prompt_tokens_details.cached_tokens }
              : undefined,
            output_tokens: chunk.usage.completion_tokens,
            total_tokens: chunk.usage.total_tokens,
          }
        : undefined,
    },
  })

  return events
}

function flushToolCallsAndComplete(
  state: ResponsesStreamState,
  chunk: ChatCompletionChunk,
): Array<ResponsesEvent> {
  const events: Array<ResponsesEvent> = []

  for (const [, tc] of state.toolCallsInProgress) {
    events.push({
      type: "response.output_item.done",
      item: {
        type: "function_call",
        call_id: tc.call_id,
        name: tc.name,
        arguments: tc.argsAccum,
      } satisfies FunctionCallItem,
    })
  }
  state.toolCallsInProgress.clear()

  events.push({
    type: "response.completed",
    response: {
      id: state.responseId,
      output: [],
      usage: chunk.usage
        ? {
            input_tokens: chunk.usage.prompt_tokens,
            input_tokens_details: chunk.usage.prompt_tokens_details
              ? { cached_tokens: chunk.usage.prompt_tokens_details.cached_tokens }
              : undefined,
            output_tokens: chunk.usage.completion_tokens,
            total_tokens: chunk.usage.total_tokens,
          }
        : undefined,
    },
  })

  return events
}
