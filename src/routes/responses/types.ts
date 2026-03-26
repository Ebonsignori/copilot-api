// OpenAI Responses API types
// https://platform.openai.com/docs/api-reference/responses

// --- Input item types ---

export interface InputTextContent {
  type: "input_text"
  text: string
}

export interface InputImageContent {
  type: "input_image"
  image_url: string
}

export interface OutputTextContent {
  type: "output_text"
  text: string
}

export type MessageContentItem =
  | InputTextContent
  | InputImageContent
  | OutputTextContent

export interface MessageItem {
  type: "message"
  role: "user" | "assistant" | "developer"
  content: Array<MessageContentItem>
  end_turn?: boolean
  phase?: "commentary" | "final_answer"
  id?: string
}

export interface ReasoningItem {
  type: "reasoning"
  id?: string
  summary?: Array<{ type: "summary_text"; text: string }>
  encrypted_content?: string
  content?: Array<{ type: "reasoning_text"; text: string }>
}

export interface FunctionCallItem {
  type: "function_call"
  call_id: string
  name: string
  arguments: string
  id?: string
}

export interface FunctionCallOutputItem {
  type: "function_call_output"
  call_id: string
  output: string | Array<InputTextContent | InputImageContent>
}

export interface LocalShellCallItem {
  type: "local_shell_call"
  call_id: string
  status?: string
  action?: { type: string; command: string[] }
}

export interface CustomToolCallItem {
  type: "custom_tool_call"
  call_id: string
  name: string
  input: string
}

export interface CustomToolCallOutputItem {
  type: "custom_tool_call_output"
  call_id: string
  name?: string
  output: string
}

export type ResponseItem =
  | MessageItem
  | ReasoningItem
  | FunctionCallItem
  | FunctionCallOutputItem
  | LocalShellCallItem
  | CustomToolCallItem
  | CustomToolCallOutputItem

// --- Tool types ---

export interface FunctionTool {
  type: "function"
  name: string
  description?: string
  strict?: boolean
  parameters?: Record<string, unknown>
}

export interface LocalShellTool {
  type: "local_shell"
}

export interface WebSearchTool {
  type: "web_search"
  external_web_access?: boolean
}

export interface ImageGenerationTool {
  type: "image_generation"
  output_format?: string
}

export interface CustomTool {
  type: "custom"
  name: string
  description?: string
  format?: Record<string, unknown>
}

export type ToolSpec =
  | FunctionTool
  | LocalShellTool
  | WebSearchTool
  | ImageGenerationTool
  | CustomTool

// --- Request ---

export interface ResponsesApiPayload {
  model: string
  input: Array<ResponseItem>
  instructions?: string
  tools?: Array<ToolSpec>
  tool_choice?: string
  parallel_tool_calls?: boolean
  reasoning?: {
    effort?: "low" | "medium" | "high"
    summary?: "auto" | "concise" | "detailed" | "none"
  }
  stream?: boolean
  store?: boolean
  include?: Array<string>
  service_tier?: string
  prompt_cache_key?: string
  text?: {
    verbosity?: "low" | "medium" | "high"
    format?: Record<string, unknown>
  }
}

// --- Response (non-streaming) ---

export interface ResponsesApiResponse {
  id: string
  object: "response"
  created_at: number
  status: "completed" | "failed" | "incomplete"
  model: string
  output: Array<ResponseItem>
  usage?: {
    input_tokens: number
    input_tokens_details?: { cached_tokens: number }
    output_tokens: number
    output_tokens_details?: { reasoning_tokens: number }
    total_tokens: number
  }
  error?: object | null
  incomplete_details?: object | null
  metadata?: object
}

// --- Streaming state ---

export interface ToolCallInProgress {
  call_id: string
  name: string
  argsAccum: string
}

export interface ResponsesStreamState {
  responseId: string
  firstChunk: boolean
  outputItemOpen: boolean
  textAccum: string
  toolCallsInProgress: Map<number, ToolCallInProgress>
}
