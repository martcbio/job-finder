const INSIDE_METADATA_RE = /^-\s*Inside IR35:\s*(yes|no)\b/im;
const OUTSIDE_METADATA_RE = /^-\s*Outside IR35:\s*(yes|no)\b/im;

const AFFIRMATIVE_INSIDE_PATTERNS = [/\binside[\s-]*ir35\b/i, /\bin[\s-]*scope of ir35\b/i];

export interface Ir35SignalInput {
  text: string;
  employmentType: string | null;
  compensation: string | null;
}

export interface Ir35SignalClassification {
  outside: boolean;
  inside: boolean;
  isContract: boolean;
  permanentEvidence: boolean;
}

/** Parsed JobServe / ingest metadata lines when present. */
export function parseIr35Metadata(text: string): {
  inside: boolean | null;
  outside: boolean | null;
} {
  let inside: boolean | null = null;
  let outside: boolean | null = null;
  const insideMatch = text.match(INSIDE_METADATA_RE);
  const insideValue = insideMatch?.[1];
  if (insideValue) inside = insideValue.toLowerCase() === "yes";
  const outsideMatch = text.match(OUTSIDE_METADATA_RE);
  const outsideValue = outsideMatch?.[1];
  if (outsideValue) outside = outsideValue.toLowerCase() === "yes";
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

/** Shared ingestion/backfill policy: IR35 applies only to non-permanent contract evidence. */
export function classifyIr35Signals(input: Ir35SignalInput): Ir35SignalClassification {
  const employmentType = input.employmentType ?? "";
  const compensation = input.compensation ?? "";
  const permanentEvidence =
    /\bpermanent\b/i.test(employmentType) ||
    /\b(?:per[\s-]+annum|annual(?:ly)?|p\.?\s*a\.?)\b/i.test(compensation);
  if (permanentEvidence) {
    return { outside: false, inside: false, isContract: false, permanentEvidence: true };
  }

  const text = [input.text, employmentType, compensation].filter(Boolean).join(" ");
  const isContract = /\bcontract(?:or|ing)?\b/i.test(text);
  return {
    outside: isContract && hasPositiveIr35Signal(text, "outside"),
    inside: isContract && hasPositiveIr35Signal(text, "inside"),
    isContract,
    permanentEvidence: false,
  };
}

function hasPositiveIr35Signal(text: string, polarity: "outside" | "inside"): boolean {
  const negated = new RegExp(`\\b${polarity}[\\s-]*ir3[45]\\s*:\\s*no\\b`, "i");
  if (negated.test(text)) return false;
  return new RegExp(`\\b${polarity}[\\s-]*ir3[45]\\b`, "i").test(text);
}
