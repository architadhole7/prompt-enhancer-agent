import { chat, LLMError, getMaxTokens, type ChatMessage } from "../llm/client";
import { SYSTEM_PROMPT, IMPROVEMENT_SYSTEM_PROMPT } from "./prompt";
import { TOOL_DEFS, runTool, scorePrompt } from "./tools";
import type { EnhanceInput } from "./validate";

export const MAX_STEPS = 5;

const AGENT_DEADLINE_MS = 150_000;

export interface Step {
  step: number;
  tool: string;
  input: unknown;
  output: unknown;
}

export interface EnhanceResult {
  original: string;
  enhanced: string;
  questions: string[];
  assumptions: string[];
  score: {
    before: number;
    after: number;
  };
  steps: Step[];
  warning: string | null;
}

const errMsg = (e: unknown) =>
  e instanceof Error ? e.message : String(e);

// ---------- user message ----------

function buildUserMessage({
  prompt,
  style,
  previousPlan,
}: EnhanceInput): string {
  if (previousPlan) {
    return `Style: ${style}
MODE: CHANGE REQUEST. Update the existing plan below. Preserve everything the change does not touch.

Change request:
${prompt}

Existing plan:
${previousPlan}`;
  }

  return `Style: ${style}
MODE: NEW PLAN.

User prompt:
${prompt}`;
}

// ---------- draft extraction ----------

function extractDraft(text: string): string | null {
  const content = text.trim();

  const hasFirstSection =
    /##\s*1[.)]?\s+Intent/i.test(content);

  const hasLastSection =
    /##\s*12[.)]?\s+Validation/i.test(content);

  if (!hasFirstSection || !hasLastSection) {
    return null;
  }

  const questionsIndex = content.indexOf("=====QUESTIONS=====");
  const assumptionsIndex = content.indexOf("=====ASSUMPTIONS=====");

  const cuts = [questionsIndex, assumptionsIndex].filter(
    (index) => index >= 0
  );

  return (
    cuts.length > 0
      ? content.slice(0, Math.min(...cuts))
      : content
  ).trim();
}

// ---------- final answer parsing ----------

function parseList(block: string): string[] {
  return block
    .split("\n")
    .map((line) =>
      line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim()
    )
    .filter(
      (line) => line && !/^none\.?$/i.test(line)
    );
}

function parseFinal(text: string) {
  const qi = text.indexOf("=====QUESTIONS=====");
  const ai = text.indexOf("=====ASSUMPTIONS=====");

  const cuts = [qi, ai].filter(
    (index) => index >= 0
  );

  const enhanced = (
    cuts.length > 0
      ? text.slice(0, Math.min(...cuts))
      : text
  ).trim();

  const questions =
    qi >= 0
      ? text.slice(qi + "=====QUESTIONS=====".length, ai > qi ? ai : undefined)
      : "";

  const assumptions =
    ai >= 0
      ? text.slice(
        ai + "=====ASSUMPTIONS=====".length,
        qi > ai ? qi : undefined
      )
      : "";

  return {
    enhanced,
    questions: parseList(questions),
    assumptions: parseList(assumptions),
  };
}

// ---------- agent ----------

