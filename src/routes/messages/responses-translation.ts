// Anthropic Messages <-> OpenAI Responses translation.
//
// Copilot serves every recent GPT (5.5, 5.6-*, gpt-6-astra) ONLY on /responses --
// they are absent from both /v1/messages and /chat/completions, so the native
// passthrough and the legacy OpenAI path both dead-end on
// `no_available_model_endpoints`. These pure functions bridge the gap; the I/O
// lives in responses-bridge.ts and the SSE mapping in responses-stream-translation.ts.
//
// Reasoning round-trip: Responses returns a `reasoning` item carrying
// `encrypted_content` (~7KB), and feeding that item back verbatim on the next turn
// is what preserves chain of thought across tool calls (verified live against
// Copilot). Anthropic clients have no such concept, but they DO round-trip a
// thinking block's `signature` untouched -- so we carry `encrypted_content` in
// `signature` and rebuild the reasoning item from it on the way back in. This keeps
// the proxy stateless: nothing to evict, nothing lost on restart.
import { randomUUID } from "node:crypto"

import type {
  FunctionCallItem,
  FunctionCallOutputItem,
  FunctionTool,
  MessageContentItem,
  ReasoningItem,
  ResponseItem,
  ResponsesApiPayload,
  ResponsesApiResponse,
  ToolSpec,
} from "~/routes/responses/types"

import type {
  AnthropicAssistantContentBlock,
  AnthropicAssistantMessage,
  AnthropicMessage,
  AnthropicMessagesPayload,
  AnthropicResponse,
  AnthropicTextBlock,
  AnthropicTool,
  AnthropicUserMessage,
} from "./anthropic-types"

// Anthropic ids are short and opaque to the client; the upstream Responses id is a
// 400+ char encrypted blob, so we mint our own rather than forwarding it.
export const newMessageId = (): string => `msg_${randomUUID()}`

// --- Request: Anthropic -> Responses ---

function systemToInstructions(
  system: AnthropicMessagesPayload["system"],
): string | undefined {
  if (!system) return undefined
  if (typeof system === "string") return system
  return system.map((block: AnthropicTextBlock) => block.text).join("\n\n")
}

// Claude Code sends a token budget; Responses wants a coarse effort bucket.
function budgetToEffort(
  thinking: AnthropicMessagesPayload["thinking"],
): ResponsesApiPayload["reasoning"] {
  if (thinking?.type !== "enabled") return undefined
  const budget = thinking.budget_tokens
  if (budget === undefined) return { effort: "medium", summary: "auto" }
  if (budget < 4096) return { effort: "low", summary: "auto" }
  if (budget < 16384) return { effort: "medium", summary: "auto" }
  return { effort: "high", summary: "auto" }
}

function userBlocksToItems(message: AnthropicUserMessage): Array<ResponseItem> {
  if (typeof message.content === "string") {
    return [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: message.content }],
      },
    ]
  }

  const items: Array<ResponseItem> = []
  const parts: Array<MessageContentItem> = []

  for (const block of message.content) {
    switch (block.type) {
      case "text": {
        parts.push({ type: "input_text", text: block.text })
        break
      }
      case "image": {
        parts.push({
          type: "input_image",
          image_url: `data:${block.source.media_type};base64,${block.source.data}`,
        })
        break
      }
      case "tool_result": {
        // A tool result is a TOP-LEVEL item in Responses, not message content, so
        // flush any text collected so far to keep ordering faithful.
        if (parts.length > 0) {
          items.push({ type: "message", role: "user", content: [...parts] })
          parts.length = 0
        }
        const output: FunctionCallOutputItem = {
          type: "function_call_output",
          call_id: block.tool_use_id,
          output: block.content,
        }
        items.push(output)
        break
      }
      default: {
        // No other user-side block types exist in the Anthropic schema today.
        break
      }
    }
  }

  if (parts.length > 0) {
    items.push({ type: "message", role: "user", content: parts })
  }
  return items
}

function assistantBlocksToItems(
  message: AnthropicAssistantMessage,
): Array<ResponseItem> {
  if (typeof message.content === "string") {
    return [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: message.content }],
      },
    ]
  }

  const items: Array<ResponseItem> = []
  for (const block of message.content) {
    switch (block.type) {
      case "thinking": {
        // Only a block that still carries its signature can be replayed -- that IS
        // the encrypted reasoning. A signature-less block (e.g. one the client
        // synthesized) is dropped rather than sent as an unusable empty item.
        if (!block.signature) break
        const reasoning: ReasoningItem = {
          type: "reasoning",
          encrypted_content: block.signature,
          summary:
            block.thinking ?
              [{ type: "summary_text", text: block.thinking }]
            : [],
        }
        items.push(reasoning)
        break
      }
      case "text": {
        items.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: block.text }],
        })
        break
      }
      case "tool_use": {
        const call: FunctionCallItem = {
          type: "function_call",
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input),
        }
        items.push(call)
        break
      }
      default: {
        // server_tool_use / web_search_tool_result are proxy-emulated Anthropic
        // blocks with no Responses equivalent; they never round-trip.
        break
      }
    }
  }
  return items
}

