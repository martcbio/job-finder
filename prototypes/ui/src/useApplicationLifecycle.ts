import { useCallback, useEffect, useState } from "react";
import {
  createApplication,
  fetchApplications,
  stageApplicationCv,
  transitionApplication,
} from "./applicationApi";
import {
  applicationInputFromQueueRow,
  findApplicationForQueueRow,
} from "./prototypes/applicationBoardModel";
import type {
  ApplicationActor,
  ApplicationRow,
  ApplicationStatus,
  ReviewQueueRow,
} from "./types";

const POLL_INTERVAL_MS = 60_000;

export type ApplicationLifecycleState = "loading" | "available" | "cloud_unavailable";

export interface ApplicationLifecycle {
  applications: ApplicationRow[];
  state: ApplicationLifecycleState;
  error: string | null;
  updatedAt: string | null;
  track: (job: ReviewQueueRow) => Promise<{ ok: boolean; error?: string }>;
  shortlist: (job: ReviewQueueRow) => Promise<{ ok: boolean; error?: string }>;
  stageCv: (id: string) => Promise<{ ok: boolean; error?: string }>;
  transition: (
    id: string,
    to: ApplicationStatus,
    by: ApplicationActor,
    note?: string,
  ) => Promise<{ ok: boolean; error?: string }>;
}

export function useApplicationLifecycle(): ApplicationLifecycle {
  const [applications, setApplications] = useState<ApplicationRow[]>([]);
  const [state, setState] = useState<ApplicationLifecycleState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await fetchApplications();
      if (result.status === "cloud_unavailable") {
        setState("cloud_unavailable");
        setError(result.reason.message);
        return;
      }
      setApplications(result.data);
      setState("available");
      setError(null);
      setUpdatedAt(new Date().toISOString());
    } catch (caught) {
      setState("cloud_unavailable");
      setError(caught instanceof Error ? caught.message : "Unable to load applications");
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const transition = useCallback(
    async (id: string, to: ApplicationStatus, by: ApplicationActor, note?: string) => {
      try {
        const result = await transitionApplication(id, to, by, note);
        if (result.status === "cloud_unavailable") {
          setState("cloud_unavailable");
          setError(result.reason.message);
          return { ok: false, error: result.reason.message };
        }
        const updated = result.data.application;
        setApplications((current) => [
          updated,
          ...current.filter((application) => application.id !== updated.id),
        ]);
        setUpdatedAt(new Date().toISOString());
        setState("available");
        setError(null);
        return { ok: true };
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : "Unable to move application";
        return { ok: false, error: message };
      }
    },
    [],
  );

  const track = useCallback(
    async (job: ReviewQueueRow) => {
      const existing = findApplicationForQueueRow(applications, job);
      if (existing) return { ok: true };
      try {
        const result = await createApplication(applicationInputFromQueueRow(job));
        if (result.status === "cloud_unavailable") {
          setState("cloud_unavailable");
          setError(result.reason.message);
          return { ok: false, error: result.reason.message };
        }
        const created = result.data.application;
        setApplications((current) => [
          created,
          ...current.filter((application) => application.id !== created.id),
        ]);
        setUpdatedAt(new Date().toISOString());
        setState("available");
        setError(null);
        return { ok: true };
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : "Unable to track application";
        return { ok: false, error: message };
      }
    },
    [applications],
  );

  const shortlist = useCallback(
    async (job: ReviewQueueRow) => {
      let existing = findApplicationForQueueRow(applications, job);
      if (!existing) {
        try {
          const result = await createApplication(applicationInputFromQueueRow(job));
          if (result.status === "cloud_unavailable") {
            setState("cloud_unavailable");
            setError(result.reason.message);
            return { ok: false, error: result.reason.message };
          }
          const created = result.data.application;
          existing = created;
          setApplications((current) => [
            created,
            ...current.filter((application) => application.id !== created.id),
          ]);
          setUpdatedAt(new Date().toISOString());
          setState("available");
          setError(null);
        } catch (caught) {
          return {
            ok: false,
            error: caught instanceof Error ? caught.message : "Unable to load tracked application",
          };
        }
      }
      if (existing.status !== "interested") return { ok: true };
      return transition(existing.id, "shortlisted", "agent");
    },
    [applications, transition],
  );

  const stageCv = useCallback(async (id: string) => {
    try {
      const result = await stageApplicationCv(id);
      const updated = result.application;
      setApplications((current) => [
        updated,
        ...current.filter((application) => application.id !== updated.id),
      ]);
      setUpdatedAt(new Date().toISOString());
      setState("available");
      setError(null);
      return { ok: true };
    } catch (caught) {
      return {
        ok: false,
        error: caught instanceof Error ? caught.message : "Unable to stage CV",
      };
    }
  }, []);

  return { applications, state, error, updatedAt, track, shortlist, stageCv, transition };
}
