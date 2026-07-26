export interface CloudLabRun {
  run_id: string;
  completed_at: string;
  health: "complete" | "degraded" | "failed";
  raw_openings_count: number;
  eligible_openings_count: number;
  suitable_openings_count: number;
  unsuitable_location_openings_count: number;
  unsuitable_role_openings_count: number;
  undecided_openings_count: number;
  substrate: "modal" | "mac";
}

export interface CloudLabOpening {
  org: string;
  ats: "ashby" | "greenhouse" | "lever";
  external_id: string;
  title: string | null;
  company: string;
  location: string;
  locations: string[];
  url: string;
  posted_at: string | null;
  location_eligibility: "eligible" | "ineligible" | "undecided";
  location_reason_codes: string[];
  role_relevance: "relevant" | "irrelevant" | "undecided";
  role_reason_codes: string[];
  disposition: "suitable" | "unsuitable_location" | "unsuitable_role" | "undecided";
  raw?: unknown;
}

export interface CloudLabSnapshot {
  status: Record<string, unknown>;
  rows: Array<Record<string, unknown>>;
}

export function buildCloudLabSnapshot(
  run: CloudLabRun,
  openings: readonly CloudLabOpening[],
): CloudLabSnapshot {
  if (run.substrate !== "modal" || run.health !== "complete") {
    throw new Error(`cloud lab run ${run.run_id} is not a complete Modal run`);
  }
  const expectedRows = run.raw_openings_count - run.unsuitable_location_openings_count;
  if (openings.length !== expectedRows) {
    throw new Error(
      `cloud lab run ${run.run_id} expected ${expectedRows} non-US candidate rows but received ${openings.length}`,
    );
  }

  const rows = openings.map((opening) => {
    if (opening.location_eligibility === "ineligible") {
      throw new Error(`cloud opening ${opening.external_id} is unexpectedly location-ineligible`);
    }
    if (!opening.raw || typeof opening.raw !== "object") {
      throw new Error(`cloud opening ${opening.external_id} has no raw ATS payload`);
    }
    return {
      org: opening.org,
      company: opening.company,
      ats: opening.ats,
      id: opening.external_id,
      title: opening.title,
      location: opening.location,
      locations: opening.locations,
      url: opening.url,
      postedAt: opening.posted_at,
      locationEligibility: {
        status: opening.location_eligibility,
        reasonCodes: opening.location_reason_codes,
      },
      roleRelevance: {
        status: opening.role_relevance,
        reasonCodes: opening.role_reason_codes,
      },
      disposition: opening.disposition,
      raw: opening.raw,
    };
  });

  return {
    status: {
      schemaVersion: 1,
      projectionId: "lab-openings",
      runId: run.run_id,
      trigger: "cloud-sync",
      scheduledAt: run.completed_at,
      startedAt: run.completed_at,
      completedAt: run.completed_at,
      timezone: "UTC",
      status: "complete",
      summary: {
        rawOpenings: run.raw_openings_count,
        syncedOpenings: rows.length,
        eligibleOpenings: run.eligible_openings_count,
        suitableOpenings: run.suitable_openings_count,
        unsuitableLocationOpenings: run.unsuitable_location_openings_count,
        unsuitableRoleOpenings: run.unsuitable_role_openings_count,
        undecidedOpenings: run.undecided_openings_count,
      },
      boards: [],
      diagnostics: ["synced from complete Modal careers-lab-openings run"],
    },
    rows,
  };
}
