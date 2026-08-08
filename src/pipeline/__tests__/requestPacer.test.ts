import { describe, expect, test } from "bun:test";
import { RequestPacer } from "../requestPacer";

describe("RequestPacer", () => {
  test("serializes concurrent request slots with the configured spacing", async () => {
    const pacer = new RequestPacer(20);
    const starts: number[] = [];
    await Promise.all(
      Array.from({ length: 3 }, async () => {
        await pacer.wait();
        starts.push(Date.now());
      }),
    );

    expect(starts).toHaveLength(3);
    expect((starts[1] ?? 0) - (starts[0] ?? 0)).toBeGreaterThanOrEqual(15);
    expect((starts[2] ?? 0) - (starts[1] ?? 0)).toBeGreaterThanOrEqual(15);
  });

  test("rejects invalid delays", () => {
    expect(() => new RequestPacer(-1)).toThrow("non-negative");
  });
});
