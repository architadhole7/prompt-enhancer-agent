export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}

export const STYLES = ["short", "detailed", "technical"] as const;
export type Style = (typeof STYLES)[number];

export const MAX_PROMPT = 2000;
export const MAX_PLAN = 20000;

export interface EnhanceInput {
  prompt: string;
  style: Style;
  previousPlan: string | null;
}

/** Shared by the API route and the CLI. Throws InputError (maps to HTTP 400). */
export function validateInput(body: unknown): EnhanceInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InputError("Request body must be a JSON object.");
  }
  const { prompt, style, previousPlan } = body as Record<string, unknown>;

  if (typeof prompt !== "string") throw new InputError("`prompt` must be a string.");
  const trimmed = prompt.trim();
  if (!trimmed) throw new InputError("`prompt` must not be empty.");
  if (trimmed.length > MAX_PROMPT) throw new InputError(`\`prompt\` must be at most ${MAX_PROMPT} characters.`);

  let s: Style = "detailed";
  if (style !== undefined && style !== null) {
    if (typeof style !== "string" || !(STYLES as readonly string[]).includes(style)) {
      throw new InputError("`style` must be one of: short, detailed, technical.");
    }
    s = style as Style;
  }

  let plan: string | null = null;
  if (previousPlan !== undefined && previousPlan !== null) {
    if (typeof previousPlan !== "string") throw new InputError("`previousPlan` must be a string or null.");
    if (previousPlan.length > MAX_PLAN) throw new InputError(`\`previousPlan\` must be at most ${MAX_PLAN} characters.`);
    plan = previousPlan.trim() || null;
  }
  return { prompt: trimmed, style: s, previousPlan: plan };
}
