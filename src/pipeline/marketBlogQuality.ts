export type EvidenceLocation = "body" | "title" | "metadata" | "missing";

export type EvidenceGrade =
  | "strong_body_evidence"
  | "weak_body_evidence"
  | "title_only_evidence"
  | "metadata_only_signal"
  | "extraction_failed_but_raw_body_strong"
  | "duplicate_of_existing_job"
  | "false_positive_non_ai_engineering";

export type TitleVerdict = "keep" | "rewrite" | "kill";

export interface StableSentence {
  id: string;
  index: number;
  text: string;
}

export interface EvidenceAudit {
  jobId: string;
  evidenceQuote: string;
  evidenceLocation: EvidenceLocation;
  grade: EvidenceGrade;
  matchedSentenceId: string | null;
  matchedSentence: string | null;
  workVerbs: string[];
  systemObjects: string[];
  constraints: string[];
  roleFamilies: RoleFamily[];
  falsePositiveRisk: boolean;
  problems: string[];
}

export type RoleFamily =
  | "llm_application_engineer"
  | "agentic_workflow_engineer"
  | "rag_knowledge_systems_engineer"
  | "ai_data_platform_engineer"
  | "inference_runtime_engineer"
  | "enterprise_ai_architect"
  | "forward_deployed_ai_engineer"
  | "ai_product_owner"
  | "ai_garnish"
  | "false_positive_non_ai";

export interface ParsedBlogPost {
  ordinal: number;
  title: string;
  body: string;
  evidence: ParsedEvidenceReference[];
}

export interface ParsedEvidenceReference {
  jobId: string;
  label: string;
  quote: string;
}

export interface TitleLint {
  title: string;
  verdict: TitleVerdict;
  score: {
    specificity: number;
    curiosity: number;
    evidenceFit: number;
    expertiseSignal: number;
    artifactImplied: number;
    total: number;
  };
  problems: string[];
  positiveSignals: string[];
}

export interface BlogPostReview {
  ordinal: number;
  title: string;
  titleLint: TitleLint;
  evidenceAudits: EvidenceAudit[];
  distinctBodyJobs: number;
  distinctStrongBodyJobs: number;
  duplicateAdjustedJobs: number;
  topBodyEvidence: EvidenceAudit[];
  weakEvidence: EvidenceAudit[];
  counterexamples: EvidenceAudit[];
  roleFamilies: RoleFamily[];
  readerPromise: string;
  technicalArtifacts: string[];
  failureMode: string;
  gate: "pass" | "note_only" | "reject";
  gateReasons: string[];
}

const METADATA_PREFIXES = [
  "priority notes",
  "query_terms",
  "query terms",
  "classification_reason",
  "classification reason",
  "labels",
  "category",
  "rag_focus",
  "enterprise_focus",
];

const WORK_VERBS = [
  "build",
  "building",
  "design",
  "designing",
  "implement",
  "implementing",
  "deploy",
  "deploying",
  "integrate",
  "integrating",
  "evaluate",
  "evaluating",
  "optimise",
  "optimising",
  "optimize",
  "optimizing",
  "maintain",
  "maintaining",
  "own",
  "owning",
  "debug",
  "debugging",
  "monitor",
  "monitoring",
  "scale",
  "scaling",
  "ship",
  "shipping",
  "deliver",
  "delivering",
  "port",
  "porting",
];

const SYSTEM_OBJECTS = [
  "agentic workflow",
  "agentic workloads",
  "agentic systems",
  "llm service",
  "llm-based systems",
  "evaluation framework",
  "evaluation harness",
  "rag pipeline",
  "rag pipelines",
  "indexing pipeline",
  "indexing",
  "inference engine",
  "inference engines",
  "data platform",
  "copilot",
  "copilots",
  "chatbot",
  "chatbots",
  "tool-use workflow",
  "tool-use workflows",
  "bedrock agent",
  "enterprise integration",
  "data ingestion",
  "retrieval",
  "vector database",
  "vector databases",
  "model serving",
  "runtime",
  "api",
  "apis",
  "workflow automation",
];

