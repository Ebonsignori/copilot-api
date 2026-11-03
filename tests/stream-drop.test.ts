import { describe, expect, test } from "bun:test"

import {
  afterLastEvent,
  streamErrorEvent,
  withErrorEventOnDrop,
} from "../src/routes/messages/stream-drop"

const encoder = new TextEncoder()
const bytes = (text: string) => encoder.encode(text)

const event = (type: string, data: Record<string, unknown>) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`

const START = event("message_start", { message: { id: "msg_1" } })
const DELTA = event("content_block_delta", {
  index: 0,
  delta: { type: "thinking_delta", thinking: "Counting the bass – three" },
})

// The undici error Copilot's drop surfaced as (2026-11-02, 34 s into a stream).
function otherSideClosed(): Error {
  const cause = Object.assign(new Error("other side closed"), {
    code: "UND_ERR_SOCKET",
  })
  return Object.assign(new TypeError("terminated"), { cause })
}

// An upstream that yields `chunks`, then fails with `error` (or ends, without one).
function upstream(
  chunks: Array<Uint8Array>,
  error?: unknown,
): ReadableStream<Uint8Array> {
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++])
      else if (error === undefined) controller.close()
      else controller.error(error)
    },
  })
}

// `text` cut into pieces of `size` bytes, so events (and characters) split across reads.
function split(text: string, size: number): Array<Uint8Array> {
  const all = bytes(text)
  const out: Array<Uint8Array> = []
  for (let i = 0; i < all.length; i += size) out.push(all.slice(i, i + size))
  return out
}

const readAll = (stream: ReadableStream<Uint8Array>) =>
  new Response(stream).text()

// The data of each SSE event in `text`, parsed.
function events(text: string): Array<{ event: string; data: unknown }> {
  return text
    .split("\n\n")
    .filter((block) => block.trim())
    .map((block) => {
      const lines = block.split("\n")
      const name = lines.find((l) => l.startsWith("event: "))?.slice(7) ?? ""
      const data = lines.find((l) => l.startsWith("data: "))?.slice(6) ?? ""
      return { event: name, data: JSON.parse(data) as unknown }
    })
}

describe("afterLastEvent", () => {
  test("finds the end of the last complete event", () => {
    expect(afterLastEvent(bytes(START + "event: ping\nda"))).toBe(START.length)
    expect(afterLastEvent(bytes(START + DELTA))).toBe(
      bytes(START + DELTA).length,
    )
  })

  test("is 0 while no event has ended", () => {
    expect(afterLastEvent(bytes("event: ping\ndata: {}\n"))).toBe(0)
    expect(afterLastEvent(new Uint8Array(0))).toBe(0)
  })

  test("takes CRLF and CR line endings too", () => {
    expect(afterLastEvent(bytes("data: 1\r\n\r\ndata: 2"))).toBe(11)
    expect(afterLastEvent(bytes("data: 1\r\rdata: 2"))).toBe(9)
  })
})

describe("withErrorEventOnDrop", () => {
  test("passes a whole stream on unchanged, however it is split", async () => {
    const text = START + DELTA + event("message_stop", {})
    for (const size of [1, 3, 7, 64, 10_000]) {
      expect(
        await readAll(withErrorEventOnDrop(upstream(split(text, size)))),
      ).toBe(text)
    }
  })

  test("passes on an unfinished last event when the upstream simply ends", async () => {
    const text = START + "event: ping\ndata: {}"
    expect(await readAll(withErrorEventOnDrop(upstream(split(text, 5))))).toBe(
      text,
    )
  })

  test("ends a dropped stream with an overloaded_error event in place of the cut event", async () => {
    const drops: Array<unknown> = []
    const cut = START + DELTA + 'event: content_block_delta\ndata: {"ty'
    const text = await readAll(
      withErrorEventOnDrop(upstream(split(cut, 4), otherSideClosed()), (e) =>
        drops.push(e),
      ),
    )

    expect(text.startsWith(START + DELTA)).toBe(true)
    const sent = events(text)
    expect(sent.map((e) => e.event)).toEqual([
      "message_start",
      "content_block_delta",
      "error",
    ])
    const error = sent[2].data as {
      type: string
      error: { type: string; message: string }
    }
    expect(error.type).toBe("error")
    expect(error.error.type).toBe("overloaded_error")
    expect(error.error.message).toContain("other side closed")
    expect(drops).toHaveLength(1)
  })

  test("the error, as the SDK reports it, is one Claude Code retries", () => {
    // The SDK makes a stream error's message from the event's JSON, and Claude
    // Code retries a message holding "type":"overloaded_error".
    const data = streamErrorEvent(otherSideClosed()).split("data: ")[1].trim()
    expect(JSON.stringify(JSON.parse(data))).toContain(
      '"type":"overloaded_error"',
    )
  })

  test("sends anything but a network drop as api_error", async () => {
    const text = await readAll(
      withErrorEventOnDrop(upstream([bytes(START)], new Error("bad chunk"))),
    )
    const error = events(text)[1].data as { error: { type: string } }
    expect(error.error.type).toBe("api_error")
  })

  test("cancels the upstream when the client goes away", async () => {
    let cancelled: unknown
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(bytes(DELTA))
      },
      cancel(reason) {
        cancelled = reason
      },
    })
    const reader = withErrorEventOnDrop(endless).getReader()
    await reader.read()
    await reader.cancel("client left")
    expect(cancelled).toBe("client left")
  })

  test("goes quietly when the client leaves while a read is waiting", async () => {
    // As the server cancels it: the upstream's waiting read comes back done.
    // Under Node, closing the cancelled stream then threw and was logged as a
    // drop; Bun lets the close pass, so here this only holds the intent.
    let sent = false
    const slow = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) return new Promise<void>(() => {})
        sent = true
        controller.enqueue(bytes(DELTA))
      },
    })
    const drops: Array<unknown> = []
    const reader = withErrorEventOnDrop(slow, (e) => drops.push(e)).getReader()
    await reader.read()
    const waiting = reader.read()
    await reader.cancel("client left")
    expect((await waiting).done).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(drops).toEqual([])
  })
})
