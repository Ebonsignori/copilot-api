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

// The catalog's fields as of 2026-11, all optional: each model lists only some.
// Anything else Copilot adds passes through /v1/models untyped.
interface ModelLimits {
  max_context_window_tokens?: number
  max_output_tokens?: number
  max_non_streaming_output_tokens?: number
  max_prompt_tokens?: number
  max_inputs?: number
  vision?: {
    max_prompt_image_size?: number
    max_prompt_images?: number
    supported_media_types?: Array<string>
  }
}

interface ModelSupports {
  tool_calls?: boolean
  parallel_tool_calls?: boolean
  dimensions?: boolean
  // Which reasoning efforts this model accepts. Astra takes all five; gpt-5.5 and
  // gpt-5.4 reject "max" with a 400, so the bridge clamps against this list.
  reasoning_effort?: Array<string>
  adaptive_thinking?: boolean
  max_thinking_budget?: number
  min_thinking_budget?: number
  streaming?: boolean
  structured_outputs?: boolean
  vision?: boolean
}

interface ModelCapabilities {
  family: string
  limits: ModelLimits
  object: string
  supports: ModelSupports
  tokenizer: string
  type: string
}

// One price tier, in AIU per batch_size tokens. Tiers apply up to their
// max_prompt_tokens: "default" first, then "long_context".
interface ModelTokenTier {
  input_price?: number
  output_price?: number
  cache_read_price?: number
  cache_write_price?: number
  cache_write_1h_price?: number
  image_input_price?: number
  image_output_price?: number
  max_prompt_tokens?: number
}

interface ModelBilling {
  auto_discount?: number
  restricted_to?: Array<string>
  token_prices?: {
    batch_size?: number
    preferred_tier?: string
    default?: ModelTokenTier
    long_context?: ModelTokenTier
  }
}

export interface Model {
  billing?: ModelBilling
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
