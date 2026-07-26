import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

export const DEFAULT_RESUME4_ROOT = "/Users/mcb/Claudelocal/careers/resume4";

/**
 * Legacy root, kept only so historical `cv_ref` values written by the retired
 * resume3 bridge still resolve to a directory. Nothing in this module executes
 * resume3 code any more.
 */
export const LEGACY_RESUME3_ROOT = "/Users/mcb/Claudelocal/careers/resume3";

/**
 * resume4-staged cv_ref values carry this prefix. Legacy resume3 values are
 * bare relative paths (`pipeline/apply/...`), so the prefix is the whole
 * discriminator and no data migration is required.
 */
export const RESUME4_CV_REF_PREFIX = "resume4:";

export type CvRefKind = "resume4-staged" | "resume3-legacy";

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

export interface ParsedCvRef {
  kind: CvRefKind;
  /** Path relative to the owning repository root. */
  relativePath: string;
  /** Repository root the relative path is anchored to. */
  root: string;
  /** Absolute path on disk. */
  absolutePath: string;
}

/**
 * Reads either cv_ref generation. New rows look like
 * `resume4:applications/jobserve/2E38-agentic-ai-engineer`; legacy rows look
 * like `pipeline/apply/app-42-acme-agentic-ai-engineer`.
 */
export function parseCvRef(
  cvRef: string,
  roots: { resume4Root?: string; resume3Root?: string } = {},
): ParsedCvRef {
  const resume4Root = path.resolve(roots.resume4Root ?? DEFAULT_RESUME4_ROOT);
  const resume3Root = path.resolve(roots.resume3Root ?? LEGACY_RESUME3_ROOT);
  if (cvRef.startsWith(RESUME4_CV_REF_PREFIX)) {
    const relativePath = cvRef.slice(RESUME4_CV_REF_PREFIX.length);
    return {
      kind: "resume4-staged",
      relativePath,
      root: resume4Root,
      absolutePath: path.join(resume4Root, relativePath),
    };
  }
  return {
    kind: "resume3-legacy",
    relativePath: cvRef,
    root: resume3Root,
    absolutePath: path.join(resume3Root, cvRef),
  };
}

export function cvRefKind(cvRef: string | null): CvRefKind | null {
  return cvRef ? parseCvRef(cvRef).kind : null;
}

export type CaptureMode = "job_markdown_stdin" | "job_url";

export interface Resume4ProcessSpec {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  stdin: string | null;
  label: "capture" | "prepare";
}

export interface ProcessOutput {
  stdout: string;
}

export interface CvStageResult {
  application: StageApplication;
  cvRef: string;
  cvRefKind: "resume4-staged";
  /** Path relative to the resume4 repository root. */
  applicationPath: string;
  /** Absolute path to the staged resume4 application directory. */
  applicationDir: string;
  resume4Root: string;
  capture: {
    mode: CaptureMode;
    site: string;
    jobId: string;
    role: string;
    url: string | null;
  };
  prepared: boolean;
  description: {
    available: boolean;
    source: CvJobSource["descriptionSource"];
  };
  /** The bridge stops at the human gate; it never produces a CV. */
  humanGate: "compose_and_facts";
  nextSteps: string[];
}

export interface CvStageDependencies {
  resolveJobSource: (application: StageApplication) => Promise<CvJobSource>;
  patchCvRef: (applicationId: string, cvRef: string) => Promise<StageApplication>;
  transitionToCvStaged: (applicationId: string) => Promise<StageApplication>;
  runProcess?: (spec: Resume4ProcessSpec) => Promise<ProcessOutput>;
}

export interface CvStageOptions {
  resume4Root?: string;
  processEnv?: NodeJS.ProcessEnv;
  /** Force a capture mode. `job_url` re-fetches over the network; stdin is the default. */
  captureMode?: CaptureMode;
  /**
   * Stage again over an existing resume4 application directory. Off by default:
   * re-preparation clears review artifacts and can destroy signed human work.
   */
  force?: boolean;
  /** Injectable filesystem probe, for tests that must not touch resume4. */
  fs?: { exists: (p: string) => boolean; list: (p: string) => string[] };
}

export function slugToken(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64)
      .replace(/-+$/g, "") || "application"
  );
}

/** resume4 rejects path tokens with separators or leading dots. */
export function safeToken(value: string, fallback: string): string {
  const token = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+|[.-]+$/g, "");
  return token.length > 0 ? token.slice(0, 64) : fallback;
}

/** A URL good enough to hand to resume4's fetcher: plain http(s), no auth, no fragment junk. */
export function isCleanSourceUrl(value: string | null): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.hostname.length > 0 &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

