import { Hono } from "hono"

import type { Model } from "~/services/copilot/get-models"

import { forwardError } from "~/lib/error"
import { state } from "~/lib/state"
import { cacheModels } from "~/lib/utils"

export const modelRoutes = new Hono()

// One model as /v1/models lists it. The first seven fields are the shape this
// route has always returned, in Anthropic's and OpenAI's terms. The rest pass on
// what Copilot's catalog says about the model, under Copilot's own names, so a
// client can choose an API, clamp effort and size its context from them:
//   supported_endpoints   which APIs Copilot serves the model on ("/v1/messages",
//                         "/chat/completions", "/responses"); absent when the
//                         catalog lists none
//   copilot_capabilities  Copilot's `capabilities`: limits (max_prompt_tokens,
//                         max_output_tokens, max_context_window_tokens, vision)
//                         and supports (tool_calls, parallel_tool_calls,
//                         reasoning_effort, vision, streaming, …), as Copilot
//                         sends them
//   copilot_billing       { token_prices }: Copilot's price tiers (default, and
//                         long_context above the default's max_prompt_tokens),
//                         in AIU per batch_size tokens; absent when the catalog
//                         has none. The rest of `billing` (which plans may use
//                         the model, the auto discount) isn't passed on.
// Not `capabilities`, `max_input_tokens` or `max_tokens`: Anthropic's ModelInfo
// defines those with other shapes, and Anthropic clients read them.
export function toModelEntry(model: Model) {
  return {
    id: model.id,
    object: "model",
    type: "model",
    created: 0, // No date available from source
    created_at: new Date(0).toISOString(), // No date available from source
    owned_by: model.vendor,
    display_name: model.name,
    supported_endpoints: model.supported_endpoints,
    copilot_capabilities: model.capabilities,
    copilot_billing:
      model.billing?.token_prices ?
        { token_prices: model.billing.token_prices }
      : undefined,
  }
}

modelRoutes.get("/", async (c) => {
  try {
    if (!state.models) {
      // This should be handled by startup logic, but as a fallback.
      await cacheModels()
    }

    const models = state.models?.data.map((model) => toModelEntry(model))

    return c.json({
      object: "list",
      data: models,
      has_more: false,
    })
  } catch (error) {
    return await forwardError(c, error)
  }
})
