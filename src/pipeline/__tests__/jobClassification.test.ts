import { describe, expect, test } from "bun:test";
import {
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
  });

  test("classifies FDE roles before generic agent roles", () => {
    const classification = classifyJobText({
      title: "Forward Deployed Engineer, AI Agents",
      description: "Work with enterprise customers to ship agent workflows.",
    });

    expect(classification.category).toBe("fde");
    expect(classification.enterpriseFocus).toBe("yes");
  });

  test("classifies inference roles", () => {
    const classification = classifyJobText({
      title: "Inference Engineer",
      description: "Build vLLM and Triton serving systems for low latency model serving.",
    });

    expect(classification.category).toBe("inference_engineer");
  });
});

describe("classification SQL builders", () => {
  test("builds classifiable job query", () => {
    const sql = buildClassifiableJobsSql(20);

    expect(sql).toContain("WHERE j.category = 'unclassified'");
    expect(sql).toContain("LEFT JOIN job_search.job_pages jp");
    expect(sql).toContain("LIMIT 20");
  });

  test("builds classification update", () => {
    const sql = buildUpdateJobClassificationSql("42", {
      category: "agentic_engineer",
      ragFocus: "yes",
      enterpriseFocus: "no",
      confidence: 0.742,
      reason: "agent's signal",
    });

    expect(sql).toContain("WHERE id = '42'");
    expect(sql).toContain("category = 'agentic_engineer'");
    expect(sql).toContain("classification_confidence = 0.7420");
    expect(sql).toContain("classification_reason = 'agent''s signal'");
  });
});