const CONSTRAINTS = [
  "production",
  "customer-facing",
  "customer facing",
  "regulated",
  "financial services",
  "secure",
  "security",
  "aws",
  "azure",
  "edge hardware",
  "edge devices",
  "live",
  "enterprise client",
  "enterprise",
  "multi-stakeholder",
  "human-in-the-loop",
  "observability",
  "governance",
  "audit",
  "permissions",
  "permission",
  "reliability",
  "reliable",
  "privacy",
  "compliance",
];

const ABSTRACT_TITLE_WORDS = [
  "strategy",
  "transformation",
  "innovation",
  "enablement",
  "architecture",
  "governance",
  "quality",
  "reliability",
  "ownership",
  "requirements",
  "delivery",
  "platform",
  "workflows",
  "enterprise",
  "productivity",
];

const CONCRETE_TITLE_WORDS = [
  "eval",
  "evals",
  "trace",
  "traces",
  "rollback",
  "prompt",
  "permission",
  "permissions",
  "audit",
  "log",
  "logs",
  "agent",
  "tool",
  "tools",
  "api",
  "rag",
  "retrieval",
  "index",
  "source",
  "pipeline",
  "handoff",
  "backlog",
  "demo",
  "context",
  "vector",
  "database",
  "freshness",
  "contract",
  "boundary",
  "boundaries",
];

const BANNED_TITLE_PHRASES = [
  "the future of",
  "unlocking",
  "harnessing",
  "navigating",
  "deep dive",
  "best practices",
  "thoughts on",
  "guide to",
  "why you should care",
  "as product requirements",
  "without theatre",
  "before autonomy",
  "test surface",
];

const FALSE_POSITIVE_TERMS = [
  "site engineer",
  "field support",
  "water quality",
  "civil",
  "maintenance",
  "reliability maintenance",
  "mechanical engineer",
  "electrical",
  "waf",
];

export function splitStableSentences(jobId: string, markdown: string): StableSentence[] {
  const body = stripMetadataAndHeadings(markdown);
  const chunks = body
    .replace(/\r/g, "\n")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((line) => normalizeWhitespace(line.replace(/^[-*]\s+/, "")))
    .filter((line) => line.length >= 24);

  return chunks.map((text, index) => ({
    id: `${jobId}.s${String(index + 1).padStart(3, "0")}`,
    index: index + 1,
    text,
  }));
}

export function auditEvidence(
  jobId: string,
  evidenceQuote: string,
  markdown: string,
): EvidenceAudit {
  const quote = normalizeWhitespace(evidenceQuote);
  const evidenceLocation = classifyEvidenceLocation(quote);
  const sentences = splitStableSentences(jobId, markdown);
  const match = evidenceLocation === "body" ? findBestSentenceMatch(quote, sentences) : null;
  const textForSignals = match?.text ?? quote;
  const workVerbs = matchedTerms(textForSignals, WORK_VERBS);
  const systemObjects = matchedTerms(textForSignals, SYSTEM_OBJECTS);
  const constraints = matchedTerms(textForSignals, CONSTRAINTS);
  const roleFamilies = classifyRoleFamilies(`${textForSignals} ${markdown}`);
  const falsePositiveRisk = isFalsePositiveRisk(textForSignals);
  const bodyHasStrongEvidence = sentences.some((sentence) => isStrongBodyText(sentence.text));
  const problems: string[] = [];

  if (evidenceLocation !== "body")
    problems.push(`${evidenceLocation} evidence cannot support a top post`);
  if (workVerbs.length === 0) problems.push("missing concrete work verb");
  if (systemObjects.length === 0) problems.push("missing concrete system object");
  if (constraints.length === 0)
    problems.push("missing production/customer/security/data constraint");
  if (falsePositiveRisk) problems.push("false-positive non-AI engineering risk");

  const grade = gradeEvidence({
    evidenceLocation,
    falsePositiveRisk,
    bodyHasStrongEvidence,
    workVerbs,
    systemObjects,
    constraints,
  });

  if (grade === "extraction_failed_but_raw_body_strong") {
    problems.push("raw body contains stronger evidence than extracted quote");
  }

  return {
    jobId,
    evidenceQuote: quote,
    evidenceLocation,
    grade,
    matchedSentenceId: match?.id ?? null,
    matchedSentence: match?.text ?? null,
    workVerbs,
    systemObjects,
    constraints,
    roleFamilies,
    falsePositiveRisk,
    problems,
  };
}

