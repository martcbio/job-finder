import { describe, expect, test } from "bun:test";
import { isInsideIr35 } from "../ir35Signals";

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
    expect(isInsideIr35("- Outside IR35: yes\n- Inside IR35: no\nContract.")).toBe(
      false,
    );
  });

  test("flags affirmative prose after stripping metadata", () => {
    const text = [
      "- Inside IR35: no",
      "Six month contract. Inside IR35. Generic enterprise migration.",
    ].join("\n");

    expect(isInsideIr35(text)).toBe(true);
  });
});
