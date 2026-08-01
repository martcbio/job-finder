import { expect, test } from "bun:test";
import { decodeHtmlEntities } from "../htmlEntities";

test("shared HTML entity decoder preserves currency and decodes ampersands last", () => {
  expect(decodeHtmlEntities("R&amp;D: &pound;800 &euro;900 &quot;quoted&quot;")).toBe(
    'R&D: £800 €900 "quoted"',
  );
});
