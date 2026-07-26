import { describe, expect, test } from "bun:test";
import { basename } from "node:path";
import { getEvaluationFilters } from "../../config/evaluation";
import { evaluateSingle } from "../evaluate";
import { collectFixtures, loadFixture } from "./helpers";

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? "";
const describeLive = OPENROUTER_API_KEY ? describe : describe.skip;
const LLM_MODEL = process.env.LLM_MODEL ?? "google/gemini-2.5-flash";
const remoteFilter = getEvaluationFilters().find(
  (f) => f.name === "location-eligibility",
) as ReturnType<typeof getEvaluationFilters>[number];

const FIXTURES_DIR = `${import.meta.dir}/fixtures/remote`;
const ACCURACY_THRESHOLD = 0.75;
const CAVEAT_FIXTURES = new Set([
  "apify-onsite-default.md",
  "protex-no-location.md",
  "robinhood-onsite.md",
  "yubo-hybrid.md",
]);

type Result = { name: string; expected: boolean; actual: boolean; reason: string };

const results: Result[] = [];

describeLive("location-eligibility filter (live; requires OPENROUTER_API_KEY)", () => {
  for (const file of collectFixtures(`${FIXTURES_DIR}/pass`)) {
    const name = basename(file, ".md");
    test(`${name} → PASS`, async () => {
      const job = await loadFixture(`${FIXTURES_DIR}/pass/${file}`);
      const result = await evaluateSingle(job, remoteFilter, OPENROUTER_API_KEY, undefined, {
        temperature: 0,
        model: LLM_MODEL,
      });
      results.push({ name, expected: true, actual: result.pass, reason: result.reason });
    }, 30_000);
  }

  for (const file of collectFixtures(`${FIXTURES_DIR}/reject`)) {
    const name = basename(file, ".md");
    const expected = CAVEAT_FIXTURES.has(file);
    test(`${name} → ${expected ? "PASS" : "FAIL"}`, async () => {
      const job = await loadFixture(`${FIXTURES_DIR}/reject/${file}`);
      const result = await evaluateSingle(job, remoteFilter, OPENROUTER_API_KEY, undefined, {
        temperature: 0,
        model: LLM_MODEL,
      });
      results.push({ name, expected, actual: result.pass, reason: result.reason });
    }, 30_000);
  }

  test("accuracy meets threshold", () => {
    const total = results.length;
    const correct = results.filter((r) => r.expected === r.actual).length;
    const accuracy = correct / total;

    const misclassified = results.filter((r) => r.expected !== r.actual);
    for (const m of misclassified) {
      console.log(
        `  MISCLASSIFIED: ${m.name} (expected ${m.expected ? "PASS" : "FAIL"}, got ${m.actual ? "PASS" : "FAIL"}): ${m.reason}`,
      );
    }
    console.log(`  Accuracy: ${correct}/${total} (${(accuracy * 100).toFixed(1)}%)`);

    expect(total).toBeGreaterThan(0);
    expect(accuracy).toBeGreaterThanOrEqual(ACCURACY_THRESHOLD);
  }, 5_000);
});
