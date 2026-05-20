import { createHash } from "node:crypto";

export function jsonbLiteral(value: unknown): string {
  const json = JSON.stringify(value);
  let tag = `json_${createHash("sha256").update(json).digest("hex").slice(0, 16)}`;
  let delimiter = `$${tag}$`;
  let counter = 0;

  while (json.includes(delimiter)) {
    counter += 1;
    tag = `${tag}_${counter}`;
    delimiter = `$${tag}$`;
  }

  return `${delimiter}${json}${delimiter}::jsonb`;
}
