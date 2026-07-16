import { quoteSqlLiteral } from "../db/config";

export const SKILL_EXTRACTOR_VERSION = "lexicon-v1";

export type SkillSignalKind =
  | "required_skill"
  | "responsibility"
  | "infrastructure_context"
  | "domain_context"
  | "vague_keyword";

export type SkillSignalConfidence = "low" | "medium" | "high";

export interface SkillSignalMatch {
  signal: string;
  kind: SkillSignalKind;
  confidence: SkillSignalConfidence;
  evidence: string;
}

export interface ExtractableJobRow {
  id: string;
  title: string;
  company_hint: string | null;
  description_text: string;
}

interface LexiconEntry {
  signal: string;
  kind: SkillSignalKind;
  confidence: SkillSignalConfidence;
  pattern: RegExp;
}

// Normalized signal vocabulary seeded from the 2026-06-05 manual market
// analysis (artifacts/job-market/2026-06-05/extracted_signals.jsonl) so the
// automated extractor stays comparable with that baseline.
const LEXICON: LexiconEntry[] = [
  {
    signal: "llm application development",
    kind: "required_skill",
    confidence: "high",
    pattern:
      /\b(?:llm[- ](?:based|backed|powered)|building (?:with )?llms?|genai (?:solutions|applications|use cases)|generative ai (?:solutions|applications|systems)|ai-enabled solutions)\b/i,
  },
  {
    signal: "agentic workflow orchestration",
    kind: "required_skill",
    confidence: "high",
    pattern:
      /\b(?:agentic|ai agents?|multi-agent|agent (?:framework|orchestration|workflow)s?|autonomous agents?)\b/i,
  },
  {
    signal: "retrieval and grounding systems",
    kind: "required_skill",
    confidence: "high",
    pattern:
      /\b(?:rag\b|retrieval[- ]augmented|vector (?:database|store|search)|embeddings?|knowledge graphs?|semantic search|grounding)\b/i,
  },
  {
    signal: "evaluation harness and llm quality",
    kind: "required_skill",
    confidence: "high",
    pattern:
      /\b(?:eval(?:uation)? (?:harness|framework|pipeline|platform)s?|llm evals?|structured evals?|regression (?:tests?|checks?) for (?:llm|ai|model)s?|model evaluation)\b/i,
  },
  {
    signal: "context engineering and memory design",
    kind: "required_skill",
    confidence: "high",
    pattern:
      /\b(?:context engineering|context window|prompt engineering|memory (?:design|systems?|management) for)\b/i,
  },
  {
    signal: "mlops deployment and model serving",
    kind: "required_skill",
    confidence: "medium",
    pattern:
      /\b(?:mlops|model serving|model deployment|inference (?:stack|pipeline|optimi[sz]ation|speed)|vllm|tensorrt|triton)\b/i,
  },
  {
    signal: "fine-tuning and model training",
    kind: "required_skill",
    confidence: "medium",
    pattern:
      /\b(?:fine[- ]?tun(?:e|ing)|lora\b|model training|training pipeline|post[- ]training)\b/i,
  },
  {
    signal: "python backend engineering",
    kind: "required_skill",
    confidence: "medium",
    pattern:
      /\b(?:python (?:developer|engineer|backend)|backend.{0,40}python|python.{0,40}(?:fastapi|django|flask))\b/i,
  },
  {
    signal: "typescript full-stack engineering",
    kind: "required_skill",
    confidence: "medium",
    pattern:
      /\b(?:typescript|node\.?js|react|next\.?js)\b.{0,60}\b(?:engineer|developer|full[- ]?stack)\b|\b(?:full[- ]?stack)\b.{0,60}\b(?:typescript|node\.?js|react)\b/i,
  },
  {
    signal: "c++ performance systems",
    kind: "required_skill",
    confidence: "medium",
    pattern: /\bc\+\+\b|\b(?:low[- ]latency|memory efficiency|close to the metal)\b/i,
  },
  {
    signal: "aws ai cloud stack",
    kind: "infrastructure_context",
    confidence: "high",
    pattern: /\b(?:aws|amazon web services|bedrock|sagemaker|agentcore)\b/i,
  },
  {
    signal: "azure ai cloud stack",
    kind: "infrastructure_context",
    confidence: "high",
    pattern: /\b(?:azure|azure openai|microsoft fabric|copilot studio)\b/i,
  },
  {
    signal: "gcp ai cloud stack",
    kind: "infrastructure_context",
    confidence: "high",
    pattern: /\b(?:gcp|google cloud|vertex ai|gemini enterprise)\b/i,
  },
  {
    signal: "kubernetes terraform cicd platform",
    kind: "infrastructure_context",
    confidence: "medium",
    pattern: /\b(?:kubernetes|k8s|terraform|ci\/cd|github actions|docker)\b/i,
  },
  {
    signal: "snowflake databricks medallion",
    kind: "infrastructure_context",
    confidence: "medium",
    pattern: /\b(?:snowflake|databricks|medallion|delta lake|lakehouse)\b/i,
  },
  {
    signal: "data pipelines and analytics engineering",
    kind: "required_skill",
    confidence: "medium",
    pattern: /\b(?:etl|elt\b|data pipelines?|data engineering|analytics engineering|dbt\b)\b/i,
  },
  {
    signal: "api integration and enterprise systems",
    kind: "responsibility",
    confidence: "medium",
    pattern:
      /\b(?:api integrations?|integrat(?:e|ing|ion) (?:with )?(?:enterprise|existing|legacy) (?:systems|platforms)|rest apis?\b)\b/i,
  },
  {
    signal: "client facing solutions delivery",
    kind: "responsibility",
    confidence: "medium",
    pattern:
      /\b(?:client[- ]facing|customer[- ]facing|pre[- ]sales|proof[- ]of[- ]concepts?|stakeholder (?:management|engagement)|forward[- ]deployed)\b/i,
  },
  {
    signal: "architecture roadmap and technical leadership",
    kind: "responsibility",
    confidence: "medium",
    pattern:
      /\b(?:technical leadership|architecture (?:roadmap|decisions|reviews)|solution architect|tech(?:nical)? lead|principal engineer|engineering standards)\b/i,
  },
  {
    signal: "internal tools and developer workflows",
    kind: "responsibility",
    confidence: "medium",
    pattern:
      /\b(?:internal (?:tools?|tooling|platforms?)|developer (?:experience|productivity|workflows?)|devex\b)\b/i,
  },
  {
    signal: "security compliance governance",
    kind: "domain_context",
    confidence: "medium",
    pattern:
      /\b(?:security (?:review|compliance|governance)|gdpr|iso 27001|soc ?2|ai governance|responsible ai)\b/i,
  },
  {
    signal: "financial services regulated domain",
    kind: "domain_context",
    confidence: "medium",
    pattern:
      /\b(?:financial services|investment (?:bank|management)|private equity|hedge fund|trading|fintech|insurance|regulated (?:industry|environment))\b/i,
  },
];