export function lintTitle(title: string): TitleLint {
  const lower = title.toLowerCase();
  const words = wordsOf(lower);
  const problems: string[] = [];
  const positiveSignals: string[] = [];
  const concreteCount = CONCRETE_TITLE_WORDS.filter((word) => lower.includes(word)).length;
  const abstractCount = ABSTRACT_TITLE_WORDS.filter((word) => words.has(word)).length;
  const hasArtifactHook =
    /\b(eval|rollback|permission|audit|trace|tool|index|source|backlog|demo|prompt)\b/i.test(title);
  const hasFailureTension =
    /\b(fail|fails|failed|won't|wrong|before|needs|only|worst|easy|hard|stop|rollback|smell|seo)\b/i.test(
      title,
    );

  if (
    BANNED_TITLE_PHRASES.some((phrase) => lower.includes(phrase)) ||
    /\bas\b.+\brequirements\b/.test(lower)
  ) {
    problems.push("banned phrase");
  }
  if (title.split(/\s+/).length > 12) problems.push("too long");
  if (concreteCount === 0) problems.push("no concrete technical artifact");
  if (abstractCount >= 2 && concreteCount === 0) problems.push("abstract taxonomy label");
  if (words.has("ai") && concreteCount === 0) problems.push("AI without concrete system object");
  if (
    words.has("enterprise") &&
    !["identity", "api", "audit", "permission", "integration", "handoff"].some((word) =>
      lower.includes(word),
    )
  ) {
    problems.push("enterprise without enterprise constraint");
  }
  if (
    words.has("rag") &&
    !["retrieval", "index", "source", "freshness", "eval", "permission", "system"].some((word) =>
      lower.includes(word),
    )
  ) {
    problems.push("RAG without retrieval/data constraint");
  }
  if (
    words.has("agentic") &&
    !["tool", "state", "permission", "approval", "rollback", "trace", "boundary"].some((word) =>
      lower.includes(word),
    )
  ) {
    problems.push("agentic without product boundary");
  }

  if (concreteCount > 0) positiveSignals.push("concrete technical noun");
  if (hasFailureTension) positiveSignals.push("tension or failure mode");
  if (hasArtifactHook) positiveSignals.push("artifact hook");

  const score = {
    specificity: Math.min(
      3,
      concreteCount + (hasFailureTension ? 1 : 0) + (hasArtifactHook ? 1 : 0),
    ),
    curiosity: Math.min(
      3,
      (hasFailureTension ? 2 : hasArtifactHook ? 2 : 0) + (/[?]/.test(title) ? 1 : 0),
    ),
    evidenceFit: problems.some((problem) => problem.includes("without")) ? 1 : 2,
    expertiseSignal: Math.min(
      3,
      concreteCount > 0 ? 2 + (hasFailureTension || hasArtifactHook ? 1 : 0) : 0,
    ),
    artifactImplied: Math.min(3, concreteCount),
    total: 0,
  };
  score.total =
    score.specificity +
    score.curiosity +
    score.evidenceFit +
    score.expertiseSignal +
    score.artifactImplied;

  const verdict: TitleVerdict =
    score.total >= 11 && problems.length === 0 ? "keep" : score.total >= 8 ? "rewrite" : "kill";

  return { title, verdict, score, problems, positiveSignals };
}

