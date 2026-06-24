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

  // Budget spent and the model still wants to search. Produce a final answer
  // that CANNOT contain another tool_use: strip the tools ENTIRELY (not just
  // tool_choice). The Copilot backend ignores tool_choice:"none" and keeps
  // emitting tool_use; but with no tools defined at all, it must answer in text.
  consola.debug(`Web search budget (${rounds}) reached; forcing final answer`)
  const finalPayload: ChatCompletionsPayload = {
    ...payload,
    tools: undefined,
    tool_choice: undefined,
  }
  const finalResponse = await complete(finalPayload)

  // Defense in depth: if the backend STILL returned tool calls despite having no
  // tools, strip them so the client never receives a dangling tool_use it can't
  // satisfy (the whole reason this interception exists).
  return stripToolCalls(finalResponse)
}

// Guarantee a response with no tool_calls. If the upstream still emitted tool
// calls (it shouldn't, with tools removed), drop them and ensure there is text
// content so the translated Anthropic message ends cleanly (end_turn) rather
// than with a dangling tool_use.
function stripToolCalls(
  response: ChatCompletionResponse,
): ChatCompletionResponse {
  const choice = response.choices[0]
  if (!choice?.message.tool_calls?.length) return response
  const hasText =
    typeof choice.message.content === "string"
    && choice.message.content.trim().length > 0
  return {
    ...response,
    choices: response.choices.map((c, i) =>
      i === 0 ?
        {
          ...c,
          finish_reason: "stop",
          message: {
            ...c.message,
            tool_calls: undefined,
            content:
              hasText ? c.message.content : (
                "I couldn't complete the web search for this request."
              ),
          },
        }
      : c,
    ),
  }
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
