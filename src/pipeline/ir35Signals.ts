const INSIDE_METADATA_RE = /^-\s*Inside IR35:\s*(yes|no)\b/im;
const OUTSIDE_METADATA_RE = /^-\s*Outside IR35:\s*(yes|no)\b/im;

const AFFIRMATIVE_INSIDE_PATTERNS = [
  /\binside[\s-]*ir35\b/i,
  /\bin[\s-]*scope of ir35\b/i,
];

/** Parsed JobServe / ingest metadata lines when present. */
export function parseIr35Metadata(text: string): {
  inside: boolean | null;
  outside: boolean | null;
} {
  let inside: boolean | null = null;
  let outside: boolean | null = null;
  const insideMatch = text.match(INSIDE_METADATA_RE);
  if (insideMatch) inside = insideMatch[1]!.toLowerCase() === "yes";
  const outsideMatch = text.match(OUTSIDE_METADATA_RE);
  if (outsideMatch) outside = outsideMatch[1]!.toLowerCase() === "yes";
  return { inside, outside };
}

export function stripIr35MetadataLines(text: string): string {
  return text
    .replace(/^-\s*Inside IR35:\s*(?:yes|no)\b.*$/gim, "")
    .replace(/^-\s*Outside IR35:\s*(?:yes|no)\b.*$/gim, "");
}

/** True only when listing text affirms inside IR35, not when metadata explicitly says no. */
export function isInsideIr35(text: string): boolean {
  const meta = parseIr35Metadata(text);
  if (meta.inside === true) return true;
  if (meta.outside === true) return false;

  const body = stripIr35MetadataLines(text);
  return AFFIRMATIVE_INSIDE_PATTERNS.some((pattern) => pattern.test(body));
}