export function parseBlogPostsMarkdown(markdown: string): ParsedBlogPost[] {
  const posts: ParsedBlogPost[] = [];
  const headingPattern = /^##\s+(\d+)\.\s+(.+)$/gm;
  const matches = Array.from(markdown.matchAll(headingPattern));

  for (let index = 0; index < matches.length; index++) {
    const match = matches[index];
    if (!match) continue;
    if (match.index === undefined || !match[1] || !match[2]) continue;
    const nextMatch = matches[index + 1];
    const nextIndex = nextMatch?.index ?? markdown.length;
    const body = markdown.slice(match.index + match[0].length, nextIndex).trim();
    posts.push({
      ordinal: Number.parseInt(match[1], 10),
      title: match[2].trim(),
      body,
      evidence: parseEvidenceReferences(body),
    });
  }

  return posts;
}

export function reviewBlogPost(
  post: ParsedBlogPost,
  rawMarkdownByJobId: Map<string, string>,
  duplicateGroupByJobId: Map<string, string> = new Map(),
): BlogPostReview {
  const titleLint = lintTitle(post.title);
  const evidenceAudits = post.evidence.map((reference) =>
    auditEvidence(reference.jobId, reference.quote, rawMarkdownByJobId.get(reference.jobId) ?? ""),
  );
  const bodyAudits = evidenceAudits.filter((audit) => audit.evidenceLocation === "body");
  const strongBodyAudits = evidenceAudits.filter((audit) => audit.grade === "strong_body_evidence");
  const distinctBodyJobs = new Set(bodyAudits.map((audit) => audit.jobId)).size;
  const distinctStrongBodyJobs = new Set(strongBodyAudits.map((audit) => audit.jobId)).size;
  const duplicateAdjustedJobs = duplicateAdjustedCount(bodyAudits, duplicateGroupByJobId);
  const roleFamilies = unique(
    evidenceAudits
      .flatMap((audit) => audit.roleFamilies)
      .filter((family) => family !== "ai_garnish"),
  );
  const topBodyEvidence = strongBodyAudits.slice(0, 5);
  const weakEvidence = evidenceAudits
    .filter((audit) => audit.grade !== "strong_body_evidence")
    .slice(0, 5);
  const counterexamples = evidenceAudits
    .filter(
      (audit) => audit.falsePositiveRisk || audit.grade === "false_positive_non_ai_engineering",
    )
    .slice(0, 3);
  const gateReasons = blogPostGateReasons({
    titleLint,
    evidenceAudits,
    distinctBodyJobs,
    distinctStrongBodyJobs,
    duplicateAdjustedJobs,
  });

  return {
    ordinal: post.ordinal,
    title: post.title,
    titleLint,
    evidenceAudits,
    distinctBodyJobs,
    distinctStrongBodyJobs,
    duplicateAdjustedJobs,
    topBodyEvidence,
    weakEvidence,
    counterexamples,
    roleFamilies,
    readerPromise: readerPromiseFor(roleFamilies, post.title),
    technicalArtifacts: artifactsFor(roleFamilies, post.title),
    failureMode: failureModeFor(roleFamilies, post.title),
    gate: gateReasons.length === 0 ? "pass" : titleLint.verdict === "kill" ? "reject" : "note_only",
    gateReasons,
  };
}

