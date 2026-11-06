import { describe, expect, test } from "bun:test"

import type { GeminiGenerateContentRequest } from "~/routes/gemini/gemini-types"
import type { Message } from "~/services/copilot/create-chat-completions"

import { geminiToCompletions } from "../src/routes/gemini/translation"

const user = (text: string) => ({ role: "user" as const, parts: [{ text }] })
const call = (name: string, args: Record<string, unknown> = {}) => ({
  functionCall: { name, args },
})
const answer = (name: string, response: Record<string, unknown> = {}) => ({
  functionResponse: { name, response },
})

function translate(contents: GeminiGenerateContentRequest["contents"]) {
  return geminiToCompletions({ contents }, "gemini-4-argon").messages
}

// Every tool message's id must be one of the calls in the assistant message
// before it, each used once.
function expectResultsMatchCalls(messages: Array<Message>) {
  let waiting: Array<string> = []
  for (const m of messages) {
    if (m.role === "assistant" && m.tool_calls)
      waiting = m.tool_calls.map((c) => c.id)
    if (m.role === "tool") {
      expect(waiting).toContain(m.tool_call_id as string)
      waiting = waiting.filter((id) => id !== m.tool_call_id)
    }
  }
  expect(waiting).toEqual([])
}

describe("geminiToCompletions: function call ids", () => {
  test("a turn calling two different functions gets each result under its own call's id", () => {
    const messages = translate([
      user("Read bars 1-2 and get the key."),
      {
        role: "model",
        parts: [call("read_score", { bars: "1-2" }), call("get_key")],
      },
      {
        role: "user",
        parts: [
          answer("read_score", { listing: "…" }),
          answer("get_key", { key: "F" }),
        ],
      },
    ])
    expectResultsMatchCalls(messages)
    const calls = messages.find((m) => m.tool_calls)?.tool_calls ?? []
    const results = messages.filter((m) => m.role === "tool")
    expect(results.map((r) => r.tool_call_id)).toEqual(calls.map((c) => c.id))
    expect(results[1].content).toBe(JSON.stringify({ key: "F" }))
  })

  test("results answer calls of one name in order, whatever order the names come in", () => {
    const messages = translate([
      user("go"),
      {
        role: "model",
        parts: [call("a", { n: 1 }), call("b"), call("a", { n: 2 })],
      },
      {
        role: "user",
        parts: [answer("b"), answer("a", { n: 1 }), answer("a", { n: 2 })],
      },
    ])
    expectResultsMatchCalls(messages)
    const ids =
      messages.find((m) => m.tool_calls)?.tool_calls?.map((c) => c.id) ?? []
    const results = messages.filter((m) => m.role === "tool")
    expect(results.map((r) => r.tool_call_id)).toEqual([ids[1], ids[0], ids[2]])
    expect(results[2].content).toBe(JSON.stringify({ n: 2 }))
  })

  test("ids are unique across the conversation's turns", () => {
    const messages = translate([
      user("go"),
      { role: "model", parts: [call("read_score", { bars: "1-2" })] },
      { role: "user", parts: [answer("read_score")] },
      { role: "model", parts: [call("read_score", { bars: "3-4" })] },
      { role: "user", parts: [answer("read_score")] },
    ])
    expectResultsMatchCalls(messages)
    const ids = messages.flatMap((m) => m.tool_calls?.map((c) => c.id) ?? [])
    expect(new Set(ids).size).toBe(2)
  })
})