export function captureSiteForApplication(application: StageApplication): string {
  if (application.source === "jobserve") return "jobserve";
  if (application.source === "lab-openings") {
    return safeToken(application.ats ?? application.org ?? "lab-openings", "lab-openings");
  }
  return "manual";
}

export function captureJobIdForApplication(application: StageApplication): string {
  const external = application.external_id?.trim();
  if (external) return safeToken(external, `app-${application.id}`);
  return safeToken(`app-${application.id}`, `app-${application.id}`);
}

/**
 * The Markdown handed to resume4 on stdin. resume4 treats it as untrusted
 * evidence, so this is a plain snapshot with no instructions to the model.
 */
export function buildJobMarkdown(application: StageApplication, jobSource: CvJobSource): string {
  const title = (jobSource.title || application.title).replace(/[\r\n]+/g, " ").trim();
  const company = (jobSource.company || application.company).replace(/[\r\n]+/g, " ").trim();
  const lines = [`# ${title}`, "", `Company: ${company}`];
  if (application.url) lines.push(`Source: ${application.url}`);
  lines.push(
    "",
    `<!-- staged from job-finder application ${application.id}; description source=${jobSource.descriptionSource} -->`,
    "",
  );
  lines.push(
    jobSource.description?.trim() ||
      "No stored job description was available for this posting; the job row carried title and company only.",
    "",
  );
  return lines.join("\n");
}

function childEnvironment(base: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !key.startsWith("RESUME_IDENTITY")) env[key] = value;
  }
  env.AGENT_MODE = "1";
  return env;
}

export function buildCaptureSpec(
  application: StageApplication,
  jobSource: CvJobSource,
  mode: CaptureMode,
  resume4Root = DEFAULT_RESUME4_ROOT,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Resume4ProcessSpec {
  const site = captureSiteForApplication(application);
  const jobId = captureJobIdForApplication(application);
  const role = (jobSource.title || application.title).replace(/[\r\n]+/g, " ").trim();
  const argv =
    mode === "job_url" && application.url
      ? ["npm", "run", "resume", "--", "new", "--url", application.url]
      : ["npm", "run", "resume", "--", "new", "--site", site, "--job-id", jobId, "--role", role];
  return {
    argv,
    cwd: resume4Root,
    env: childEnvironment(baseEnv),
    stdin: mode === "job_url" ? null : buildJobMarkdown(application, jobSource),
    label: "capture",
  };
}

export function buildPrepareSpec(
  applicationPath: string,
  resume4Root = DEFAULT_RESUME4_ROOT,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Resume4ProcessSpec {
  return {
    argv: ["npm", "run", "resume", "--", "prepare", applicationPath],
    cwd: resume4Root,
    env: childEnvironment(baseEnv),
    stdin: null,
    label: "prepare",
  };
}

export async function runResume4Process(spec: Resume4ProcessSpec): Promise<ProcessOutput> {
  const processHandle = Bun.spawn(spec.argv, {
    cwd: spec.cwd,
    env: spec.env,
    stdin: spec.stdin === null ? "ignore" : new TextEncoder().encode(spec.stdin),
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
        `resume4 ${spec.label} failed with exit ${exitCode}: ${spec.argv.join(" ")}`,
        stdout.trim() ? `stdout:\n${stdout.trim()}` : "stdout: <empty>",
        stderr.trim() ? `stderr:\n${stderr.trim()}` : "stderr: <empty>",
      ].join("\n"),
    );
  }
  return { stdout };
}

/**
 * `resume -- new` prints the absolute application directory as its last line.
 * npm may prepend its own banner lines, so take the last line that looks like
 * a path under the resume4 applications tree.
 */
export function parseCapturedApplicationDir(stdout: string, resume4Root: string): string {
  const applicationsRoot = path.join(path.resolve(resume4Root), "applications");
  const candidate = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(applicationsRoot))
    .pop();
  if (!candidate) {
    throw new Error(
      `resume4 capture did not print an application directory under ${applicationsRoot}.\nstdout:\n${stdout.trim() || "<empty>"}`,
    );
  }
  return candidate;
}

/**
 * Stdin is the default and near-universal path: the stored posting is
 * deterministic and needs no network. `--url` re-fetches live, so it is only
 * reachable by an explicit `captureMode` override on a clean http(s) URL.
 */
export function chooseCaptureMode(
  _application: StageApplication,
  _jobSource: CvJobSource,
): CaptureMode {
  return "job_markdown_stdin";
}

