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
}

export const state: State = {
  accountType: "individual",
  manualApprove: false,
  rateLimitWait: false,
  showToken: false,
}
