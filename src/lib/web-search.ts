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

// One executed search, captured so the handler can emit faithful Anthropic
// server_tool_use + web_search_tool_result blocks. `text` is what the model
// reads (the OpenAI tool message); `results` is the structured data for blocks.
// `errorCode` is set (and results empty) when the search couldn't run.
export interface SearchRecord {
  query: string
  text: string
  results: Array<BrokerResult>
  errorCode?:
    | "too_many_requests"
    | "unavailable"
    | "invalid_input"
    | "max_uses_exceeded"
    | "query_too_long"
}

// Run the broker for one tool call's arguments, returning BOTH the model-facing
// text and the structured results/error. Never throws — a failed search becomes
// a record with an errorCode and a model-readable text, so one bad search never
// aborts the turn.
export async function runWebSearchDetailed(
  argsJson: string,
): Promise<SearchRecord> {
  let query = ""
  let count: number | undefined
  try {
    const parsed = JSON.parse(argsJson) as { query?: string; count?: number }
    query = typeof parsed.query === "string" ? parsed.query : ""
    count = typeof parsed.count === "number" ? parsed.count : undefined
  } catch {
    return {
      query: "",
      text: "Web search failed: could not parse the tool arguments.",
      results: [],
      errorCode: "invalid_input",
    }
  }
  if (!query.trim()) {
    return {
      query,
      text: "Web search failed: empty query.",
      results: [],
      errorCode: "invalid_input",
    }
  }

  try {
    const resp = await callBroker(query, count)
    return { query, text: formatResultsForModel(resp), results: resp.results }
  } catch (error) {
    if (error instanceof BrokerExhaustedError) {
      return {
        query,
        text: "Web search is unavailable: the search quota is exhausted for this period. Answer from your own knowledge and say it may be out of date.",
        results: [],
        errorCode: "too_many_requests",
      }
    }
    consola.error("Web search broker error:", error)
    return {
      query,
      text: `Web search failed: ${error instanceof Error ? error.message : String(error)}`,
      results: [],
      errorCode: "unavailable",
    }
  }
}

// Thin string-only wrapper (back-compat for callers that only need model text).
export async function runWebSearch(argsJson: string): Promise<string> {
  return (await runWebSearchDetailed(argsJson)).text
}
