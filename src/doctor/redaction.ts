const SECRET_ASSIGNMENT =
  /(\b(?:[a-z0-9]+[_-])*(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|authorization|database[_-]?url)\b["']?\s*[:=]\s*)(["']?)[^\s"',;}]+/gi;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const KNOWN_TOKEN = /\b(?:sk-(?:proj-)?|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{8,}\b/g;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const URL_CREDENTIALS = /((?:https?|postgres(?:ql)?):\/\/)[^/\s:@]+:[^/\s@]+@/gi;

/**
 * Remove common secret-shaped material before it reaches prompts or durable artifacts.
 *
 * @param value - Untrusted diagnostic text.
 * @returns Diagnostic text with secret values replaced.
 */
export function redactSecrets(value: string): string {
  return value
    .replace(SECRET_ASSIGNMENT, (_match, prefix: string, quote: string) => {
      return `${prefix}${quote}[REDACTED]`;
    })
    .replace(BEARER, "Bearer [REDACTED]")
    .replace(KNOWN_TOKEN, "[REDACTED_TOKEN]")
    .replace(JWT, "[REDACTED_JWT]")
    .replace(URL_CREDENTIALS, "$1[REDACTED]@");
}
