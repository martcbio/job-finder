import { describe, expect, test } from "bun:test";
import type { OpsParityRow } from "../../types";
import { deriveParityComparisons } from "../parityModel";

function row(
  substrate: "mac" | "modal",
  runId: string,
  createdAt: string,
  digest: string,
): OpsParityRow {
  return {
    run_date: "2026-07-16",
    substrate,
    run_id: runId,
    openings_count: 10,
    ids_sha256: digest,
    created_at: createdAt,
  };
}

describe("deriveParityComparisons", () => {
  test("compares the closest Mac and Modal runs for each date", () => {
    const comparisons = deriveParityComparisons([
      row("mac", "mac-1", "2026-07-16T08:15:00Z", "same"),
      row("modal", "modal-early", "2026-07-16T03:00:00Z", "different"),
      row("modal", "modal-near", "2026-07-16T09:00:00Z", "same"),
      row("modal", "modal-late", "2026-07-16T21:00:00Z", "different"),
    ]);

    expect(comparisons).toHaveLength(1);
    expect(comparisons[0]).toMatchObject({
      status: "in_sync",
      mac: { run_id: "mac-1" },
      modal: { run_id: "modal-near" },
      separationMinutes: 45,
    });
  });

  test("treats pairs outside 120 minutes as neutral", () => {
    const [comparison] = deriveParityComparisons([
      row("mac", "mac-1", "2026-07-16T08:15:00Z", "mac"),
      row("modal", "modal-1", "2026-07-16T10:16:00Z", "modal"),
    ]);

    expect(comparison?.status).toBe("no_comparable_window");
    expect(comparison?.separationMinutes).toBe(121);
  });
});
