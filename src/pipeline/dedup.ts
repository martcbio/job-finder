import type OpenAI from "openai";
import { logger } from "../logger";
import { getClient } from "../services/llm";
import type { TokenTracker } from "../services/tokenTracker";

export interface DedupResult {
  isDuplicate: boolean;
  matchedTitle?: string;
}

export interface CrossSourceIdentityInput {
  company: string | null;
  title: string;
  location: string | null;
}

export interface CrossSourceIdentity {
  company: string;
  title: string;
  city: string;
}

const log = logger.child({ component: "dedup" });

export function normalizeCrossSourceIdentity(
  input: CrossSourceIdentityInput,
): CrossSourceIdentity | null {
  const company = normalizeIdentityText(input.company ?? "").replace(
    /\b(?:incorporated|inc|limited|ltd|llc|plc|corporation|corp)\b/g,
    "",
  );
  const title = normalizeIdentityText(input.title);
  const city = normalizeLocationCity(input.location);
  const normalizedCompany = company.replace(/\s+/g, " ").trim();
  if (!normalizedCompany || !title || !city) return null;
  return { company: normalizedCompany, title, city };
}

function normalizeIdentityText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9+#]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeLocationCity(value: string | null): string | null {
  if (!value) return null;
  const firstPart = value.split(/[,;|/]/, 1)[0] ?? "";
  const city = normalizeIdentityText(
    firstPart.replace(/\([^)]*\)/g, " ").replace(/\b(?:hybrid|on[ -]?site)\b/gi, " "),
  ).replace(/^greater\s+/, "");
  if (!city || /^(?:remote|uk|united kingdom|england|europe|emea)$/.test(city)) return null;
  return city;
}

const DEDUP_TOOL: OpenAI.ChatCompletionTool = {
  type: "function",
  function: {
    name: "check_duplicate",
    description:
      "Decide whether the new job title refers to the same role as any existing title at the same company",
    parameters: {
      type: "object" as const,
      properties: {
        isDuplicate: {
          type: "boolean",
          description: "True if the new title is the same role as an existing title",
        },
        matchedTitle: {
          type: "string",
          description: "The existing title that matches, or null if no match",
        },
      },
      required: ["isDuplicate"],
    },
  },
};

export async function checkFuzzyDuplicate(
  newTitle: string,
  existingTitles: string[],
  apiKey: string,
  tracker?: TokenTracker,
  model?: string,
): Promise<DedupResult> {
  if (existingTitles.length === 0) {
    return { isDuplicate: false };
  }

  // Short-circuit: exact case-insensitive match
  const normalizedNew = newTitle.toLowerCase().trim();
  for (const existing of existingTitles) {
    if (existing.toLowerCase().trim() === normalizedNew) {
      return { isDuplicate: true, matchedTitle: existing };
    }
  }

  const client = getClient(apiKey);
  const modelName = model ?? "google/gemini-2.5-flash";

  const numbered = existingTitles.map((t, i) => `${i + 1}. ${t}`).join("\n");

  const response = await client.chat.completions.create({
    model: modelName,
    max_tokens: 128,
    messages: [
      {
        role: "system",
        content: `You compare job titles at the same company to detect duplicates. Two titles are duplicates if they refer to the same role despite minor wording differences: abbreviations (Sr. = Senior, Eng = Engineer), reordering (Backend Engineer = Engineer, Backend), or trivial additions (e.g. adding a team name). They are NOT duplicates if the seniority level, domain, or function differs (e.g. "Senior Backend Engineer" vs "Staff Frontend Engineer").`,
      },
      {
        role: "user",
        content: `New title: "${newTitle}"\n\nExisting titles at the same company:\n${numbered}\n\nIs the new title a duplicate of any existing title?`,
      },
    ],
    tools: [DEDUP_TOOL],
    tool_choice: { type: "function", function: { name: "check_duplicate" } },
  });

  if (response.usage) {
    tracker?.add(response.model ?? modelName, "dedup", {
      input_tokens: response.usage.prompt_tokens,
      output_tokens: response.usage.completion_tokens,
    });
  } else {
    log.warn({ model: modelName }, "No usage data in response");
  }

  // Intentionally lenient: on missing/malformed tool calls we default to
  // "not a duplicate" so borderline jobs still reach the user for review.
  const toolCall = response.choices[0]?.message?.tool_calls?.[0];
  if (!toolCall || toolCall.type !== "function") {
    return { isDuplicate: false };
  }

  try {
    const input = JSON.parse(toolCall.function.arguments) as {
      isDuplicate: boolean;
      matchedTitle?: string;
    };
    return {
      isDuplicate: input.isDuplicate,
      matchedTitle: input.matchedTitle ?? undefined,
    };
  } catch {
    log.warn({ arguments: toolCall.function.arguments }, "Failed to parse dedup tool arguments");
    return { isDuplicate: false };
  }
}
