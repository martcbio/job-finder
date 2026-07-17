import { resolve } from "node:path";

const DEFAULT_FUNNEL_PATH = "/Users/mcb/Claudelocal/careers/market/funnel.md";
const API_BASE_URL = "http://127.0.0.1:3737";
const FALLBACK_TITLE = "General opportunity";

export type FunnelApplicationStatus =
  | "interested"
  | "shortlisted"
  | "cv_staged"
  | "sent"
  | "response"
  | "interview"
  | "closed";

export interface FunnelTableRow {
  cells: Record<string, string>;
  line: number;
}

export interface FunnelCandidate {
  company: string;
  title: string;
  url: string | null;
  status: FunnelApplicationStatus;
  originalStatus: string;
  notes: string;
  line: number;
}

interface CloudApplication {
  id: string;
  company: string;
  title: string;
  status: string;
}

interface ApiEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: { code?: string; message?: string };
}

interface CloudResult<T> {
  status: "available" | "cloud_unavailable";
  data?: T;
  reason?: { code?: string; message?: string };
}

const HEADER_ALIASES = {
  company: ["company", "org", "organisation", "organization"],
  title: ["title", "role", "position"],
  status: ["status", "stage"],
  url: ["url", "link", "job url", "job link"],
} as const;

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

function splitTableLine(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return [];
  return trimmed
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim());
}

function isSeparator(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function findCell(row: FunnelTableRow, aliases: readonly string[]): string | undefined {
  for (const alias of aliases) {
    const value = row.cells[alias];
    if (value !== undefined) return value;
  }
  return undefined;
}

function plainText(value: string): string {
  return value
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractUrl(value: string): string | null {
  const markdownLink = value.match(/\[[^\]]*]\((https?:\/\/[^)\s]+)\)/i)?.[1];
  const rawLink = value.match(/https?:\/\/[^\s|)]+/i)?.[0];
  const candidate = markdownLink ?? rawLink;
  if (!candidate) return null;
  try {
    return new URL(candidate).toString();
  } catch {
    return null;
  }
}

export function parseFunnelTables(markdown: string): FunnelTableRow[] {
  const lines = markdown.split(/\r?\n/);
  const rows: FunnelTableRow[] = [];

  for (let index = 0; index < lines.length - 1; index += 1) {
    const headers = splitTableLine(lines[index] ?? "").map(normalizeHeader);
    const separator = splitTableLine(lines[index + 1] ?? "");
    if (headers.length === 0 || separator.length !== headers.length || !isSeparator(separator)) {
      continue;
    }
    const hasCompany = HEADER_ALIASES.company.some((header) => headers.includes(header));
    const hasStatus = HEADER_ALIASES.status.some((header) => headers.includes(header));
    if (!hasCompany || !hasStatus) continue;

    index += 2;
    while (index < lines.length) {
      const values = splitTableLine(lines[index] ?? "");
      if (values.length === 0) break;
      if (values.length !== headers.length) {
        throw new Error(`Malformed funnel table row at line ${index + 1}`);
      }
      rows.push({
        cells: Object.fromEntries(headers.map((header, cellIndex) => [header, values[cellIndex] ?? ""])),
        line: index + 1,
      });
      index += 1;
    }
  }

  return rows;
}

export function mapFunnelStatus(value: string): {
  status: FunnelApplicationStatus;
  recognized: boolean;
} {
  const normalized = plainText(value)
    .toLowerCase()
    .replace(/\(owner\)$/i, "")
    .replace(/[\s_]+/g, "-");
  if (["seed", "seed-weak", "to-confirm", "interested"].includes(normalized)) {
    return { status: "interested", recognized: true };
  }
  if (["openings-checked", "shortlisted"].includes(normalized)) {
    return { status: "shortlisted", recognized: true };
  }
  if (["cv-staged", "cv-ready"].includes(normalized)) {
    return { status: "cv_staged", recognized: true };
  }
  if (["sent", "applied"].includes(normalized)) return { status: "sent", recognized: true };
  if (["response", "responded"].includes(normalized)) {
    return { status: "response", recognized: true };
  }
  if (["interview", "interviewing", "offer"].includes(normalized)) {
    return { status: "interview", recognized: true };
  }
  if (["closed", "outcome", "rejected", "declined", "withdrawn"].includes(normalized)) {
    return { status: "closed", recognized: true };
  }
  return { status: "interested", recognized: false };
}

