import { runPsql, runPsqlJson, withPsqlClientCleanup } from "../src/db/psql";
import {
  buildClusterJobStatsSql,
  buildExtractionTotalsSql,
  buildSkillSignalCountsSql,
  buildSkillSignalPairsSql,
  clusterSignals,
  computeOverlaps,
  DEFAULT_CLUSTER_OPTIONS,
  renderSkillClustersMarkdown,
  type SignalCountRow,
  type SignalPairRow,
  type SkillClusterReport,
} from "../src/pipeline/skillClusters";
import {
  buildExtractableJobsSql,
  buildRecordSkillSignalsSql,
  type ExtractableJobRow,
  extractSkillSignals,
} from "../src/pipeline/skillSignals";

function readNumberFlag(args: string[], name: string, fallback: number): number {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = Number.parseInt(args[index + 1] ?? "", 10);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  const extractLimit = readNumberFlag(args, "--extract-limit", 500);
  const asJson = args.includes("--json");

  // Phase 1: extract signals from any jobs the lexicon has not seen yet.
  let extractedThisRun = 0;
  let signalsThisRun = 0;
  while (extractedThisRun < extractLimit) {
    const batchLimit = Math.min(200, extractLimit - extractedThisRun);
    const rows = await runPsqlJson<ExtractableJobRow[]>(buildExtractableJobsSql(batchLimit));
    if (rows.length === 0) break;
    for (const row of rows) {
      const signals = extractSkillSignals({ title: row.title, description: row.description_text });
      await runPsql(buildRecordSkillSignalsSql(row.id, signals));
      extractedThisRun += 1;
      signalsThisRun += signals.length;
    }
    if (rows.length < batchLimit) break;
  }

  // Phase 2: recompute counts, overlaps, clusters.
  const totals = await runPsqlJson<{ extracted_jobs: number; signalled_jobs: number }>(
    buildExtractionTotalsSql(),
  );
  const counts = await runPsqlJson<SignalCountRow[]>(buildSkillSignalCountsSql());
  const pairs = await runPsqlJson<SignalPairRow[]>(
    buildSkillSignalPairsSql(DEFAULT_CLUSTER_OPTIONS.minShared),
  );
  const overlaps = computeOverlaps(counts, pairs);
  const clusterShapes = clusterSignals(counts, overlaps);

  let clusterStats: { cluster: string; jobs: number; top_companies: string[] }[] = [];
  if (clusterShapes.length > 0) {
    clusterStats = await runPsqlJson<{ cluster: string; jobs: number; top_companies: string[] }[]>(
      buildClusterJobStatsSql(clusterShapes),
    );
  }
  const statsByName = new Map(clusterStats.map((row) => [row.cluster, row]));

  const report: SkillClusterReport = {
    generatedAt: new Date().toISOString(),
    extractedJobs: totals.extracted_jobs,
    signalledJobs: totals.signalled_jobs,
    signals: counts,
    overlaps,
    clusters: clusterShapes.map((cluster) => ({
      ...cluster,
      jobs: statsByName.get(cluster.name)?.jobs ?? 0,
      topCompanies: statsByName.get(cluster.name)?.top_companies ?? [],
    })),
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.error(
      `extracted ${extractedThisRun} new jobs this run (${signalsThisRun} signals); corpus: ${totals.extracted_jobs} jobs scanned`,
    );
    console.log(renderSkillClustersMarkdown(report));
  }
}

withPsqlClientCleanup(run).catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});
