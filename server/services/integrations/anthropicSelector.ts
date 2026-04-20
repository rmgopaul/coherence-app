/**
 * Anthropic-powered King of the Day selector — Phase C.3.
 *
 * Gated behind the `SMART_KING_AI_ENABLED` env flag AND requires the
 * user to have an Anthropic integration row with a valid API key.
 * When both are present, the rules-based selector's top candidates
 * are sent to Claude Haiku to pick a headline + reason that reads
 * more editorially than the templated strings in the rules path.
 *
 * If anything goes wrong (no key, flag off, rate limit, malformed
 * JSON response), we return null and the caller falls through to
 * the rules-based pick. The feature is strictly an enhancement —
 * never a required dependency.
 *
 * Uses native fetch; no SDK dependency added.
 *
 * See: productivity-hub/handoff/king-of-the-day.md §"AI layer"
 */
import { parseJsonMetadata } from "../../routers/helpers";

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_API_VERSION = "2023-06-01";
// Haiku 4.5 is the latest Haiku model per the repo's README / docs.
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

export interface AiCandidate {
  title: string;
  reason: string;
  taskId: string | null;
  eventId: string | null;
  score: number;
}

export interface AiSelectorResult {
  title: string;
  reason: string;
  taskId: string | null;
  eventId: string | null;
}

export interface AiSelectorContext {
  /** Optional display name so the model can personalise the tone. */
  userName?: string | null;
  dateKey: string;
  anthropicApiKey: string;
  anthropicModel?: string;
  candidates: AiCandidate[];
}

/* ------------------------------------------------------------------ */
/*  Feature-flag / integration helpers                                 */
/* ------------------------------------------------------------------ */

export function isAiSelectorEnabled(): boolean {
  const raw = process.env.SMART_KING_AI_ENABLED;
  if (!raw) return false;
  const trimmed = raw.trim().toLowerCase();
  return trimmed === "1" || trimmed === "true" || trimmed === "yes";
}

export interface AnthropicIntegration {
  accessToken: string | null;
  model: string | null;
}

export function extractAnthropicAuth(row: {
  accessToken?: string | null;
  metadata?: string | null;
}): AnthropicIntegration {
  const meta = parseJsonMetadata(row?.metadata ?? null);
  return {
    accessToken: row?.accessToken ?? null,
    model:
      typeof meta.model === "string" && meta.model.length > 0
        ? meta.model
        : null,
  };
}

/* ------------------------------------------------------------------ */
/*  Prompt construction                                                */
/* ------------------------------------------------------------------ */

function buildPrompt(ctx: AiSelectorContext): {
  system: string;
  user: string;
} {
  const name = (ctx.userName ?? "").trim();
  const subject = name.length > 0 ? name : "the user";

  const candidateLines = ctx.candidates
    .slice(0, 8)
    .map((c, i) => {
      const refBits: string[] = [];
      if (c.taskId) refBits.push(`taskId:${c.taskId}`);
      if (c.eventId) refBits.push(`eventId:${c.eventId}`);
      const refSuffix = refBits.length > 0 ? ` (${refBits.join(", ")})` : "";
      return `${i + 1}. [score ${c.score}] ${c.title} — ${c.reason}${refSuffix}`;
    })
    .join("\n");

  const system = [
    `You are ${subject}'s editor. Pick the ONE thing ${subject} should ship today.`,
    `Output strict JSON only — no markdown, no prose before or after.`,
    `Schema: { "title": string, "reason": string, "taskId"?: string, "eventId"?: string }`,
    `Rules:`,
    `- title MUST be <= 50 characters, a concrete action verb phrase.`,
    `- reason MUST be <= 120 characters, one sentence explaining urgency.`,
    `- Prefer overdue tasks when they exist.`,
    `- If taskId or eventId identifies the pick, include it verbatim.`,
    `- Never invent work — your pick must come from the candidate list.`,
  ].join("\n");

  const user = [
    `Today: ${ctx.dateKey}`,
    `Candidates (scored by a rules selector — higher score = more urgent):`,
    candidateLines || "(none)",
    ``,
    `Return JSON.`,
  ].join("\n");

  return { system, user };
}

/* ------------------------------------------------------------------ */
/*  HTTP + parsing                                                     */
/* ------------------------------------------------------------------ */

interface AnthropicMessagesResponse {
  content?: Array<{ type: string; text?: string }>;
}

function extractJsonPayload(text: string): string | null {
  // Models sometimes wrap JSON in ```json fences. Peel them off.
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fenced) return fenced[1].trim();
  // Otherwise, find the first balanced JSON object.
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return null;
}

export async function aiSelectKingOfDay(
  ctx: AiSelectorContext
): Promise<AiSelectorResult | null> {
  if (ctx.candidates.length === 0) return null;
  if (!ctx.anthropicApiKey) return null;

  const model = ctx.anthropicModel ?? DEFAULT_MODEL;
  const { system, user } = buildPrompt(ctx);

  let response: Response;
  try {
    response = await fetch(ANTHROPIC_MESSAGES_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ctx.anthropicApiKey,
        "anthropic-version": ANTHROPIC_API_VERSION,
      },
      body: JSON.stringify({
        model,
        max_tokens: 256,
        system,
        messages: [{ role: "user", content: user }],
      }),
      // Anthropic's API should answer within a second or two; cap at
      // 10s so a hanging call doesn't block the .get() request.
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    console.warn("[kingOfDay.ai] fetch failed:", err);
    return null;
  }

  if (!response.ok) {
    console.warn(
      `[kingOfDay.ai] Anthropic API ${response.status} ${response.statusText}`
    );
    return null;
  }

  let body: AnthropicMessagesResponse;
  try {
    body = (await response.json()) as AnthropicMessagesResponse;
  } catch (err) {
    console.warn("[kingOfDay.ai] response parse failed:", err);
    return null;
  }

  const text =
    body.content?.find((block) => block.type === "text")?.text?.trim() ?? "";
  if (!text) return null;

  const payload = extractJsonPayload(text);
  if (!payload) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (err) {
    console.warn("[kingOfDay.ai] JSON parse failed:", err);
    return null;
  }

  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;

  const title = typeof obj.title === "string" ? obj.title.trim() : "";
  const reason = typeof obj.reason === "string" ? obj.reason.trim() : "";
  if (!title) return null;

  // Validate that the task/event id (if present) matches one of the
  // candidates we sent — the model shouldn't invent IDs.
  const candidateTaskIds = new Set(
    ctx.candidates.map((c) => c.taskId).filter((id): id is string => !!id)
  );
  const candidateEventIds = new Set(
    ctx.candidates.map((c) => c.eventId).filter((id): id is string => !!id)
  );

  const rawTaskId = typeof obj.taskId === "string" ? obj.taskId.trim() : "";
  const rawEventId = typeof obj.eventId === "string" ? obj.eventId.trim() : "";
  const taskId =
    rawTaskId && candidateTaskIds.has(rawTaskId) ? rawTaskId : null;
  const eventId =
    rawEventId && candidateEventIds.has(rawEventId) ? rawEventId : null;

  return {
    title: title.slice(0, 200),
    reason: reason.slice(0, 500) || "picked by AI editor",
    taskId,
    eventId,
  };
}

// Exported for tests.
export const __test__ = { buildPrompt, extractJsonPayload };