export interface ExistingStageEvidence {
  reason: "cv_ref" | "directory";
  detail: string;
}

/**
 * resume4's `new` uses mkdir(recursive:false) and `prepare` clears review
 * artifacts, so a second staging run can destroy signed human work. Refuse
 * before touching the CLI unless the caller explicitly forces it.
 */
export function findExistingStage(
  application: StageApplication,
  resume4Root: string,
  fs: { exists: (p: string) => boolean; list: (p: string) => string[] } = {
    exists: existsSync,
    list: readdirSync,
  },
): ExistingStageEvidence | null {
  if (application.cv_ref?.startsWith(RESUME4_CV_REF_PREFIX)) {
    return { reason: "cv_ref", detail: application.cv_ref };
  }
  const site = captureSiteForApplication(application);
  const jobId = captureJobIdForApplication(application);
  const siteDir = path.join(resume4Root, "applications", site);
  if (!fs.exists(siteDir)) return null;
  const match = fs.list(siteDir).find((name) => name === jobId || name.startsWith(`${jobId}-`));
  return match ? { reason: "directory", detail: path.join("applications", site, match) } : null;
}

export function nextStepsFor(applicationPath: string): string[] {
  return [
    `Human: compose into ${applicationPath}/working.md from ${applicationPath}/compose-packet.md (resume4).`,
    `Human: approve the fact registry, then run 'npm run resume -- sync-facts ${applicationPath}' in resume4.`,
    "Human: council, reconciliation, audits, Pro, and the sealed render stay in resume4; this bridge never renders a CV.",
  ];
}

export async function finalizeApplicationCvStage(
  applicationId: string,
  cvRef: string,
  dependencies: Pick<CvStageDependencies, "patchCvRef" | "transitionToCvStaged">,
): Promise<StageApplication> {
  await dependencies.patchCvRef(applicationId, cvRef);
  return dependencies.transitionToCvStaged(applicationId);
}

/**
 * Stages a job into resume4. This no longer produces a CV of any kind: resume4
 * is human-gated, so the bridge captures the posting, runs preparation, and
 * hands the human the next step.
 */
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

  const resume4Root = path.resolve(options.resume4Root ?? DEFAULT_RESUME4_ROOT);
  if (!options.force) {
    const existing = findExistingStage(application, resume4Root, options.fs);
    if (existing) {
      throw new Error(
        [
          `Application ${application.id} is already staged into resume4 (${existing.reason}: ${existing.detail}).`,
          "Re-staging runs resume4 prepare again, which clears review artifacts and can destroy signed human work.",
          "Resume the existing application in resume4, or pass force explicitly if the directory is known to be disposable.",
        ].join(" "),
      );
    }
  }
  const runProcess = dependencies.runProcess ?? runResume4Process;
  const jobSource = await dependencies.resolveJobSource(application);
  const mode = options.captureMode ?? chooseCaptureMode(application, jobSource);
  const captureSpec = buildCaptureSpec(
    application,
    jobSource,
    mode,
    resume4Root,
    options.processEnv ?? process.env,
  );

  const captured = await runProcess(captureSpec);
  const applicationDir = parseCapturedApplicationDir(captured.stdout, resume4Root);
  const applicationPath = path.relative(resume4Root, applicationDir);
  if (applicationPath.startsWith("..") || path.isAbsolute(applicationPath)) {
    throw new Error(`resume4 capture escaped the repository root: ${applicationDir}`);
  }

  // `new` already prepares, but preparation is idempotent and the contract
  // requires classification/retrieval to have run before the human takes over.
  await runProcess(
    buildPrepareSpec(applicationPath, resume4Root, options.processEnv ?? process.env),
  );

  const cvRef = `${RESUME4_CV_REF_PREFIX}${applicationPath.split(path.sep).join("/")}`;
  const transitioned = await finalizeApplicationCvStage(application.id, cvRef, dependencies);

  return {
    application: transitioned,
    cvRef,
    cvRefKind: "resume4-staged",
    applicationPath,
    applicationDir,
    resume4Root,
    capture: {
      mode,
      site: captureSiteForApplication(application),
      jobId: captureJobIdForApplication(application),
      role: (jobSource.title || application.title).replace(/[\r\n]+/g, " ").trim(),
      url: mode === "job_url" ? application.url : null,
    },
    prepared: true,
    description: {
      available: Boolean(jobSource.description?.trim()),
      source: jobSource.descriptionSource,
    },
    humanGate: "compose_and_facts",
    nextSteps: nextStepsFor(applicationPath),
  };
}
