import { quoteSqlLiteral } from "../db/config";

export type JobCategory =
  | "unclassified"
  | "agentic_engineer"
  | "agentic_architect"
  | "fde"
  | "inference_engineer"
  | "other";

export type FocusSignal = "yes" | "no" | "unknown";
export type ClassificationStage = "metadata" | "page";
export type JobClassificationLabel =
  | "agentic_engineer"
  | "agentic_architect"
  | "rag_enterprise"
  | "fde"
  | "solutions_engineer"
  | "inference_engineer"
  | "ml_platform"
  | "backend_product_engineering"
  | "developer_tools"
  | "ai_enablement"
  | "internal_ai_tooling"
  | "business_automation_ai"
  | "ai_operations"
  | "workplace_ai"
  | "ai_adoption_transformation"
  | "data_engineering"
  | "security_ai"
  | "founding_engineer"
  | "ai_product_manager"
  | "non_engineering"
  | "staffing_agency"
  | "index_not_job";

export interface ClassifiableJobRow {
  id: string;
  title: string;
  company_hint: string | null;
  canonical_url: string;
  description_text: string;
  has_page_snapshot: boolean;
}

export interface ClassificationLabelMatch {
  label: JobClassificationLabel;
  confidence: number;
  reason: string;
}

export interface JobClassification {
  category: Exclude<JobCategory, "unclassified">;
  ragFocus: FocusSignal;
  enterpriseFocus: FocusSignal;
  confidence: number;
  reason: string;
  sourceStage: ClassificationStage;
  labels: ClassificationLabelMatch[];
}

