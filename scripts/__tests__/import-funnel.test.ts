import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mapFunnelRow, mapFunnelStatus, parseFunnelTables } from "../import-funnel";

const fixturePath = join(import.meta.dir, "fixtures", "funnel-table.md");

describe("funnel import", () => {
  test("parses candidate tables and maps their fields", async () => {
    const rows = parseFunnelTables(await Bun.file(fixturePath).text());
    const candidates = rows.map(mapFunnelRow);

    expect(candidates).toHaveLength(4);
    expect(candidates[0]).toMatchObject({
      company: "Acme AI",
      title: "Deployment Engineer",
      url: "https://example.com/acme",
      status: "sent",
      originalStatus: "SENT(owner)",
    });
    expect(candidates[1]?.url).toBe("https://example.com/labs");
  });

  test("uses a stable title fallback for organization-level rows", async () => {
    const rows = parseFunnelTables(await Bun.file(fixturePath).text());
    expect(mapFunnelRow(rows[3] ?? { cells: {}, line: 0 })).toMatchObject({
      company: "Anthropic",
      title: "General opportunity",
      status: "shortlisted",
    });
  });

  test("maps unknown statuses to interested and preserves the original wording", async () => {
    expect(mapFunnelStatus("waiting-on-founder")).toEqual({
      status: "interested",
      recognized: false,
    });
    const rows = parseFunnelTables(await Bun.file(fixturePath).text());
    const candidate = mapFunnelRow(rows[2] ?? { cells: {}, line: 0 });
    expect(candidate.status).toBe("interested");
    expect(candidate.notes).toContain("unmapped funnel status: waiting-on-founder");
  });

  test("rejects malformed table rows", () => {
    expect(() =>
      parseFunnelTables(`| Org | Status |\n|---|---|\n| Acme | seed | extra |`),
    ).toThrow("Malformed funnel table row at line 3");
  });
});
