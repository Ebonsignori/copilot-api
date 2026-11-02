import { randomUUID } from "node:crypto"

import type { State } from "./state"

export const standardHeaders = () => ({
  "content-type": "application/json",
  accept: "application/json",
})

// Identify as the GitHub Copilot CLI (`copilot`). Values captured from a real
// CLI request by pointing COPILOT_API_URL at a local header dump.
const COPILOT_CLI_VERSION = "1.0.89-3"
const INTEGRATION_ID = "copilot-developer-cli"
const EDITOR_VERSION = `copilot/${COPILOT_CLI_VERSION}`
const USER_AGENT = `copilot/${COPILOT_CLI_VERSION} (${process.platform} ${process.version})`

const API_VERSION = "2026-08-01"

// Anthropic Messages API version, required on the native /v1/messages passthrough
// (Copilot's native Anthropic endpoint rejects the request without it).
export const ANTHROPIC_VERSION = "2023-06-01"

export const copilotBaseUrl = (state: State) =>
  state.accountType === "individual" ?
    "https://api.githubcopilot.com"
  : `https://api.${state.accountType}.githubcopilot.com`
export const copilotHeaders = (state: State, vision: boolean = false) => {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${state.copilotToken}`,
    "content-type": standardHeaders()["content-type"],
    "copilot-integration-id": INTEGRATION_ID,
    "editor-version": EDITOR_VERSION,
    "user-agent": USER_AGENT,
    "openai-intent": "conversation-agent",
    "x-github-api-version": API_VERSION,
    "x-request-id": randomUUID(),
  }

  if (vision) headers["copilot-vision-request"] = "true"

  return headers
}

export const GITHUB_API_BASE_URL = "https://api.github.com"
export const githubHeaders = (state: State) => ({
  ...standardHeaders(),
  authorization: `token ${state.githubToken}`,
  "editor-version": EDITOR_VERSION,
  "user-agent": USER_AGENT,
  "x-github-api-version": API_VERSION,
})

export const GITHUB_BASE_URL = "https://github.com"
export const GITHUB_CLIENT_ID = "Iv1.b507a08c87ecfe98"
export const GITHUB_APP_SCOPES = ["read:user"].join(" ")
