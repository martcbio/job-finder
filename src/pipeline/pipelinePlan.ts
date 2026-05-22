export const PIPELINE_STEPS = [
  "db_check",
  "search",
  "ingest_pages",
  "classify",
  "duplicates",
  "queue",
] as const;

export type PipelineStepName = (typeof PIPELINE_STEPS)[number];

export interface PipelinePlanOptions {
  keywords: string[];
  sites: string[];
  timeFilter: string;
  includeRemote: boolean;
  location: string | null;
  maxQueries: number;
  searchLimit: number;
  searchTimeoutMs: number;
  pageLimit: number;
  pageTimeoutMs: number;
  classifyLimit: number;
  duplicateLimit: number;
  duplicateThreshold: number;
  queueLimit: number;
  skipSteps: PipelineStepName[];
}

export interface PipelineStep {
  name: PipelineStepName;
  description: string;
  command: string[];
}

export function isPipelineStepName(value: string): value is PipelineStepName {
  return (PIPELINE_STEPS as readonly string[]).includes(value);
}

export function buildPipelinePlan(options: PipelinePlanOptions): PipelineStep[] {
  const steps: PipelineStep[] = [
    {
      name: "db_check",
      description: "Verify local Postgres schema and pending migrations.",
      command: ["bun", "run", "db:check"],
    },
    {
      name: "search",
      description: "Run configured source fanout and persist search results.",
      command: buildSearchCommand(options),
    },
    {
      name: "ingest_pages",
      description: "Ingest full job pages using ATS metadata first, then Jina Reader.",
      command: [
        "bun",
        "run",
        "jobs:ingest-pages",
        "--",
        "--limit",
        String(options.pageLimit),
        "--timeout-ms",
        String(options.pageTimeoutMs),
      ],
    },
    {
      name: "classify",
      description: "Classify unclassified jobs into non-destructive labels.",
      command: ["bun", "run", "jobs:classify", "--", "--limit", String(options.classifyLimit)],
    },
    {
      name: "duplicates",
      description: "Store possible duplicate relationships without suppressing jobs.",
      command: [
        "bun",
        "run",
        "jobs:duplicates",
        "--",
        "--limit",
        String(options.duplicateLimit),
        "--threshold",
        String(options.duplicateThreshold),
      ],
    },
    {
      name: "queue",
      description: "Print the current human review queue.",
      command: ["bun", "run", "jobs:queue", "--", "--limit", String(options.queueLimit)],
    },
  ];

  const skip = new Set(options.skipSteps);
  return steps.filter((step) => !skip.has(step.name));
}

export function shellQuoteArgs(args: string[]): string {
  return args.map(shellQuoteArg).join(" ");
}

function buildSearchCommand(options: PipelinePlanOptions): string[] {
  const command = ["bun", "run", "search:db", "--"];

  for (const keyword of options.keywords) {
    command.push("-k", keyword);
  }

  for (const site of options.sites) {
    command.push("--site", site);
  }

  command.push("--time", options.timeFilter);
  command.push("--max-queries", String(options.maxQueries));
  command.push("--limit", String(options.searchLimit));
  command.push("--timeout-ms", String(options.searchTimeoutMs));

  if (!options.includeRemote) {
    command.push("--exclude-remote");
  }

  if (options.location !== null) {
    command.push("--location", options.location);
  }

  return command;
}

function shellQuoteArg(arg: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(arg)) return arg;
  return `'${arg.replaceAll("'", "'\"'\"'")}'`;
}
