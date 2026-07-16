import { describe, expect, test } from "bun:test";
import { reclassifyIr35Markdown } from "../ir35Backfill";

describe("reclassifyIr35Markdown", () => {
  test("removes contradictory positive labels from permanent per-annum fixtures", () => {
    const decision = reclassifyIr35Markdown(
      [
        "# AI Architect",
        "- Employment type: Permanent",
        "- Compensation: £85k - £90k per annum + Bonus, Outside IR35",
        "- Outside IR35: yes",
        "- Inside IR35: no",
        "- Priority notes: outside_ir35, agentic",
      ].join("\n"),
    );

    expect(decision.changed).toBe(true);
    expect(decision.reason).toBe("permanent_evidence_veto");
    expect(decision.markdown).toContain("- Outside IR35: no");
    expect(decision.markdown).toContain("- Priority notes: agentic");
    expect(decision.markdown).not.toContain("outside_ir35");
  });

  test("leaves genuine day-rate contract labels unchanged", () => {
    const markdown = [
      "# AI Architect",
      "- Employment type: Contract",
      "- Compensation: £600 per day outside IR35",
      "- Outside IR35: yes",
      "- Priority notes: contract, outside_ir35",
    ].join("\n");

    expect(reclassifyIr35Markdown(markdown)).toEqual({
      changed: false,
      reason: null,
      markdown,
    });
  });

  test("leaves already-negative permanent metadata unchanged", () => {
    const markdown = "- Employment type: Permanent\n- Outside IR35: no\n- Inside IR35: no";
    expect(reclassifyIr35Markdown(markdown).changed).toBe(false);
  });
});
