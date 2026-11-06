import { Hono } from "hono"

import { forwardError } from "~/lib/error"

import { handleGenerateContent } from "./handler"

export const geminiRoutes = new Hono()

const ACTIONS = new Set(["generateContent", "streamGenerateContent"])

// The @google/genai SDK puts the action in the model's path segment:
// POST /v1beta/models/gemini-2.5-pro:streamGenerateContent. Hono has no escape
// for a literal colon in a route, so the routes used to be
// "/:model\\:generateContent", which named the parameter
// "model\:generateContent": c.req.param("model") was undefined, every request
// went to Copilot without a model, and Copilot's default model (gpt-4o-mini)
// answered instead of the Gemini model asked for. The segment is split here.
export function parseModelAction(
  segment: string,
): { model: string; action: string } | undefined {
  const colon = segment.lastIndexOf(":")
  if (colon <= 0) return undefined
  const model = segment.slice(0, colon)
  const action = segment.slice(colon + 1)
  return ACTIONS.has(action) ? { model, action } : undefined
}

// POST /v1beta/models/:model:generateContent
// POST /v1beta/models/:model:streamGenerateContent
geminiRoutes.post("/:segment", async (c) => {
  const target = parseModelAction(c.req.param("segment"))
  if (!target) return c.notFound()
  try {
    return await handleGenerateContent(
      c,
      target.model,
      target.action === "streamGenerateContent",
    )
  } catch (error) {
    return await forwardError(c, error)
  }
})
