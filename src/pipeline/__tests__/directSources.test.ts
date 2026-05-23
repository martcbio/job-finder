import { describe, expect, test } from "bun:test";
import { parseLinearCareersListings } from "../directSources";

describe("direct source adapters", () => {
  test("parses Linear careers listing links into direct job URLs", () => {
    const listings = parseLinearCareersListings(`
      <a href="/careers/d3bc1ced-3ce4-4086-a050-555055dbb1ff">
        Senior / Staff Fullstack Engineer
        Europe, North America
        Learn more →
      </a>
      <a href="/careers/b4a7764e-c680-4bdf-9956-dc78f2ca94d5">
        Senior / Staff Product Engineer, AI
        North America
        Learn more →
      </a>
    `);

    expect(listings).toEqual([
      {
        title: "Senior / Staff Fullstack Engineer",
        location: "Europe, North America",
        url: "https://linear.app/careers/d3bc1ced-3ce4-4086-a050-555055dbb1ff",
      },
      {
        title: "Senior / Staff Product Engineer, AI",
        location: "North America",
        url: "https://linear.app/careers/b4a7764e-c680-4bdf-9956-dc78f2ca94d5",
      },
    ]);
  });
});
