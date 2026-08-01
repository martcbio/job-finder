import { describe, expect, test } from "bun:test";
import { outcomeFromError } from "../fastRefresh/utils";

describe("outcomeFromError", () => {
  test("classifies JobServe usage restrictions as robots or WAF blocking", () => {
    expect(outcomeFromError(new Error("JobServe usage restricted for this client"))).toBe(
      "blocked_robots_or_waf",
    );
  });
});
