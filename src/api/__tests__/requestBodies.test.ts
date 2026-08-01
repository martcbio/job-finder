import { describe, expect, test } from "bun:test";
import {
  DEFAULT_FAST_REFRESH_OPTIONS,
  normalizeFastRefreshOptions,
} from "../../pipeline/fastRefresh";
import { ApiError } from "../errors";
import { fastRefreshOptionsFromBody } from "../requestBodies";

describe("fastRefreshOptionsFromBody", () => {
  test("normalizes an empty request with the shared JobServe defaults", () => {
    expect(fastRefreshOptionsFromBody({})).toEqual(normalizeFastRefreshOptions());
    expect(fastRefreshOptionsFromBody({})).toMatchObject({
      sourceIds: DEFAULT_FAST_REFRESH_OPTIONS.sourceIds,
      jobserveMaxPages: 2,
      jobserveImportLimitPerQuery: 5,
    });
  });

  test("rejects JobServe over-caps as API validation errors", () => {
    const invalidCases: ReadonlyArray<readonly [Record<string, unknown>, string]> = [
      [{ jobserveMaxPages: 3 }, "jobserveMaxPages must be a positive integer up to 2"],
      [
        { jobserveImportLimitPerQuery: 6 },
        "jobserveImportLimitPerQuery must be a positive integer up to 5",
      ],
    ];
    for (const [body, message] of invalidCases) {
      try {
        fastRefreshOptionsFromBody(body);
        throw new Error("expected fast refresh validation to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect(error).toMatchObject({
          status: 400,
          code: "invalid_positive_integer",
          message,
        });
      }
    }
  });
});
