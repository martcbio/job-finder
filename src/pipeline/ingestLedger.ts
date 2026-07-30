import { createHash } from "node:crypto";

const INGEST_LEDGER_CONTRACT_VERSION = 1;
const SHA256_RE = /^[0-9a-f]{64}$/;
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ledgerRecordBrand: unique symbol = Symbol("IngestLedgerRecord");
const ledgerHashBrand: unique symbol = Symbol("IngestLedgerHash");

type OpaqueLedgerRecord = {
  readonly [ledgerRecordBrand]: true;
};

type LedgerHash = string & {
  readonly [ledgerHashBrand]: true;
};

type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

type CanonicalJson = {
  readonly value: JsonValue;
  readonly text: string;
};

type PendingScope = ScopeIdentity & {
  readonly _tag: "pending";
};

type RunningScope = ScopeIdentity & {
  readonly _tag: "running";
  readonly startedAt: string;
};

type CompleteScope = ScopeIdentity & {
  readonly _tag: "complete";
  readonly startedAt: string | null;
  readonly completedAt: string;
  readonly observations: readonly IngestObservation[];
  readonly resultCount: number;
};

type FailedScope = ScopeIdentity & {
  readonly _tag: "failed";
  readonly startedAt: string | null;
  readonly observations: readonly IngestObservation[];
  readonly failedAt: string;
  readonly failureCode: string;
};

type ScopeIdentity = OpaqueLedgerRecord & {
  readonly sourceId: string;
  readonly scopeKey: string;
  readonly scopeHash: LedgerHash;
  readonly request: JsonValue;
};

type RunIdentity = OpaqueLedgerRecord & {
  readonly runHash: LedgerHash;
  readonly producer: string;
  readonly contractVersion: number;
};

type CollectingIngestRun = RunIdentity & {
  readonly _tag: "collecting";
  readonly scopes: readonly IngestSourceScope[];
  readonly producedVersionHashes: readonly LedgerHash[];
};

type ReadyIngestRun = RunIdentity & {
  readonly _tag: "ready";
  readonly scopes: readonly CompleteScope[];
  readonly producedVersionHashes: readonly LedgerHash[];
  readonly readyAt: string;
};

type CommittedIngestRun = RunIdentity & {
  readonly _tag: "committed";
  readonly scopes: readonly CompleteScope[];
  readonly producedVersionHashes: readonly LedgerHash[];
  readonly readyAt: string;
  readonly committedAt: string;
  readonly manifest: CommitManifest;
};

type FailedIngestRun = RunIdentity & {
  readonly _tag: "failed";
  readonly scopes: readonly IngestSourceScope[];
  readonly producedVersionHashes: readonly LedgerHash[];
  readonly readyAt: string | null;
  readonly failedAt: string;
  readonly failureCode: string;
};

/** A typed success or expected ingest-ledger failure. */
export type LedgerResult<T> =
  | { readonly _tag: "ok"; readonly value: T }
  | { readonly _tag: "err"; readonly error: IngestLedgerError };

/** Stable error codes returned by the deterministic ingest-ledger core. */
export type IngestLedgerErrorCode =
  | "INVALID_INPUT"
  | "INVALID_JSON"
  | "DUPLICATE_SCOPE"
  | "UNKNOWN_SCOPE"
  | "ILLEGAL_TRANSITION"
  | "INCOMPLETE_SCOPE"
  | "HASH_MISMATCH"
  | "MISSING_PROVENANCE"
  | "UNKNOWN_OBSERVATION"
  | "UNKNOWN_LISTING_VERSION"
  | "UNREFERENCED_LISTING_VERSION"
  | "CONFLICTING_COMMIT";

/** Structured expected failure from an ingest-ledger operation. */
export type IngestLedgerError = {
  readonly _tag: "IngestLedgerError";
  readonly code: IngestLedgerErrorCode;
  readonly message: string;
};

/** Input describing one explicit source/query/page scope in a durable run. */
export type IngestSourceScopeInput = {
  readonly sourceId: string;
  readonly scopeKey: string;
  readonly request: unknown;
};

/** Input used to create a deterministic durable-run identity. */
export type CreateIngestRunInput = {
  readonly producer: string;
  readonly scopes: readonly IngestSourceScopeInput[];
};

/** One source scope in its legal lifecycle state. */
export type IngestSourceScope = PendingScope | RunningScope | CompleteScope | FailedScope;

/** A durable ingest run in its legal lifecycle state. */
export type IngestRun = CollectingIngestRun | ReadyIngestRun | CommittedIngestRun | FailedIngestRun;

/** Input for one immutable raw source observation. */
export type IngestObservationInput = {
  readonly scopeHash: string;
  readonly sourceRecordKey: string;
  readonly observedAt: string;
  readonly raw: unknown;
};

