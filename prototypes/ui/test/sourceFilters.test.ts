import { expect, test } from "bun:test";

import type { SourceCatalogEntry } from "../src/sourceFilters";
import { hasSavedSourceSelection, loadEnabledSourceIds } from "../src/sourceFilters";

const CURRENT_STORAGE_KEY = "jobsradar.sourceFilters.v3";
const LEGACY_STORAGE_KEY = "job-finder.sourceFilters.v3";

const catalog = [
  { id: "linear-careers", label: "Linear", successRate: 0.9, evergreen: true },
  { id: "google-careers", label: "Google", successRate: 0.7, evergreen: false },
] satisfies SourceCatalogEntry[];

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function withStorage<T>(storage: Storage, callback: () => T): T {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });

  try {
    return callback();
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
}

test("migrates a legacy source selection to the Jobsradar storage key", () => {
  const storage = new MemoryStorage();
  const selection = JSON.stringify({ enabledSourceIds: ["linear-careers"] });
  storage.setItem(LEGACY_STORAGE_KEY, selection);

  withStorage(storage, () => {
    expect(hasSavedSourceSelection()).toBe(true);
    expect(storage.getItem(CURRENT_STORAGE_KEY)).toBe(selection);
    expect(loadEnabledSourceIds(catalog)).toEqual(["linear-careers"]);

    storage.setItem(
      LEGACY_STORAGE_KEY,
      JSON.stringify({ enabledSourceIds: ["google-careers"] }),
    );
    expect(loadEnabledSourceIds(catalog)).toEqual(["linear-careers"]);
  });
});

test("migrates an intentionally empty legacy selection without enabling every source", () => {
  const storage = new MemoryStorage();
  const selection = JSON.stringify({ enabledSourceIds: [] });
  storage.setItem(LEGACY_STORAGE_KEY, selection);

  withStorage(storage, () => {
    expect(loadEnabledSourceIds(catalog)).toEqual([]);
    expect(storage.getItem(CURRENT_STORAGE_KEY)).toBe(selection);
  });
});
