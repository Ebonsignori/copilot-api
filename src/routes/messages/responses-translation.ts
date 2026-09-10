// Anthropic Messages <-> OpenAI Responses translation.
//
// Copilot serves every recent GPT (5.5, 5.6-*, gpt-6-astra) ONLY on /responses --
// they are absent from both /v1/messages and /chat/completions, so the native
// passthrough and the legacy OpenAI path both dead-end on
// `no_available_model_endpoints`. These pure functions bridge the gap; the I/O
// lives in responses-bridge.ts and the SSE mapping in responses-stream-translation.ts.
//
// Reasoning round-trip: Responses returns a `reasoning` item carrying
// `encrypted_content` (~7KB), and feeding that item back verbatim on the next turn
// is what preserves chain of thought across tool calls (verified live against
// Copilot). Anthropic clients have no such concept, but they DO round-trip a
// thinking block's `signature` untouched -- so we carry `encrypted_content` in
// `signature` and rebuild the reasoning item from it on the way back in. This keeps
// the proxy stateless: nothing to evict, nothing lost on restart.
import { randomUUID } from "node:crypto"

import type {
  FunctionCallItem,
  FunctionCallOutputItem,
  InputImageContent,
  InputTextContent,
  FunctionTool,
  MessageContentItem,
  ReasoningItem,
  ResponseItem,
  ResponsesApiPayload,
  ResponsesApiResponse,
  ToolSpec,
} from "~/routes/responses/types"

import type {
  AnthropicAssistantContentBlock,
  AnthropicAssistantMessage,
  AnthropicImageBlock,
  AnthropicToolResultBlock,
  AnthropicMessage,
  AnthropicMessagesPayload,
  AnthropicResponse,
  AnthropicTextBlock,
  AnthropicTool,
  AnthropicUserMessage,
} from "./anthropic-types"

// Anthropic ids are short and opaque to the client; the upstream Responses id is a
// 400+ char encrypted blob, so we mint our own rather than forwarding it.
export const newMessageId = (): string => `msg_${randomUUID()}`

// --- Request: Anthropic -> Responses ---

function systemToInstructions(
  system: AnthropicMessagesPayload["system"],
): string | undefined {
  if (!system) return undefined
  if (typeof system === "string") return system
  return system.map((block: AnthropicTextBlock) => block.text).join("\n\n")
}

// Effort, weakest to strongest. Anthropic and Copilot use the same five names, so
// the mapping is identity -- the work here is defaulting and clamping.
const EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"] as const
type Effort = (typeof EFFORT_ORDER)[number]

// Anthropic's documented API default is `high` ("setting effort to high produces
// exactly the same behavior as omitting the parameter"). Copilot's default is
// `medium`. Sending nothing therefore silently runs a notch weaker than the same
// session would on Claude, so we send `high` explicitly instead of omitting it.
const DEFAULT_EFFORT: Effort = "high"

// Measured stall threshold. Sweeping max_output_tokens x effort on a real prompt:
// `high` and `xhigh` completed at every budget down to 512, `max` came back
// `incomplete` at 512 (468 reasoning tokens, 103 chars of text), and an earlier repro
// stalled xhigh outright at 64. So the risk is confined to tiny budgets, and the cap
// is set just above the smallest verified-safe point rather than guessed at. Capping
// effort is the right lever -- raising max_output_tokens would overrun the client's
// own limit. The ceiling is `high` (Anthropic's default), so a normal request is
// never downgraded.
const SMALL_OUTPUT_BUDGET = 1024
const SMALL_BUDGET_EFFORT_CEILING = "high"
// Copilot rejects a max_output_tokens below this.
const MIN_OUTPUT_TOKENS = 16

// Clamp to the strongest level the model actually advertises. gpt-5.5 / gpt-5.4 400
// on "max", which would otherwise make /effort max lock a user out of those models
// entirely. An unknown model (empty list) is left alone rather than guessed at.
export function clampEffort(
  requested: Effort,
  supported: Array<string> | undefined,
): Effort {
  if (!supported || supported.length === 0) return requested
  const allowed = EFFORT_ORDER.filter((level) => supported.includes(level))
  if (allowed.length === 0) return requested
  const wanted = EFFORT_ORDER.indexOf(requested)
  const atOrBelow = allowed.filter(
    (level) => EFFORT_ORDER.indexOf(level) <= wanted,
  )
  return atOrBelow.length > 0 ? (atOrBelow.at(-1) as Effort) : allowed[0]
}