/** Immutable, content-addressed raw source evidence. */
export type IngestObservation = OpaqueLedgerRecord & {
  readonly observationHash: LedgerHash;
  readonly scopeHash: LedgerHash;
  readonly sourceRecordKey: string;
  readonly observedAt: string;
  readonly raw: JsonValue;
};

/** Input for one immutable normalized representation of a listing. */
export type NormalizedListingVersionInput = {
  readonly listingKey: string;
  readonly normalizer: string;
  readonly normalized: unknown;
};

/** Immutable, content-addressed normalized listing version. */
export type NormalizedListingVersion = OpaqueLedgerRecord & {
  readonly versionHash: LedgerHash;
  readonly createdByScopeHash: LedgerHash;
  readonly listingKey: string;
  readonly normalizer: string;
  readonly normalized: JsonValue;
};

/** Immutable provenance edge from raw evidence to a normalized listing version. */
export type ObservationVersionEdge = OpaqueLedgerRecord & {
  readonly observationHash: LedgerHash;
  readonly versionHash: LedgerHash;
};

/** Deterministic payload and digest committed atomically for a complete run. */
export type CommitManifest = OpaqueLedgerRecord & {
  readonly manifestHash: LedgerHash;
  readonly payload: {
    readonly contractVersion: number;
    readonly runHash: LedgerHash;
    readonly scopes: readonly {
      readonly scopeHash: LedgerHash;
      readonly sourceId: string;
      readonly scopeKey: string;
      readonly resultCount: number;
      readonly observationHashes: readonly LedgerHash[];
    }[];
    readonly versionHashes: readonly LedgerHash[];
    readonly edges: readonly ObservationVersionEdge[];
  };
};

/** Creates a collecting run with stable scope and run hashes and no ambient time. */
export function createIngestRun(input: CreateIngestRunInput): LedgerResult<CollectingIngestRun> {
  const producerError = requireNonEmpty(input.producer, "producer");
  if (producerError) return err(producerError);
  if (input.scopes.length === 0) {
    return err(makeError("INVALID_INPUT", "An ingest run requires at least one source scope"));
  }

  const scopes: PendingScope[] = [];
  const scopeKeys = new Set<string>();
  const scopeHashes = new Set<string>();
  for (const [index, inputScope] of input.scopes.entries()) {
    const sourceError = requireNonEmpty(inputScope.sourceId, `scopes[${index}].sourceId`);
    if (sourceError) return err(sourceError);
    const keyError = requireNonEmpty(inputScope.scopeKey, `scopes[${index}].scopeKey`);
    if (keyError) return err(keyError);

    const sourceId = inputScope.sourceId.trim();
    const scopeKey = inputScope.scopeKey.trim();
    const identityKey = `${sourceId}\u0000${scopeKey}`;
    if (scopeKeys.has(identityKey)) {
      return err(
        makeError(
          "DUPLICATE_SCOPE",
          `Source scope "${sourceId}:${scopeKey}" appears more than once`,
        ),
      );
    }
    scopeKeys.add(identityKey);

    const request = canonicalizeJson(inputScope.request);
    if (request._tag === "err") return request;
    if (!isJsonObject(request.value.value)) {
      return err(makeError("INVALID_INPUT", `scopes[${index}].request must be a JSON object`));
    }

    const scopeHash = hashJson({
      contractVersion: INGEST_LEDGER_CONTRACT_VERSION,
      sourceId,
      scopeKey,
      request: request.value.value,
    });
    if (scopeHash._tag === "err") return scopeHash;
    if (scopeHashes.has(scopeHash.value)) {
      return err(makeError("DUPLICATE_SCOPE", `Duplicate source scope hash ${scopeHash.value}`));
    }
    scopeHashes.add(scopeHash.value);
    scopes.push({
      [ledgerRecordBrand]: true,
      _tag: "pending",
      sourceId,
      scopeKey,
      scopeHash: scopeHash.value,
      request: request.value.value,
    });
  }

  scopes.sort(compareScope);
  const runHash = hashJson({
    contractVersion: INGEST_LEDGER_CONTRACT_VERSION,
    producer: input.producer.trim(),
    scopes: scopes.map(scopeIdentityProjection),
  });
  if (runHash._tag === "err") return runHash;

  return ok({
    [ledgerRecordBrand]: true,
    _tag: "collecting",
    runHash: runHash.value,
    producer: input.producer.trim(),
    contractVersion: INGEST_LEDGER_CONTRACT_VERSION,
    scopes: Object.freeze(scopes),
    producedVersionHashes: Object.freeze([]),
  });
}

