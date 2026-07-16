import { quoteSqlLiteral } from "../db/config";

export interface SignalCountRow {
  signal: string;
  jobs: number;
  companies: number;
}

export interface SignalPairRow {
  signal_a: string;
  signal_b: string;
  shared_jobs: number;
}

export interface SignalOverlap {
  a: string;
  b: string;
  jobsA: number;
  jobsB: number;
  shared: number;
  jaccard: number;
}

export interface SkillCluster {
  name: string;
  signals: string[];
  /** Distinct jobs carrying any signal in the cluster (filled from SQL). */
  jobs: number;
  topCompanies: string[];
}

export interface SkillClusterReport {
  generatedAt: string;
  extractedJobs: number;
  signalledJobs: number;
  signals: SignalCountRow[];
  overlaps: SignalOverlap[];
  clusters: SkillCluster[];
}

export interface ClusterOptions {
  /** Minimum shared jobs before a pair can merge two signals. */
  minShared: number;
  /** Minimum Jaccard similarity before a pair can merge two signals. */
  minJaccard: number;
}

export const DEFAULT_CLUSTER_OPTIONS: ClusterOptions = {
  minShared: 3,
  minJaccard: 0.3,
};

const NOISE_SIGNAL = "vague ai mention without concrete system";

export function buildSkillSignalCountsSql(): string {
  return `SELECT COALESCE(json_agg(row_to_json(count_row)), '[]'::json)
FROM (
  SELECT
    s.normalized_signal AS signal,
    COUNT(DISTINCT s.job_id)::int AS jobs,
    COUNT(DISTINCT j.company_hint)::int AS companies
  FROM job_search.job_skill_signals s
  JOIN job_search.jobs j ON j.id = s.job_id
  GROUP BY s.normalized_signal
  ORDER BY jobs DESC, signal
) count_row;`;
}

export function buildSkillSignalPairsSql(minShared: number): string {
  return `SELECT COALESCE(json_agg(row_to_json(pair_row)), '[]'::json)
FROM (
  WITH sig AS (
    SELECT DISTINCT job_id, normalized_signal
    FROM job_search.job_skill_signals
    WHERE normalized_signal <> ${quoteSqlLiteral(NOISE_SIGNAL)}
  )
  SELECT
    a.normalized_signal AS signal_a,
    b.normalized_signal AS signal_b,
    COUNT(*)::int AS shared_jobs
  FROM sig a
  JOIN sig b ON b.job_id = a.job_id AND b.normalized_signal > a.normalized_signal
  GROUP BY 1, 2
  HAVING COUNT(*) >= ${minShared}
  ORDER BY shared_jobs DESC, signal_a, signal_b
) pair_row;`;
}

export function buildExtractionTotalsSql(): string {
  return `SELECT row_to_json(totals_row)
FROM (
  SELECT
    (SELECT COUNT(*)::int FROM job_search.job_skill_extractions) AS extracted_jobs,
    (SELECT COUNT(DISTINCT job_id)::int FROM job_search.job_skill_signals) AS signalled_jobs
) totals_row;`;
}

export function buildClusterJobStatsSql(clusters: { name: string; signals: string[] }[]): string {
  const mappings = clusters.flatMap((cluster) =>
    cluster.signals.map(
      (signal) => `(${quoteSqlLiteral(signal)}, ${quoteSqlLiteral(cluster.name)})`,
    ),
  );
  return `SELECT COALESCE(json_agg(row_to_json(cluster_row)), '[]'::json)
FROM (
  SELECT
    m.cluster,
    COUNT(DISTINCT s.job_id)::int AS jobs,
    (
      SELECT COALESCE(json_agg(company), '[]'::json)
      FROM (
        SELECT j2.company_hint AS company
        FROM job_search.job_skill_signals s2
        JOIN job_search.jobs j2 ON j2.id = s2.job_id
        JOIN (VALUES ${mappings.join(", ")}) m2(signal, cluster) ON m2.signal = s2.normalized_signal
        WHERE m2.cluster = m.cluster AND j2.company_hint IS NOT NULL
        GROUP BY j2.company_hint
        ORDER BY COUNT(DISTINCT s2.job_id) DESC, j2.company_hint
        LIMIT 8
      ) top_companies
    ) AS top_companies
  FROM (VALUES ${mappings.join(", ")}) m(signal, cluster)
  JOIN job_search.job_skill_signals s ON s.normalized_signal = m.signal
  GROUP BY m.cluster
  ORDER BY jobs DESC
) cluster_row;`;
}