export function mapFunnelRow(row: FunnelTableRow): FunnelCandidate {
  const company = plainText(findCell(row, HEADER_ALIASES.company) ?? "");
  const originalStatus = plainText(findCell(row, HEADER_ALIASES.status) ?? "");
  if (!company) throw new Error(`Funnel row ${row.line} has no company`);
  if (!originalStatus) throw new Error(`Funnel row ${row.line} has no status`);

  const title = plainText(findCell(row, HEADER_ALIASES.title) ?? "") || FALLBACK_TITLE;
  const explicitUrl = findCell(row, HEADER_ALIASES.url);
  const url = extractUrl(explicitUrl ?? Object.values(row.cells).join(" "));
  const mapped = mapFunnelStatus(originalStatus);
  const sourceNotes = Object.entries(row.cells)
    .filter(([header, value]) => {
      const primaryHeaders = [...HEADER_ALIASES.company, ...HEADER_ALIASES.title, ...HEADER_ALIASES.url];
      return value.trim() && !primaryHeaders.includes(header as never);
    })
    .map(([header, value]) => `${header}: ${plainText(value)}`);
  if (!mapped.recognized) sourceNotes.push(`unmapped funnel status: ${originalStatus}`);

  return {
    company,
    title,
    url,
    status: mapped.status,
    originalStatus,
    notes: [`Imported from market/funnel.md line ${row.line}.`, ...sourceNotes].join(" "),
    line: row.line,
  };
}

function matchKey(company: string, title: string): string {
  return `${company.trim().toLocaleLowerCase()}\u0000${title.trim().toLocaleLowerCase()}`;
}

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, init);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot reach job-finder API at ${API_BASE_URL}: ${detail}`, { cause: error });
  }
  const body = (await response.json()) as ApiEnvelope<T>;
  if (!response.ok || !body.ok || body.data === undefined) {
    throw new Error(
      `API ${init?.method ?? "GET"} ${path} failed (${response.status}): ${body.error?.code ?? "unknown_error"} ${body.error?.message ?? ""}`.trim(),
    );
  }
  return body.data;
}

function requireAvailable<T>(result: CloudResult<T>, operation: string): T {
  if (result.status !== "available" || result.data === undefined) {
    throw new Error(
      `${operation} unavailable: ${result.reason?.code ?? "unknown_error"} ${result.reason?.message ?? ""}`.trim(),
    );
  }
  return result.data;
}

function transitionPlan(status: FunnelApplicationStatus): FunnelApplicationStatus[] {
  if (status === "interested") return [];
  if (status === "closed") return ["closed"];
  const forward: FunnelApplicationStatus[] = [
    "shortlisted",
    "cv_staged",
    "sent",
    "response",
    "interview",
  ];
  return forward.slice(0, forward.indexOf(status) + 1);
}

async function applyCandidate(candidate: FunnelCandidate): Promise<void> {
  const createResult = await apiRequest<CloudResult<{ application: CloudApplication; created: boolean }>>(
    "/api/applications",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "manual",
        company: candidate.company,
        title: candidate.title,
        url: candidate.url,
        notes: candidate.notes,
      }),
    },
  );
  const created = requireAvailable(createResult, `Create ${candidate.company} / ${candidate.title}`);
  if (!created.created) return;

  for (const to of transitionPlan(candidate.status)) {
    const by = ["sent", "response", "interview", "closed"].includes(to) ? "owner" : "agent";
    const note = to === "closed" ? `Historical funnel outcome: ${candidate.originalStatus}` : undefined;
    const transitionResult = await apiRequest<CloudResult<{ application: CloudApplication }>>(
      `/api/applications/${created.application.id}/transition`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to, by, ...(note ? { note } : {}) }),
      },
    );
    requireAvailable(transitionResult, `Transition ${candidate.company} / ${candidate.title} to ${to}`);
  }
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const pathFlag = args.indexOf("--file");
  const funnelPath = resolve(pathFlag === -1 ? DEFAULT_FUNNEL_PATH : (args[pathFlag + 1] ?? ""));
  if (pathFlag !== -1 && !args[pathFlag + 1]) throw new Error("--file requires a path");

  const markdown = await Bun.file(funnelPath).text();
  const candidates = parseFunnelTables(markdown).map(mapFunnelRow);
  if (candidates.length === 0) throw new Error(`No funnel table rows found in ${funnelPath}`);

  const listResult = await apiRequest<CloudResult<CloudApplication[]>>("/api/applications");
  const existing = requireAvailable(listResult, "List applications");
  const existingByKey = new Map(existing.map((application) => [matchKey(application.company, application.title), application]));
  const pending = candidates.filter((candidate) => !existingByKey.has(matchKey(candidate.company, candidate.title)));

  console.log(`Funnel import ${apply ? "apply" : "dry run"}`);
  console.log(`Source: ${funnelPath}`);
  console.log(`Parsed rows: ${candidates.length}`);
  console.log(`Would create: ${pending.length}`);
  console.log(`Already exists: ${candidates.length - pending.length}`);
  for (const candidate of candidates) {
    const application = existingByKey.get(matchKey(candidate.company, candidate.title));
    if (application) {
      console.log(`EXISTS | ${candidate.company} | ${candidate.title} | ${application.status} | id=${application.id}`);
      continue;
    }
    console.log(
      `${apply ? "CREATE" : "WOULD CREATE"} | ${candidate.company} | ${candidate.title} | ${candidate.originalStatus} -> ${candidate.status}`,
    );
    if (apply) await applyCandidate(candidate);
  }
}

if (import.meta.main) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