/** Transitions one pending scope to running; replaying the same start is a no-op. */
export function startIngestScope(
  run: IngestRun,
  scopeHash: string,
  startedAt: string,
): LedgerResult<CollectingIngestRun> {
  if (run._tag !== "collecting") {
    return illegalTransition(`Cannot start a source scope while run is ${run._tag}`);
  }
  const timestamp = parseTimestamp(startedAt, "startedAt");
  if (timestamp._tag === "err") return timestamp;
  const scope = run.scopes.find((candidate) => candidate.scopeHash === scopeHash);
  if (!scope) return unknownScope(scopeHash);
  if (scope._tag === "running") {
    return scope.startedAt === timestamp.value
      ? ok(run)
      : illegalTransition(`Running source scope ${scopeHash} cannot change startedAt`);
  }
  if (scope._tag !== "pending") {
    return illegalTransition(`Cannot start source scope ${scopeHash} from ${scope._tag}`);
  }

  const started: RunningScope = { ...scope, _tag: "running", startedAt: timestamp.value };
  return ok(replaceScope(run, started));
}

/**
 * Completes one source scope with immutable observations.
 *
 * Duplicate observation hashes are collapsed, so a deterministic replay has the
 * same result count. An empty observation list is a valid zero-result scope.
 */
export function completeIngestScope(
  run: IngestRun,
  scopeHash: string,
  completedAt: string,
  observations: readonly IngestObservation[],
): LedgerResult<CollectingIngestRun> {
  if (run._tag !== "collecting") {
    return illegalTransition(`Cannot complete a source scope while run is ${run._tag}`);
  }
  const timestamp = parseTimestamp(completedAt, "completedAt");
  if (timestamp._tag === "err") return timestamp;
  const scope = run.scopes.find((candidate) => candidate.scopeHash === scopeHash);
  if (!scope) return unknownScope(scopeHash);

  const deduplicated = deduplicateObservations(scopeHash, observations);
  if (deduplicated._tag === "err") return deduplicated;
  if (scope._tag === "complete") {
    const existingHashes = scope.observations.map((observation) => observation.observationHash);
    const replayHashes = deduplicated.value.map((observation) => observation.observationHash);
    return scope.completedAt === timestamp.value && arraysEqual(existingHashes, replayHashes)
      ? ok(run)
      : err(
          makeError(
            "ILLEGAL_TRANSITION",
            `Completed source scope ${scopeHash} cannot change completedAt or observations`,
          ),
        );
  }
  if (scope._tag !== "pending" && scope._tag !== "running") {
    return illegalTransition(`Cannot complete source scope ${scopeHash} from ${scope._tag}`);
  }
  const startedAt = scope._tag === "running" ? scope.startedAt : null;
  if (startedAt !== null && Date.parse(timestamp.value) < Date.parse(startedAt)) {
    return illegalTransition(
      `Source scope ${scopeHash} cannot complete before its startedAt timestamp`,
    );
  }
  const observationBeforeStart =
    startedAt === null
      ? undefined
      : deduplicated.value.find(
          (observation) => Date.parse(observation.observedAt) < Date.parse(startedAt),
        );
  if (observationBeforeStart) {
    return illegalTransition(
      `Observation ${observationBeforeStart.observationHash} cannot precede source scope startedAt`,
    );
  }
  const observationAfterCompletion = deduplicated.value.find(
    (observation) => Date.parse(observation.observedAt) > Date.parse(timestamp.value),
  );
  if (observationAfterCompletion) {
    return illegalTransition(
      `Observation ${observationAfterCompletion.observationHash} cannot follow source scope completedAt`,
    );
  }

  const complete: CompleteScope = {
    ...scopeIdentityProjection(scope),
    _tag: "complete",
    startedAt,
    completedAt: timestamp.value,
    observations: deduplicated.value,
    resultCount: deduplicated.value.length,
  };
  return ok(replaceScope(run, complete));
}

