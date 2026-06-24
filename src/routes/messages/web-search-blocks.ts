import { type SearchRecord } from "~/lib/web-search"

import {
  type AnthropicServerToolUseBlock,
  type AnthropicWebSearchToolResultBlock,
} from "./anthropic-types"

// Anthropic requires a non-empty encrypted_content on each web_search_result for
// schema validity. The proxy fetches from Brave/Tavily and has no real opaque
// token; Claude Code renders sources from url/title and never decodes this, so a
// stable placeholder is safe. (See the web-search-tool docs: the field is only
// used for multi-turn citation re-submission, which our single-turn proxy never
// does.)
const ENCRYPTED_CONTENT_PLACEHOLDER = "proxy-web-search-no-encrypted-content"

// Map a SearchRecord's errorCode to the Anthropic web_search_tool_result_error.
function toResultContent(
  record: SearchRecord,
): AnthropicWebSearchToolResultBlock["content"] {
  if (record.errorCode) {
    return { type: "web_search_tool_result_error", error_code: record.errorCode }
  }
  return record.results.map((r) => ({
    type: "web_search_result" as const,
    url: r.url,
    title: r.title || r.url,
    encrypted_content: ENCRYPTED_CONTENT_PLACEHOLDER,
    page_age: null,
  }))
}

// Build the faithful server_tool_use + web_search_tool_result block PAIRS for the
// searches the proxy executed, so Claude Code shows the search count + sources.
// IDs use the srvtoolu_ prefix Anthropic uses and are deterministic per response
// (responseId + index) so the streaming and non-streaming paths agree.
export function buildSearchBlocks(
  searches: Array<SearchRecord>,
  responseId: string,
): Array<AnthropicServerToolUseBlock | AnthropicWebSearchToolResultBlock> {
  const blocks: Array<
    AnthropicServerToolUseBlock | AnthropicWebSearchToolResultBlock
  > = []
  searches.forEach((record, i) => {
    const id = `srvtoolu_${responseId}_${i}`
    blocks.push({
      type: "server_tool_use",
      id,
      name: "web_search",
      input: { query: record.query },
    })
    blocks.push({
      type: "web_search_tool_result",
      tool_use_id: id,
      content: toResultContent(record),
    })
  })
  return blocks
}
