import { copilotBaseUrl, copilotHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

export const getModels = async () => {
  const response = await fetch(`${copilotBaseUrl(state)}/models`, {
    headers: copilotHeaders(state),
  })

  if (!response.ok) throw new HTTPError("Failed to get models", response)

  return (await response.json()) as ModelsResponse
}

export interface ModelsResponse {
  data: Array<Model>
  object: string
}

interface ModelLimits {
  max_context_window_tokens?: number
  max_output_tokens?: number
  max_prompt_tokens?: number
  max_inputs?: number
}

interface ModelSupports {
  tool_calls?: boolean
  parallel_tool_calls?: boolean
  dimensions?: boolean
  // Which reasoning efforts this model accepts. Astra takes all five; gpt-5.5 and
  // gpt-5.4 reject "max" with a 400, so the bridge clamps against this list.
  reasoning_effort?: Array<string>
}

interface ModelCapabilities {
  family: string
  limits: ModelLimits
  object: string
  supports: ModelSupports
  tokenizer: string
  type: string
}

export interface Model {
  capabilities: ModelCapabilities
  id: string
  // Which upstream API shapes Copilot serves this model on, e.g.
  // ["/v1/messages", "/chat/completions"] for Claude, ["/responses"] for every
  // recent GPT. Drives which outbound path /v1/messages takes — see
  // isResponsesOnlyModel in routes/messages/responses-bridge.ts.
  supported_endpoints?: Array<string>
  model_picker_enabled: boolean
  name: string
  object: string
  preview: boolean
  vendor: string
  version: string
  policy?: {
    state: string
    terms: string
  }
}