/** Fails a pending/running scope while retaining its bounded observation evidence. */
export function failIngestScope(
  run: IngestRun,
  scopeHash: string,
  failedAt: string,
  failureCode: string,
  observations: readonly IngestObservation[],
): LedgerResult<CollectingIngestRun> {
  if (run._tag !== "collecting") {
    return illegalTransition(`Cannot fail a source scope while run is ${run._tag}`);
  }
  const timestamp = parseTimestamp(failedAt, "failedAt");
  if (timestamp._tag === "err") return timestamp;
  const failureError = requireNonEmpty(failureCode, "failureCode");
  if (failureError) return err(failureError);
  const scope = run.scopes.find((candidate) => candidate.scopeHash === scopeHash);
  if (!scope) return unknownScope(scopeHash);
  const deduplicated = deduplicateObservations(scopeHash, observations);
  if (deduplicated._tag === "err") return deduplicated;
  if (scope._tag === "failed") {
    const existingHashes = scope.observations.map((observation) => observation.observationHash);
    const replayHashes = deduplicated.value.map((observation) => observation.observationHash);
    return scope.failureCode === failureCode.trim() &&
      scope.failedAt === timestamp.value &&
      arraysEqual(existingHashes, replayHashes)
      ? ok(run)
      : illegalTransition(
          `Failed source scope ${scopeHash} cannot change failedAt, failure code, or observations`,
        );
  }
  if (scope._tag !== "pending" && scope._tag !== "running") {
    return illegalTransition(`Cannot fail source scope ${scopeHash} from ${scope._tag}`);
  }
  const startedAt = scope._tag === "running" ? scope.startedAt : null;
  if (startedAt !== null && Date.parse(timestamp.value) < Date.parse(startedAt)) {
    return illegalTransition(
      `Source scope ${scopeHash} cannot fail before its startedAt timestamp`,
    );
  }
  const observationBeforeStart =
    startedAt === null
      ? undefined
      : deduplicated.value.find(
          (observation) => Date.parse(observation.observedAt) < Date.parse(startedAt),
        );
  if (observationBeforeStart) {
    return illegalTransition(
      `Observation ${observationBeforeStart.observationHash} cannot precede source scope startedAt`,
    );
  }
  const observationAfterFailure = deduplicated.value.find(
    (observation) => Date.parse(observation.observedAt) > Date.parse(timestamp.value),
  );
  if (observationAfterFailure) {
    return illegalTransition(
      `Observation ${observationAfterFailure.observationHash} cannot follow source scope failedAt`,
    );
  }

  const failed: FailedScope = {
    ...scopeIdentityProjection(scope),
    _tag: "failed",
    startedAt,
    observations: deduplicated.value,
    failedAt: timestamp.value,
    failureCode: failureCode.trim(),
  };
  return ok(replaceScope(run, failed));
}

/** Marks a run ready only when every explicit source scope is complete. */
export function prepareIngestRun(run: IngestRun, readyAt: string): LedgerResult<ReadyIngestRun> {
  const timestamp = parseTimestamp(readyAt, "readyAt");
  if (timestamp._tag === "err") return timestamp;
  if (run._tag === "ready") {
    return run.readyAt === timestamp.value
      ? ok(run)
      : illegalTransition(`Ready ingest run ${run.runHash} cannot change readyAt`);
  }
  if (run._tag !== "collecting") {
    return illegalTransition(`Cannot prepare an ingest run from ${run._tag}`);
  }
  const incomplete = run.scopes.find((scope) => scope._tag !== "complete");
  if (incomplete) {
    return err(
      makeError(
        "INCOMPLETE_SCOPE",
        `Source scope ${incomplete.scopeHash} is ${incomplete._tag}; every scope must be complete`,
      ),
    );
  }
  const completeScopes = run.scopes.filter(isCompleteScope);
  const completedAfterReady = completeScopes.find(
    (scope) => Date.parse(scope.completedAt) > Date.parse(timestamp.value),
  );
  if (completedAfterReady) {
    return illegalTransition(
      `Ingest run readyAt cannot precede completedAt for source scope ${completedAfterReady.scopeHash}`,
    );
  }

  return ok({
    ...runIdentityProjection(run),
    _tag: "ready",
    scopes: Object.freeze(completeScopes),
    producedVersionHashes: run.producedVersionHashes,
    readyAt: timestamp.value,
  });
}

/** Transitions a collecting or ready run to failed without discarding evidence. */
export function failIngestRun(
  run: IngestRun,
  failedAt: string,
  failureCode: string,
): LedgerResult<FailedIngestRun> {
  const timestamp = parseTimestamp(failedAt, "failedAt");
  if (timestamp._tag === "err") return timestamp;
  const failureError = requireNonEmpty(failureCode, "failureCode");
  if (failureError) return err(failureError);
  if (run._tag === "committed") {
    return illegalTransition("A committed ingest run cannot fail");
  }
  if (run._tag === "failed") {
    return run.failureCode === failureCode.trim() && run.failedAt === timestamp.value
      ? ok(run)
      : illegalTransition("A failed ingest run cannot change failedAt or failure code");
  }
  const readyAt = run._tag === "ready" ? run.readyAt : null;
  if (readyAt !== null && Date.parse(timestamp.value) < Date.parse(readyAt)) {
    return illegalTransition("An ingest run cannot fail before its readyAt timestamp");
  }
  const laterScopeLifecycleTimestamp = run.scopes
    .flatMap(scopeLifecycleTimestamps)
    .find((recordedAt) => Date.parse(recordedAt) > Date.parse(timestamp.value));
  if (laterScopeLifecycleTimestamp) {
    return illegalTransition(
      "An ingest run cannot fail before recorded scope or evidence lifecycle timestamps",
    );
  }

  return ok({
    ...runIdentityProjection(run),
    _tag: "failed",
    scopes: run.scopes,
    producedVersionHashes: run.producedVersionHashes,
    readyAt,
    failedAt: timestamp.value,
    failureCode: failureCode.trim(),
  });
}

