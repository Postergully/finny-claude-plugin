// Instance configuration for multi-instance support

export interface InstanceConfig {
  name: string;
  url: string;
  token?: string;
  timeout?: number;
  default?: boolean;
}

// OpenAI-compatible API types

export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface OpenAIChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string | null;
      tool_calls?: OpenAIToolCall[];
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// MCP-facing types (facade over OpenAI response)

export interface HermesChatResponse {
  response: string;
  model?: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  tool_calls?: OpenAIToolCall[];
}

export interface HermesHealthResponse {
  status: 'ok' | 'error';
  message?: string;
}
