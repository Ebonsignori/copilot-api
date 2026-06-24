import {
  type AnthropicResponse,
  type AnthropicStreamEventData,
} from "./anthropic-types"

// Turn a finished (non-streaming) Anthropic message into the ordered SSE event
// sequence a streaming client expects. Used by the web_search path: the loop
// produces a complete message server-side, but a streaming client (Claude Code)
// still needs message_start → content_block_* → message_delta → message_stop.
//
// We emit each content block whole (one big delta) rather than token-by-token —
// the answer is already complete, so there's nothing to stream incrementally,
// and clients accept a single delta per block.
export function anthropicResponseToStreamEvents(
  response: AnthropicResponse,
): Array<AnthropicStreamEventData> {
  const events: Array<AnthropicStreamEventData> = []

  events.push({
    type: "message_start",
    message: {
      id: response.id,
      type: "message",
      role: "assistant",
      model: response.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: 0,
        ...(response.usage.cache_read_input_tokens !== undefined && {
          cache_read_input_tokens: response.usage.cache_read_input_tokens,
        }),
      },
    },
  })

  response.content.forEach((block, index) => {
    if (block.type === "text") {
      events.push({
        type: "content_block_start",
        index,
        content_block: { type: "text", text: "" },
      })
      if (block.text) {
        events.push({
          type: "content_block_delta",
          index,
          delta: { type: "text_delta", text: block.text },
        })
      }
      events.push({ type: "content_block_stop", index })
    } else if (block.type === "tool_use") {
      // A passed-through client-side tool_use (e.g. the model also called a
      // non-web_search tool). Emit it as a tool_use block + one input_json_delta.
      events.push({
        type: "content_block_start",
        index,
        content_block: {
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: {},
        },
      })
      events.push({
        type: "content_block_delta",
        index,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify(block.input ?? {}),
        },
      })
      events.push({ type: "content_block_stop", index })
    } else {
      // thinking blocks aren't produced by the web_search path; skip safely.
    }
  })

  events.push({
    type: "message_delta",
    delta: {
      stop_reason: response.stop_reason,
      stop_sequence: response.stop_sequence,
    },
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      ...(response.usage.cache_read_input_tokens !== undefined && {
        cache_read_input_tokens: response.usage.cache_read_input_tokens,
      }),
    },
  })
  events.push({ type: "message_stop" })

  return events
}
