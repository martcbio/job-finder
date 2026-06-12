import { mkdir, readdir } from "node:fs/promises";
import { basename, resolve } from "node:path";
import {
  parseBlogPostsMarkdown,
  renderBlogQualityReview,
  reviewBlogPost,
  type BlogPostReview,
} from "../src/pipeline/marketBlogQuality";

interface Options {
  inputDir: string;
  outputDir: string | null;
  blogFile: string | null;
}

function parseOptions(args: string[]): Options {
  return {
    inputDir: readStringFlag(args, "--input") ?? "",
    outputDir: readStringFlag(args, "--output"),
    blogFile: readStringFlag(args, "--blog-file"),
  };
}

function readStringFlag(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function printUsage(): void {
  console.log(`Usage:
  bun run jobs:blog-lint -- --input artifacts/job-market/2026-06-07

Options:
  --input      Job-market artifact directory. Defaults to latest artifacts/job-market/YYYY-MM-DD.
  --blog-file  Blog post markdown file. Defaults to blog_posts.md, then blog_posts_curated.md.
  --output     Repo-local output directory. Defaults to <input>/blog-quality.`);
}

async function latestArtifactDir(): Promise<string> {
  const root = resolve("artifacts/job-market");
  const entries = await readdir(root, { withFileTypes: true });
  const dates = entries
    .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const latest = dates.at(-1);
  if (!latest) throw new Error("No artifacts/job-market/YYYY-MM-DD directories found");
  return resolve(root, latest);
}

function assertRepoLocalPath(path: string, label: string): string {
  const resolved = resolve(path);
  const root = process.cwd();
  if (resolved !== root && !resolved.startsWith(`${root}/`)) {
    throw new Error(`${label} must stay inside this project: ${path}`);
  }
  if (resolved.startsWith("/tmp/") || resolved.startsWith("/private/tmp/")) {
    throw new Error(`${label} must not be under /tmp`);
  }
  return resolved;
}

async function findBlogFile(inputDir: string, explicit: string | null): Promise<string> {
  if (explicit) return assertRepoLocalPath(explicit, "--blog-file");
  const candidates = [`${inputDir}/blog_posts.md`, `${inputDir}/blog_posts_curated.md`];
  for (const candidate of candidates) {
    const file = Bun.file(candidate);
    if (await file.exists()) return candidate;
  }
  throw new Error(`No blog_posts.md or blog_posts_curated.md found in ${inputDir}`);
}

async function loadRawMarkdown(inputDir: string): Promise<Map<string, string>> {
  const rawDir = `${inputDir}/raw-descriptions`;
  const entries = await readdir(rawDir, { withFileTypes: true });
  const byJobId = new Map<string, string>();
  for (const entry of entries) {
    if (!entry.isFile() || !/^job_\d+\.md$/.test(entry.name)) continue;
    const jobId = basename(entry.name, ".md");
    byJobId.set(jobId, await Bun.file(`${rawDir}/${entry.name}`).text());
  }
  return byJobId;
}

function duplicateGroupMap(rawMarkdownByJobId: Map<string, string>): Map<string, string> {
  const groups = new Map<string, string>();
  const seen = new Map<string, string>();
  for (const [jobId, markdown] of rawMarkdownByJobId.entries()) {
    const signature = markdown
      .toLowerCase()
      .replace(/^#+.+$/gm, "")
      .replace(/\b(jobserve|apply|privacy|terms)\b/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 2000);
    const existing = seen.get(signature);
    if (existing) {
      groups.set(jobId, existing);
    } else {
      seen.set(signature, jobId);
      groups.set(jobId, jobId);
    }
  }
  return groups;
}

async function writeJsonl<T>(path: string, rows: T[]): Promise<void> {
  await Bun.write(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    return;
  }

  const options = parseOptions(args);
  const inputDir = assertRepoLocalPath(options.inputDir || (await latestArtifactDir()), "--input");
  const outputDir = assertRepoLocalPath(options.outputDir ?? `${inputDir}/blog-quality`, "--output");
  const blogFile = await findBlogFile(inputDir, options.blogFile);
  const rawMarkdownByJobId = await loadRawMarkdown(inputDir);
  const duplicateGroupByJobId = duplicateGroupMap(rawMarkdownByJobId);
  const posts = parseBlogPostsMarkdown(await Bun.file(blogFile).text());
  const reviews: BlogPostReview[] = posts.map((post) =>
    reviewBlogPost(post, rawMarkdownByJobId, duplicateGroupByJobId),
  );

  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeJsonl(
      `${outputDir}/title_lints.jsonl`,
      reviews.map((review) => review.titleLint),
    ),
    writeJsonl(
      `${outputDir}/evidence_audit.jsonl`,
      reviews.flatMap((review) => review.evidenceAudits),
    ),
    writeJsonl(`${outputDir}/post_reviews.jsonl`, reviews),
    Bun.write(`${outputDir}/blog_quality_review.md`, renderBlogQualityReview(reviews)),
  ]);

  console.log(`Wrote ${outputDir}`);
  console.log(`Blog file: ${blogFile}`);
  console.log(`Posts: ${reviews.length}`);
  console.log(`Pass: ${reviews.filter((review) => review.gate === "pass").length}`);
  console.log(`Note only: ${reviews.filter((review) => review.gate === "note_only").length}`);
  console.log(`Reject: ${reviews.filter((review) => review.gate === "reject").length}`);
}

run().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});