export async function enhance(
  input: EnhanceInput
): Promise<EnhanceResult> {
  const started = Date.now();
  const maxTokens = getMaxTokens(input.style);

  const before = scorePrompt(input.prompt).score;
  const originalUserMessage = buildUserMessage(input);

  const messages: ChatMessage[] = [
    {
      role: "system",
      content: SYSTEM_PROMPT,
    },
    {
      role: "user",
      content: originalUserMessage,
    },
  ];

  const steps: Step[] = [];

  let draft: string | null = null;
  let draftResponse: string | null = null;
  let warning: string | null = null;
  let generationRetries = 0;

  // ---------- native tool-calling loop ----------
  // Only analyze_prompt and get_template are exposed to the LLM.

  while (true) {
    if (Date.now() - started > AGENT_DEADLINE_MS) {
      throw new LLMError(504, "The agent took too long.");
    }

    if (steps.length >= MAX_STEPS) {
      warning = "Tool step limit reached.";

      if (!draft) {
        throw new LLMError(
          502,
          "The agent reached its tool limit before generating a complete plan."
        );
      }

      break;
    }

    const msg = await chat(messages, TOOL_DEFS, maxTokens);

    messages.push(msg);

    // Capture a complete plan from a normal assistant response.
    if (msg.content?.trim()) {
      const candidate = extractDraft(msg.content);

      if (candidate) {
        draft = candidate;
        draftResponse = msg.content;
      }
    }

    const calls = msg.tool_calls ?? [];

    // No more tool calls: the model should have generated its plan.
    if (calls.length === 0) {
      if (draft) {
        break;
      }

      // Allow one corrective generation if the model failed to
      // produce the required 12-section plan.
      if (generationRetries < 1) {
        generationRetries++;

        messages.push({
          role: "user",
          content:
            "Your previous response did not contain a complete plan. Generate the full plan now using all 12 required numbered sections, followed by the exact QUESTIONS and ASSUMPTIONS markers. Do not call any tools in this response.",
        });

        continue;
      }

      throw new LLMError(
        502,
        "AI provider did not return a complete 12-section plan."
      );
    }

    // Execute native tool calls and return their results to the model.
    for (const call of calls) {
      if (steps.length >= MAX_STEPS) {
        warning = "Tool step limit reached.";
        break;
      }

      const name = call.function.name;

      let args: unknown = {};
      let output: unknown;

      try {
        try {
          args = call.function.arguments
            ? JSON.parse(call.function.arguments)
            : {};
        } catch {
          throw new Error(
            "Tool arguments were not valid JSON."
          );
        }

        output = runTool(name, args);
      } catch (error) {
        console.error(
          `[agent] tool "${name}" failed: ${errMsg(error)}`
        );

        output = {
          error: errMsg(error),
        };
      }

      steps.push({
        step: steps.length + 1,
        tool: name,
        input: args,
        output,
      });

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(output),
      });
    }

    if (steps.length >= MAX_STEPS) {
      if (!draft) {
        throw new LLMError(
          502,
          "The agent reached its tool limit before generating a complete plan."
        );
      }

      break;
    }
  }

  if (!draft || !draftResponse) {
    throw new LLMError(
      502,
      "AI provider did not return a complete plan."
    );
  }

  // ---------- local scoring ----------
  // No LLM tool call is used for scoring.

  let currentScore = scorePrompt(draft);
  let finalResponse = draftResponse;

  // ---------- one optional improvement pass ----------

  if (currentScore.score < 7) {
    if (Date.now() - started > AGENT_DEADLINE_MS) {
      warning =
        "Improvement was skipped because the agent deadline was reached.";
    } else {
      try {
        const improvementMessage = `Original user requirements:
${input.prompt}

Current plan:
${draft}

Scoring issues to fix:
${currentScore.issues.length > 0
            ? currentScore.issues.map((issue) => `- ${issue}`).join("\n")
            : "- Improve clarity and implementation readiness."}

Instructions:
- Return the complete 12-section plan (sections ## 1. Intent through ## 12. Validation).
- Preserve all confirmed requirements.
- Add no unsupported features or invented business logic.
- Fix the scoring issues listed above.
- Follow the requested style: ${input.style}.
- Return the complete revised plan followed by exact QUESTIONS and ASSUMPTIONS markers.`;

        // Fresh minimal message list: short system prompt + original user requirements + current plan + scorePrompt issues.
        // No tool definitions, no prior history. Send previousPlan only once (not duplicated here).
        const improvedMessage = await chat(
          [
            {
              role: "system",
              content: IMPROVEMENT_SYSTEM_PROMPT,
            },
            {
              role: "user",
              content: improvementMessage,
            },
          ],
          undefined,
          maxTokens
        );

        const improvedResponse =
          improvedMessage.content?.trim() ?? "";

        const improvedDraft = extractDraft(improvedResponse);

        if (improvedDraft) {
          draft = improvedDraft;
          draftResponse = improvedResponse;
          finalResponse = improvedResponse;
          currentScore = scorePrompt(improvedDraft);
        } else {
          warning = "improvement pass failed: incomplete plan returned";
        }
      } catch (error) {
        // Return first plan with warning "improvement pass failed: <reason>", never discard it.
        console.error(
          `[agent] improvement pass failed: ${errMsg(error)}`
        );

        warning = `improvement pass failed: ${errMsg(error)}`;
      }
    }
  }

  // ---------- final result ----------

  const parsed = parseFinal(finalResponse);

  let enhanced = parsed.enhanced;

  if (!enhanced && draft) {
    enhanced = draft;

    warning =
      warning ??
      "Showing the last available draft because final formatting was incomplete.";
  }

  if (!enhanced) {
    throw new LLMError(
      502,
      "AI provider returned an empty plan."
    );
  }

  if (currentScore.score < 7 && !warning) {
    warning =
      "The final plan is available, but its local quality score is below 7.";
  }

  return {
    original: input.prompt,
    enhanced,
    questions: parsed.questions,
    assumptions: parsed.assumptions,
    score: {
      before,
      after: scorePrompt(enhanced).score,
    },
    steps,
    warning,
  };
}