function requestedEffort(payload: AnthropicMessagesPayload): Effort {
  // output_config.effort is the modern control -- /effort, --effort and
  // CLAUDE_CODE_EFFORT_LEVEL all set it, and on adaptive-reasoning models it is the
  // only one with any effect. Observed on the wire: ultracode arrives here as
  // "xhigh"; it is a client behavior, not a sixth level.
  const explicit = payload.output_config?.effort
  if (explicit && (EFFORT_ORDER as ReadonlyArray<string>).includes(explicit)) {
    return explicit
  }

  const thinking = payload.thinking
  // Responses has no "off", so the honest floor for a client that disabled thinking
  // is the weakest level -- otherwise background calls pay for reasoning they
  // explicitly turned off.
  if (thinking?.type === "disabled") return "low"

  // Legacy fixed-budget form. Real Claude Code never sends budget_tokens (it sends
  // thinking.type adaptive|disabled), so this only serves older Anthropic clients.
  const budget = thinking?.budget_tokens
  if (budget !== undefined) {
    if (budget < 4096) return "low"
    if (budget < 16384) return "medium"
    return "high"
  }
  return DEFAULT_EFFORT
}

function resolveReasoning(
  payload: AnthropicMessagesPayload,
  supportedEfforts?: Array<string>,
): ResponsesApiPayload["reasoning"] {
  let effort = requestedEffort(payload)

  if (
    payload.max_tokens < SMALL_OUTPUT_BUDGET
    && EFFORT_ORDER.indexOf(effort)
      > EFFORT_ORDER.indexOf(SMALL_BUDGET_EFFORT_CEILING)
  ) {
    effort = SMALL_BUDGET_EFFORT_CEILING
  }

  return { effort: clampEffort(effort, supportedEfforts), summary: "auto" }
}

// Copilot rejects the ENTIRE request when a tool schema carries a `pattern` its
// validator cannot compile. Measured against the live endpoint with strict mode off:
//   accepted -> plain patterns, and lookaround ((?!..), (?=..), (?<=..), (?<!..))
//   rejected -> unicode property escapes (\p{..} / \P{..}) and named groups ((?<n>..))
// Only those two dialects are dropped, so ordinary constraints -- including Agent's
// ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$ and Artifact's lookahead paths -- still reach the
// model as guidance. A dropped pattern costs a hint; a kept one that fails to
// compile costs the entire request.
const UNSUPPORTED_REGEX = /\\p\{|\(\?<[A-Z_]/i

export function stripSchemaPatterns(value: unknown): unknown {
  if (Array.isArray(value))
    return value.map((item) => stripSchemaPatterns(item))
  if (typeof value !== "object" || value === null) return value

  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (
      key === "pattern"
      && typeof child === "string"
      && UNSUPPORTED_REGEX.test(child)
    ) {
      continue
    }
    out[key] = stripSchemaPatterns(child)
  }
  return out
}

function imageToInputImage(block: AnthropicImageBlock): InputImageContent {
  return {
    type: "input_image",
    image_url: `data:${block.source.media_type};base64,${block.source.data}`,
  }
}

// Anthropic tool results carry either a string or a block array, and the block
// types are Anthropic's own ("text", "image"). Responses rejects those names
// outright -- `Invalid value: 'text'. Supported values are: 'input_text', ...` -- and
// that 400 kills the whole request, so every block has to be renamed on the way
// through rather than forwarded verbatim.
function toolResultOutput(
  block: AnthropicToolResultBlock,
): FunctionCallOutputItem["output"] {
  if (typeof block.content === "string") return block.content

  const parts: Array<InputTextContent | InputImageContent> = []
  for (const part of block.content) {
    if (part.type === "text") {
      parts.push({ type: "input_text", text: part.text })
      // The declared union says anything not "text" must be "image", so this check
      // looks redundant to the type checker. It isn't: the wire is not bound by our
      // types, and this file has already been broken twice by real payloads carrying
      // shapes the types didn't predict. Match explicitly and drop the rest.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    } else if (part.type === "image") {
      parts.push(imageToInputImage(part))
    }
    // Anything else is dropped. Forwarding an unrecognized block would either send
    // a name Responses rejects (400, whole request lost) or dereference fields the
    // block doesn't have; a missing part only costs the model some context.
  }
  // Responses wants a string or a non-empty array; "" is the safe empty form.
  return parts.length > 0 ? parts : ""
}

function userBlocksToItems(message: AnthropicUserMessage): Array<ResponseItem> {
  if (typeof message.content === "string") {
    return [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: message.content }],
      },
    ]
  }

  const items: Array<ResponseItem> = []
  const parts: Array<MessageContentItem> = []

  for (const block of message.content) {
    switch (block.type) {
      case "text": {
        parts.push({ type: "input_text", text: block.text })
        break
      }
      case "image": {
        parts.push(imageToInputImage(block))
        break
      }
      case "tool_result": {
        // A tool result is a TOP-LEVEL item in Responses, not message content, so
        // flush any text collected so far to keep ordering faithful.
        if (parts.length > 0) {
          items.push({ type: "message", role: "user", content: [...parts] })
          parts.length = 0
        }
        const output: FunctionCallOutputItem = {
          type: "function_call_output",
          call_id: block.tool_use_id,
          output: toolResultOutput(block),
        }
        items.push(output)
        break
      }
      default: {
        // No other user-side block types exist in the Anthropic schema today.
        break
      }
    }
  }

  if (parts.length > 0) {
    items.push({ type: "message", role: "user", content: parts })
  }
  return items
}

