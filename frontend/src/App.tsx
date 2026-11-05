import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { enhance, type EnhanceResponse, type Style } from "./api";

const LIMIT = 2000;

export default function App() {
  const [prompt, setPrompt] = useState("");
  const [style, setStyle] = useState<Style>("detailed");
  const [changeMode, setChangeMode] = useState(false);
  const [previousPlan, setPreviousPlan] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<EnhanceResponse | null>(null);
  const [copied, setCopied] = useState(false);

  const canSubmit = !loading && prompt.trim().length > 0 && prompt.length <= LIMIT;

  async function run() {
    setLoading(true);
    setError(null);
    try {
      const plan = changeMode && previousPlan.trim() ? previousPlan : null;
      setResult(await enhance({ prompt, style, previousPlan: plan }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  async function copy() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.enhanced);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("Copy failed. Select the text and copy it manually.");
    }
  }

  function useAsPrevious() {
    if (!result) return;
    setChangeMode(true);
    setPreviousPlan(result.enhanced);
    setPrompt("");
  }

  return (
    <main className="page">
      <header>
        <h1>Prompt Enhancer</h1>
        <p>Turn a rough website idea into a plan an AI website builder can follow.</p>
      </header>

      <section className="panel">
        <label htmlFor="idea">{changeMode ? "Change request" : "Your idea"}</label>
        <textarea
          id="idea"
          rows={4}
          value={prompt}
          maxLength={LIMIT}
          placeholder={changeMode ? "e.g. add online food ordering" : "e.g. develop a cafe website"}
          onChange={(e) => setPrompt(e.target.value)}
        />
        <div className="row">
          <span className="muted">
            {prompt.length} / {LIMIT}
          </span>
          <div className="row gap">
            <label className="inline" htmlFor="style">
              Style
            </label>
            <select id="style" value={style} onChange={(e) => setStyle(e.target.value as Style)}>
              <option value="short">Short</option>
              <option value="detailed">Detailed</option>
              <option value="technical">Technical</option>
            </select>
            <button onClick={run} disabled={!canSubmit}>
              {loading ? "Enhancing…" : "Enhance"}
            </button>
          </div>
        </div>

        <details open={changeMode} onToggle={(e) => setChangeMode((e.target as HTMLDetailsElement).open)}>
          <summary>Update an existing plan</summary>
          <p className="muted">Paste the previous plan. Your text above is then treated as a change request.</p>
          <textarea
            rows={5}
            value={previousPlan}
            onChange={(e) => setPreviousPlan(e.target.value)}
            placeholder="Previous plan (markdown)"
            aria-label="Previous plan"
          />
        </details>

        {loading && (
          <p className="status" role="status">
            The agent is working. This can take up to a minute.
          </p>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </section>

      {result && (
        <>
          <section className="bar">
            <span>
              Score: <strong>{result.score.before}</strong> to <strong>{result.score.after}</strong> out of 10
            </span>
            {result.warning && <span className="warn">Warning: {result.warning}</span>}
          </section>

          <section className="split">
            <div className="panel">
              <h2>Original</h2>
              <p className="original">{result.original}</p>
            </div>
            <div className="panel">
              <div className="row">
                <h2>Enhanced</h2>
                <div className="row gap">
                  <button className="ghost" onClick={useAsPrevious}>
                    Use as previous plan
                  </button>
                  <button className="ghost" onClick={copy}>
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
              </div>
              <div className="md">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{result.enhanced}</ReactMarkdown>
              </div>
            </div>
          </section>

          <section className="split">
            <div className="panel">
              <h2>Questions</h2>
              {result.questions.length ? (
                <ul>
                  {result.questions.map((q, i) => (
                    <li key={i}>{q}</li>
                  ))}
                </ul>
              ) : (
                <p className="muted">No blocking questions.</p>
              )}
            </div>
            <div className="panel">
              <h2>Assumptions</h2>
              {result.assumptions.length ? (
                <ul>
                  {result.assumptions.map((a, i) => (
                    <li key={i}>{a}</li>
                  ))}
                </ul>
              ) : (
                <p className="muted">No assumptions listed.</p>
              )}
            </div>
          </section>

          <section className="panel">
            <details>
              <summary>Agent steps ({result.steps.length})</summary>
              {result.steps.map((s) => (
                <details key={s.step} className="step">
                  <summary>
                    {s.step}. {s.tool}
                  </summary>
                  <h3>Input</h3>
                  <pre>{JSON.stringify(s.input, null, 2)}</pre>
                  <h3>Output</h3>
                  <pre>{JSON.stringify(s.output, null, 2)}</pre>
                </details>
              ))}
            </details>
          </section>
        </>
      )}
    </main>
  );
}