export function renderBlogQualityReview(reviews: BlogPostReview[]): string {
  const lines = [
    "# Blog Quality Review",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "Hard gates: body-level evidence, concrete work verbs, concrete system objects, constraints, duplicate-adjusted counts, and non-taxonomy titles.",
    "",
  ];

  for (const review of reviews) {
    lines.push(`## ${review.ordinal}. ${review.title}`);
    lines.push("");
    lines.push(`- Gate: ${review.gate}`);
    lines.push(`- Title verdict: ${review.titleLint.verdict} (${review.titleLint.score.total}/15)`);
    if (review.gateReasons.length > 0) {
      lines.push(`- Gate reasons: ${review.gateReasons.join("; ")}`);
    }
    lines.push(`- Role families: ${review.roleFamilies.join(", ") || "none"}`);
    lines.push(`- Reader promise: ${review.readerPromise}`);
    lines.push(`- Failure mode: ${review.failureMode}`);
    lines.push(`- Artifact(s): ${review.technicalArtifacts.join(", ")}`);
    lines.push(
      `- Evidence: ${review.distinctBodyJobs} body jobs, ${review.distinctStrongBodyJobs} strong body jobs, ${review.duplicateAdjustedJobs} duplicate-adjusted body jobs`,
    );
    lines.push("");
    lines.push("### Top Body Evidence");
    lines.push("");
    appendEvidence(lines, review.topBodyEvidence);
    lines.push("### Weak / Rejected Evidence");
    lines.push("");
    appendEvidence(lines, review.weakEvidence);
    if (review.counterexamples.length > 0) {
      lines.push("### Counterexamples");
      lines.push("");
      appendEvidence(lines, review.counterexamples);
    }
  }

  return `${lines.join("\n")}\n`;
}

function parseEvidenceReferences(body: string): ParsedEvidenceReference[] {
  const references: ParsedEvidenceReference[] = [];
  const pattern = /^\s*-\s+`(job_\d+)`\s+([^:]+):\s+(.+)$/gm;
  for (const match of body.matchAll(pattern)) {
    if (!match[1] || !match[2] || !match[3]) continue;
    references.push({
      jobId: match[1],
      label: match[2].trim(),
      quote: match[3].trim(),
    });
  }
  return references;
}

function classifyEvidenceLocation(quote: string): EvidenceLocation {
  if (!quote) return "missing";
  const lower = quote.toLowerCase();
  if (METADATA_PREFIXES.some((prefix) => lower.startsWith(prefix))) return "metadata";
  if (/^#+\s+/.test(quote)) return "title";
  return "body";
}

function gradeEvidence(input: {
  evidenceLocation: EvidenceLocation;
  falsePositiveRisk: boolean;
  bodyHasStrongEvidence: boolean;
  workVerbs: string[];
  systemObjects: string[];
  constraints: string[];
}): EvidenceGrade {
  if (input.falsePositiveRisk) return "false_positive_non_ai_engineering";
  if (input.evidenceLocation === "metadata") return "metadata_only_signal";
  if (input.evidenceLocation === "title") {
    return input.bodyHasStrongEvidence
      ? "extraction_failed_but_raw_body_strong"
      : "title_only_evidence";
  }
  if (input.evidenceLocation !== "body") return "weak_body_evidence";
  return input.workVerbs.length > 0 &&
    input.systemObjects.length > 0 &&
    input.constraints.length > 0
    ? "strong_body_evidence"
    : "weak_body_evidence";
}

function findBestSentenceMatch(quote: string, sentences: StableSentence[]): StableSentence | null {
  const normalizedQuote = normalizeWhitespace(quote).toLowerCase();
  if (!normalizedQuote) return null;

  let best: { sentence: StableSentence; score: number } | null = null;
  for (const sentence of sentences) {
    const normalizedSentence = sentence.text.toLowerCase();
    const score =
      normalizedSentence.includes(normalizedQuote) || normalizedQuote.includes(normalizedSentence)
        ? 1
        : tokenOverlapScore(normalizedQuote, normalizedSentence);
    if (!best || score > best.score) best = { sentence, score };
  }

  return best && best.score >= 0.35 ? best.sentence : null;
}

function tokenOverlapScore(a: string, b: string): number {
  const aTokens = wordsOf(a);
  const bTokens = wordsOf(b);
  if (aTokens.size === 0 || bTokens.size === 0) return 0;
  let overlap = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) overlap++;
  }
  return overlap / Math.min(aTokens.size, bTokens.size);
}