function assistantBlocksToItems(
  message: AnthropicAssistantMessage,
): Array<ResponseItem> {
  if (typeof message.content === "string") {
    return [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: message.content }],
      },
    ]
  }

  const items: Array<ResponseItem> = []
  for (const block of message.content) {
    switch (block.type) {
      case "thinking": {
        // Only a block that still carries its signature can be replayed -- that IS
        // the encrypted reasoning. A signature-less block (e.g. one the client
        // synthesized) is dropped rather than sent as an unusable empty item.
        if (!block.signature) break
        const reasoning: ReasoningItem = {
          type: "reasoning",
          encrypted_content: block.signature,
          summary:
            block.thinking ?
              [{ type: "summary_text", text: block.thinking }]
            : [],
        }
        items.push(reasoning)
        break
      }
      case "text": {
        items.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: block.text }],
        })
        break
      }
      case "tool_use": {
        const call: FunctionCallItem = {
          type: "function_call",
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input),
        }
        items.push(call)
        break
      }
      default: {
        // server_tool_use / web_search_tool_result are proxy-emulated Anthropic
        // blocks with no Responses equivalent; they never round-trip.
        break
      }
    }
  }
  return items
}

function messagesToInput(
  messages: Array<AnthropicMessage>,
): Array<ResponseItem> {
  return messages.flatMap((message) =>
    message.role === "user" ?
      userBlocksToItems(message)
    : assistantBlocksToItems(message),
  )
}

function toolsToResponses(
  tools: Array<AnthropicTool> | undefined,
): Array<ToolSpec> | undefined {
  if (!tools || tools.length === 0) return undefined
  // Anthropic server-side tools (web_search) carry no input_schema and have no
  // Responses equivalent -- forwarding them would be a malformed function tool.
  const clientTools = tools.filter((tool) => Boolean(tool.input_schema))
  if (clientTools.length === 0) return undefined
  return clientTools.map(
    (tool): FunctionTool => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      // Copilot defaults function tools to strict mode, which forces EVERY property
      // into `required` -- even ones the client declared optional. The model must
      // then emit all of them, so a tool documented as "provide at most one of name
      // or path" becomes impossible to call correctly and the caller loops on
      // validation errors. Opting out restores optional parameters; Copilot honors it.
      strict: false,
      parameters: stripSchemaPatterns(tool.input_schema) as Record<
        string,
        unknown
      >,
    }),
  )
}

