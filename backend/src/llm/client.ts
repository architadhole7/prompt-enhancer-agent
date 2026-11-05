// Thin client for OpenAI-compatible chat APIs with native tool calling.
// Supports Groq and other compatible providers.
// API keys are read from environment variables and never logged or returned.

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatOptions {
  tools?: ToolDef[];
  maxTokens?: number;
  style?: string;
}

export class LLMError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "LLMError";
    this.status = status;
  }
}

interface ProviderResponse {
  choices?: {
    message?: ChatMessage;
    finish_reason?: string;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export function getMaxTokens(style?: string): number {
  const s = style?.toLowerCase();
  if (s === "short") {
    return Number(process.env.LLM_MAX_TOKENS_SHORT || process.env.MAX_TOKENS_SHORT) || 2000;
  }
  if (s === "technical") {
    return Number(process.env.LLM_MAX_TOKENS_TECHNICAL || process.env.MAX_TOKENS_TECHNICAL) || 3500;
  }
  if (s === "detailed") {
    return Number(process.env.LLM_MAX_TOKENS_DETAILED || process.env.MAX_TOKENS_DETAILED) || 3000;
  }
  return Number(process.env.LLM_MAX_TOKENS || process.env.MAX_TOKENS) || 3000;
}

export function parseRetryAfter(header: string | null, body: string): number | null {
  if (header) {
    const sec = Number(header);
    if (!isNaN(sec) && sec >= 0) {
      return Math.ceil(sec);
    }
    const dateMs = Date.parse(header);
    if (!isNaN(dateMs)) {
      const diffSec = Math.ceil((dateMs - Date.now()) / 1000);
      if (diffSec >= 0) return diffSec;
    }
  }

  const minSecMatch = body.match(
    /try again in\s+(?:(\d+(?:\.\d+)?)\s*m(?:in(?:ute)?s?)?\s*)?(\d+(?:\.\d+)?)\s*s/i
  );
  if (minSecMatch) {
    const mins = minSecMatch[1] ? parseFloat(minSecMatch[1]) : 0;
    const secs = parseFloat(minSecMatch[2]);
    return Math.ceil(mins * 60 + secs);
  }

  const secMatch = body.match(/(?:try again in|retry after)\s+(\d+(?:\.\d+)?)\s*(?:s|seconds)?/i);
  if (secMatch) {
    return Math.ceil(parseFloat(secMatch[1]));
  }

  return null;
}

function mapProviderStatus(status: number): LLMError {
  if (status === 401 || status === 403) {
    return new LLMError(
      500,
      "AI API key is invalid or not allowed. Check LLM_API_KEY on the server."
    );
  }

  if (status === 429) {
    return new LLMError(
      429,
      "AI provider rate limit reached. Try again shortly."
    );
  }

  if (status === 408 || status === 504) {
    return new LLMError(504, "AI provider timed out.");
  }

  return new LLMError(
    502,
    `AI provider failed (status ${status}).`
  );
}

export async function chat(
  messages: ChatMessage[],
  tools?: ToolDef[],
  options?: number | ChatOptions
): Promise<ChatMessage> {
  const key = process.env.LLM_API_KEY?.trim();

  if (!key || key.startsWith("your_")) {
    throw new LLMError(
      500,
      "AI API key is missing. Set LLM_API_KEY in the backend environment."
    );
  }

  const base = (
    process.env.LLM_BASE_URL ||
    "https://api.groq.com/openai/v1"
  ).replace(/\/+$/, "");

  const model = process.env.LLM_MODEL || "openai/gpt-oss-120b";
  const timeoutMs = Number(process.env.LLM_TIMEOUT_MS) || 60000;

  let maxTokens: number;
  if (typeof options === "number") {
    maxTokens = options;
  } else if (options && typeof options === "object") {
    maxTokens = options.maxTokens ?? getMaxTokens(options.style);
  } else {
    maxTokens = getMaxTokens();
  }

  let retried429 = false;
  let retriedToolUse = false;
  let sendReasoning = process.env.LLM_REASONING_EFFORT !== "none";

  while (true) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const bodyPayload: Record<string, unknown> = {
      model,
      messages,
      temperature: 0.3,
      max_tokens: maxTokens,
      ...(sendReasoning
        ? { reasoning_effort: process.env.LLM_REASONING_EFFORT || "low" }
        : {}),
      ...(tools && tools.length > 0
        ? {
            tools,
            tool_choice: "auto",
          }
        : {}),
    };

    try {
      let response: Response;

      try {
        response = await fetch(`${base}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${key}`,
          },
          body: JSON.stringify(bodyPayload),
          signal: controller.signal,
        });
      } catch (error) {
        if ((error as Error).name === "AbortError") {
          throw new LLMError(504, "AI provider timed out.");
        }
        throw new LLMError(502, "Could not reach the AI provider.");
      }

      if (!response.ok) {
        const responseText = await response.text().catch(() => "");

        // Log diagnostics safely - never log API keys or full provider response bodies.
        console.error("[LLM provider error]", {
          status: response.status,
          retryAfter: response.headers.get("retry-after"),
          remainingTokens: response.headers.get("x-ratelimit-remaining-tokens"),
        });

        if (response.status === 429) {
          const waitSec = parseRetryAfter(
            response.headers.get("retry-after"),
            responseText
          );
          if (!retried429 && waitSec !== null && waitSec <= 35) {
            retried429 = true;
            await new Promise((resolve) => setTimeout(resolve, waitSec * 1000));
            continue;
          }
          const waitMsg = waitSec !== null ? `~${waitSec}s` : "shortly";
          throw new LLMError(429, `Rate limit reached, retry in ${waitMsg}.`);
        }

        if (
          response.status === 400 &&
          sendReasoning &&
          responseText.includes("reasoning_effort")
        ) {
          sendReasoning = false;
          continue;
        }

        if (
          response.status === 400 &&
          !retriedToolUse &&
          responseText.includes("tool_use_failed")
        ) {
          retriedToolUse = true;
          continue;
        }

        throw mapProviderStatus(response.status);
      }

      let data: ProviderResponse;

      try {
        data = (await response.json()) as ProviderResponse;
      } catch {
        throw new LLMError(
          502,
          "AI provider returned an unreadable response."
        );
      }

      const choice = data.choices?.[0];
      const message = choice?.message;

      if (!message) {
        throw new LLMError(
          502,
          "AI provider returned an empty response."
        );
      }

      // Log response metadata only, never prompts or credentials.
      console.log("[LLM response]", {
        finishReason: choice.finish_reason,
        hasToolCalls: Boolean(message.tool_calls?.length),
        contentLength: message.content?.length ?? 0,
        promptTokens: data.usage?.prompt_tokens,
        completionTokens: data.usage?.completion_tokens,
        totalTokens: data.usage?.total_tokens,
      });

      return {
        role: "assistant",
        content: message.content ?? null,
        tool_calls: message.tool_calls,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