/** Creates immutable raw evidence whose hash is stable across JSON object key order. */
export function createIngestObservation(
  input: IngestObservationInput,
): LedgerResult<IngestObservation> {
  const scopeHash = parseLedgerHash(input.scopeHash, "scopeHash");
  if (scopeHash._tag === "err") return scopeHash;
  const keyError = requireNonEmpty(input.sourceRecordKey, "sourceRecordKey");
  if (keyError) return err(keyError);
  const observedAt = parseTimestamp(input.observedAt, "observedAt");
  if (observedAt._tag === "err") return observedAt;
  const raw = canonicalizeJson(input.raw);
  if (raw._tag === "err") return raw;
  const sourceRecordKey = input.sourceRecordKey.trim();
  const observationHash = hashJson({
    contractVersion: INGEST_LEDGER_CONTRACT_VERSION,
    scopeHash: scopeHash.value,
    sourceRecordKey,
    observedAt: observedAt.value,
    raw: raw.value.value,
  });
  if (observationHash._tag === "err") return observationHash;

  return ok({
    [ledgerRecordBrand]: true,
    observationHash: observationHash.value,
    scopeHash: scopeHash.value,
    sourceRecordKey,
    observedAt: observedAt.value,
    raw: raw.value.value,
  });
}

/** Creates a version and returns the collecting aggregate with its hash registered. */
export function createNormalizedListingVersion(
  run: IngestRun,
  createdByScopeHash: string,
  input: NormalizedListingVersionInput,
): LedgerResult<{
  readonly run: CollectingIngestRun;
  readonly version: NormalizedListingVersion;
}> {
  if (run._tag !== "collecting") {
    return illegalTransition(`Cannot create a listing version while run is ${run._tag}`);
  }
  const producerScope = run.scopes.find((scope) => scope.scopeHash === createdByScopeHash);
  if (!producerScope) return unknownScope(createdByScopeHash);
  if (producerScope._tag !== "pending" && producerScope._tag !== "running") {
    return illegalTransition(
      `Cannot create a listing version from source scope ${createdByScopeHash} in state ${producerScope._tag}`,
    );
  }
  const listingError = requireNonEmpty(input.listingKey, "listingKey");
  if (listingError) return err(listingError);
  const normalizerError = requireNonEmpty(input.normalizer, "normalizer");
  if (normalizerError) return err(normalizerError);
  const normalized = canonicalizeJson(input.normalized);
  if (normalized._tag === "err") return normalized;
  if (!isJsonObject(normalized.value.value)) {
    return err(makeError("INVALID_INPUT", "normalized must be a JSON object"));
  }
  const listingKey = input.listingKey.trim();
  const normalizer = input.normalizer.trim();
  const versionHash = hashJson({
    contractVersion: INGEST_LEDGER_CONTRACT_VERSION,
    listingKey,
    normalizer,
    normalized: normalized.value.value,
  });
  if (versionHash._tag === "err") return versionHash;

  const version: NormalizedListingVersion = {
    [ledgerRecordBrand]: true,
    versionHash: versionHash.value,
    createdByScopeHash: producerScope.scopeHash,
    listingKey,
    normalizer,
    normalized: normalized.value.value,
  };
  const producedVersionHashes = run.producedVersionHashes.includes(version.versionHash)
    ? run.producedVersionHashes
    : Object.freeze([...run.producedVersionHashes, version.versionHash].sort(compareUtf8));

  return ok({
    run:
      producedVersionHashes === run.producedVersionHashes ? run : { ...run, producedVersionHashes },
    version,
  });
}

/** Creates the explicit provenance edge between one observation and one version. */
export function linkObservationToVersion(
  observation: IngestObservation,
  version: NormalizedListingVersion,
): ObservationVersionEdge {
  return Object.freeze({
    [ledgerRecordBrand]: true,
    observationHash: observation.observationHash,
    versionHash: version.versionHash,
  });
}

/**
 * Builds and commits a complete deterministic manifest from registered version hashes.
 *
 * Replaying the same commit returns the original committed run. A second,
 * different manifest for the same run is rejected.
 */
