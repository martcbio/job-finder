import { describe, expect, test } from "bun:test";
import {
  buildExtractableJobsSql,
  buildRecordSkillSignalsSql,
  extractSkillSignals,
  SKILL_EXTRACTOR_VERSION,
} from "../skillSignals";

describe("extractSkillSignals", () => {
  test("extracts concrete signals with evidence lines", () => {
    const signals = extractSkillSignals({
      title: "AI Engineer - AWS Bedrock - Evaluation Harness - LLM",
      description: [
        "You will build LLM-backed applications with agentic workflows.",
        "Experience with RAG and vector databases required.",
        "Design evaluation frameworks for LLM-based systems.",
      ].join("\n"),
    });

    const names = signals.map((signal) => signal.signal);
    expect(names).toContain("llm application development");
    expect(names).toContain("agentic workflow orchestration");
    expect(names).toContain("retrieval and grounding systems");
    expect(names).toContain("aws ai cloud stack");

    const rag = signals.find((signal) => signal.signal === "retrieval and grounding systems");
    expect(rag?.evidence).toContain("vector databases");
  });

  test("returns one match per signal even with repeated mentions", () => {
    const signals = extractSkillSignals({
      title: "Agentic engineer",
      description: "agentic agentic ai agents multi-agent agent orchestration",
    });
    const agentic = signals.filter((signal) => signal.signal === "agentic workflow orchestration");
    expect(agentic).toHaveLength(1);
  });

  test("falls back to vague keyword when AI appears without concrete signals", () => {
    const signals = extractSkillSignals({
      title: "AI Engineer - Trading Analytics",
      description: "An exciting AI opportunity in a fast-paced environment.",
    });
    expect(signals.some((signal) => signal.signal === "vague ai mention without concrete system")).toBe(
      true,
    );
  });

  test("emits no vague fallback when text has no AI language", () => {
    const signals = extractSkillSignals({
      title: "Plumber",
      description: "Fix pipes. Full time.",
    });
    expect(signals).toHaveLength(0);
  });

  test("domain context alone still counts as non-concrete", () => {
    const signals = extractSkillSignals({
      title: "AI Lead",
      description: "Join a top hedge fund using AI.",
    });
    expect(signals.some((signal) => signal.signal === "vague ai mention without concrete system")).toBe(
      true,
    );
    expect(signals.some((signal) => signal.signal === "financial services regulated domain")).toBe(true);
  });
});

describe("buildRecordSkillSignalsSql", () => {
  test("escapes quotes and records the extraction ledger", () => {
    const sql = buildRecordSkillSignalsSql("42", [
      {
        signal: "llm application development",
        kind: "required_skill",
        confidence: "high",
        evidence: "you'll build LLM apps",
      },
    ]);
    expect(sql).toContain("you''ll build LLM apps");
    expect(sql).toContain("ON CONFLICT (job_id, normalized_signal, signal_kind, extractor) DO NOTHING");
    expect(sql).toContain("job_skill_extractions");
    expect(sql).toContain(SKILL_EXTRACTOR_VERSION);
  });

  test("records a zero-signal extraction without inserting signals", () => {
    const sql = buildRecordSkillSignalsSql("7", []);
    expect(sql).not.toContain("job_skill_signals\n");
    expect(sql).toContain("VALUES (7, 'lexicon-v1', 0)");
  });

  test("rejects non-numeric job ids", () => {
    expect(() => buildRecordSkillSignalsSql("7; DROP TABLE jobs", [])).toThrow();
  });
});

describe("buildExtractableJobsSql", () => {
  test("filters by extractor ledger and bounds the batch", () => {
    const sql = buildExtractableJobsSql(50);
    expect(sql).toContain("job_skill_extractions");
    expect(sql).toContain("LIMIT 50");
    expect(sql).toContain("'lexicon-v1'");
  });
});
