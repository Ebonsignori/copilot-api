import { afterEach, describe, expect, mock, test } from "bun:test"

import { state } from "~/lib/state"

import { geminiRoutes, parseModelAction } from "../src/routes/gemini/route"

state.copilotToken = "test-token"
state.accountType = "individual"

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

// Stands in for Copilot's /chat/completions, keeping the bodies it was sent.
function fakeCopilot(): Array<Record<string, unknown>> {
  const sent: Array<Record<string, unknown>> = []
  const answer = {
    id: "1",
    object: "chat.completion",
    created: 0,
    model: "gemini-4-argon",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "OK" },
        finish_reason: "stop",
        logprobs: null,
      },
    ],
  }
  const chunk = {
    ...answer,
    object: "chat.completion.chunk",
    choices: [
      {
        index: 0,
        delta: { content: "OK" },
        finish_reason: "stop",
        logprobs: null,
      },
    ],
  }
  globalThis.fetch = mock((_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Record<string, unknown>
    sent.push(body)
    return Promise.resolve(
      body.stream ?
        new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
          headers: { "content-type": "text/event-stream" },
        })
      : Response.json(answer),
    )
  }) as unknown as typeof fetch
  return sent
}

const request = { contents: [{ role: "user", parts: [{ text: "hi" }] }] }
const post = (path: string) =>
  geminiRoutes.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  })

describe("parseModelAction", () => {
  test("splits the model from the action at the last colon", () => {
    expect(parseModelAction("gemini-4-argon:generateContent")).toEqual({
      model: "gemini-4-argon",
      action: "generateContent",
    })
    expect(parseModelAction("gemini-3.8-flash:streamGenerateContent")).toEqual({
      model: "gemini-3.8-flash",
      action: "streamGenerateContent",
    })
  })

  test("refuses a segment without a model or with another action", () => {
    expect(parseModelAction("gemini-4-argon")).toBeUndefined()
    expect(parseModelAction(":generateContent")).toBeUndefined()
    expect(parseModelAction("gemini-4-argon:countTokens")).toBeUndefined()
  })
})

describe("the Gemini route", () => {
  test("generateContent sends Copilot the model asked for", async () => {
    const sent = fakeCopilot()
    const res = await post("/gemini-4-argon:generateContent")
    expect(res.status).toBe(200)
    expect(sent).toHaveLength(1)
    expect(sent[0].model).toBe("gemini-4-argon")
    expect(sent[0].stream).toBe(false)
  })

  test("streamGenerateContent sends the model asked for, streaming", async () => {
    const sent = fakeCopilot()
    const res = await post("/gemini-3.8-flash:streamGenerateContent")
    expect(res.status).toBe(200)
    await res.text()
    expect(sent[0].model).toBe("gemini-3.8-flash")
    expect(sent[0].stream).toBe(true)
  })

  test("another action is not found, and nothing is sent", async () => {
    const sent = fakeCopilot()
    const res = await post("/gemini-4-argon:countTokens")
    expect(res.status).toBe(404)
    expect(sent).toHaveLength(0)
  })
})
