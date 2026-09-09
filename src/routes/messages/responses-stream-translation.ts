import type {
  ResponseItem,
  ResponsesApiResponse,
} from "~/routes/responses/types"

// Responses SSE -> Anthropic SSE, incrementally.
//
// Event names below are not from the OpenAI docs -- they were captured live from
// Copilot's /responses endpoint for gpt-6-astra (see the plan's probe notes), which
// is why the reasoning path is modeled on `reasoning_summary_*` rather than the
// `reasoning_text_*` variants some other deployments emit.
//
// Anthropic requires strictly paired content_block_start/stop around a monotonically
// increasing index, while Responses reports progress against its own `output_index`.
// We therefore keep a map from output_index -> our block index, so parallel tool
// calls (several function_call items open at once) stay correctly addressed.
import type {
  AnthropicStreamEventData,
  AnthropicResponse,
} from "./anthropic-types"

import {
  mapResponsesStopReason,
  mapResponsesUsage,
  newMessageId,
} from "./responses-translation"

type BlockKind = "thinking" | "text" | "tool_use"

interface OpenBlock {
  index: number
  kind: BlockKind
}

export interface ResponsesToAnthropicState {
  messageId: string
  model: string
  messageStartSent: boolean
  nextBlockIndex: number
  // output_index -> the Anthropic content block we opened for it
  blocks: Map<number, OpenBlock>
  // output_index -> how many reasoning summary parts we've seen (for separators)
  summaryParts: Map<number, number>
}

export function createResponsesStreamState(): ResponsesToAnthropicState {
  return {
    messageId: newMessageId(),
    model: "",
    messageStartSent: false,
    nextBlockIndex: 0,
    blocks: new Map(),
    summaryParts: new Map(),
  }
}

// The subset of the Responses stream envelope we act on. Everything else is
// bookkeeping we deliberately consume without emitting.
export interface ResponsesStreamEvent {
  type: string
  output_index?: number
  summary_index?: number
  delta?: string
  item?: ResponseItem
  response?: ResponsesApiResponse
}

function openBlock(
  state: ResponsesToAnthropicState,
  outputIndex: number,
  contentBlock: Extract<
    AnthropicStreamEventData,
    { type: "content_block_start" }
  >["content_block"],
): AnthropicStreamEventData {
  const index = state.nextBlockIndex++
  // Only thinking / text / tool_use blocks are ever opened here; the wider union
  // includes proxy-emulated web_search blocks the bridge never emits.
  state.blocks.set(outputIndex, {
    index,
    kind: contentBlock.type as BlockKind,
  })
  return { type: "content_block_start", index, content_block: contentBlock }
}

function closeBlock(
  state: ResponsesToAnthropicState,
  outputIndex: number,
): Array<AnthropicStreamEventData> {
  const block = state.blocks.get(outputIndex)
  if (!block) return []
  state.blocks.delete(outputIndex)
  return [{ type: "content_block_stop", index: block.index }]
}

