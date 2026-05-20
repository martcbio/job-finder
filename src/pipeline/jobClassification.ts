import { quoteSqlLiteral } from "../db/config";

export type JobCategory =
  | "unclassified"
  | "agentic_engineer"
  | "agentic_architect"
  | "fde"
  | "inference_engineer"
  | "other";

export type FocusSignal = "yes" | "no" | "unknown";

export interface ClassifiableJobRow {
  id: string;
  title: string;
  company_hint: string | null;
  canonical_url: string;
  description_text: string;
}

export interface JobClassification {
  category: Exclude<JobCategory, "unclassified">;
  ragFocus: FocusSignal;
  enterpriseFocus: FocusSignal;
  confidence: number;
  reason: string;
}

export function buildClassifiableJobsSql(limit: number): string {
  return `SELECT COALESCE(json_agg(row_to_json(classifiable_row)), '[]'::json)
FROM (
  SELECT
    j.id::text AS id,
    j.title_normalized AS title,
    j.company_hint,
    j.canonical_url,
    CONCAT_WS(
      E'\\n',
      COALESCE(string_agg(DISTINCT sr.description_raw, E'\\n'), ''),
      COALESCE(string_agg(DISTINCT jp.markdown, E'\\n'), '')
    ) AS description_text
  FROM job_search.jobs j
  LEFT JOIN job_search.job_observations jo ON jo.job_id = j.id
  LEFT JOIN job_search.search_results sr ON sr.id = jo.search_result_id
  LEFT JOIN job_search.job_pages jp ON jp.job_id = j.id AND jp.status = 'success'
  WHERE j.category = 'unclassified'
  GROUP BY j.id
  ORDER BY j.last_seen_at DESC, j.id DESC
  LIMIT ${limit}
) classifiable_row;`;
}

export function buildUpdateJobClassificationSql(
  jobId: string,
  classification: JobClassification,
): string {
  return `UPDATE job_search.jobs
SET category = ${quoteSqlLiteral(classification.category)},
    rag_focus = ${quoteSqlLiteral(classification.ragFocus)},
    enterprise_focus = ${quoteSqlLiteral(classification.enterpriseFocus)},
    classification_confidence = ${classification.confidence.toFixed(4)},
    classification_reason = ${quoteSqlLiteral(classification.reason)},
    classified_at = now()
WHERE id = ${quoteSqlLiteral(jobId)};`;
}

export function classifyJobText(input: { title: string; description: string }): JobClassification {
  const haystack = `${input.title}\n${input.description}`.toLowerCase();
  const title = input.title.toLowerCase();
  const reasons: string[] = [];

  let category: JobClassification["category"] = "other";
  let confidence = 0.52;

  if (matches(haystack, ["forward deployed", "field engineer", "fde", "solutions engineer"])) {
    category = "fde";
    confidence = 0.76;
    reasons.push("matched FDE/customer-facing engineering language");
  } else if (
    matches(haystack, [
      "inference",
      "model serving",
      "serving stack",
      "vllm",
      "triton",
      "tensorrt",
      "cuda",
      "latency",
    ])
  ) {
    category = "inference_engineer";
    confidence = 0.78;
    reasons.push("matched inference/model-serving language");
  } else if (
    matches(title, ["architect"]) &&
    matches(haystack, ["agentic", " ai agent", " agents", "llm"])
  ) {
    category = "agentic_architect";
    confidence = 0.8;
    reasons.push("matched architect title plus agent/LLM language");
  } else if (
    matches(haystack, ["agentic", " ai agent", " agents", "llm application", "ai engineer"])
  ) {
    category = "agentic_engineer";
    confidence = 0.74;
    reasons.push("matched agent/LLM application engineering language");
  } else {
    reasons.push("no strong target-category signal found");
  }

  const ragFocus = classifyFocus(haystack, [
    " rag",
    "retrieval augmented",
    "retrieval-augmented",
    "retrieval",
    "vector database",
    "embeddings",
    "semantic search",
    "knowledge graph",
  ]);
  if (ragFocus === "yes") reasons.push("matched RAG/retrieval signal");

  const enterpriseFocus = classifyFocus(haystack, [
    "enterprise",
    "b2b",
    "customer workflow",
    "compliance",
    "security",
    "salesforce",
    "servicenow",
    "internal tools",
  ]);
  if (enterpriseFocus === "yes") reasons.push("matched enterprise/productization signal");

  return {
    category,
    ragFocus,
    enterpriseFocus,
    confidence,
    reason: reasons.join("; "),
  };
}

function classifyFocus(haystack: string, needles: string[]): FocusSignal {
  if (matches(haystack, needles)) return "yes";
  if (haystack.trim().length > 80) return "no";
  return "unknown";
}

function matches(haystack: string, needles: string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}
