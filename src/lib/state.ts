import type { ModelsResponse } from "~/services/copilot/get-models"

export interface State {
  githubToken?: string
  copilotToken?: string

  accountType: string
  models?: ModelsResponse
  vsCodeVersion?: string

  manualApprove: boolean
  rateLimitWait: boolean
  showToken: boolean

  // Rate limiting configuration
  rateLimitSeconds?: number
  lastRequestTimestamp?: number

  // Web search broker (the n100 search-broker). When both are set, the
  // /v1/messages route intercepts Anthropic's server-side `web_search` tool and
  // services it against this broker instead of letting the tool_use dangle.
  searchServiceUrl?: string
  searchServiceToken?: string

  // When true (default), /v1/messages forwards straight to Copilot's native
  // Anthropic endpoint — preserving native `thinking` blocks, signatures, and
  // token-by-token streaming. When false, the legacy translate-through-OpenAI
  // path is used instead (a kill-switch for a fast revert without a redeploy).
  // The web_search emulation pre-branch runs regardless of this flag.
  anthropicPassthrough: boolean
}

export const state: State = {
  accountType: "individual",
  manualApprove: false,
  rateLimitWait: false,
  showToken: false,
  anthropicPassthrough: true,
}
