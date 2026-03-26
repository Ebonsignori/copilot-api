import { Hono } from "hono"

import { forwardError } from "~/lib/error"

import { handleResponses } from "./handler"

export const responsesRoute = new Hono()

responsesRoute.post("/", async (c) => {
  try {
    return await handleResponses(c)
  } catch (error) {
    return await forwardError(c, error)
  }
})
