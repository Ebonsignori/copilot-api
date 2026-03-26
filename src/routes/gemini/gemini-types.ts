// Gemini API Types
// https://ai.google.dev/api/generate-content

// --- Request ---

export interface GeminiPart {
  text?: string
  inlineData?: {
    mimeType: string
    data: string // base64
  }
  functionCall?: {
    name: string
    args: Record<string, unknown>
  }
  functionResponse?: {
    name: string
    response: Record<string, unknown>
  }
}

export interface GeminiContent {
  role: "user" | "model"
  parts: Array<GeminiPart>
}

export interface GeminiTool {
  functionDeclarations?: Array<{
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }>
}

export interface GeminiToolConfig {
  functionCallingConfig?: {
    mode?: "AUTO" | "ANY" | "NONE"
    allowedFunctionNames?: Array<string>
  }
}

export interface GeminiGenerateContentRequest {
  contents: Array<GeminiContent>
  systemInstruction?: {
    parts: Array<{ text: string }>
  }
  tools?: Array<GeminiTool>
  toolConfig?: GeminiToolConfig
  generationConfig?: {
    temperature?: number
    topP?: number
    topK?: number
    maxOutputTokens?: number
    stopSequences?: Array<string>
    candidateCount?: number
    responseMimeType?: string
  }
  safetySettings?: Array<{
    category: string
    threshold: string
  }>
}

// --- Response ---

export interface GeminiFunctionCall {
  name: string
  args: Record<string, unknown>
}

export interface GeminiResponsePart {
  text?: string
  functionCall?: GeminiFunctionCall
}

export interface GeminiCandidate {
  content: {
    role: "model"
    parts: Array<GeminiResponsePart>
  }
  finishReason?:
    | "STOP"
    | "MAX_TOKENS"
    | "SAFETY"
    | "RECITATION"
    | "OTHER"
    | "FINISH_REASON_UNSPECIFIED"
  index?: number
  safetyRatings?: Array<{
    category: string
    probability: string
  }>
}

export interface GeminiUsageMetadata {
  promptTokenCount: number
  candidatesTokenCount: number
  totalTokenCount: number
  cachedContentTokenCount?: number
}

export interface GeminiGenerateContentResponse {
  candidates: Array<GeminiCandidate>
  usageMetadata?: GeminiUsageMetadata
  modelVersion?: string
}

// --- Streaming ---

// Streaming responses are newline-delimited JSON objects, each being a
// GeminiGenerateContentResponse with partial candidate content.
// The @google/genai SDK wraps these as SSE: data: <json>

export interface GeminiStreamState {
  firstChunk: boolean
  toolCallsInProgress: Map<
    string,
    { name: string; argsAccum: string }
  >
}