export function commitIngestRun(
  run: IngestRun,
  committedAt: string,
  edges: readonly ObservationVersionEdge[],
): LedgerResult<CommittedIngestRun> {
  if (run._tag !== "ready" && run._tag !== "committed") {
    return illegalTransition(`Cannot commit an ingest run from ${run._tag}`);
  }
  const timestamp = parseTimestamp(committedAt, "committedAt");
  if (timestamp._tag === "err") return timestamp;
  if (Date.parse(timestamp.value) < Date.parse(run.readyAt)) {
    return illegalTransition("An ingest run cannot commit before its readyAt timestamp");
  }

  const observations = run.scopes.flatMap((scope) => scope.observations);
  const observationHashes = new Set(observations.map((observation) => observation.observationHash));
  const producedVersionHashes = new Set(run.producedVersionHashes);

  const edgesByKey = new Map<string, ObservationVersionEdge>();
  const referencedVersionHashes = new Set<LedgerHash>();
  const observationsWithProvenance = new Set<LedgerHash>();
  for (const edge of edges) {
    if (!observationHashes.has(edge.observationHash)) {
      return err(
        makeError(
          "UNKNOWN_OBSERVATION",
          `Provenance references observation ${edge.observationHash} outside this run`,
        ),
      );
    }
    if (!producedVersionHashes.has(edge.versionHash)) {
      return err(
        makeError(
          "UNKNOWN_LISTING_VERSION",
          `Provenance references unknown listing version ${edge.versionHash}`,
        ),
      );
    }
    const edgeKey = `${edge.observationHash}:${edge.versionHash}`;
    edgesByKey.set(edgeKey, edge);
    referencedVersionHashes.add(edge.versionHash);
    observationsWithProvenance.add(edge.observationHash);
  }

  const missingObservation = observations.find(
    (observation) => !observationsWithProvenance.has(observation.observationHash),
  );
  if (missingObservation) {
    return err(
      makeError(
        "MISSING_PROVENANCE",
        `Observation ${missingObservation.observationHash} has no normalized listing version`,
      ),
    );
  }

  const unreferencedVersionHash = run.producedVersionHashes.find(
    (versionHash) => !referencedVersionHashes.has(versionHash),
  );
  if (unreferencedVersionHash) {
    return err(
      makeError(
        "UNREFERENCED_LISTING_VERSION",
        `Listing version ${unreferencedVersionHash} is not referenced by this run`,
      ),
    );
  }

  const sortedEdges = [...edgesByKey.values()].sort(compareEdge);
  const payload: CommitManifest["payload"] = Object.freeze({
    contractVersion: INGEST_LEDGER_CONTRACT_VERSION,
    runHash: run.runHash,
    scopes: Object.freeze(
      run.scopes.map((scope) =>
        Object.freeze({
          scopeHash: scope.scopeHash,
          sourceId: scope.sourceId,
          scopeKey: scope.scopeKey,
          resultCount: scope.resultCount,
          observationHashes: Object.freeze(
            scope.observations.map((observation) => observation.observationHash).sort(),
          ),
        }),
      ),
    ),
    versionHashes: run.producedVersionHashes,
    edges: Object.freeze(sortedEdges),
  });
  const manifestHash = hashJson(payload);
  if (manifestHash._tag === "err") return manifestHash;
  const manifest: CommitManifest = Object.freeze({
    [ledgerRecordBrand]: true,
    manifestHash: manifestHash.value,
    payload,
  });

  if (run._tag === "committed") {
    if (run.committedAt !== timestamp.value) {
      return illegalTransition(`Committed ingest run ${run.runHash} cannot change committedAt`);
    }
    return run.manifest.manifestHash === manifest.manifestHash
      ? ok(run)
      : err(
          makeError(
            "CONFLICTING_COMMIT",
            `Run ${run.runHash} was already committed with a different manifest`,
          ),
        );
  }

  return ok({
    ...runIdentityProjection(run),
    _tag: "committed",
    scopes: run.scopes,
    producedVersionHashes: run.producedVersionHashes,
    readyAt: run.readyAt,
    committedAt: timestamp.value,
    manifest,
  });
}

function replaceScope(
  run: CollectingIngestRun,
  replacement: IngestSourceScope,
): CollectingIngestRun {
  return {
    ...run,
    scopes: Object.freeze(
      run.scopes.map((scope) => (scope.scopeHash === replacement.scopeHash ? replacement : scope)),
    ),
  };
}

