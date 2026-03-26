import { Hono } from "hono"

import { forwardError } from "~/lib/error"

import { handleGenerateContent } from "./handler"

export const geminiRoutes = new Hono()

// POST /v1beta/models/:model:generateContent
// POST /v1beta/models/:model:streamGenerateContent
// The @google/genai SDK appends the action as part of the path segment
// e.g. /v1beta/models/gemini-2.5-pro:generateContent
geminiRoutes.post("/:model\\:generateContent", async (c) => {
  try {
    return await handleGenerateContent(c)
  } catch (error) {
    return await forwardError(c, error)
  }
})

geminiRoutes.post("/:model\\:streamGenerateContent", async (c) => {
  try {
    return await handleGenerateContent(c)
  } catch (error) {
    return await forwardError(c, error)
  }
})
