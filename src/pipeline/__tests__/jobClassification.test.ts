import { describe, expect, test } from "bun:test";
import {
  buildClassifiableJobsForSearchRunSql,
  buildClassifiableJobsSql,
  buildUpdateJobClassificationSql,
  classifyJobText,
} from "../jobClassification";

describe("classifyJobText", () => {
  test("classifies agentic architect roles with RAG focus", () => {
    const classification = classifyJobText({
      title: "Principal Agentic AI Architect",
      description:
        "Own LLM agent architecture, retrieval augmented generation, and vector database patterns.",
    });

    expect(classification.category).toBe("agentic_architect");
    expect(classification.ragFocus).toBe("yes");
    expect(classification.confidence).toBeGreaterThan(0.75);
    expect(classification.sourceStage).toBe("metadata");
    expect(classification.labels.map((label) => label.label)).toContain("agentic_architect");
  });

  test("classifies FDE roles before generic agent roles", () => {
    const classification = classifyJobText({
      title: "Forward Deployed Engineer, AI Agents",
      description: "Work with enterprise customers to ship retrieval agent workflows.",
    });

    expect(classification.category).toBe("fde");
    expect(classification.enterpriseFocus).toBe("yes");
    expect(classification.labels.map((label) => label.label)).toContain("fde");
    expect(classification.labels.map((label) => label.label)).toContain("rag_enterprise");
  });

  test("classifies inference roles", () => {
    const classification = classifyJobText({
      title: "Inference Engineer",
      description: "Build vLLM and Triton serving systems for low latency model serving.",
    });

    expect(classification.category).toBe("inference_engineer");
    expect(classification.labels.map((label) => label.label)).toContain("inference_engineer");
  });

  test("emits a broad multi-label set without forcing a single fit decision", () => {
    const classification = classifyJobText({
      title: "Founding AI Engineer, Developer Platform",
      description:
        "Build agentic LLM applications, SDKs, APIs, RAG workflows, and enterprise compliance features.",
      hasPageSnapshot: true,
    });

    expect(classification.sourceStage).toBe("page");
    expect(classification.category).toBe("agentic_engineer");
    expect(classification.labels.map((label) => label.label)).toEqual(
      expect.arrayContaining([
        "agentic_engineer",
        "founding_engineer",
        "backend_product_engineering",
        "developer_tools",
        "rag_enterprise",
      ]),
    );
  });

  test("classifies AI automation engineering as an agentic adjacent role", () => {
    const classification = classifyJobText({
      title: "AI Automation Engineer",
      description:
        "Build internal platform automations with agentic workflows, Workato, APIs, and process automation for business teams.",
    });

    expect(classification.category).toBe("agentic_engineer");
    expect(classification.labels.map((label) => label.label)).toEqual(
      expect.arrayContaining([
        "business_automation_ai",
        "internal_ai_tooling",
        "backend_product_engineering",
      ]),
    );
  });

  test("keeps AI enablement and workplace roles visible as labels", () => {
    const classification = classifyJobText({
      title: "Software Engineer - AI Enablement and Workplace Technology",
      description:
        "Own internal AI tools, employee productivity AI, Gemini Enterprise rollout, Microsoft Copilot adoption, and developer acceleration.",
    });

    expect(classification.labels.map((label) => label.label)).toEqual(
      expect.arrayContaining([
        "ai_enablement",
        "internal_ai_tooling",
        "workplace_ai",
        "ai_adoption_transformation",
      ]),
    );
  });

  test("captures AI operations and transformation roles without requiring a fit decision", () => {
    const classification = classifyJobText({
      title: "AI Operations Lead",
      description:
        "Lead AI operations, internal AI transformation, workflow automation, change management, and business automation across teams.",
    });

    expect(classification.category).toBe("other");
    expect(classification.labels.map((label) => label.label)).toEqual(
      expect.arrayContaining([
        "ai_operations",
        "business_automation_ai",
        "ai_adoption_transformation",
      ]),
    );
  });
});

describe("classification SQL builders", () => {
  test("builds classifiable job query", () => {
    const sql = buildClassifiableJobsSql(20);

    expect(sql).toContain("WHERE j.category = 'unclassified'");
    expect(sql).toContain("LEFT JOIN job_search.job_pages jp");
    expect(sql).toContain("LIMIT 20");
  });

  test("builds run-scoped classifiable job query", () => {
    const sql = buildClassifiableJobsForSearchRunSql(77, 20);

    expect(sql).toContain("sq.run_id = 77");
    expect(sql).toContain("JOIN job_search.search_runs search_run ON search_run.id = sq.run_id");
    expect(sql).toContain("JOIN job_search.search_results sr ON sr.query_id = sq.id");
    expect(sql).toContain("JOIN job_search.job_observations jo ON jo.search_result_id = sr.id");
    expect(sql).toContain("jp.fetched_at >= search_run.started_at");
    expect(sql).toContain("WHERE sq.run_id = 77");
    expect(sql).toContain("j.category = 'unclassified'");
    expect(sql).toContain("LIMIT 20");
  });

  test("builds classification update", () => {
    const sql = buildUpdateJobClassificationSql("42", {
      category: "agentic_engineer",
      ragFocus: "yes",
      enterpriseFocus: "no",
      confidence: 0.742,
      reason: "agent's signal",
      sourceStage: "metadata",
      labels: [
        {
          label: "agentic_engineer",
          confidence: 0.742,
          reason: "agent's signal",
        },
      ],
    });

    expect(sql).toContain("WHERE id = '42'");
    expect(sql).toContain("category = 'agentic_engineer'");
    expect(sql).toContain("classification_confidence = 0.7420");
    expect(sql).toContain("classification_reason = 'agent''s signal'");
    expect(sql).toContain("review_state = CASE");
    expect(sql).toContain("THEN 'ready_for_review'");
    expect(sql).toContain("INSERT INTO job_search.review_events");
    expect(sql).toContain("ARRAY['classified', 'metadata']::text[]");
    expect(sql).toContain("DELETE FROM job_search.job_classification_labels");
    expect(sql).toContain("'agentic_engineer'");
    expect(sql).toContain("'metadata'");
  });
});