export function buildClassifiableJobsSql(limit: number): string {
  return `SELECT COALESCE(json_agg(row_to_json(classifiable_row)), '[]'::json)
FROM (
  SELECT
    j.id::text AS id,
    j.title_normalized AS title,
    j.company_hint,
    j.canonical_url,
    BOOL_OR(jp.id IS NOT NULL) AS has_page_snapshot,
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

export function buildClassifiableJobsForSearchRunSql(runId: number, limit: number): string {
  return `SELECT COALESCE(json_agg(row_to_json(classifiable_row)), '[]'::json)
FROM (
  SELECT
    j.id::text AS id,
    j.title_normalized AS title,
    j.company_hint,
    j.canonical_url,
    BOOL_OR(jp.id IS NOT NULL) AS has_page_snapshot,
    CONCAT_WS(
      E'\\n',
      COALESCE(string_agg(DISTINCT sr.description_raw, E'\\n'), ''),
      COALESCE(string_agg(DISTINCT jp.markdown, E'\\n'), '')
    ) AS description_text
  FROM job_search.search_queries sq
  JOIN job_search.search_runs search_run ON search_run.id = sq.run_id
  JOIN job_search.search_results sr ON sr.query_id = sq.id
  JOIN job_search.job_observations jo ON jo.search_result_id = sr.id
  JOIN job_search.jobs j ON j.id = jo.job_id
  LEFT JOIN job_search.job_pages jp
    ON jp.job_id = j.id
   AND jp.status = 'success'
   AND jp.fetched_at >= search_run.started_at
  WHERE sq.run_id = ${runId}
    AND j.category = 'unclassified'
  GROUP BY j.id
  ORDER BY j.last_seen_at DESC, j.id DESC
  LIMIT ${limit}
) classifiable_row;`;
}

export function buildUpdateJobClassificationSql(
  jobId: string,
  classification: JobClassification,
): string {
  return `WITH current_job AS (
  SELECT id, review_state
  FROM job_search.jobs
  WHERE id = ${quoteSqlLiteral(jobId)}
  FOR UPDATE
),
updated_job AS (
  UPDATE job_search.jobs
SET category = ${quoteSqlLiteral(classification.category)},
    rag_focus = ${quoteSqlLiteral(classification.ragFocus)},
    enterprise_focus = ${quoteSqlLiteral(classification.enterpriseFocus)},
    classification_confidence = ${classification.confidence.toFixed(4)},
    classification_reason = ${quoteSqlLiteral(classification.reason)},
    classified_at = now(),
    review_state = CASE
      WHEN job_search.jobs.review_state IN ('new', 'needs_page_ingest', 'needs_classification')
        THEN 'ready_for_review'
      ELSE job_search.jobs.review_state
    END
FROM current_job
WHERE job_search.jobs.id = current_job.id
RETURNING job_search.jobs.id, current_job.review_state AS from_state, job_search.jobs.review_state AS to_state
),
deleted_old_labels AS (
  DELETE FROM job_search.job_classification_labels
  WHERE job_id IN (SELECT id FROM updated_job)
    AND source_stage = ${quoteSqlLiteral(classification.sourceStage)}
),
inserted_review_event AS (
  INSERT INTO job_search.review_events (
    job_id,
    from_state,
    to_state,
    reason_codes,
    note,
    actor
  )
  SELECT
    id,
    from_state,
    to_state,
    ARRAY['classified', ${quoteSqlLiteral(classification.sourceStage)}]::text[],
    ${quoteSqlLiteral(classification.reason)},
    'system'
  FROM updated_job
  WHERE from_state <> to_state
)
${buildInsertLabelsSql(classification)};`;
}

export function classifyJobText(input: {
  title: string;
  description: string;
  hasPageSnapshot?: boolean;
}): JobClassification {
  const haystack = `${input.title}\n${input.description}`.toLowerCase();
  const title = input.title.toLowerCase();
  const reasons: string[] = [];
  const labels: ClassificationLabelMatch[] = [];
  const hasAiSignal =
    /\b(?:ai|genai|llm|artificial intelligence|agentic|copilot|gemini enterprise)\b/.test(haystack);

  let category: JobClassification["category"] = "other";
  let confidence = 0.52;

  if (matches(haystack, ["general application", "job board", "view all jobs", "browse jobs"])) {
    addLabel(labels, "index_not_job", 0.86, "matched index/general-application language");
  }

  if (
    matches(haystack, [
      "staffing agency",
      "recruitment agency",
      "talent marketplace",
      "our client",
      "for one of our clients",
      "on behalf of",
    ])
  ) {
    addLabel(labels, "staffing_agency", 0.82, "matched staffing/intermediary language");
  }

  if (matches(title, ["product manager", "product lead"]) && hasAiSignal) {
    addLabel(labels, "ai_product_manager", 0.78, "matched AI product-management language");
  } else if (
    matches(title, ["account executive", "sales", "marketing", "recruiter", "designer"]) &&
    !matches(title, ["sales engineer", "solutions engineer"])
  ) {
    addLabel(labels, "non_engineering", 0.74, "matched non-engineering title language");
  }

  if (matches(haystack, ["forward deployed", "field engineer", "fde"])) {
    category = "fde";
    confidence = 0.76;
    reasons.push("matched FDE/customer-facing engineering language");
    addLabel(labels, "fde", confidence, "matched forward-deployed engineering signal");
  }

  if (
    matches(haystack, ["solutions engineer", "solution engineer", "sales engineer", "pre-sales"])
  ) {
    if (category === "other") {
      category = "fde";
      confidence = 0.72;
      reasons.push("matched solutions-engineering language");
    }
    addLabel(labels, "solutions_engineer", 0.74, "matched solutions-engineering signal");
  }

  if (
    matches(haystack, [
      "founding engineer",
      "founding ai engineer",
      "founder engineer",
      "first engineer",
    ])
  ) {
    addLabel(labels, "founding_engineer", 0.78, "matched founding-engineer language");
  }

  if (
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
    if (category === "other") {
      category = "inference_engineer";
      confidence = 0.78;
      reasons.push("matched inference/model-serving language");
    }
    addLabel(labels, "inference_engineer", 0.78, "matched inference/model-serving signal");
  }

  if (
    matches(haystack, [
      "ml platform",
      "mlops",
      "machine learning platform",
      "model training",
      "training pipeline",
      "evaluation platform",
      "eval platform",
    ])
  ) {
    addLabel(labels, "ml_platform", 0.72, "matched ML platform/evaluation signal");
  }

  if (
    matches(haystack, [
      "ai enablement",
      "artificial intelligence enablement",
      "ai-enabled enablement",
      "ai workforce enablement",
      "ai tools and adoption",
      "ai tool adoption",
    ])
  ) {
    addLabel(labels, "ai_enablement", 0.74, "matched AI enablement/adoption signal");
  }

  if (
    hasAiSignal &&
    matches(haystack, [
      "internal ai",
      "internal ai tooling",
      "internal ai tools",
      "internal tools",
      "internal products",
      "internal platform",
      "internal applications",
      "developer acceleration",
      "employee productivity",
      "productivity ai",
    ])
  ) {
    addLabel(labels, "internal_ai_tooling", 0.73, "matched internal AI/tooling signal");
  }

  if (
    hasAiSignal &&
    matches(haystack, [
      "ai automation",
      "business automation",
      "workflow automation",
      "process automation",
      "agentic workflow",
      "agentic workflows",
      "workato",
      "zapier",
      "make.com",
      "n8n",
    ])
  ) {
    if (category === "other" && matches(title, ["engineer", "developer", "builder"])) {
      category = "agentic_engineer";
      confidence = 0.71;
      reasons.push("matched AI automation engineering language");
    }
    addLabel(labels, "business_automation_ai", 0.72, "matched AI/business automation signal");
  }

  if (
    matches(haystack, [
      "ai operations",
      "ai ops",
      "operations ai",
      "ai operations lead",
      "ai operations engineer",
      "ai operations specialist",
    ])
  ) {
    addLabel(labels, "ai_operations", 0.7, "matched AI operations signal");
  }

  if (
    hasAiSignal &&
    matches(haystack, [
      "workplace technology",
      "workplace ai",
      "productivity ai",
      "gemini enterprise",
      "microsoft copilot",
      "copilot adoption",
      "collaboration tools",
    ])
  ) {
    addLabel(labels, "workplace_ai", 0.7, "matched workplace/productivity AI signal");
  }

  if (
    matches(haystack, [
      "ai adoption",
      "ai transformation",
      "internal ai transformation",
      "copilot adoption",
      "gemini enterprise rollout",
      "business transformation",
      "ai strategy",
      "change management",
    ])
  ) {
    addLabel(
      labels,
      "ai_adoption_transformation",
      0.68,
      "matched AI adoption/transformation signal",
    );
  }

  if (
    matches(title, ["architect"]) &&
    matches(haystack, ["agentic", " ai agent", " agents", "llm"])
  ) {
    if (category === "other") {
      category = "agentic_architect";
      confidence = 0.8;
      reasons.push("matched architect title plus agent/LLM language");
    }
    addLabel(labels, "agentic_architect", 0.8, "matched agentic architect signal");
  } else if (
    matches(haystack, [
      "agentic",
      " ai agent",
      " agents",
      "llm application",
      "ai engineer",
      "ai-native",
    ])
  ) {
    if (category === "other") {
      category = "agentic_engineer";
      confidence = 0.74;
      reasons.push("matched agent/LLM application engineering language");
    }
    addLabel(labels, "agentic_engineer", 0.74, "matched agent/LLM application signal");
  }

  if (matches(haystack, ["backend", "api", "distributed systems", "full stack", "full-stack"])) {
    addLabel(
      labels,
      "backend_product_engineering",
      0.62,
      "matched backend/product engineering signal",
    );
  }

  if (
    matches(haystack, [
      "developer tools",
      "devtools",
      "developer experience",
      "sdk",
      "api platform",
      "cli",
    ])
  ) {
    addLabel(labels, "developer_tools", 0.68, "matched developer-tooling signal");
  }

  if (
    matches(haystack, [
      "data engineer",
      "data pipeline",
      "etl",
      "warehouse",
      "analytics engineering",
    ])
  ) {
    addLabel(labels, "data_engineering", 0.7, "matched data-engineering signal");
  }

  if (matches(haystack, ["security", "compliance"]) && hasAiSignal) {
    addLabel(labels, "security_ai", 0.68, "matched security plus AI/LLM signal");
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
  if (ragFocus === "yes" && enterpriseFocus === "yes") {
    addLabel(labels, "rag_enterprise", 0.76, "matched RAG and enterprise/productization signals");
  }

  if (reasons.length === 0) reasons.push("no strong target-category signal found");

  return {
    category,
    ragFocus,
    enterpriseFocus,
    confidence,
    reason: reasons.join("; "),
    sourceStage: input.hasPageSnapshot ? "page" : "metadata",
    labels: labels.sort((left, right) => right.confidence - left.confidence),
  };
}

function buildInsertLabelsSql(classification: JobClassification): string {
  if (classification.labels.length === 0) {
    return "SELECT 0 WHERE false";
  }

  const values = classification.labels
    .map(
      (label) => `(
    (SELECT id FROM updated_job),
    ${quoteSqlLiteral(label.label)},
    ${quoteSqlLiteral(classification.sourceStage)},
    ${label.confidence.toFixed(4)},
    ${quoteSqlLiteral(label.reason)}
  )`,
    )
    .join(",\n");

  return `INSERT INTO job_search.job_classification_labels (
  job_id,
  label,
  source_stage,
  confidence,
  reason
)
VALUES
${values}
ON CONFLICT (job_id, label, source_stage) DO UPDATE
SET
  confidence = EXCLUDED.confidence,
  reason = EXCLUDED.reason,
  classified_at = now();`;
}

function addLabel(
  labels: ClassificationLabelMatch[],
  label: JobClassificationLabel,
  confidence: number,
  reason: string,
): void {
  const existing = labels.find((candidate) => candidate.label === label);
  if (!existing) {
    labels.push({ label, confidence, reason });
    return;
  }

  if (confidence > existing.confidence) {
    existing.confidence = confidence;
    existing.reason = reason;
  }
}

function classifyFocus(haystack: string, needles: string[]): FocusSignal {
  if (matches(haystack, needles)) return "yes";
  if (haystack.trim().length > 80) return "no";
  return "unknown";
}

function matches(haystack: string, needles: string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}
