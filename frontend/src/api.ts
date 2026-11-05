// Backend URL comes from configuration (VITE_API_URL). Empty = same origin.
const API = ((import.meta.env.VITE_API_URL as string | undefined) ?? "").replace(/\/+$/, "");

export interface Step {
  step: number;
  tool: string;
  input: unknown;
  output: unknown;
}

export interface EnhanceResponse {
  original: string;
  enhanced: string;
  questions: string[];
  assumptions: string[];
  score: { before: number; after: number };
  steps: Step[];
  warning: string | null;
}

export type Style = "short" | "detailed" | "technical";

export async function enhance(body: {
  prompt: string;
  style: Style;
  previousPlan: string | null;
}): Promise<EnhanceResponse> {
  let res: Response;
  try {
    res = await fetch(`${API}/api/enhance`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(170_000),
    });
  } catch {
    throw new Error("Could not reach the server. Check that the backend is running.");
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new Error(`The server returned an unexpected response (${res.status}).`);
  }
  if (!res.ok) {
    const msg = (data as { error?: string })?.error;
    throw new Error(msg ?? `Request failed (${res.status}).`);
  }
  return data as EnhanceResponse;
}