const VAGUE_AI_PATTERN = /\b(?:ai|artificial intelligence|genai|machine learning|ml)\b/i;

function evidenceFor(text: string, pattern: RegExp): string {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed && pattern.test(trimmed)) {
      return trimmed.length > 240 ? `${trimmed.slice(0, 237)}...` : trimmed;
    }
  }
  const match = text.match(pattern);
  return match?.[0] ?? "";
}

/**
 * Deterministic lexicon pass over a job's title + full text. Returns at most
 * one match per normalized signal. Falls back to a single low-confidence
 * "vague ai mention" signal when AI language appears without any concrete
 * lexicon hit, mirroring the manual baseline's noise bucket.
 */
export function extractSkillSignals(input: {
  title: string;
  description: string;
}): SkillSignalMatch[] {
  const text = `${input.title}\n${input.description}`;
  const matches: SkillSignalMatch[] = [];

  for (const entry of LEXICON) {
    if (!entry.pattern.test(text)) continue;
    matches.push({
      signal: entry.signal,
      kind: entry.kind,
      confidence: entry.confidence,
      evidence: evidenceFor(text, entry.pattern),
    });
  }

  const concrete = matches.some((match) => match.kind !== "domain_context");
  if (!concrete && VAGUE_AI_PATTERN.test(text)) {
    matches.push({
      signal: "vague ai mention without concrete system",
      kind: "vague_keyword",
      confidence: "low",
      evidence: evidenceFor(text, VAGUE_AI_PATTERN),
    });
  }

  return matches;
}

export function buildExtractableJobsSql(
  limit: number,
  extractor = SKILL_EXTRACTOR_VERSION,
): string {
  return `SELECT COALESCE(json_agg(row_to_json(extract_row)), '[]'::json)
FROM (
  SELECT
    j.id::text AS id,
    j.title_normalized AS title,
    j.company_hint,
    CONCAT_WS(
      E'\\n',
      COALESCE(string_agg(DISTINCT sr.description_raw, E'\\n'), ''),
      COALESCE(string_agg(DISTINCT jp.markdown, E'\\n'), '')
    ) AS description_text
  FROM job_search.jobs j
  LEFT JOIN job_search.job_observations jo ON jo.job_id = j.id
  LEFT JOIN job_search.search_results sr ON sr.id = jo.search_result_id
  LEFT JOIN job_search.job_pages jp ON jp.job_id = j.id AND jp.status = 'success'
  WHERE NOT EXISTS (
    SELECT 1
    FROM job_search.job_skill_extractions jse
    WHERE jse.job_id = j.id AND jse.extractor = ${quoteSqlLiteral(extractor)}
  )
  GROUP BY j.id
  ORDER BY j.last_seen_at DESC, j.id DESC
  LIMIT ${limit}
) extract_row;`;
}

export function buildRecordSkillSignalsSql(
  jobId: string,
  signals: SkillSignalMatch[],
  extractor = SKILL_EXTRACTOR_VERSION,
): string {
  if (!/^[1-9]\d*$/.test(jobId)) {
    throw new Error(`Invalid job id "${jobId}" for skill signal insert`);
  }
  const id = Number.parseInt(jobId, 10);

  const statements: string[] = [];
  if (signals.length > 0) {
    const rows = signals
      .map(
        (signal) =>
          `(${id}, ${quoteSqlLiteral(signal.signal)}, ${quoteSqlLiteral(signal.kind)}, ${quoteSqlLiteral(
            signal.evidence,
          )}, ${quoteSqlLiteral(signal.confidence)}, ${quoteSqlLiteral(extractor)})`,
      )
      .join(",\n  ");
    statements.push(`INSERT INTO job_search.job_skill_signals
  (job_id, normalized_signal, signal_kind, evidence_snippet, confidence, extractor)
VALUES
  ${rows}
ON CONFLICT (job_id, normalized_signal, signal_kind, extractor) DO NOTHING;`);
  }

  statements.push(`INSERT INTO job_search.job_skill_extractions (job_id, extractor, signal_count)
VALUES (${id}, ${quoteSqlLiteral(extractor)}, ${signals.length})
ON CONFLICT (job_id, extractor)
DO UPDATE SET extracted_at = now(), signal_count = EXCLUDED.signal_count;`);

  return statements.join("\n");
}
