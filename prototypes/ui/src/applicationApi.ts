import type {
  ApplicationActor,
  ApplicationCloudResult,
  ApplicationRow,
  ApplicationStatus,
  CreateApplicationInput,
} from "./types";

interface ApiErrorEnvelope {
  ok: false;
  error: { code: string; message: string };
}

interface ApiSuccessEnvelope<T> {
  ok: true;
  data: ApplicationCloudResult<T>;
}

async function applicationRequest<T>(path: string, init?: RequestInit): Promise<ApplicationCloudResult<T>> {
  const response = await fetch(`/api${path}`, { ...init, cache: "no-store" });
  const body = (await response.json()) as ApiSuccessEnvelope<T> | ApiErrorEnvelope;
  if (!response.ok || !body.ok) {
    throw new Error(body.ok ? `HTTP ${response.status}` : body.error.message);
  }
  return body.data;
}

export function fetchApplications(): Promise<ApplicationCloudResult<ApplicationRow[]>> {
  return applicationRequest("/applications");
}

export function createApplication(
  input: CreateApplicationInput,
): Promise<ApplicationCloudResult<{ application: ApplicationRow; created: boolean }>> {
  return applicationRequest("/applications", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function transitionApplication(
  id: string,
  to: ApplicationStatus,
  by: ApplicationActor,
  note?: string,
): Promise<ApplicationCloudResult<{ application: ApplicationRow }>> {
  return applicationRequest(`/applications/${id}/transition`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ to, by, ...(note ? { note } : {}) }),
  });
}
