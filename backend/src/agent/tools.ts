import type { ToolDef } from "../llm/client";

export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

export type ProjectType =
  | "cafe_restaurant"
  | "railway_ticket_booking"
  | "ecommerce"
  | "portfolio"
  | "other";

// ---------- tool definitions sent to the model ----------

export const TOOL_DEFS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "analyze_prompt",
      description: "Analyze prompt for project type, mode, and missing details.",
      parameters: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
          },
        },
        required: ["prompt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_template",
      description: "Get template entities and implicit requirements for project type.",
      parameters: {
        type: "object",
        properties: {
          project_type: {
            type: "string",
            enum: [
              "cafe_restaurant",
              "railway_ticket_booking",
              "ecommerce",
              "portfolio",
              "other",
            ],
          },
        },
        required: ["project_type"],
      },
    },
  },
];

// ---------- analyze_prompt ----------

const TYPE_RULES: [ProjectType, RegExp][] = [
  [
    "cafe_restaurant",
    /\b(cafe|café|coffee|restaurant|bakery|diner|bistro|menu|food)\b/i,
  ],
  [
    "railway_ticket_booking",
    /\b(railway|train|irctc|ticket|booking|reservation|flight|bus|seat)s?\b/i,
  ],
  [
    "ecommerce",
    /\b(e-?commerce|shop|store|cart|marketplace|checkout|sell|selling)\b/i,
  ],
  [
    "portfolio",
    /\b(portfolio|resume|cv|personal (site|website)|freelancer)\b/i,
  ],
];

const CHECKS: Record<string, RegExp> = {
  purpose:
    /\b(for|to|so that|allow|sell|book|showcase|manage|track|order|promote)\b/i,
  target_users:
    /\b(customers?|users?|students?|admins?|visitors?|clients?|patients?|staff|owners?|travell?ers?|passengers?|employers?)\b/i,
  pages_or_features:
    /\b(pages?|menu|cart|search|dashboard|gallery|contact|checkout|features?|blog|reservations?)\b/i,
  design_style:
    /\b(minimal|modern|dark|light|colou?rs?|theme|style|design|responsive|clean|elegant)\b/i,
  tech_stack:
    /\b(react|next\.?js|vue|angular|node|express|django|flask|php|laravel|wordpress|mongodb|postgres|mysql|tailwind|stack)\b/i,
  constraints:
    /\b(budget|deadline|within|must|only|limit|weeks?|days?|free|no more than)\b/i,
  login_needs:
    /\b(login|log in|sign ?in|sign ?up|register|auth|accounts?|admin)\b/i,
  payment_needs:
    /\b(payments?|pay|stripe|razorpay|paypal|upi|checkout|card)\b/i,
};

function analyzePrompt(args: unknown) {
  const prompt = (args as { prompt?: unknown })?.prompt;

  if (typeof prompt !== "string" || !prompt.trim()) {
    throw new ToolError("`prompt` must be a non-empty string.");
  }

  const project_type: ProjectType =
    TYPE_RULES.find(([, re]) => re.test(prompt))?.[0] ?? "other";

  const mode =
    /\b(add|update|change|modify|remove|redesign|existing|fix|improve|replace|integrate|extend)\b/i.test(
      prompt
    )
      ? "change_to_existing_project"
      : "new_build";

  const missing: string[] = [];

  for (const [key, re] of Object.entries(CHECKS)) {
    if (!re.test(prompt)) {
      missing.push(key);
    }
  }

  return {
    project_type,
    mode,
    missing,
  };
}

// ---------- get_template ----------

const TYPE_DATA: Record<
  ProjectType,
  { entities: string[]; implicit: string[] }
