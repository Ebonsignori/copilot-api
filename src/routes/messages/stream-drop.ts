// What the client gets when Copilot closes a stream partway through.
//
// Copilot's native endpoint now and then closes the connection mid-answer
// (undici: `TypeError: terminated`, cause `other side closed`), seconds or
// minutes in, with no error event. Piped straight through, the client then saw
// its own connection cut with no reason given, and the failed read surfaced here
// as an unhandled rejection.
//
// Instead, the upstream SSE is passed on whole events at a time, and if the
// upstream fails, the client gets one last Anthropic `error` event and a clean
// end. The event's type is `overloaded_error` for a network drop, because that
// is the mid-stream error Anthropic clients treat as passing and ask again for:
// Claude Code retries any error whose message holds `"type":"overloaded_error"`,
// and the SDK makes a stream error's message from the event's JSON. It would
// show an `api_error` (no status) to the user instead. Anything other than a
// network drop is sent as `api_error`.

import { describeError, isTransientNetworkError } from "~/lib/process-guard"

const LF = 0x0a
const CR = 0x0d

// Where the last complete SSE event in `bytes` ends (after its blank line), or 0
// if none has ended yet. Events end with a blank line: \n\n, \r\n\r\n or \r\r.
export function afterLastEvent(bytes: Uint8Array): number {
  for (let i = bytes.length - 1; i > 0; i--) {
    const a = bytes[i - 1]
    const b = bytes[i]
    if ((a === LF && b === LF) || (a === CR && b === CR)) return i + 1
    if (
      a === CR
      && b === LF
      && i >= 3
      && bytes[i - 2] === LF
      && bytes[i - 3] === CR
    ) {
      return i + 1
    }
  }
  return 0
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

// The SSE event that tells the client the upstream failed partway.
export function streamErrorEvent(error: unknown): string {
  const network = isTransientNetworkError(error)
  const body = {
    type: "error",
    error: {
      type: network ? "overloaded_error" : "api_error",
      message:
        network ?
          `GitHub Copilot closed the stream before the answer was finished (${describeError(error)}). The request was fine; send it again.`
        : `The stream from GitHub Copilot failed before the answer was finished: ${describeError(error)}`,
    },
  }
  return `event: error\ndata: ${JSON.stringify(body)}\n\n`
}

// `upstream`, passed on a whole event at a time: a chunk is sent up to the end of
// the last event it completes, and the rest waits for the next chunk. If reading
// the upstream fails, the incomplete event is dropped, an `error` event is sent
// in its place and the stream ends; `onDrop` hears of it first. The client
// cancelling (it went away) cancels the upstream, as a plain pipe would.
export function withErrorEventOnDrop(
  upstream: ReadableStream<Uint8Array>,
  onDrop: (error: unknown) => void = () => {},
): ReadableStream<Uint8Array> {
  const reader = upstream.getReader()
  let pending: Uint8Array = new Uint8Array(0)
  // The client went away: a read still waiting then comes back done (or failed),
  // and there's no one left to send anything to.
  let cancelled = false

  return new ReadableStream<Uint8Array>({
    // Reads until something can be sent: a pull that enqueues nothing would
    // leave the client's read waiting forever.
    async pull(controller) {
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (cancelled) return
          if (done) {
            if (pending.length > 0) controller.enqueue(pending)
            controller.close()
            return
          }
          pending = concat(pending, value)
          const end = afterLastEvent(pending)
          if (end > 0) {
            controller.enqueue(pending.slice(0, end))
            pending = pending.slice(end)
            return
          }
        }
      } catch (error) {
        if (cancelled) return
        onDrop(error)
        controller.enqueue(new TextEncoder().encode(streamErrorEvent(error)))
        controller.close()
      }
    },
    cancel(reason) {
      cancelled = true
      return reader.cancel(reason)
    },
  })
}
