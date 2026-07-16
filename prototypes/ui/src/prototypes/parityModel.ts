import type { OpsParityRow } from "../types";

export const PARITY_WINDOW_MINUTES = 120;

export type ParityComparison = {
  runDate: string;
  mac: OpsParityRow | null;
  modal: OpsParityRow | null;
  separationMinutes: number | null;
  status: "awaiting_mac" | "awaiting_modal" | "no_comparable_window" | "in_sync" | "divergence";
};

function closestPair(macRows: OpsParityRow[], modalRows: OpsParityRow[]) {
  let closest: { mac: OpsParityRow; modal: OpsParityRow; milliseconds: number } | null = null;
  for (const mac of macRows) {
    for (const modal of modalRows) {
      const milliseconds = Math.abs(
        new Date(mac.created_at).getTime() - new Date(modal.created_at).getTime(),
      );
      if (closest === null || milliseconds < closest.milliseconds) {
        closest = { mac, modal, milliseconds };
      }
    }
  }
  return closest;
}

export function deriveParityComparisons(rows: OpsParityRow[]): ParityComparison[] {
  const byDate = new Map<string, OpsParityRow[]>();
  for (const row of rows) byDate.set(row.run_date, [...(byDate.get(row.run_date) ?? []), row]);

  return [...byDate.entries()]
    .sort(([left], [right]) => right.localeCompare(left))
    .map(([runDate, dateRows]) => {
      const macRows = dateRows.filter((row) => row.substrate === "mac");
      const modalRows = dateRows.filter((row) => row.substrate === "modal");
      if (macRows.length === 0) {
        return {
          runDate,
          mac: null,
          modal: modalRows[0] ?? null,
          separationMinutes: null,
          status: "awaiting_mac" as const,
        };
      }
      if (modalRows.length === 0) {
        return {
          runDate,
          mac: macRows[0] ?? null,
          modal: null,
          separationMinutes: null,
          status: "awaiting_modal" as const,
        };
      }

      const pair = closestPair(macRows, modalRows);
      if (pair === null) throw new Error("parity pair unexpectedly missing");
      const separationMinutes = pair.milliseconds / 60_000;
      const status =
        separationMinutes > PARITY_WINDOW_MINUTES
          ? "no_comparable_window"
          : pair.mac.ids_sha256 === pair.modal.ids_sha256
            ? "in_sync"
            : "divergence";
      return { runDate, mac: pair.mac, modal: pair.modal, separationMinutes, status };
    });
}
