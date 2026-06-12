import { describe, expect, test } from "bun:test";
import {
  auditEvidence,
  lintTitle,
  parseBlogPostsMarkdown,
  reviewBlogPost,
  splitStableSentences,
} from "../marketBlogQuality";

const strongRuntimeBody = `# Formula Recruitment - AI Engineer

You'll be working deep in the runtime layer, porting and optimising inference engines to run efficiently on edge hardware.
You will deploy models to edge devices where memory, latency, and runtime stability matter.`;

describe("market blog quality evidence", () => {
  test("builds stable sentence IDs from body text only", () => {
    const sentences = splitStableSentences("job_801", strongRuntimeBody);

    expect(sentences[0]?.id).toBe("job_801.s001");
    expect(sentences[0]?.text).toContain("porting and optimising inference engines");
    expect(sentences.some((sentence) => sentence.text.startsWith("#"))).toBe(false);
  });

  test("rejects metadata as evidence", () => {
    const audit = auditEvidence(
      "job_801",
      "Priority notes: contract, outside_ir35, inference",
      strongRuntimeBody,
    );

    expect(audit.evidenceLocation).toBe("metadata");
    expect(audit.grade).toBe("metadata_only_signal");
    expect(audit.problems).toContain("metadata evidence cannot support a top post");
  });

  test("distinguishes title-only extraction from weak roles when body is strong", () => {
    const audit = auditEvidence(
      "job_801",
      "# Formula Recruitment - AI Engineer",
      strongRuntimeBody,
    );

    expect(audit.evidenceLocation).toBe("title");
    expect(audit.grade).toBe("extraction_failed_but_raw_body_strong");
    expect(audit.roleFamilies).toContain("inference_runtime_engineer");
  });

  test("marks body snippets with verb, object, and constraint as strong", () => {
    const quote =
      "You'll be working deep in the runtime layer, porting and optimising inference engines to run efficiently on edge hardware.";
    const audit = auditEvidence("job_801", quote, strongRuntimeBody);

    expect(audit.evidenceLocation).toBe("body");
    expect(audit.grade).toBe("strong_body_evidence");
    expect(audit.matchedSentenceId).toBe("job_801.s001");
    expect(audit.workVerbs).toContain("porting");
    expect(audit.systemObjects).toContain("inference engines");
    expect(audit.constraints).toContain("edge hardware");
  });

  test("flags non-AI engineering false positives", () => {
    const audit = auditEvidence(
      "job_936",
      "This scheme plays a critical role in improving river water quality and environmental sustainability within a protected catchment area.",
      "This scheme plays a critical role in improving river water quality and environmental sustainability within a protected catchment area. Working on behalf of a regional water authority, the project includes design and construction.",
    );

    expect(audit.grade).toBe("false_positive_non_ai_engineering");
    expect(audit.falsePositiveRisk).toBe(true);
  });
});

describe("market blog quality title linting", () => {
  test("kills taxonomy labels", () => {
    const lint = lintTitle("Security and governance as AI product requirements");

    expect(lint.verdict).toBe("kill");
    expect(lint.problems).toContain("banned phrase");
  });

  test("keeps artifact-shaped titles", () => {
    const lint = lintTitle("The Permission Model Is Part of the Prompt");

    expect(lint.verdict).toBe("keep");
    expect(lint.score.total).toBeGreaterThanOrEqual(11);
  });
});

describe("market blog quality post review", () => {
  test("requires body-level evidence before a post can pass", () => {
    const markdown = `## 1. The Permission Model Is Part of the Prompt

- Job evidence: job_1, job_2, job_3
  - \`job_1\` Example: Priority notes: security_ai
  - \`job_2\` Example: # Agentic AI Engineer
  - \`job_3\` Example: Security and governance matter.
`;
    const posts = parseBlogPostsMarkdown(markdown);
    const raw = new Map([
      ["job_1", "Priority notes: security_ai"],
      ["job_2", "# Agentic AI Engineer"],
      ["job_3", "Security and governance matter."],
    ]);
    const post = posts[0];
    expect(post).toBeDefined();
    if (!post) throw new Error("expected parsed post");
    const review = reviewBlogPost(post, raw);

    expect(review.gate).not.toBe("pass");
    expect(review.gateReasons).toContain("fewer than 3 distinct body-evidence jobs");
    expect(review.evidenceAudits.map((audit) => audit.grade)).toContain("metadata_only_signal");
    expect(review.evidenceAudits.map((audit) => audit.grade)).toContain("title_only_evidence");
  });
});
