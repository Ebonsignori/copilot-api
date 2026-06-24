import consola from "consola"

import { state } from "./state"

// Anthropic ships its server-side web search as a tool whose `type` is a dated
// identifier (web_search_20250305, …) but whose `name` Claude Code sends as
// "web_search". After translateToOpenAI flattens tools to plain functions only
// the name survives, so we match on the name.
export function isWebSearchToolName(name: string | undefined): boolean {
  return name === "web_search"
}

// True when the request asked for web search AND we have a broker to service it.
// Without a configured broker we leave the tool alone (legacy dangling behavior)
// rather than pretend to handle it.
export function webSearchEnabled(
  tools: Array<{ name: string }> | undefined,
): boolean {
  if (!state.searchServiceUrl || !state.searchServiceToken) return false
  return Boolean(tools?.some((t) => isWebSearchToolName(t.name)))
}

export interface BrokerResult {
  title: string
  url: string
  snippet: string
}
export interface BrokerResponse {
  provider: string
  results: Array<BrokerResult>
  answer?: string
}

// Call the n100 search-broker. Returns the parsed broker response, or throws on
// transport failure. A 429 (quota exhausted) is surfaced as a typed flag so the
// caller can hand the model a "no results / quota exhausted" observation rather
// than failing the whole turn.
export class BrokerExhaustedError extends Error {}

export async function callBroker(
  query: string,
  count?: number,
): Promise<BrokerResponse> {
  const url = `${state.searchServiceUrl!.replace(/\/+$/, "")}/search`
  let res: Response
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${state.searchServiceToken!}`,
      },
      body: JSON.stringify({ query, count }),
      signal: AbortSignal.timeout(15000),
    })
  } catch (error) {
    throw new Error(
      `search broker unreachable: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  if (res.status === 429) {
    throw new BrokerExhaustedError("search quota exhausted")
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`search broker returned ${res.status}: ${body.slice(0, 200)}`)
  }

  return (await res.json()) as BrokerResponse
}

// Render a broker response as the string content of an OpenAI `tool` message —
// what the model reads as the result of its web_search call. Compact and plain;
// the model cites/summarizes from it.
export function formatResultsForModel(resp: BrokerResponse): string {
  const lines: Array<string> = []
  if (resp.answer) lines.push(`Answer: ${resp.answer}`, "")
  if (resp.results.length === 0) {
    lines.push("No results found.")
  } else {
    resp.results.forEach((r, i) => {
      lines.push(`${i + 1}. ${r.title || "(untitled)"}`)
      if (r.url) lines.push(`   ${r.url}`)
      if (r.snippet) lines.push(`   ${r.snippet}`)
    })
  }
  lines.push("", `(source: ${resp.provider})`)
  return lines.join("\n")
}

// Run the broker for one tool call's arguments, converting any failure into a
// model-readable string so a single bad search never aborts the turn.
export async function runWebSearch(argsJson: string): Promise<string> {
  let query = ""
  let count: number | undefined
  try {
    const parsed = JSON.parse(argsJson) as { query?: string; count?: number }
    query = typeof parsed.query === "string" ? parsed.query : ""
    count = typeof parsed.count === "number" ? parsed.count : undefined
  } catch {
    return "Web search failed: could not parse the tool arguments."
  }
  if (!query.trim()) return "Web search failed: empty query."

  try {
    const resp = await callBroker(query, count)
    return formatResultsForModel(resp)
  } catch (error) {
    if (error instanceof BrokerExhaustedError) {
      return "Web search is unavailable: the search quota is exhausted for this period. Answer from your own knowledge and say it may be out of date."
    }
    consola.error("Web search broker error:", error)
    return `Web search failed: ${error instanceof Error ? error.message : String(error)}`
  }
}