function deduplicateObservations(
  scopeHash: string,
  observations: readonly IngestObservation[],
): LedgerResult<readonly IngestObservation[]> {
  const byHash = new Map<string, IngestObservation>();
  for (const observation of observations) {
    if (observation.scopeHash !== scopeHash) {
      return err(
        makeError(
          "HASH_MISMATCH",
          `Observation ${observation.observationHash} belongs to scope ${observation.scopeHash}, not ${scopeHash}`,
        ),
      );
    }
    if (!SHA256_RE.test(observation.observationHash)) {
      return err(
        makeError(
          "INVALID_INPUT",
          `Observation hash ${observation.observationHash} is not a lowercase SHA-256 digest`,
        ),
      );
    }
    byHash.set(observation.observationHash, observation);
  }
  return ok(Object.freeze([...byHash.values()].sort(compareObservation)));
}

function canonicalizeJson(value: unknown): LedgerResult<CanonicalJson> {
  const parsed = parseJsonValue(value, new Set<object>(), "$");
  if (parsed._tag === "err") return parsed;
  return ok({ value: parsed.value, text: renderCanonicalJson(parsed.value) });
}

function parseJsonValue(
  value: unknown,
  ancestors: Set<object>,
  path: string,
): LedgerResult<JsonValue> {
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" &&
      Number.isFinite(value) &&
      (!Number.isInteger(value) || Number.isSafeInteger(value)))
  ) {
    return ok(value);
  }
  if (typeof value === "string") {
    if (value.includes("\u0000")) {
      return err(
        makeError("INVALID_JSON", `${path} contains a null character unsupported by jsonb`),
      );
    }
    if (hasLoneUtf16Surrogate(value)) {
      return err(makeError("INVALID_JSON", `${path} contains a lone UTF-16 surrogate`));
    }
    return ok(value);
  }
  if (typeof value === "number") {
    return err(
      makeError(
        "INVALID_JSON",
        Number.isFinite(value)
          ? `${path} contains an unsafe integer; encode large identifiers as strings`
          : `${path} contains a non-finite number`,
      ),
    );
  }
  if (typeof value !== "object") {
    return err(makeError("INVALID_JSON", `${path} contains unsupported ${typeof value}`));
  }
  if (ancestors.has(value)) {
    return err(makeError("INVALID_JSON", `${path} contains a cycle`));
  }

  ancestors.add(value);
  if (Array.isArray(value)) {
    const items: JsonValue[] = [];
    for (const [index, item] of value.entries()) {
      const parsed = parseJsonValue(item, ancestors, `${path}[${index}]`);
      if (parsed._tag === "err") return parsed;
      items.push(parsed.value);
    }
    ancestors.delete(value);
    return ok(Object.freeze(items));
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    ancestors.delete(value);
    return err(makeError("INVALID_JSON", `${path} must be a plain JSON object`));
  }

  const entries = Object.entries(value);
  const nullKey = entries.find(([key]) => key.includes("\u0000"));
  if (nullKey !== undefined) {
    ancestors.delete(value);
    return err(makeError("INVALID_JSON", `${path} contains a null character key`));
  }
  const invalidKey = entries.find(([key]) => hasLoneUtf16Surrogate(key));
  if (invalidKey !== undefined) {
    ancestors.delete(value);
    return err(makeError("INVALID_JSON", `${path} contains a lone UTF-16 surrogate key`));
  }

  const record: Record<string, JsonValue> = {};
  for (const [key, item] of entries.sort(([left], [right]) => compareUtf8(left, right))) {
    const parsed = parseJsonValue(item, ancestors, `${path}.${key}`);
    if (parsed._tag === "err") return parsed;
    record[key] = parsed.value;
  }
  ancestors.delete(value);
  return ok(Object.freeze(record));
}

function hashJson(value: unknown): LedgerResult<LedgerHash> {
  const canonical = canonicalizeJson(value);
  if (canonical._tag === "err") return canonical;
  const digest = createHash("sha256").update(canonical.value.text).digest("hex");
  // SAFETY: createHash("sha256").digest("hex") always returns a lowercase 64-character digest.
  return ok(digest as LedgerHash);
}

function parseTimestamp(value: string, field: string): LedgerResult<string> {
  if (typeof value !== "string" || !ISO_TIMESTAMP_RE.test(value)) {
    return err(
      makeError("INVALID_INPUT", `${field} must be an exact UTC ISO-8601 millisecond timestamp`),
    );
  }
  const epochMilliseconds = Date.parse(value);
  if (!Number.isFinite(epochMilliseconds) || new Date(epochMilliseconds).toISOString() !== value) {
    return err(
      makeError("INVALID_INPUT", `${field} must be an exact UTC ISO-8601 millisecond timestamp`),
    );
  }
  return ok(value);
}

function requireNonEmpty(value: string, field: string): IngestLedgerError | null {
  if (typeof value !== "string" || value.trim() === "") {
    return makeError("INVALID_INPUT", `${field} must be a non-empty string`);
  }
  return value.includes("\u0000")
    ? makeError("INVALID_INPUT", `${field} contains a null character unsupported by PostgreSQL`)
    : null;
}

