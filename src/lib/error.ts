import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"

import consola from "consola"

export class HTTPError extends Error {
  response: Response

  constructor(message: string, response: Response) {
    super(message)
    this.response = response
  }
}

// An error the PROXY itself originated, as opposed to one forwarded from
// upstream: it carries the status and Anthropic error `type` we want the client
// to see. Used for conditions the proxy can diagnose better than the upstream
// can — e.g. "the search broker is only reachable over Tailscale, which is down".
export class ProxyStatusError extends Error {
  status: ContentfulStatusCode
  anthropicType: string

  constructor(
    status: ContentfulStatusCode,
    anthropicType: string,
    message: string,
  ) {
    super(message)
    this.name = "ProxyStatusError"
    this.status = status
    this.anthropicType = anthropicType
  }
}

export async function forwardError(c: Context, error: unknown) {
  // A deliberate, self-diagnosed failure — report it in Anthropic's envelope
  // ({ type: "error", error: { type, message } }) so clients render the message
  // rather than a generic failure, and log it as a warning: it is not a bug.
  if (error instanceof ProxyStatusError) {
    consola.warn(`Returning ${error.status} to client: ${error.message}`)
    return c.json(
      {
        type: "error",
        error: {
          type: error.anthropicType,
          message: error.message,
        },
      },
      error.status,
    )
  }

  consola.error("Error occurred:", error)

  if (error instanceof HTTPError) {
    const errorText = await error.response.text()
    let errorJson: unknown
    try {
      errorJson = JSON.parse(errorText)
    } catch {
      errorJson = errorText
    }
    consola.error("HTTP error:", errorJson)
    return c.json(
      {
        error: {
          message: errorText,
          type: "error",
        },
      },
      error.response.status as ContentfulStatusCode,
    )
  }

  return c.json(
    {
      error: {
        message: (error as Error).message,
        type: "error",
      },
    },
    500,
  )
}
