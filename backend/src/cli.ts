import { enhance } from "./agent/agent";
import { InputError, validateInput } from "./agent/validate";
import { LLMError } from "./llm/client";

const USAGE = `Usage: node dist/cli.js "<idea>" [--style short|detailed|technical] [--verbose]`;

async function main() {
  const argv = process.argv.slice(2);
  let style: string | undefined;
  let verbose = false;
  const words: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--verbose") verbose = true;
    else if (argv[i] === "--style") style = argv[++i];
    else if (argv[i].startsWith("--style=")) style = argv[i].slice(8);
    else words.push(argv[i]);
  }

  const input = validateInput({ prompt: words.join(" "), style });
  const r = await enhance(input);

  console.log(r.enhanced);
  if (r.questions.length) console.log("\nQuestions:\n" + r.questions.map((q) => `- ${q}`).join("\n"));
  if (r.assumptions.length) console.log("\nAssumptions:\n" + r.assumptions.map((a) => `- ${a}`).join("\n"));
  console.log(`\nScore: ${r.score.before} -> ${r.score.after}`);
  if (r.warning) console.log(`Warning: ${r.warning}`);
  if (verbose) {
    console.log("\nAgent steps:");
    for (const s of r.steps) {
      console.log(`\n[${s.step}] ${s.tool}\n  input:  ${JSON.stringify(s.input)}\n  output: ${JSON.stringify(s.output)}`);
    }
  }
}

main().catch((e) => {
  if (e instanceof InputError) console.error(`Error: ${e.message}\n${USAGE}`);
  else if (e instanceof LLMError) console.error(`Error (${e.status}): ${e.message}`);
  else console.error("Error: unexpected failure.");
  process.exit(1);
});