function messagesToInput(
  messages: Array<AnthropicMessage>,
): Array<ResponseItem> {
  return messages.flatMap((message) =>
    message.role === "user" ?
      userBlocksToItems(message)
    : assistantBlocksToItems(message),
  )
}

function toolsToResponses(
  tools: Array<AnthropicTool> | undefined,
): Array<ToolSpec> | undefined {
  if (!tools || tools.length === 0) return undefined
  // Anthropic server-side tools (web_search) carry no input_schema and have no
  // Responses equivalent -- forwarding them would be a malformed function tool.
  const clientTools = tools.filter((tool) => Boolean(tool.input_schema))
  if (clientTools.length === 0) return undefined
  return clientTools.map(
    (tool): FunctionTool => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    }),
  )
}

function toolChoiceToResponses(
  choice: AnthropicMessagesPayload["tool_choice"],
): ResponsesApiPayload["tool_choice"] {
  switch (choice?.type) {
    case "auto": {
      return "auto"
    }
    case "any": {
      return "required"
    }
    case "none": {
      return "none"
    }
    case "tool": {
      return choice.name ? { type: "function", name: choice.name } : "required"
    }
    default: {
      return undefined
    }
  }
}

export function anthropicToResponsesPayload(
  payload: AnthropicMessagesPayload,
): ResponsesApiPayload {
  return {
    model: payload.model,
    input: messagesToInput(payload.messages),
    instructions: systemToInstructions(payload.system),
    tools: toolsToResponses(payload.tools),
    tool_choice: toolChoiceToResponses(payload.tool_choice),
    reasoning: budgetToEffort(payload.thinking),
    max_output_tokens: payload.max_tokens,
    stream: payload.stream,
    // Without this the reasoning items come back with no encrypted_content and
    // the chain of thought cannot survive a tool-call round trip.
    include: ["reasoning.encrypted_content"],
    // The proxy is stateless; never ask Copilot to retain the conversation.
    store: false,
  }
}

// --- Response: Responses -> Anthropic ---

function reasoningToThinking(
  item: ReasoningItem,
): AnthropicAssistantContentBlock {
  const summary = (item.summary ?? []).map((part) => part.text).join("\n\n")
  const content = (item.content ?? []).map((part) => part.text).join("\n\n")
  return {
    type: "thinking",
    thinking: summary || content,
    ...(item.encrypted_content !== undefined && {
      signature: item.encrypted_content,
    }),
  }
}

function functionCallToToolUse(
  item: FunctionCallItem,
): AnthropicAssistantContentBlock {
  let input: Record<string, unknown>
  try {
    input = JSON.parse(item.arguments || "{}") as Record<string, unknown>
  } catch {
    // A truncated turn can leave arguments as invalid JSON. An empty object keeps
    // the block well-formed rather than failing the whole translation.
    input = {}
  }
  return { type: "tool_use", id: item.call_id, name: item.name, input }
}

export function responsesOutputToBlocks(
  output: Array<ResponseItem>,
): Array<AnthropicAssistantContentBlock> {
  const blocks: Array<AnthropicAssistantContentBlock> = []
  for (const item of output) {
    switch (item.type) {
      case "reasoning": {
        blocks.push(reasoningToThinking(item))
        break
      }
      case "function_call": {
        blocks.push(functionCallToToolUse(item))
        break
      }
      case "message": {
        for (const part of item.content) {
          if (part.type === "output_text" && part.text) {
            blocks.push({ type: "text", text: part.text })
          }
        }
        break
      }
      default: {
        break
      }
    }
  }
  return blocks
}

export function mapResponsesStopReason(
  response: Pick<ResponsesApiResponse, "output" | "status">,
): AnthropicResponse["stop_reason"] {
  if (response.output.some((item) => item.type === "function_call")) {
    return "tool_use"
  }
  if (response.status === "incomplete") return "max_tokens"
  return "end_turn"
}

export function mapResponsesUsage(
  usage: ResponsesApiResponse["usage"],
): AnthropicResponse["usage"] {
  const cached = usage?.input_tokens_details?.cached_tokens ?? 0
  return {
    // Anthropic reports uncached input separately from the cache-read count.
    input_tokens: Math.max((usage?.input_tokens ?? 0) - cached, 0),
    output_tokens: usage?.output_tokens ?? 0,
    ...(cached > 0 && { cache_read_input_tokens: cached }),
  }
}

export function responsesResponseToAnthropic(
  response: ResponsesApiResponse,
): AnthropicResponse {
  return {
    id: newMessageId(),
    type: "message",
    role: "assistant",
    content: responsesOutputToBlocks(response.output),
    model: response.model,
    stop_reason: mapResponsesStopReason(response),
    stop_sequence: null,
    usage: mapResponsesUsage(response.usage),
  }
}