function isJsonObject(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCompleteScope(scope: IngestSourceScope): scope is CompleteScope {
  return scope._tag === "complete";
}

function scopeLifecycleTimestamps(scope: IngestSourceScope): readonly string[] {
  switch (scope._tag) {
    case "pending":
      return [];
    case "running":
      return [scope.startedAt];
    case "complete":
      return [
        ...(scope.startedAt === null ? [] : [scope.startedAt]),
        scope.completedAt,
        ...scope.observations.map((observation) => observation.observedAt),
      ];
    case "failed":
      return [
        ...(scope.startedAt === null ? [] : [scope.startedAt]),
        ...scope.observations.map((observation) => observation.observedAt),
        scope.failedAt,
      ];
  }
}

function scopeIdentityProjection(scope: ScopeIdentity): ScopeIdentity {
  return {
    [ledgerRecordBrand]: true,
    sourceId: scope.sourceId,
    scopeKey: scope.scopeKey,
    scopeHash: scope.scopeHash,
    request: scope.request,
  };
}

function runIdentityProjection(run: RunIdentity): RunIdentity {
  return {
    [ledgerRecordBrand]: true,
    runHash: run.runHash,
    producer: run.producer,
    contractVersion: run.contractVersion,
  };
}

function compareScope(left: ScopeIdentity, right: ScopeIdentity): number {
  return compareUtf8(left.scopeHash, right.scopeHash);
}

function compareObservation(left: IngestObservation, right: IngestObservation): number {
  return compareUtf8(left.observationHash, right.observationHash);
}

function compareEdge(left: ObservationVersionEdge, right: ObservationVersionEdge): number {
  return (
    compareUtf8(left.observationHash, right.observationHash) ||
    compareUtf8(left.versionHash, right.versionHash)
  );
}

function arraysEqual(left: readonly LedgerHash[], right: readonly LedgerHash[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function unknownScope(scopeHash: string): LedgerResult<never> {
  return err(makeError("UNKNOWN_SCOPE", `Run does not contain source scope ${scopeHash}`));
}

function illegalTransition(message: string): LedgerResult<never> {
  return err(makeError("ILLEGAL_TRANSITION", message));
}

function parseLedgerHash(value: string, field: string): LedgerResult<LedgerHash> {
  if (!SHA256_RE.test(value)) {
    return err(makeError("INVALID_INPUT", `${field} must be a lowercase SHA-256 digest`));
  }
  // SAFETY: SHA256_RE proves the string has the only representation accepted for LedgerHash.
  return ok(value as LedgerHash);
}

function renderCanonicalJson(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return canonicalNumber(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(renderCanonicalJson).join(",")}]`;

  return `{${Object.entries(value)
    .sort(([left], [right]) => compareUtf8(left, right))
    .map(([key, item]) => `${JSON.stringify(key)}:${renderCanonicalJson(item)}`)
    .join(",")}}`;
}

function canonicalNumber(value: number): string {
  if (Object.is(value, -0) || value === 0) return "0";
  const rendered = String(value).toLowerCase();
  const exponentMarker = rendered.indexOf("e");
  if (exponentMarker === -1) return trimFractionZeros(rendered);

  const mantissa = rendered.slice(0, exponentMarker);
  const exponent = Number(rendered.slice(exponentMarker + 1));
  const negative = mantissa.startsWith("-");
  const unsignedMantissa = negative ? mantissa.slice(1) : mantissa;
  const [integerPart = "", fractionalPart = ""] = unsignedMantissa.split(".");
  const digits = `${integerPart}${fractionalPart}`;
  const decimalPosition = integerPart.length + exponent;
  const expanded =
    decimalPosition <= 0
      ? `0.${"0".repeat(-decimalPosition)}${digits}`
      : decimalPosition >= digits.length
        ? `${digits}${"0".repeat(decimalPosition - digits.length)}`
        : `${digits.slice(0, decimalPosition)}.${digits.slice(decimalPosition)}`;
  return `${negative ? "-" : ""}${trimFractionZeros(expanded)}`;
}

function trimFractionZeros(value: string): string {
  return value.includes(".") ? value.replace(/(\.[0-9]*?)0+$/, "$1").replace(/\.$/, "") : value;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function hasLoneUtf16Surrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (!(nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff)) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function makeError(code: IngestLedgerErrorCode, message: string): IngestLedgerError {
  return { _tag: "IngestLedgerError", code, message };
}

function ok<T>(value: T): LedgerResult<T> {
  return { _tag: "ok", value };
}

function err(error: IngestLedgerError): LedgerResult<never> {
  return { _tag: "err", error };
}