function messageStart(
  state: ResponsesToAnthropicState,
  model: string,
): AnthropicStreamEventData {
  state.messageStartSent = true
  state.model = model
  return {
    type: "message_start",
    message: {
      id: state.messageId,
      type: "message",
      role: "assistant",
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      // Real token counts only arrive with response.completed; Anthropic clients
      // accept zeros here and take the final numbers from message_delta.
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  }
}

function handleItemAdded(
  event: ResponsesStreamEvent,
  state: ResponsesToAnthropicState,
  outputIndex: number,
): Array<AnthropicStreamEventData> {
  const item = event.item
  if (!item) return []

  if (item.type === "reasoning") {
    // Opened even when the model produces no summary text: the block still has to
    // exist to carry encrypted_content out via signature_delta on item.done.
    return [openBlock(state, outputIndex, { type: "thinking", thinking: "" })]
  }

  if (item.type === "function_call") {
    const call = item
    return [
      openBlock(state, outputIndex, {
        type: "tool_use",
        id: call.call_id,
        name: call.name,
        input: {},
      }),
    ]
  }

  // "message" items open their block on content_part.added instead, so that a
  // message carrying no text never produces an empty block.
  return []
}

function handleItemDone(
  event: ResponsesStreamEvent,
  state: ResponsesToAnthropicState,
  outputIndex: number,
): Array<AnthropicStreamEventData> {
  const events: Array<AnthropicStreamEventData> = []
  const block = state.blocks.get(outputIndex)
  if (!block) return events

  // Emit the encrypted reasoning as the block's signature. This is what lets the
  // client hand the chain of thought back to us next turn.
  if (block.kind === "thinking" && event.item?.type === "reasoning") {
    const encrypted = event.item.encrypted_content
    if (encrypted) {
      events.push({
        type: "content_block_delta",
        index: block.index,
        delta: { type: "signature_delta", signature: encrypted },
      })
    }
  }

  events.push(...closeBlock(state, outputIndex))
  return events
}

function handleCompleted(
  event: ResponsesStreamEvent,
  state: ResponsesToAnthropicState,
): Array<AnthropicStreamEventData> {
  const events: Array<AnthropicStreamEventData> = []

  // Defensive: close anything the upstream left open so the client never sees an
  // unterminated block.
  for (const outputIndex of state.blocks.keys()) {
    events.push(...closeBlock(state, outputIndex))
  }

  const response = event.response
  const output: Array<ResponseItem> = response?.output ?? []
  const stopReason: AnthropicResponse["stop_reason"] =
    response ?
      mapResponsesStopReason({ output, status: response.status })
    : "end_turn"

  events.push(
    {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: mapResponsesUsage(response?.usage),
    },
    { type: "message_stop" },
  )
  return events
}

// eslint-disable-next-line complexity
export function translateResponsesEventToAnthropicEvents(
  event: ResponsesStreamEvent,
  state: ResponsesToAnthropicState,
): Array<AnthropicStreamEventData> {
  const events: Array<AnthropicStreamEventData> = []
  const outputIndex = event.output_index ?? 0

  switch (event.type) {
    case "response.created": {
      if (!state.messageStartSent) {
        events.push(messageStart(state, event.response?.model ?? ""))
      }
      break
    }

    case "response.output_item.added": {
      events.push(...handleItemAdded(event, state, outputIndex))
      break
    }

    case "response.reasoning_summary_part.added": {
      // Separate consecutive summary parts so they don't run together.
      const seen = state.summaryParts.get(outputIndex) ?? 0
      state.summaryParts.set(outputIndex, seen + 1)
      const block = state.blocks.get(outputIndex)
      if (seen > 0 && block) {
        events.push({
          type: "content_block_delta",
          index: block.index,
          delta: { type: "thinking_delta", thinking: "\n\n" },
        })
      }
      break
    }

    case "response.reasoning_summary_text.delta": {
      const block = state.blocks.get(outputIndex)
      if (block && event.delta) {
        events.push({
          type: "content_block_delta",
          index: block.index,
          delta: { type: "thinking_delta", thinking: event.delta },
        })
      }
      break
    }

    case "response.content_part.added": {
      events.push(openBlock(state, outputIndex, { type: "text", text: "" }))
      break
    }

    case "response.output_text.delta": {
      const block = state.blocks.get(outputIndex)
      if (block && event.delta) {
        events.push({
          type: "content_block_delta",
          index: block.index,
          delta: { type: "text_delta", text: event.delta },
        })
      }
      break
    }

    case "response.content_part.done": {
      events.push(...closeBlock(state, outputIndex))
      break
    }

    case "response.function_call_arguments.delta": {
      const block = state.blocks.get(outputIndex)
      if (block && event.delta) {
        events.push({
          type: "content_block_delta",
          index: block.index,
          delta: { type: "input_json_delta", partial_json: event.delta },
        })
      }
      break
    }

    case "response.output_item.done": {
      events.push(...handleItemDone(event, state, outputIndex))
      break
    }

    case "response.completed":
    case "response.incomplete": {
      events.push(...handleCompleted(event, state))
      break
    }

    case "response.failed": {
      events.push({
        type: "error",
        error: {
          type: "api_error",
          message: "The upstream Responses request failed.",
        },
      })
      break
    }

    default: {
      // response.in_progress, *.done bookkeeping, *_part.done, etc.
      break
    }
  }

  return events
}