function toolChoiceToResponses(
  choice: AnthropicMessagesPayload["tool_choice"],
): ResponsesApiPayload["tool_choice"] {
  switch (choice?.type) {
    case "auto": {
      return "auto"
    }
    case "any": {
      return "required"
    }
    case "none": {
      return "none"
    }
    case "tool": {
      return choice.name ? { type: "function", name: choice.name } : "required"
    }
    default: {
      return undefined
    }
  }
}

export function anthropicToResponsesPayload(
  payload: AnthropicMessagesPayload,
  supportedEfforts?: Array<string>,
): ResponsesApiPayload {
  return {
    model: payload.model,
    input: messagesToInput(payload.messages),
    instructions: systemToInstructions(payload.system),
    tools: toolsToResponses(payload.tools),
    tool_choice: toolChoiceToResponses(payload.tool_choice),
    reasoning: resolveReasoning(payload, supportedEfforts),
    max_output_tokens: Math.max(payload.max_tokens, MIN_OUTPUT_TOKENS),
    stream: payload.stream,
    // Without this the reasoning items come back with no encrypted_content and
    // the chain of thought cannot survive a tool-call round trip.
    include: ["reasoning.encrypted_content"],
    // The proxy is stateless; never ask Copilot to retain the conversation.
    store: false,
  }
}

// --- Response: Responses -> Anthropic ---

function reasoningToThinking(
  item: ReasoningItem,
): AnthropicAssistantContentBlock {
  const summary = (item.summary ?? []).map((part) => part.text).join("\n\n")
  const content = (item.content ?? []).map((part) => part.text).join("\n\n")
  return {
    type: "thinking",
    thinking: summary || content,
    ...(item.encrypted_content !== undefined && {
      signature: item.encrypted_content,
    }),
  }
}

function functionCallToToolUse(
  item: FunctionCallItem,
): AnthropicAssistantContentBlock {
  let input: Record<string, unknown>
  try {
    input = JSON.parse(item.arguments || "{}") as Record<string, unknown>
  } catch {
    // A truncated turn can leave arguments as invalid JSON. An empty object keeps
    // the block well-formed rather than failing the whole translation.
    input = {}
  }
  return { type: "tool_use", id: item.call_id, name: item.name, input }
}

export function responsesOutputToBlocks(
  output: Array<ResponseItem>,
): Array<AnthropicAssistantContentBlock> {
  const blocks: Array<AnthropicAssistantContentBlock> = []
  for (const item of output) {
    switch (item.type) {
      case "reasoning": {
        blocks.push(reasoningToThinking(item))
        break
      }
      case "function_call": {
        blocks.push(functionCallToToolUse(item))
        break
      }
      case "message": {
        for (const part of item.content) {
          if (part.type === "output_text" && part.text) {
            blocks.push({ type: "text", text: part.text })
          }
        }
        break
      }
      default: {
        break
      }
    }
  }
  return blocks
}

export function mapResponsesStopReason(
  response: Pick<ResponsesApiResponse, "output" | "status">,
): AnthropicResponse["stop_reason"] {
  if (response.output.some((item) => item.type === "function_call")) {
    return "tool_use"
  }
  if (response.status === "incomplete") return "max_tokens"
  return "end_turn"
}

export function mapResponsesUsage(
  usage: ResponsesApiResponse["usage"],
): AnthropicResponse["usage"] {
  const cached = usage?.input_tokens_details?.cached_tokens ?? 0
  return {
    // Anthropic reports uncached input separately from the cache-read count.
    input_tokens: Math.max((usage?.input_tokens ?? 0) - cached, 0),
    output_tokens: usage?.output_tokens ?? 0,
    ...(cached > 0 && { cache_read_input_tokens: cached }),
  }
}

export function responsesResponseToAnthropic(
  response: ResponsesApiResponse,
): AnthropicResponse {
  return {
    id: newMessageId(),
    type: "message",
    role: "assistant",
    content: responsesOutputToBlocks(response.output),
    model: response.model,
    stop_reason: mapResponsesStopReason(response),
    stop_sequence: null,
    usage: mapResponsesUsage(response.usage),
  }
}
