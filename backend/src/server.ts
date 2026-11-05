import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { enhanceRouter } from "./routes/enhance";
import { LLMError } from "./llm/client";
import { InputError } from "./agent/validate";

const app = express();
app.set("trust proxy", 1); // correct client IP behind Render / nginx
app.disable("x-powered-by");
app.use(helmet());

const origins = (process.env.CORS_ORIGIN || "http://localhost:3000,http://localhost:5173")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
app.use(cors({ origin: origins, methods: ["GET", "POST"] }));
app.use(express.json({ limit: "100kb" }));

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use(
  "/api/enhance",
  rateLimit({
    windowMs: 60_000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests. Please wait a minute." },
  }),
);
app.use("/api", enhanceRouter);

app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Not found." });
});

// Central error handler: always JSON, never leaks internals or secrets.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof InputError) return res.status(400).json({ error: err.message });
  if (err instanceof LLMError) {
    console.error(`[error] ${err.status} ${err.message}`);
    return res.status(err.status).json({ error: err.message });
  }
  const e = err as { type?: string };
  if (e?.type === "entity.parse.failed") return res.status(400).json({ error: "Request body is not valid JSON." });
  if (e?.type === "entity.too.large") return res.status(400).json({ error: "Request body is too large." });
  console.error("[error] unexpected:", err instanceof Error ? err.message : "unknown");
  return res.status(500).json({ error: "Internal server error." });
});

const port = Number(process.env.PORT) || 4000;
const server = app.listen(port, "0.0.0.0", () => console.log(`Backend listening on :${port}`));

const shutdown = () => server.close(() => process.exit(0));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