function stripMetadataAndHeadings(markdown: string): string {
  return markdown
    .split(/\n+/)
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      if (/^#+\s+/.test(trimmed)) return false;
      return !METADATA_PREFIXES.some((prefix) => trimmed.toLowerCase().startsWith(prefix));
    })
    .join("\n");
}

function isStrongBodyText(text: string): boolean {
  return (
    matchedTerms(text, WORK_VERBS).length > 0 &&
    matchedTerms(text, SYSTEM_OBJECTS).length > 0 &&
    matchedTerms(text, CONSTRAINTS).length > 0
  );
}

function classifyRoleFamilies(text: string): RoleFamily[] {
  const lower = text.toLowerCase();
  const families: RoleFamily[] = [];
  if (/\b(agent|agentic|tool-use|planning loop|memory-augmented|human-in-the-loop)\b/.test(lower)) {
    families.push("agentic_workflow_engineer");
  }
  if (/\b(rag|retrieval|indexing|knowledge|vector|document|grounding)\b/.test(lower)) {
    families.push("rag_knowledge_systems_engineer");
  }
  if (
    /\b(inference|runtime|edge hardware|edge device|llama\.cpp|onnx|ggml|model serving)\b/.test(
      lower,
    )
  ) {
    families.push("inference_runtime_engineer");
  }
  if (
    /\b(data ingestion|etl|elt|data platform|databricks|snowflake|streaming|pipeline)\b/.test(lower)
  ) {
    families.push("ai_data_platform_engineer");
  }
  if (/\b(llm|genai|ai-powered|copilot|chatbot|bedrock|azure openai)\b/.test(lower)) {
    families.push("llm_application_engineer");
  }
  if (
    /\b(enterprise|integration|identity|audit|governance|compliance|financial services)\b/.test(
      lower,
    )
  ) {
    families.push("enterprise_ai_architect");
  }
  if (
    /\b(forward deployed|client delivery|stakeholder|handoff|discovery|business impact)\b/.test(
      lower,
    )
  ) {
    families.push("forward_deployed_ai_engineer");
  }
  if (/\b(product owner|product manager|backlog|roadmap|adoption|user workflow)\b/.test(lower)) {
    families.push("ai_product_owner");
  }
  if (isFalsePositiveRisk(lower)) families.push("false_positive_non_ai");
  if (families.length === 0 && /\b(ai|genai|llm|agentic)\b/.test(lower))
    families.push("ai_garnish");
  return unique(families);
}

function matchedTerms(text: string, terms: string[]): string[] {
  const lower = text.toLowerCase();
  return unique(terms.filter((term) => lower.includes(term)));
}

function isFalsePositiveRisk(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    FALSE_POSITIVE_TERMS.some((term) => lower.includes(term)) &&
    !/\b(llm|genai|rag|agentic|inference)\b/.test(lower)
  );
}

function blogPostGateReasons(input: {
  titleLint: TitleLint;
  evidenceAudits: EvidenceAudit[];
  distinctBodyJobs: number;
  distinctStrongBodyJobs: number;
  duplicateAdjustedJobs: number;
}): string[] {
  const reasons: string[] = [];
  const concreteWorkSnippets = input.evidenceAudits.filter(
    (audit) => audit.evidenceLocation === "body" && audit.workVerbs.length > 0,
  ).length;
  const constrainedSnippets = input.evidenceAudits.filter(
    (audit) => audit.evidenceLocation === "body" && audit.constraints.length > 0,
  ).length;

  if (input.titleLint.verdict !== "keep") reasons.push(`title ${input.titleLint.verdict}`);
  if (input.distinctBodyJobs < 3) reasons.push("fewer than 3 distinct body-evidence jobs");
  if (input.duplicateAdjustedJobs < 3) reasons.push("fewer than 3 duplicate-adjusted body jobs");
  if (concreteWorkSnippets < 2) reasons.push("fewer than 2 body snippets with concrete work verbs");
  if (constrainedSnippets < 1)
    reasons.push("no body snippet with production/customer/security/data constraint");
  if (input.distinctStrongBodyJobs === 0) reasons.push("no strong body evidence");

  return reasons;
}

