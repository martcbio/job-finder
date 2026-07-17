import { existsSync, readdirSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_RESUME3_ROOT = "/Users/mcb/Claudelocal/careers/resume3";
export const DEFAULT_FRAGMENT_LIMIT = 7;

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "our",
  "that",
  "the",
  "their",
  "this",
  "to",
  "we",
  "will",
  "with",
  "you",
  "your",
]);

export interface StageApplication {
  id: string;
  org: string | null;
  ats: string | null;
  external_id: string | null;
  source: "lab-openings" | "jobserve" | "manual";
  title: string;
  company: string;
  url: string | null;
  status: string;
  status_history: Array<{ status: string; at: string; by: string }>;
  cv_ref: string | null;
  notes: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface CvJobSource {
  title: string;
  company: string;
  description: string | null;
  descriptionSource:
    | "local_job_page"
    | "local_observation"
    | "lab_opening_raw"
    | "application_only";
}

export interface ResumeFragment {
  index: number;
  lane: string;
  tags: string[];
  text: string;
}

export interface ScoredResumeFragment extends ResumeFragment {
  score: number;
  keywordMatches: string[];
  tagMatches: string[];
}

export interface ResumeProcessSpec {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  label: "sync" | "compose";
}

export interface CvStageResult {
  application: StageApplication;
  caseRef: string;
  caseDir: string;
  sourcePath: string;
  htmlPaths: string[];
  pdfPaths: string[];
  renderStatus: "dummy_rendered";
  identity: "dummy";
  description: {
    available: boolean;
    source: CvJobSource["descriptionSource"];
  };
  fragments: {
    available: number;
    selected: number;
  };
}

export interface CvStageDependencies {
  resolveJobSource: (application: StageApplication) => Promise<CvJobSource>;
  patchCvRef: (applicationId: string, cvRef: string) => Promise<StageApplication>;
  transitionToCvStaged: (applicationId: string) => Promise<StageApplication>;
  runProcess?: (spec: ResumeProcessSpec) => Promise<void>;
}

export interface CvStageOptions {
  resume3Root?: string;
  fragmentLimit?: number;
  processEnv?: NodeJS.ProcessEnv;
}

function tokens(value: string): string[] {
  return [
    ...new Set(
      value
        .toLowerCase()
        .replace(/<[^>]+>/g, " ")
        .replace(/\*\*|__|`/g, " ")
        .match(/[a-z0-9][a-z0-9+#.-]*/g)
        ?.map((token) => token.replace(/^[.-]+|[.-]+$/g, ""))
        .filter((token) => token.length > 1 && !STOP_WORDS.has(token)) ?? [],
    ),
  ];
}

export function parseResumeFragments(markdown: string): ResumeFragment[] {
  const fragments: ResumeFragment[] = [];
  let lane = "unclassified";
  let tags: string[] = [];

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    const heading = line.match(/^##\s+(.+)$/);
    if (heading) {
      lane = heading[1]?.trim() || "unclassified";
      tags = tokens(lane);
      continue;
    }
    const tagComment = line.match(/^<!--\s*tags?:\s*(.*?)\s*-->$/i);
    if (tagComment) {
      tags = [...new Set([...tokens(lane), ...tokens(tagComment[1] ?? "")])];
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (!bullet) continue;
    fragments.push({
      index: fragments.length,
      lane,
      tags: [...tags],
      text: bullet[1]?.trim() ?? "",
    });
  }

  return fragments.filter((fragment) => fragment.text.length > 0);
}

export function scoreResumeFragment(
  fragment: ResumeFragment,
  jobText: string,
): ScoredResumeFragment {
  const jobTokens = new Set(tokens(jobText));
  const keywordMatches = tokens(fragment.text).filter((token) => jobTokens.has(token));
  const tagMatches = fragment.tags.filter((tag) => jobTokens.has(tag));
  return {
    ...fragment,
    score: keywordMatches.length * 2 + tagMatches.length * 4,
    keywordMatches,
    tagMatches,
  };
}

export function selectResumeFragments(
  fragments: ResumeFragment[],
  jobText: string,
  limit = DEFAULT_FRAGMENT_LIMIT,
): ScoredResumeFragment[] {
  return fragments
    .map((fragment) => scoreResumeFragment(fragment, jobText))
    .filter((fragment) => fragment.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, limit);
}

function markdownSafe(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

export function buildRecentMarkdown(
  application: StageApplication,
  selected: ScoredResumeFragment[],
  availableCount: number,
): string {
  const audit = selected.length
    ? selected.map(
        (fragment, position) =>
          `<!-- rank=${position + 1} score=${fragment.score} lane=${JSON.stringify(fragment.lane)} keywords=${JSON.stringify(fragment.keywordMatches)} tags=${JSON.stringify(fragment.tagMatches)} -->`,
      )
    : ["<!-- no positive-overlap canonical fragments were available -->"];
  const bullets = selected.length
    ? selected.map((fragment) => `- ${fragment.text}`)
    : [
        `- Mechanical selection found no usable canonical fragments for ${markdownSafe(application.title)} at ${markdownSafe(application.company)}; refine this dummy draft before send.`,
      ];

  return [
    "# Adaptive layer",
    "",
    "<!-- mechanically selected v1 — refine before send -->",
    "<!-- score = 2 per shared bullet keyword + 4 per shared lane/tag keyword; zero-score bullets are excluded; ties keep canonical order -->",
    `<!-- canonical fragments available=${availableCount}; selected=${selected.length} -->`,
    ...audit,
    "",
    "## Experience",
    "",
    "### Mechanically Selected Evidence",
    `organization: ${markdownSafe(application.company)}`,
    "location: Role-specific selection",
    `role: ${markdownSafe(application.title)}`,
    "dates: Draft staging only",
    "",
    ...bullets,
    "",
  ].join("\n");
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64)
      .replace(/-+$/g, "") || "application"
  );
}

export function caseNameForApplication(application: StageApplication): string {
  if (!/^[1-9]\d*$/.test(application.id)) {
    throw new Error(`Application id must be a positive integer; got ${application.id}`);
  }
  return `app-${application.id}-${slug(`${application.company}-${application.title}`)}`;
}

export function buildComposition(application: StageApplication, caseName: string) {
  return {
    job_id: `app-${application.id}`,
    job_slug: caseName,
    application_note: `[[Application ${application.id} - ${application.company} - ${application.title}]]`,
    profile_label: application.title,
    sync_from: { resume_root: "../../../resume" },
    recipe: {
      experience_order: ["recent", "historical"],
      historical_include: [],
    },
    layers: {
      historical: "inputs/historical",
      adaptive: "inputs/recent.md",
      education_languages: "inputs/education-languages.md",
    },
    overrides: {
      identity: null,
      historical: null,
      education_languages: null,
    },
    output: { source: "outputs/source.md" },
    render: {
      html_dir: "outputs/html",
      pdf_dir: "outputs/pdf",
      catalog: "preferred",
    },
  };
}

function childEnvironment(base: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !key.startsWith("RESUME_IDENTITY")) env[key] = value;
  }
  env.AGENT_MODE = "1";
  if (!env.CHROME_BIN) {
    const headlessShell = findRepoLocalHeadlessShell();
    if (headlessShell) env.CHROME_BIN = headlessShell;
  }
  return env;
}

// resume3 refuses mac .app browser bundles for PDF rendering (correctly); a
// standalone chrome-headless-shell lives in resume3's puppeteer cache dir.
function findRepoLocalHeadlessShell(resume3Root = DEFAULT_RESUME3_ROOT): string | null {
  const cacheRoot = path.join(resume3Root, "chrome-headless-shell");
  if (!existsSync(cacheRoot)) return null;
  for (const version of readdirSync(cacheRoot).sort().reverse()) {
    const candidate = path.join(
      cacheRoot,
      version,
      "chrome-headless-shell-mac-arm64",
      "chrome-headless-shell",
    );
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function buildResume3ProcessSpecs(
  caseDir: string,
  resume3Root = DEFAULT_RESUME3_ROOT,
  baseEnv: NodeJS.ProcessEnv = process.env,
): { sync: ResumeProcessSpec; compose: ResumeProcessSpec } {
  const env = childEnvironment(baseEnv);
  return {
    sync: {
      argv: [
        "node",
        path.join(resume3Root, "scripts/sync_job_inputs.js"),
        caseDir,
        "--identity=dummy",
      ],
      cwd: resume3Root,
      env: { ...env },
      label: "sync",
    },
    compose: {
      argv: [
        "node",
        path.join(resume3Root, "scripts/compose_job_cv.js"),
        caseDir,
        "--render",
        "--identity=dummy",
      ],
      cwd: resume3Root,
      env: { ...env },
      label: "compose",
    },
  };
}

export async function runResume3Process(spec: ResumeProcessSpec): Promise<void> {
  const processHandle = Bun.spawn(spec.argv, {
    cwd: spec.cwd,
    env: spec.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    processHandle.exited,
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(
      [
        `resume3 ${spec.label} failed with exit ${exitCode}: ${spec.argv.join(" ")}`,
        stdout.trim() ? `stdout:\n${stdout.trim()}` : "stdout: <empty>",
        stderr.trim() ? `stderr:\n${stderr.trim()}` : "stderr: <empty>",
      ].join("\n"),
    );
  }
}

async function generatedFiles(directory: string, extension: string): Promise<string[]> {
  const names = await readdir(directory);
  return names
    .filter((name) => name.endsWith(extension))
    .sort()
    .map((name) => path.join(directory, name));
}

export async function finalizeApplicationCvStage(
  applicationId: string,
  caseRef: string,
  dependencies: Pick<CvStageDependencies, "patchCvRef" | "transitionToCvStaged">,
): Promise<StageApplication> {
  await dependencies.patchCvRef(applicationId, caseRef);
  return dependencies.transitionToCvStaged(applicationId);
}

export async function stageApplicationCv(
  application: StageApplication,
  dependencies: CvStageDependencies,
  options: CvStageOptions = {},
): Promise<CvStageResult> {
  if (application.status !== "shortlisted") {
    throw new Error(
      `Application ${application.id} must be shortlisted before CV staging; current status is ${application.status}.`,
    );
  }

  const resume3Root = path.resolve(options.resume3Root ?? DEFAULT_RESUME3_ROOT);
  const applyRoot = path.join(resume3Root, "pipeline/apply");
  const caseName = caseNameForApplication(application);
  const caseDir = path.join(applyRoot, caseName);
  const caseRef = path.posix.join("pipeline/apply", caseName);
  const inputsDir = path.join(caseDir, "inputs");
  const outputsDir = path.join(caseDir, "outputs");
  await mkdir(inputsDir, { recursive: true });
  await mkdir(outputsDir, { recursive: true });

  await writeFile(
    path.join(caseDir, "composition.json"),
    `${JSON.stringify(buildComposition(application, caseName), null, 2)}\n`,
    "utf8",
  );

  const processSpecs = buildResume3ProcessSpecs(
    caseDir,
    resume3Root,
    options.processEnv ?? process.env,
  );
  const runProcess = dependencies.runProcess ?? runResume3Process;
  await runProcess(processSpecs.sync);

  const jobSource = await dependencies.resolveJobSource(application);
  const fragmentMarkdown = await readFile(
    path.join(resume3Root, "resume/resume-fragments.md"),
    "utf8",
  );
  const fragments = parseResumeFragments(fragmentMarkdown);
  const jobText = [jobSource.title, jobSource.company, jobSource.description ?? ""].join("\n");
  const selected = selectResumeFragments(
    fragments,
    jobText,
    options.fragmentLimit ?? DEFAULT_FRAGMENT_LIMIT,
  );
  await writeFile(
    path.join(inputsDir, "recent.md"),
    buildRecentMarkdown(application, selected, fragments.length),
    "utf8",
  );

  await runProcess(processSpecs.compose);
  const sourcePath = path.join(outputsDir, "source.md");
  await readFile(sourcePath, "utf8");
  const htmlPaths = await generatedFiles(path.join(outputsDir, "html"), ".html");
  const pdfPaths = await generatedFiles(path.join(outputsDir, "pdf"), ".pdf");
  if (htmlPaths.length === 0 || pdfPaths.length === 0) {
    throw new Error(
      `resume3 compose completed without both dummy HTML and PDF outputs in ${outputsDir}`,
    );
  }

  const transitioned = await finalizeApplicationCvStage(application.id, caseRef, dependencies);
  return {
    application: transitioned,
    caseRef,
    caseDir,
    sourcePath,
    htmlPaths,
    pdfPaths,
    renderStatus: "dummy_rendered",
    identity: "dummy",
    description: {
      available: Boolean(jobSource.description?.trim()),
      source: jobSource.descriptionSource,
    },
    fragments: { available: fragments.length, selected: selected.length },
  };
}