> = {
  cafe_restaurant: {
    entities: [
      "User",
      "MenuCategory",
      "MenuItem",
      "Order",
      "OrderItem",
      "Reservation",
      "Offer",
    ],
    implicit: [
      "Menu with categories and prices",
      "Opening hours and location",
      "Contact and map",
      "Mobile-first layout",
      "Admin menu management",
      "Order or reservation confirmation",
    ],
  },

  railway_ticket_booking: {
    entities: [
      "User",
      "Station",
      "Train",
      "Route",
      "Schedule",
      "Seat",
      "Booking",
      "Passenger",
      "Payment",
    ],
    implicit: [
      "Seat availability and double-booking prevention",
      "Booking cancellation and refund rules",
      "PNR/ticket reference",
      "Payment confirmation and failure handling",
      "Concurrency control on seat selection",
      "Admin schedule management",
    ],
  },

  ecommerce: {
    entities: [
      "User",
      "Category",
      "Product",
      "Cart",
      "CartItem",
      "Order",
      "OrderItem",
      "Payment",
      "Address",
    ],
    implicit: [
      "Search and filters",
      "Inventory tracking",
      "Cart persistence",
      "Order tracking",
      "Admin product and order management",
      "Secure checkout",
    ],
  },

  portfolio: {
    entities: [
      "Project",
      "Skill",
      "Experience",
      "ContactMessage",
    ],
    implicit: [
      "Fast loading and SEO basics",
      "Responsive layout",
      "Contact form with spam protection",
      "Downloadable resume",
      "Accessible navigation",
    ],
  },

  other: {
    entities: ["User", "(derive from the idea)"],
    implicit: [
      "Responsive layout",
      "Input validation",
      "Error and empty states",
      "Basic security (authN/authZ where users exist)",
    ],
  },
};

const PROJECT_TYPES = Object.keys(TYPE_DATA) as ProjectType[];

function getTemplate(args: unknown) {
  const pt = (args as { project_type?: unknown })?.project_type;

  if (
    typeof pt !== "string" ||
    !PROJECT_TYPES.includes(pt as ProjectType)
  ) {
    throw new ToolError(
      `\`project_type\` must be one of: ${PROJECT_TYPES.join(", ")}.`
    );
  }

  const d = TYPE_DATA[pt as ProjectType];

  return {
    typical_entities: d.entities,
    implicit_requirements: d.implicit,
  };
}

// ---------- local deterministic scoring ----------
// This function is called by the backend, NOT by the LLM.

export function scorePrompt(plan: string) {
  const issues: string[] = [];
  const found = new Set<number>();

  for (const m of plan.matchAll(/^#{1,4}\s*(\d{1,2})[.)]?\s/gm)) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 12) found.add(n);
  }

  const sections = (found.size / 12) * 2;

  if (found.size < 12) {
    issues.push(
      `Only ${found.size}/12 numbered sections found (use headings like "## 1. Intent").`
    );
  }

  const hasC = /\bConfirmed\b/.test(plan);
  const hasA = /\bAssumed\b/.test(plan);
  const tagging = (hasC ? 1 : 0) + (hasA ? 1 : 0);

  if (tagging < 2) {
    issues.push("Tag requirements as [Confirmed] or [Assumed].");
  }

  const hasMvp = /\bMVP\b/.test(plan);
  const scope = hasMvp
    ? 1 + (/optional/i.test(plan) && /future/i.test(plan) ? 1 : 0)
    : 0;

  if (scope < 2) {
    issues.push(
      "Separate MVP, Optional features and Future enhancements."
    );
  }

  const deps = (plan.match(/depends on/gi) ?? []).length;
  const tasks = deps >= 3 ? 2 : deps >= 1 ? 1 : 0;

  if (tasks < 2) {
    issues.push('Every task needs a "Depends on: ..." line.');
  }

  const acceptance =
    (/acceptance criteria/i.test(plan) ? 1 : 0) +
    (/\btest(s|ing)?\b/i.test(plan) ? 1 : 0);

  if (acceptance < 2) {
    issues.push("Add acceptance criteria and testing requirements.");
  }

  const score = Math.max(
    0,
    Math.min(
      10,
      Math.round(sections + tagging + scope + tasks + acceptance)
    )
  );

  return {
    score,
    breakdown: {
      sections_present: found.size,
      tagging,
      scope_separation: scope,
      task_dependencies: tasks,
      acceptance_and_tests: acceptance,
    },
    issues,
  };
}

// ---------- tool dispatcher ----------

type ToolImplementation = (args: unknown) => unknown;

const IMPLS: Record<string, ToolImplementation> = {
  analyze_prompt: analyzePrompt,
  get_template: getTemplate,
};

export function runTool(name: string, args: unknown): unknown {
  const impl = Object.prototype.hasOwnProperty.call(IMPLS, name)
    ? IMPLS[name]
    : undefined;

  if (!impl) {
    throw new ToolError(
      `Unknown tool "${name}". Available tools: ${Object.keys(IMPLS).join(", ")}.`
    );
  }

  if (
    typeof args !== "object" ||
    args === null ||
    Array.isArray(args)
  ) {
    throw new ToolError("Tool arguments must be a JSON object.");
  }

  return impl(args);
}
