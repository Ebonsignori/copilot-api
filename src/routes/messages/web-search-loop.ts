import consola from "consola"

import {
  createChatCompletions,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"

import { isWebSearchToolName, runWebSearch } from "~/lib/web-search"

// Default cap on web_search rounds when the request's tool doesn't specify
// max_uses. Each round may service several parallel searches.
const DEFAULT_MAX_USES = 5
// Absolute backstop so a misbehaving model can't loop forever.
const HARD_CAP = 8

function isNonStreaming(
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse {
  return Object.hasOwn(response, "choices")
}

// Anthropic's server-side web_search tool arrives without an input_schema, so the
// flattened OpenAI function ends up with `parameters: undefined`. Give it a real
// schema so Copilot's model reliably emits { query } (and an optional count).
export function ensureWebSearchSchema(payload: ChatCompletionsPayload): void {
  if (!payload.tools) return
  for (const tool of payload.tools) {
    if (tool.type === "function" && isWebSearchToolName(tool.function.name)) {
      tool.function.parameters = {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query." },
          count: {
            type: "integer",
            description: "Number of results (1-10).",
          },
        },
        required: ["query"],
      }
      if (!tool.function.description) {
        tool.function.description =
          "Search the live web for current information beyond your training data."
      }
    }
  }
}

// Run the web_search agentic loop entirely server-side and return the FINAL
// non-streaming completion (a normal text answer, or — for non-web_search tool
// calls — the upstream response passed straight through for Claude Code to run).
//
// The loop operates on the OpenAI payload: it appends the assistant's tool_calls
// message and a `tool` result message per search, then re-asks, mirroring how a
// real client would satisfy Anthropic's server-side web_search.
//
// deps lets tests inject fakes (mirrors the dependency-injection pattern used
// across this ecosystem):
//   deps.complete — async (payload) => ChatCompletionResponse (default: the real
//                   createChatCompletions, forced non-streaming).
//   deps.search   — async (argsJson) => string tool-result (default: runWebSearch
//                   against the broker).
export interface WebSearchLoopDeps {
  complete?: (
    payload: ChatCompletionsPayload,
  ) => Promise<ChatCompletionResponse>
  search?: (argsJson: string) => Promise<string>
}

export async function runWebSearchLoop(
  openAIPayload: ChatCompletionsPayload,
  maxUses: number = DEFAULT_MAX_USES,
  deps: WebSearchLoopDeps = {},
): Promise<ChatCompletionResponse> {
  const complete = deps.complete ?? defaultComplete
  const search = deps.search ?? runWebSearch

  // Work on a copy with streaming forced off and its own messages array so we
  // never mutate the caller's payload.
  const payload: ChatCompletionsPayload = {
    ...openAIPayload,
    stream: false,
    messages: [...openAIPayload.messages],
  }
  ensureWebSearchSchema(payload)

  const rounds = Math.max(1, Math.min(HARD_CAP, maxUses))

  for (let i = 0; i < rounds; i++) {
    const response = await complete(payload)

    const choice = response.choices[0]
    const toolCalls = choice?.message.tool_calls

    // Normal text finish, or no tool calls → done.
    if (!choice || choice.finish_reason !== "tool_calls" || !toolCalls?.length) {
      return response
    }

    // Only auto-service when EVERY tool call is web_search. If the model also
    // wants a client-side tool (Bash/Read/…), hand the whole response back to
    // Claude Code untouched so it can execute the lot. (Mixing server web_search
    // with client tools in one turn is rare; documented limitation.)
    const allWebSearch = toolCalls.every((tc) =>
      isWebSearchToolName(tc.function.name),
    )
    if (!allWebSearch) {
      return response
    }

    // Append the assistant turn (its tool_calls) then a tool result per search.
    payload.messages.push({
      role: "assistant",
      content: choice.message.content ?? null,
      tool_calls: toolCalls,
    })
    for (const tc of toolCalls) {
      const content = await search(tc.function.arguments)
      payload.messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content,
      })
    }
  }

  // Budget spent and the model still wants to search. Force a final answer with
  // no further tool use so we never return a dangling tool_use to the client.
  consola.debug(`Web search budget (${rounds}) reached; forcing final answer`)
  return complete({ ...payload, tool_choice: "none" })
}

// Default completion: the real upstream call, with a guard that we never get a
// streaming response back (we always force stream:false before calling).
async function defaultComplete(
  payload: ChatCompletionsPayload,
): Promise<ChatCompletionResponse> {
  const response = await createChatCompletions({ ...payload, stream: false })
  if (!isNonStreaming(response)) {
    throw new Error("web search loop received a streaming response")
  }
  return response
}
