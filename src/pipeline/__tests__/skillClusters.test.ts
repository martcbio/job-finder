import { describe, expect, test } from "bun:test";
import {
  buildClusterJobStatsSql,
  clusterSignals,
  computeOverlaps,
  renderSkillClustersMarkdown,
  type SignalCountRow,
  type SkillClusterReport,
} from "../skillClusters";

const COUNTS: SignalCountRow[] = [
  { signal: "llm application development", jobs: 20, companies: 12 },
  { signal: "agentic workflow orchestration", jobs: 15, companies: 10 },
  { signal: "retrieval and grounding systems", jobs: 8, companies: 6 },
  { signal: "snowflake databricks medallion", jobs: 5, companies: 4 },
];

describe("computeOverlaps", () => {
  test("computes jaccard from counts and shared jobs", () => {
    const overlaps = computeOverlaps(COUNTS, [
      { signal_a: "agentic workflow orchestration", signal_b: "llm application development", shared_jobs: 12 },
    ]);
    expect(overlaps).toHaveLength(1);
    const overlap = overlaps[0];
    expect(overlap?.shared).toBe(12);
    // union = 20 + 15 - 12 = 23
    expect(overlap?.jaccard).toBeCloseTo(12 / 23);
  });
});

describe("clusterSignals", () => {
  test("merges signals above both floors and names cluster by frequency", () => {
    const overlaps = computeOverlaps(COUNTS, [
      { signal_a: "agentic workflow orchestration", signal_b: "llm application development", shared_jobs: 12 },
      { signal_a: "llm application development", signal_b: "retrieval and grounding systems", shared_jobs: 7 },
    ]);
    const clusters = clusterSignals(COUNTS, overlaps, { minShared: 3, minJaccard: 0.3 });
    const main = clusters[0];
    expect(main?.name).toBe("llm application development");
    expect(main?.signals).toContain("agentic workflow orchestration");
    expect(main?.signals).toContain("retrieval and grounding systems");
    // databricks had no qualifying overlap: stays a singleton cluster
    expect(clusters.some((cluster) => cluster.name === "snowflake databricks medallion")).toBe(true);
  });

  test("keeps weak overlaps apart", () => {
    const overlaps = computeOverlaps(COUNTS, [
      { signal_a: "llm application development", signal_b: "snowflake databricks medallion", shared_jobs: 3 },
    ]);
    // jaccard = 3 / (20+5-3) = 0.136 < 0.3 → no merge
    const clusters = clusterSignals(COUNTS, overlaps, { minShared: 3, minJaccard: 0.3 });
    expect(clusters).toHaveLength(4);
  });

  test("excludes the vague-keyword noise signal from clustering", () => {
    const counts = [...COUNTS, { signal: "vague ai mention without concrete system", jobs: 30, companies: 20 }];
    const clusters = clusterSignals(counts, [], { minShared: 3, minJaccard: 0.3 });
    expect(clusters.some((cluster) => cluster.name.includes("vague"))).toBe(false);
  });
});

describe("buildClusterJobStatsSql", () => {
  test("maps signals to clusters via VALUES and escapes literals", () => {
    const sql = buildClusterJobStatsSql([
      { name: "llm application development", signals: ["llm application development", "agentic workflow orchestration"] },
    ]);
    expect(sql).toContain("VALUES ('llm application development', 'llm application development')");
    expect(sql).toContain("COUNT(DISTINCT s.job_id)");
    expect(sql).toContain("LIMIT 8");
  });
});

describe("renderSkillClustersMarkdown", () => {
  test("renders signals, overlaps, and clusters", () => {
    const report: SkillClusterReport = {
      generatedAt: "2026-06-12T00:00:00.000Z",
      extractedJobs: 100,
      signalledJobs: 80,
      signals: COUNTS,
      overlaps: computeOverlaps(COUNTS, [
        { signal_a: "agentic workflow orchestration", signal_b: "llm application development", shared_jobs: 12 },
      ]),
      clusters: [
        {
          name: "llm application development",
          signals: ["llm application development", "agentic workflow orchestration"],
          jobs: 23,
          topCompanies: ["Acme", "Globex"],
        },
      ],
    };
    const markdown = renderSkillClustersMarkdown(report);
    expect(markdown).toContain("# Job Market Skill Clusters");
    expect(markdown).toContain("Jobs scanned: 100 (80 with at least one signal)");
    expect(markdown).toContain("∩");
    expect(markdown).toContain("### llm application development — 23 jobs");
    expect(markdown).toContain("Top companies: Acme, Globex");
  });
});
