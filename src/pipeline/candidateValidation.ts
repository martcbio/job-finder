import { detectAtsSource, fetchAtsData } from "../services/ats";
import type { Fetcher } from "../services/ats/types";
import type { SearchResultItem } from "./searchTargets";

export interface CandidateValidationAccepted {
  accepted: true;
}

export interface CandidateValidationRejected {
  accepted: false;
  reason: string;
}

export type CandidateValidationResult = CandidateValidationAccepted | CandidateValidationRejected;

export async function validateCandidateBeforePersist(
  item: SearchResultItem,
  fetcher: Fetcher = fetch,
): Promise<CandidateValidationResult> {
  const source = detectAtsSource(item.url);
  if (!source) return { accepted: true };

  const data = await fetchAtsData(item.url, { title: item.title }, fetcher);
  if (!data) {
    return {
      accepted: false,
      reason: `supported ATS candidate was not live via ${source} API`,
    };
  }

  return { accepted: true };
}
