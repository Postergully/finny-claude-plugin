export interface ToolResponse {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export function successResponse(text: string): ToolResponse {
  return {
    content: [{ type: 'text', text }],
  };
}

export function errorResponse(message: string): ToolResponse {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
  };
}

export function jsonResponse(data: unknown): ToolResponse {
  return successResponse(JSON.stringify(data, null, 2));
}
