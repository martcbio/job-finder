import { describe, expect, test } from "bun:test";
import { classifyIr35Signals, isInsideIr35 } from "../ir35Signals";

describe("isInsideIr35", () => {
  test("does not flag ingest metadata when inside is no", () => {
    const text = [
      "- Outside IR35: no",
      "- Inside IR35: no",
      "Head of Engineering and AI. 12 month contract. London.",
    ].join("\n");

    expect(isInsideIr35(text)).toBe(false);
  });

  test("flags ingest metadata when inside is yes", () => {
    expect(isInsideIr35("- Inside IR35: yes\nContract role.")).toBe(true);
  });

  test("flags outside metadata as not inside", () => {
    expect(isInsideIr35("- Outside IR35: yes\n- Inside IR35: no\nContract.")).toBe(false);
  });

  test("flags affirmative prose after stripping metadata", () => {
    const text = [
      "- Inside IR35: no",
      "Six month contract. Inside IR35. Generic enterprise migration.",
    ].join("\n");

    expect(isInsideIr35(text)).toBe(true);
  });
});

describe("classifyIr35Signals", () => {
  test("vetoes affirmative labels when permanent or per-annum evidence is present", () => {
    expect(
      classifyIr35Signals({
        text: "Recruiter says Outside IR35",
        employmentType: "Permanent",
        compensation: "£85k per annum",
      }),
    ).toMatchObject({
      outside: false,
      inside: false,
      isContract: false,
      permanentEvidence: true,
    });
  });

  test("keeps affirmative labels on a genuine contract", () => {
    expect(
      classifyIr35Signals({
        text: "Six month contract, outside IR35",
        employmentType: "Contract",
        compensation: "£600 per day",
      }),
    ).toMatchObject({ outside: true, inside: false, isContract: true, permanentEvidence: false });
  });
});
