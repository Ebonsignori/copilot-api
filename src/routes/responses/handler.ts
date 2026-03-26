import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"
import { events } from "fetch-event-stream"

import { awaitApproval } from "~/lib/approval"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { copilotHeaders, copilotBaseUrl } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"

import type { ResponsesApiPayload } from "./types"

export async function handleResponses(c: Context) {
  await checkRateLimit(state)

  const payload = await c.req.json<ResponsesApiPayload>()
  consola.debug("Responses API request payload:", JSON.stringify(payload).slice(0, 400))

  if (state.manualApprove) {
    await awaitApproval()
  }

  if (!state.copilotToken) throw new Error("Copilot token not found")

  const response = await fetch(`${copilotBaseUrl(state)}/responses`, {
    method: "POST",
    headers: {
      ...copilotHeaders(state),
      "X-Initiator": "agent",
      accept: "text/event-stream",
    },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    consola.error("Failed to call Copilot /responses", response)
    throw new HTTPError("Failed to call Copilot /responses", response)
  }

  if (!payload.stream) {
    return c.json(await response.json())
  }

  consola.debug("Streaming /responses passthrough")
  return streamSSE(c, async (stream) => {
    for await (const chunk of events(response)) {
      consola.debug("Responses chunk:", JSON.stringify(chunk))
      if (chunk.data === "[DONE]") break
      if (!chunk.data) continue
      await stream.writeSSE({
        event: chunk.event ?? undefined,
        data: chunk.data,
      })
    }
  })
}

