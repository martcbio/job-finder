import { createHash } from "node:crypto";
import type { JobIngestResult } from "../pipeline/jobIngest";
import { redactSecrets } from "./redaction";

/** Why a terminal ingest outcome is or is not eligible for Doctor repair. */
export type DoctorClassification =
  | {
      readonly _tag: "healthy";
      readonly reason: "ingest_complete";
    }
  | {
      readonly _tag: "non_repair";
      readonly reason: "external_transient" | "operator_input";
      readonly summary: string;
    }
  | {
      readonly _tag: "repair";
      readonly incident: DoctorIncidentDraft;
    };

/** The immutable content used to create a Doctor incident. */
export interface DoctorIncidentDraft {
  readonly schemaVersion: 1;
  readonly kind: "ingest_result" | "ingest_throw";
  readonly severity: "degraded" | "failed";
  readonly summary: string;
  readonly evidence: ReadonlyArray<DoctorEvidence>;
  readonly fingerprint: string;
}

/** Safe evidence captured at the deterministic CLI boundary. */
export interface DoctorEvidence {
  readonly source: string;
  readonly status: string;
  readonly message: string;
}

const EXTERNAL_TRANSIENT =
  /\b(timeout|timed out|abort(?:ed)?|rate[ -]?limit|429|401|403|unauthori[sz]ed|forbidden|auth(?:entication)?(?: required| failed)?|captcha|robot|blocked|connection reset|econnreset|econnrefused|enotfound|dns|network|temporar(?:y|ily)|service unavailable|bad gateway|gateway timeout)\b/i;

const OPERATOR_INPUT =
  /\b(unknown argument|requires a value|requires a positive integer|unknown ingest source|limited to \d+)\b/i;

const INTERNAL_EVIDENCE =
  /\b(typeerror|referenceerror|syntaxerror|rangeerror|invariant|assertion|parser|parse error|invalid json|migration|schema|enoent|eacces|permission denied|database has|bug|defect|should never|unexpected)\b/i;

function messageOf(error: unknown): string {
  return redactSecrets(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
}

/**
 * Redact a classified incident and recompute its fingerprint from safe evidence.
 *
 * @param draft - Classified incident content.
 * @returns A persistence- and prompt-safe incident draft.
 */
export function redactDoctorIncidentDraft(draft: DoctorIncidentDraft): DoctorIncidentDraft {
  const evidence = draft.evidence.map((item) => ({
    source: redactSecrets(item.source),
    status: redactSecrets(item.status),
    message: redactSecrets(item.message),
  }));
  return {
    ...draft,
    summary: redactSecrets(draft.summary),
    evidence,
    fingerprint: fingerprint(draft.kind, draft.severity, evidence),
  };
}

function normalizeForFingerprint(value: string): string {
  return value
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/\b[0-9a-f]{8,}\b/gi, "<id>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim();
}

function fingerprint(
  kind: DoctorIncidentDraft["kind"],
  severity: DoctorIncidentDraft["severity"],
  evidence: ReadonlyArray<DoctorEvidence>,
): string {
  const stableEvidence = evidence
    .map((item) => ({
      source: item.source,
      status: item.status,
      message: normalizeForFingerprint(item.message),
    }))
    .sort((left, right) =>
      `${left.source}:${left.status}:${left.message}`.localeCompare(
        `${right.source}:${right.status}:${right.message}`,
      ),
    );
  return createHash("sha256")
    .update(JSON.stringify({ kind, severity, evidence: stableEvidence }))
    .digest("hex");
}

function isExternalOnly(evidence: ReadonlyArray<DoctorEvidence>): boolean {
  return (
    evidence.length > 0 &&
    evidence.every(
      (item) => EXTERNAL_TRANSIENT.test(item.message) && !INTERNAL_EVIDENCE.test(item.message),
    )
  );
}

/**
 * Classify a completed deterministic ingest result without calling a model.
 *
 * @param result - The terminal ingest receipt.
 * @returns A healthy, non-repair, or repair-worthy classification.
 */
export function classifyIngestResult(result: JobIngestResult): DoctorClassification {
  if (result.status === "complete") {
    return { _tag: "healthy", reason: "ingest_complete" };
  }

  const evidence = result.sources.flatMap((source) => {
    if (source.errors.length === 0) {
      return source.status === "complete"
        ? []
        : [{ source: source.id, status: source.status, message: "No error evidence was reported" }];
    }
    return source.errors.map((message) => ({
      source: source.id,
      status: source.status,
      message: redactSecrets(message),
    }));
  });
  const summary = `jobsradar ingest returned ${result.status}`;
  if (isExternalOnly(evidence)) {
    return { _tag: "non_repair", reason: "external_transient", summary };
  }
  return redactClassification({
    _tag: "repair",
    incident: {
      schemaVersion: 1,
      kind: "ingest_result",
      severity: result.status,
      summary,
      evidence,
      fingerprint: fingerprint("ingest_result", result.status, evidence),
    },
  });
}

function redactClassification(
  classification: Extract<DoctorClassification, { readonly _tag: "repair" }>,
): DoctorClassification {
  return { _tag: "repair", incident: redactDoctorIncidentDraft(classification.incident) };
}

/**
 * Classify an error thrown at the jobsradar CLI boundary.
 *
 * @param error - The unclassified thrown value.
 * @returns A non-repair or repair-worthy classification.
 */
export function classifyIngestThrow(error: unknown): DoctorClassification {
  const message = messageOf(error);
  if (OPERATOR_INPUT.test(message)) {
    return { _tag: "non_repair", reason: "operator_input", summary: message };
  }
  const evidence = [{ source: "jobsradar-cli", status: "threw", message }];
  if (isExternalOnly(evidence)) {
    return { _tag: "non_repair", reason: "external_transient", summary: message };
  }
  return redactClassification({
    _tag: "repair",
    incident: {
      schemaVersion: 1,
      kind: "ingest_throw",
      severity: "failed",
      summary: "jobsradar ingest threw before returning a receipt",
      evidence,
      fingerprint: fingerprint("ingest_throw", "failed", evidence),
    },
  });
}