function duplicateAdjustedCount(
  audits: EvidenceAudit[],
  duplicateGroupByJobId: Map<string, string>,
): number {
  const groups = new Set<string>();
  for (const audit of audits) {
    groups.add(duplicateGroupByJobId.get(audit.jobId) ?? audit.jobId);
  }
  return groups.size;
}

function readerPromiseFor(families: RoleFamily[], title: string): string {
  const lower = title.toLowerCase();
  if (lower.includes("permission")) {
    return "After reading this, the reader can design an AI feature where permissions, retrieval context, and audit behavior are treated as product logic.";
  }
  if (lower.includes("eval")) {
    return "After reading this, the reader can turn ambiguous LLM behavior into testable eval cases and release gates.";
  }
  if (lower.includes("rollback")) {
    return "After reading this, the reader can ship an LLM-backed feature with traces, deployment gates, and a rollback path.";
  }
  if (families.includes("inference_runtime_engineer")) {
    return "After reading this, the reader can reason about inference as runtime systems work: latency, memory, hardware, and deployment constraints.";
  }
  if (families.includes("rag_knowledge_systems_engineer")) {
    return "After reading this, the reader can design retrieval around freshness, permissions, indexing, and answer-quality checks.";
  }
  return "After reading this, the reader can translate vague AI demand into a concrete engineering artifact and acceptance criteria.";
}

function artifactsFor(families: RoleFamily[], title: string): string[] {
  const lower = title.toLowerCase();
  const artifacts = new Set<string>();
  if (lower.includes("permission") || families.includes("enterprise_ai_architect")) {
    artifacts.add("permission matrix");
    artifacts.add("audit event schema");
  }
  if (lower.includes("eval") || families.includes("llm_application_engineer")) {
    artifacts.add("eval harness");
    artifacts.add("trace log");
  }
  if (lower.includes("rollback")) artifacts.add("rollback checklist");
  if (families.includes("rag_knowledge_systems_engineer")) artifacts.add("RAG ingestion pipeline");
  if (families.includes("agentic_workflow_engineer")) artifacts.add("tool schema");
  if (families.includes("ai_product_owner")) artifacts.add("backlog slice");
  if (families.includes("inference_runtime_engineer")) artifacts.add("runtime benchmark");
  if (artifacts.size === 0) artifacts.add("architecture diagram");
  return Array.from(artifacts);
}

function failureModeFor(families: RoleFamily[], title: string): string {
  const lower = title.toLowerCase();
  if (lower.includes("permission"))
    return "The model answers with context the user should not have been allowed to see.";
  if (lower.includes("eval"))
    return "The same product behavior changes silently because the expected behavior was never specified as eval data.";
  if (lower.includes("rollback"))
    return "A demo-quality LLM feature ships without a way to detect or reverse degraded behavior.";
  if (families.includes("inference_runtime_engineer"))
    return "The model works in a notebook but fails latency, memory, or hardware constraints in the runtime path.";
  if (families.includes("rag_knowledge_systems_engineer"))
    return "Retrieval looks plausible while stale, unpermissioned, or badly chunked sources drive bad answers.";
  return "The job spec says AI, but no one has translated that into ownership, constraints, or acceptance tests.";
}

function appendEvidence(lines: string[], audits: EvidenceAudit[]): void {
  if (audits.length === 0) {
    lines.push("_None._");
    lines.push("");
    return;
  }

  for (const audit of audits) {
    lines.push(
      `- \`${audit.jobId}\` ${audit.matchedSentenceId ? `\`${audit.matchedSentenceId}\`` : ""} ${audit.grade}: ${audit.matchedSentence ?? audit.evidenceQuote}`,
    );
    if (audit.problems.length > 0) {
      lines.push(`  - Problems: ${audit.problems.join("; ")}`);
    }
  }
  lines.push("");
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function wordsOf(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[a-z0-9+]+/g) ?? []);
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}
