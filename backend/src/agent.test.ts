import test from "node:test";
import assert from "node:assert/strict";
import { chat, LLMError } from "./llm/client";
import { enhance } from "./agent/agent";
import { scorePrompt } from "./agent/tools";
import { validateInput, InputError } from "./agent/validate";

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("429 with Retry-After waits and retries successfully", async () => {
  process.env.LLM_API_KEY = "dummy-test-key";
  let callCount = 0;

  globalThis.fetch = (async () => {
    callCount++;
    if (callCount === 1) {
      return new Response(JSON.stringify({ error: { message: "rate limit" } }), {
        status: 429,
        headers: { "retry-after": "0", "Content-Type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: "Success response" } }],
        usage: { prompt_tokens: 15, completion_tokens: 25, total_tokens: 40 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }) as unknown as typeof fetch;

  const result = await chat([{ role: "user", content: "hello" }]);
  assert.equal(callCount, 2);
  assert.equal(result.content, "Success response");
});

test("429 with wait > 35s throws LLMError without infinite retries", async () => {
  process.env.LLM_API_KEY = "dummy-test-key";
  let callCount = 0;

  globalThis.fetch = (async () => {
    callCount++;
    return new Response(
      JSON.stringify({ error: { message: "Rate limit exceeded. Please try again in 45s." } }),
      {
        status: 429,
        headers: { "retry-after": "45", "Content-Type": "application/json" },
      }
    );
  }) as unknown as typeof fetch;

  await assert.rejects(
    async () => {
      await chat([{ role: "user", content: "hello" }]);
    },
    (err: unknown) => {
      assert(err instanceof LLMError);
      assert.equal(err.status, 429);
      assert.match(err.message, /Rate limit reached, retry in ~45s/);
      return true;
    }
  );
  assert.equal(callCount, 1);
});

test("missing API key throws LLMError(500)", async () => {
  const oldKey = process.env.LLM_API_KEY;
  delete process.env.LLM_API_KEY;

  try {
    await assert.rejects(
      async () => {
        await chat([{ role: "user", content: "hello" }]);
      },
      (err: unknown) => {
        assert(err instanceof LLMError);
        assert.equal(err.status, 500);
        assert.match(err.message, /AI API key is missing/);
        return true;
      }
    );
  } finally {
    process.env.LLM_API_KEY = oldKey;
  }
});

test("invalid input validation throws InputError for empty, too long, and bad style", () => {
  // Empty prompt
  assert.throws(
    () => validateInput({ prompt: "" }),
    (err: unknown) => err instanceof InputError && /must not be empty/i.test(err.message)
  );

  // Whitespace-only prompt
  assert.throws(
    () => validateInput({ prompt: "   " }),
    (err: unknown) => err instanceof InputError && /must not be empty/i.test(err.message)
  );

  // Too long prompt (>2000 chars)
  assert.throws(
    () => validateInput({ prompt: "x".repeat(2001) }),
    (err: unknown) => err instanceof InputError && /at most 2000/i.test(err.message)
  );

  // Bad style
  assert.throws(
    () => validateInput({ prompt: "Valid prompt", style: "super-detailed" }),
    (err: unknown) => err instanceof InputError && /style.*must be one of/i.test(err.message)
  );
});

test("improvement failure keeps first plan and records warning", async () => {
  process.env.LLM_API_KEY = "dummy-test-key";

  // Low score plan (score < 7 because it lacks tags, MVP scope separation, deps)
  const lowScorePlan = `## 1. Intent
Cafe website
## 2. Requirements
Menu display
## 3. Ambiguities and questions
None
## 4. Scope
Full build
## 5. Users and journeys
Guests
## 6. Architecture
Standard
## 7. Technology
Web
## 8. Database plan
Items
## 9. UI/UX plan
Pages
## 10. Task breakdown
T1: Build
## 11. Risks
None
## 12. Validation
Check works
=====QUESTIONS=====
- none
=====ASSUMPTIONS=====
- none`;

  let callCount = 0;
  globalThis.fetch = (async () => {
    callCount++;
    if (callCount === 1) {
      // Step 1: LLM returns plan directly (extractDraft finds it)
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: lowScorePlan } }],
          usage: { prompt_tokens: 100, completion_tokens: 150 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    // Step 2: Improvement pass fails with 429 (wait 60s)
    return new Response(
      JSON.stringify({ error: { message: "Rate limit exceeded. Please try again in 60s." } }),
      {
        status: 429,
        headers: { "retry-after": "60", "Content-Type": "application/json" },
      }
    );
  }) as unknown as typeof fetch;

  const result = await enhance({
    prompt: "Build a cafe website",
    style: "short",
    previousPlan: null,
  });

  assert.equal(callCount, 2);
  assert(result.enhanced.includes("## 1. Intent"));
  assert(result.enhanced.includes("## 12. Validation"));
  assert(result.warning !== null);
  assert.match(result.warning, /improvement pass failed: Rate limit reached, retry in ~60s/);
});

test("all 12 headings parsed and detected by scorePrompt", () => {
  const full12Plan = `
## 1. Intent
Build an online cafe ordering platform.
## 2. Requirements
- Menu catalog [Confirmed]
- Order notification [Assumed]
## 3. Ambiguities and questions
- None
## 4. Scope
- MVP: Browse menu and checkout
- Optional features: Loyalty points
- Future enhancements: Mobile app
## 5. Users and journeys
Customer and Admin journeys.
## 6. Architecture
Client-server with REST API.
## 7. Technology
React frontend, Node Express backend, PostgreSQL.
## 8. Database plan
User, Menu, Order tables with foreign key constraints.
## 9. UI/UX plan
Responsive design, loading spinners, empty cart states.
## 10. Task breakdown
- T1: Setup schema
  Expected output: Migrations created
  Depends on: none
- T2: Build API
  Expected output: Endpoints ready
  Depends on: T1
- T3: Build UI
  Expected output: Pages integrated
  Depends on: T2
## 11. Risks
Payment processing downtime.
## 12. Validation
Acceptance criteria: 100% order flow test passes.
Testing requirements: End-to-end and unit testing.

=====QUESTIONS=====
- none
=====ASSUMPTIONS=====
- none
`;

  const scored = scorePrompt(full12Plan);
  assert.equal(scored.breakdown.sections_present, 12);
  assert.equal(scored.score, 10);
  assert.deepEqual(scored.issues, []);
});