export function computeOverlaps(counts: SignalCountRow[], pairs: SignalPairRow[]): SignalOverlap[] {
  const jobsBySignal = new Map(counts.map((row) => [row.signal, row.jobs]));
  return pairs
    .map((pair) => {
      const jobsA = jobsBySignal.get(pair.signal_a) ?? 0;
      const jobsB = jobsBySignal.get(pair.signal_b) ?? 0;
      const union = jobsA + jobsB - pair.shared_jobs;
      return {
        a: pair.signal_a,
        b: pair.signal_b,
        jobsA,
        jobsB,
        shared: pair.shared_jobs,
        jaccard: union > 0 ? pair.shared_jobs / union : 0,
      };
    })
    .sort((left, right) => right.shared - left.shared || right.jaccard - left.jaccard);
}

/**
 * Greedy union-find agglomeration: signals merge into one cluster when their
 * overlap clears both the shared-job floor and the Jaccard floor. Cluster
 * names take the highest-frequency member signal.
 */
export function clusterSignals(
  counts: SignalCountRow[],
  overlaps: SignalOverlap[],
  options: ClusterOptions = DEFAULT_CLUSTER_OPTIONS,
): { name: string; signals: string[] }[] {
  const parent = new Map<string, string>();
  const find = (signal: string): string => {
    let root = signal;
    while (parent.get(root) !== undefined && parent.get(root) !== root) {
      root = parent.get(root) as string;
    }
    parent.set(signal, root);
    return root;
  };
  const union = (a: string, b: string): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootB, rootA);
  };

  for (const row of counts) {
    if (row.signal !== NOISE_SIGNAL) parent.set(row.signal, row.signal);
  }
  for (const overlap of overlaps) {
    if (overlap.shared < options.minShared || overlap.jaccard < options.minJaccard) continue;
    if (!parent.has(overlap.a) || !parent.has(overlap.b)) continue;
    union(overlap.a, overlap.b);
  }

  const members = new Map<string, string[]>();
  for (const signal of parent.keys()) {
    const root = find(signal);
    const list = members.get(root) ?? [];
    list.push(signal);
    members.set(root, list);
  }

  const jobsBySignal = new Map(counts.map((row) => [row.signal, row.jobs]));
  return [...members.values()]
    .map((signals) => {
      const sorted = [...signals].sort(
        (left, right) => (jobsBySignal.get(right) ?? 0) - (jobsBySignal.get(left) ?? 0),
      );
      return { name: sorted[0] as string, signals: sorted };
    })
    .sort(
      (left, right) => (jobsBySignal.get(right.name) ?? 0) - (jobsBySignal.get(left.name) ?? 0),
    );
}

export function renderSkillClustersMarkdown(report: SkillClusterReport): string {
  const lines: string[] = [
    "# Job Market Skill Clusters",
    "",
    `Generated: ${report.generatedAt}`,
    `Jobs scanned: ${report.extractedJobs} (${report.signalledJobs} with at least one signal)`,
    "",
    "## Demand Signals",
    "",
  ];
  for (const row of report.signals) {
    lines.push(`- ${row.signal}: ${row.jobs} jobs across ${row.companies} companies`);
  }

  lines.push("", "## Strongest Overlaps (venn pairs)", "");
  for (const overlap of report.overlaps.slice(0, 20)) {
    lines.push(
      `- ${overlap.a} (${overlap.jobsA}) ∩ ${overlap.b} (${overlap.jobsB}) = ${overlap.shared} shared jobs (jaccard ${overlap.jaccard.toFixed(2)})`,
    );
  }

  lines.push("", "## Clusters", "");
  for (const cluster of report.clusters) {
    lines.push(`### ${cluster.name} — ${cluster.jobs} jobs`, "");
    lines.push(`Signals: ${cluster.signals.join("; ")}`);
    if (cluster.topCompanies.length > 0) {
      lines.push(`Top companies: ${cluster.topCompanies.join(", ")}`);
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
