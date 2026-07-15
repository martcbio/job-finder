import { z } from "zod";

export type AtsSource = "lever" | "ashby" | "greenhouse" | "workable";

export type WorkplaceType = "Remote" | "Hybrid" | "OnSite";

// Injected so unit tests can supply recorded responses without hitting the network.
// Mirrors the `fetch` signature so POST-bodied calls (Workable) work alongside
// the simple GETs the other fetchers use.
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface AtsJobData {
  source: AtsSource;
  title?: string | null;
  company?: string | null;
  location: string;
  locations: string[];
  workplaceType: WorkplaceType | null;
  country: string | null;
  descriptionPlain?: string | null;
}

export interface AtsOrgJob {
  source: Exclude<AtsSource, "workable">;
  org: string;
  id: string;
  title: string | null;
  company?: string | null;
  location: string;
  locations: string[];
  url: string;
  postedAt: string | null;
  raw: unknown;
}

export type AtsAcquisitionFailure =
  | {
      kind: "transport";
      endpoint: string;
      message: string;
      errorName: string;
      errorCode: string | null;
      retryable: boolean;
    }
  | {
      kind: "http";
      endpoint: string;
      status: number;
      statusText: string;
      retryable: boolean;
    }
  | {
      kind: "parse";
      endpoint: string;
      contentType: string | null;
      message: string;
    }
  | {
      kind: "schema";
      endpoint: string;
      issues: Array<{
        code: string;
        path: Array<string | number>;
        message: string;
      }>;
    };

export type AtsOrgAcquisition =
  | {
      status: "success";
      endpoint: string;
      attempts: number;
      durationMs: number;
      jobs: AtsOrgJob[];
    }
  | {
      status: "failure";
      attempts: number;
      durationMs: number;
      failure: AtsAcquisitionFailure;
    };

// All three ATS surfaces emit `null` for unset fields on at least some payloads
// (observed live on Ashby), so optional fields use .nullish() to accept both
// undefined (missing) and null (explicitly null).

// Lever — https://api.lever.co/v0/postings/{org}/{id}?mode=json
export const leverJobSchema = z
  .object({
    id: z.string().nullish(),
    text: z.string().nullish(),
    categories: z
      .object({
        location: z.string().nullish(),
        allLocations: z.array(z.string()).nullish(),
        commitment: z.string().nullish(),
        department: z.string().nullish(),
        team: z.string().nullish(),
      })
      .nullish(),
    workplaceType: z.string().nullish(),
    country: z.string().nullish(),
    hostedUrl: z.string().nullish(),
    applyUrl: z.string().nullish(),
    createdAt: z.number().nullish(),
    descriptionPlain: z.string().nullish(),
    descriptionBodyPlain: z.string().nullish(),
  })
  .passthrough();

export type LeverJob = z.infer<typeof leverJobSchema>;
export const leverListResponseSchema = z.array(
  leverJobSchema.refine((job) => Boolean(job.id || job.hostedUrl), {
    message: "Lever list entries require id or hostedUrl",
  }),
);

// Ashby — https://api.ashbyhq.com/posting-api/job-board/{org}
export const ashbyJobSchema = z
  .object({
    id: z.string(),
    title: z.string().nullish(),
    location: z.string().nullish(),
    secondaryLocations: z
      .array(
        z.object({
          location: z.string(),
        }),
      )
      .nullish(),
    isRemote: z.boolean().nullish(),
    workplaceType: z.string().nullish(),
    address: z
      .object({
        postalAddress: z
          .object({
            addressCountry: z.string().nullish(),
            addressLocality: z.string().nullish(),
          })
          .nullish(),
      })
      .nullish(),
    descriptionPlain: z.string().nullish(),
    publishedAt: z.string().nullish(),
    jobUrl: z.string().nullish(),
    applyUrl: z.string().nullish(),
  })
  .passthrough();

export const ashbyOrgResponseSchema = z.object({
  jobs: z.array(ashbyJobSchema),
  apiVersion: z.string().nullish(),
});

export type AshbyJob = z.infer<typeof ashbyJobSchema>;
export type AshbyOrgResponse = z.infer<typeof ashbyOrgResponseSchema>;

// Greenhouse — https://boards-api.greenhouse.io/v1/boards/{org}/jobs/{id}
export const greenhouseJobSchema = z
  .object({
    id: z.number(),
    title: z.string().nullish(),
    company_name: z.string().nullish(),
    content: z.string().nullish(),
    absolute_url: z.string().nullish(),
    first_published: z.string().nullish(),
    updated_at: z.string().nullish(),
    location: z
      .object({
        name: z.string(),
      })
      .nullish(),
    offices: z
      .array(
        z.object({
          id: z.number(),
          name: z.string().nullish(),
          location: z.string().nullish(),
        }),
      )
      .nullish(),
  })
  .passthrough();

export type GreenhouseJob = z.infer<typeof greenhouseJobSchema>;
export const greenhouseListResponseSchema = z
  .object({
    jobs: z.array(greenhouseJobSchema),
  })
  .passthrough();

// Workable — POST https://apply.workable.com/api/v3/accounts/{slug}/jobs
// (no per-job endpoint exists; we filter the list response by shortcode).
export const workableJobSchema = z.object({
  shortcode: z.string(),
  title: z.string().nullish(),
  workplace: z.string().nullish(),
  remote: z.boolean().nullish(),
  location: z
    .object({
      country: z.string().nullish(),
      countryCode: z.string().nullish(),
      city: z.string().nullish(),
      region: z.string().nullish(),
    })
    .nullish(),
  locations: z
    .array(
      z.object({
        country: z.string().nullish(),
        countryCode: z.string().nullish(),
        city: z.string().nullish(),
        region: z.string().nullish(),
      }),
    )
    .nullish(),
});

export const workableListResponseSchema = z.object({
  results: z.array(workableJobSchema),
  total: z.number().nullish(),
  nextPage: z.string().nullish(),
});

export type WorkableJob = z.infer<typeof workableJobSchema>;
export type WorkableListResponse = z.infer<typeof workableListResponseSchema>;
