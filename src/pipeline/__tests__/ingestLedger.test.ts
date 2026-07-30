import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { IngestObservation } from "../ingestLedger";
import {
  commitIngestRun,
  completeIngestScope,
  createIngestObservation,
  createIngestRun,
  createNormalizedListingVersion,
  failIngestRun,
  failIngestScope,
  linkObservationToVersion,
  prepareIngestRun,
  startIngestScope,
} from "../ingestLedger";

const timestamp = "2026-07-30T10:00:00.000Z";

function unwrap<T>(result: { _tag: "ok"; value: T } | { _tag: "err"; error: unknown }): T {
  if (result._tag === "err") throw new Error(`Expected success: ${JSON.stringify(result.error)}`);
  return result.value;
}

describe("deterministic ingest ledger", () => {
  test("requires authoritative constructors for opaque ledger records", () => {
    const rawRecord = {
      observationHash: "0".repeat(64),
      scopeHash: "1".repeat(64),
      sourceRecordKey: "forged",
      observedAt: timestamp,
      raw: {},
    };
    // @ts-expect-error -- Ledger hashes and records carry private brands created only by this module.
    const forged: IngestObservation = rawRecord;

    expect(forged.sourceRecordKey).toBe("forged");
  });

  test("hashes equivalent plans and evidence identically regardless of JSON key order", () => {
    const first = unwrap(
      createIngestRun({
        producer: "radar-fixture",
        scopes: [
          {
            sourceId: "greenhouse",
            scopeKey: "openai:engineering",
            request: { query: "engineering", page: 1 },
          },
        ],
      }),
    );
    const replay = unwrap(
      createIngestRun({
        producer: "radar-fixture",
        scopes: [
          {
            sourceId: "greenhouse",
            scopeKey: "openai:engineering",
            request: { page: 1, query: "engineering" },
          },
        ],
      }),
    );

    expect(replay.runHash).toBe(first.runHash);
    expect(replay.scopes[0]?.scopeHash).toBe(first.scopes[0]?.scopeHash);

    const scopeHash = first.scopes[0]?.scopeHash;
    if (!scopeHash) throw new Error("Expected source scope");
    const observation = unwrap(
      createIngestObservation({
        scopeHash,
        sourceRecordKey: "openai:123",
        observedAt: timestamp,
        raw: { title: "Engineer", metadata: { team: "Applied AI", location: "London" } },
      }),
    );
    const observationReplay = unwrap(
      createIngestObservation({
        scopeHash,
        sourceRecordKey: "openai:123",
        observedAt: timestamp,
        raw: { metadata: { location: "London", team: "Applied AI" }, title: "Engineer" },
      }),
    );

    expect(observationReplay.observationHash).toBe(observation.observationHash);
  });

  test("rejects lone UTF-16 surrogates before UTF-8 key sorting or hashing", () => {
    const forward: Record<string, number> = {};
    forward["\ud800"] = 1;
    forward["\ud801"] = 2;
    const reverse: Record<string, number> = {};
    reverse["\ud801"] = 2;
    reverse["\ud800"] = 1;

    for (const request of [forward, reverse, { value: "\udc00" }]) {
      expect(
        createIngestRun({
          producer: "unicode-fixture",
          scopes: [{ sourceId: "fixture", scopeKey: "unicode", request }],
        }),
      ).toMatchObject({ _tag: "err", error: { code: "INVALID_JSON" } });
    }

    expect(
      createIngestRun({
        producer: "unicode-fixture",
        scopes: [{ sourceId: "fixture", scopeKey: "valid-unicode", request: { "😀": "𐐷" } }],
      }),
    ).toMatchObject({ _tag: "ok" });
  });

  test("rejects null characters in JSON keys and persisted identity strings", () => {
    const nullKeyRequest: Record<string, number> = {};
    nullKeyRequest["unsafe\u0000key"] = 1;

    expect(
      createIngestRun({
        producer: "null-fixture",
        scopes: [{ sourceId: "fixture", scopeKey: "null-key", request: nullKeyRequest }],
      }),
    ).toMatchObject({ _tag: "err", error: { code: "INVALID_JSON" } });

    for (const input of [
      {
        producer: "unsafe\u0000producer",
        scopes: [{ sourceId: "fixture", scopeKey: "identity", request: {} }],
      },
      {
        producer: "null-fixture",
        scopes: [{ sourceId: "unsafe\u0000source", scopeKey: "identity", request: {} }],
      },
      {
        producer: "null-fixture",
        scopes: [{ sourceId: "fixture", scopeKey: "unsafe\u0000scope", request: {} }],
      },
    ]) {
      expect(createIngestRun(input)).toMatchObject({
        _tag: "err",
        error: { code: "INVALID_INPUT" },
      });
    }

    expect(
      createIngestObservation({
        scopeHash: "a".repeat(64),
        sourceRecordKey: "unsafe\u0000record",
        observedAt: timestamp,
        raw: {},
      }),
    ).toMatchObject({ _tag: "err", error: { code: "INVALID_INPUT" } });
    const versionRun = unwrap(
      createIngestRun({
        producer: "null-fixture",
        scopes: [{ sourceId: "fixture", scopeKey: "version-identity", request: {} }],
      }),
    );
    const versionScope = versionRun.scopes[0];
    if (!versionScope) throw new Error("Expected version source scope");
    expect(
      createNormalizedListingVersion(versionRun, versionScope.scopeHash, {
        listingKey: "unsafe\u0000listing",
        normalizer: "radar-v1",
        normalized: {},
      }),
    ).toMatchObject({ _tag: "err", error: { code: "INVALID_INPUT" } });
    expect(
      createNormalizedListingVersion(versionRun, versionScope.scopeHash, {
        listingKey: "fixture:listing",
        normalizer: "unsafe\u0000normalizer",
        normalized: {},
      }),
    ).toMatchObject({ _tag: "err", error: { code: "INVALID_INPUT" } });
  });

  test("canonicalizes exponent-boundary numbers as plain decimals", () => {
    const run = unwrap(
      createIngestRun({
        producer: "numeric-boundary-fixture",
        scopes: [
          {
            sourceId: "fixture",
            scopeKey: "numeric-boundaries",
            request: { large: 1e21, small: 1e-7, negativeZero: -0 },
          },
        ],
      }),
    );
    const canonicalScopeIdentity =
      '{"contractVersion":1,"request":{"large":1000000000000000000000,"negativeZero":0,"small":0.0000001},"scopeKey":"numeric-boundaries","sourceId":"fixture"}';
    const expectedScopeHash = createHash("sha256").update(canonicalScopeIdentity).digest("hex");

    expect(run.scopes[0]?.request).toEqual({
      large: 1e21,
      negativeZero: -0,
      small: 1e-7,
    });
    expect(String(run.scopes[0]?.scopeHash)).toBe(expectedScopeHash);
    for (const unsupported of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(
        createIngestRun({
          producer: "numeric-boundary-fixture",
          scopes: [
            {
              sourceId: "fixture",
              scopeKey: "non-finite",
              request: { nested: [unsupported] },
            },
          ],
        }),
      ).toMatchObject({ _tag: "err", error: { code: "INVALID_JSON" } });
    }
  });

  test("persists a zero-result scope as a complete source row and commits it", () => {
    const collecting = unwrap(
      createIngestRun({
        producer: "radar-fixture",
        scopes: [
          {
            sourceId: "ashby",
            scopeKey: "linear:agentic",
            request: { query: "agentic" },
          },
        ],
      }),
    );
    const scopeHash = collecting.scopes[0]?.scopeHash;
    if (!scopeHash) throw new Error("Expected source scope");
    const complete = unwrap(completeIngestScope(collecting, scopeHash, timestamp, []));

    expect(complete.scopes[0]).toMatchObject({
      _tag: "complete",
      scopeHash,
      resultCount: 0,
      observations: [],
    });

    const ready = unwrap(prepareIngestRun(complete, timestamp));
    expect(commitIngestRun(ready, "2026-07-30T09:59:59.999Z", [])).toMatchObject({
      _tag: "err",
      error: {
        code: "ILLEGAL_TRANSITION",
        message: "An ingest run cannot commit before its readyAt timestamp",
      },
    });
    const committed = unwrap(commitIngestRun(ready, timestamp, []));

    expect(committed.manifest.payload.scopes).toEqual([
      {
        scopeHash,
        sourceId: "ashby",
        scopeKey: "linear:agentic",
        resultCount: 0,
        observationHashes: [],
      },
    ]);
    expect(committed.manifest.payload.versionHashes).toEqual([]);
    expect(committed.manifest.payload.edges).toEqual([]);
  });

  test("deduplicates replayed observations, versions, and provenance by hash", () => {
    const collecting = unwrap(
      createIngestRun({
        producer: "radar-fixture",
        scopes: [
          {
            sourceId: "greenhouse",
            scopeKey: "openai:all",
            request: { page: 1 },
          },
        ],
      }),
    );
    const scopeHash = collecting.scopes[0]?.scopeHash;
    if (!scopeHash) throw new Error("Expected source scope");
    const observation = unwrap(
      createIngestObservation({
        scopeHash,
        sourceRecordKey: "openai:123",
        observedAt: timestamp,
        raw: { title: "Applied AI Engineer" },
      }),
    );
    const firstVersionCreation = unwrap(
      createNormalizedListingVersion(collecting, scopeHash, {
        listingKey: "greenhouse:openai:123",
        normalizer: "radar-v1",
        normalized: { title: "Applied AI Engineer", company: "OpenAI" },
      }),
    );
    const version = firstVersionCreation.version;
    expect(version.createdByScopeHash).toBe(scopeHash);
    const replayedVersionCreation = unwrap(
      createNormalizedListingVersion(firstVersionCreation.run, scopeHash, {
        listingKey: "greenhouse:openai:123",
        normalizer: "radar-v1",
        normalized: { title: "Applied AI Engineer", company: "OpenAI" },
      }),
    );
    expect(replayedVersionCreation.run).toBe(firstVersionCreation.run);
    expect(replayedVersionCreation.run.producedVersionHashes).toEqual([version.versionHash]);
    const edge = linkObservationToVersion(observation, version);
    const complete = unwrap(
      completeIngestScope(replayedVersionCreation.run, scopeHash, timestamp, [
        observation,
        observation,
      ]),
    );
    const ready = unwrap(prepareIngestRun(complete, timestamp));
    const committed = unwrap(commitIngestRun(ready, timestamp, [edge, edge]));
    const replay = unwrap(commitIngestRun(committed, timestamp, [edge]));

    expect(complete.scopes[0]).toMatchObject({ _tag: "complete", resultCount: 1 });
    expect(committed.manifest.payload.versionHashes).toEqual([version.versionHash]);
    expect(committed.manifest.payload.edges).toEqual([edge]);
    expect(replay).toBe(committed);
    expect(commitIngestRun(committed, "2026-07-30T11:00:00.000Z", [edge])).toMatchObject({
      _tag: "err",
      error: { code: "ILLEGAL_TRANSITION" },
    });
  });

  test("rejects timestamp precision and offsets outside exact UTC milliseconds", () => {
    const scopeHash = "a".repeat(64);

    expect(
      createIngestObservation({
        scopeHash,
        sourceRecordKey: "microsecond",
        observedAt: "2026-07-30T10:00:00.000001Z",
        raw: {},
      }),
    ).toMatchObject({ _tag: "err", error: { code: "INVALID_INPUT" } });
    expect(
      createIngestObservation({
        scopeHash,
        sourceRecordKey: "offset",
        observedAt: "2026-07-30T12:00:00.000+02:00",
        raw: {},
      }),
    ).toMatchObject({ _tag: "err", error: { code: "INVALID_INPUT" } });
  });

  test("rejects ready and commit transitions while evidence is incomplete", () => {
    const collecting = unwrap(
      createIngestRun({
        producer: "radar-fixture",
        scopes: [
          {
            sourceId: "greenhouse",
            scopeKey: "openai:all",
            request: { page: 1 },
          },
        ],
      }),
    );

    const notReady = prepareIngestRun(collecting, timestamp);
    expect(notReady).toMatchObject({
      _tag: "err",
      error: { code: "INCOMPLETE_SCOPE" },
    });

    const prematureCommit = commitIngestRun(collecting, timestamp, []);
    expect(prematureCommit).toMatchObject({
      _tag: "err",
      error: { code: "ILLEGAL_TRANSITION" },
    });
  });

  test("rejects terminal scope mutation and missing observation-version provenance", () => {
    const collecting = unwrap(
      createIngestRun({
        producer: "radar-fixture",
        scopes: [
          {
            sourceId: "greenhouse",
            scopeKey: "openai:all",
            request: { page: 1 },
          },
        ],
      }),
    );
    const scopeHash = collecting.scopes[0]?.scopeHash;
    if (!scopeHash) throw new Error("Expected source scope");
    const observation = unwrap(
      createIngestObservation({
        scopeHash,
        sourceRecordKey: "openai:123",
        observedAt: timestamp,
        raw: { title: "Applied AI Engineer" },
      }),
    );
    const referencedVersionCreation = unwrap(
      createNormalizedListingVersion(collecting, scopeHash, {
        listingKey: "greenhouse:openai:123",
        normalizer: "radar-v1",
        normalized: { title: "Applied AI Engineer" },
      }),
    );
    const referencedVersion = referencedVersionCreation.version;
    const unreferencedVersionCreation = unwrap(
      createNormalizedListingVersion(referencedVersionCreation.run, scopeHash, {
        listingKey: "greenhouse:openai:unreferenced",
        normalizer: "radar-v1",
        normalized: { title: "Unreferenced" },
      }),
    );
    const staleComplete = unwrap(
      completeIngestScope(collecting, scopeHash, timestamp, [observation]),
    );
    const staleReady = unwrap(prepareIngestRun(staleComplete, timestamp));
    expect(
      commitIngestRun(staleReady, timestamp, [
        linkObservationToVersion(observation, referencedVersion),
      ]),
    ).toMatchObject({
      _tag: "err",
      error: { code: "UNKNOWN_LISTING_VERSION" },
    });

    const complete = unwrap(
      completeIngestScope(unreferencedVersionCreation.run, scopeHash, timestamp, [observation]),
    );
    const startedAgain = startIngestScope(complete, scopeHash, timestamp);
    expect(startedAgain).toMatchObject({
      _tag: "err",
      error: { code: "ILLEGAL_TRANSITION" },
    });
    expect(
      createNormalizedListingVersion(complete, scopeHash, {
        listingKey: "greenhouse:openai:late",
        normalizer: "radar-v1",
        normalized: { title: "Late version" },
      }),
    ).toMatchObject({
      _tag: "err",
      error: { code: "ILLEGAL_TRANSITION" },
    });

    const ready = unwrap(prepareIngestRun(complete, timestamp));
    const missingProvenance = commitIngestRun(ready, timestamp, []);
    expect(missingProvenance).toMatchObject({
      _tag: "err",
      error: { code: "MISSING_PROVENANCE" },
    });

    expect(
      commitIngestRun(ready, timestamp, [linkObservationToVersion(observation, referencedVersion)]),
    ).toMatchObject({
      _tag: "err",
      error: { code: "UNREFERENCED_LISTING_VERSION" },
    });
  });

  test("rejects contradictory timestamps on replayed start, complete, and fail transitions", () => {
    const collecting = unwrap(
      createIngestRun({
        producer: "radar-fixture",
        scopes: [
          { sourceId: "ashby", scopeKey: "linear:all", request: { page: 1 } },
          { sourceId: "greenhouse", scopeKey: "openai:all", request: { page: 1 } },
          { sourceId: "lever", scopeKey: "anthropic:all", request: { page: 1 } },
        ],
      }),
    );
    const [firstScope, secondScope, thirdScope] = collecting.scopes;
    if (!firstScope || !secondScope || !thirdScope) throw new Error("Expected three source scopes");

    const started = unwrap(startIngestScope(collecting, firstScope.scopeHash, timestamp));
    expect(
      startIngestScope(started, firstScope.scopeHash, "2026-07-30T10:00:01.000Z"),
    ).toMatchObject({
      _tag: "err",
      error: { code: "ILLEGAL_TRANSITION" },
    });

    expect(
      completeIngestScope(started, firstScope.scopeHash, "2026-07-30T09:59:59.999Z", []),
    ).toMatchObject({
      _tag: "err",
      error: { code: "ILLEGAL_TRANSITION" },
    });
    const completed = unwrap(completeIngestScope(started, firstScope.scopeHash, timestamp, []));
    expect(
      completed.scopes.find((scope) => scope.scopeHash === firstScope.scopeHash),
    ).toMatchObject({
      _tag: "complete",
      startedAt: timestamp,
    });
    expect(
      completeIngestScope(completed, firstScope.scopeHash, "2026-07-30T10:00:01.000Z", []),
    ).toMatchObject({
      _tag: "err",
      error: { code: "ILLEGAL_TRANSITION" },
    });

    const secondStarted = unwrap(startIngestScope(completed, secondScope.scopeHash, timestamp));
    expect(
      failIngestScope(
        secondStarted,
        secondScope.scopeHash,
        "2026-07-30T09:59:59.999Z",
        "source_timeout",
        [],
      ),
    ).toMatchObject({
      _tag: "err",
      error: { code: "ILLEGAL_TRANSITION" },
    });
    const scopeFailed = unwrap(
      failIngestScope(secondStarted, secondScope.scopeHash, timestamp, "source_timeout", []),
    );
    expect(
      scopeFailed.scopes.find((scope) => scope.scopeHash === secondScope.scopeHash),
    ).toMatchObject({
      _tag: "failed",
      startedAt: timestamp,
    });
    expect(
      failIngestScope(
        scopeFailed,
        secondScope.scopeHash,
        "2026-07-30T10:00:01.000Z",
        "source_timeout",
        [],
      ),
    ).toMatchObject({
      _tag: "err",
      error: { code: "ILLEGAL_TRANSITION" },
    });

    const runFailed = unwrap(failIngestRun(scopeFailed, timestamp, "scope_failed"));
    expect(runFailed).toMatchObject({ _tag: "failed", readyAt: null });
    expect(failIngestRun(runFailed, "2026-07-30T10:00:01.000Z", "scope_failed")).toMatchObject({
      _tag: "err",
      error: { code: "ILLEGAL_TRANSITION" },
    });
  });

  test("bounds observation evidence and run failure by recorded lifecycle timestamps", () => {
    const collecting = unwrap(
      createIngestRun({
        producer: "lifecycle-bounds-fixture",
        scopes: [{ sourceId: "fixture", scopeKey: "bounded", request: {} }],
      }),
    );
    const scope = collecting.scopes[0];
    if (!scope) throw new Error("Expected source scope");
    const started = unwrap(startIngestScope(collecting, scope.scopeHash, timestamp));
    const beforeStart = unwrap(
      createIngestObservation({
        scopeHash: scope.scopeHash,
        sourceRecordKey: "before-start",
        observedAt: "2026-07-30T09:59:59.999Z",
        raw: {},
      }),
    );
    const withinBounds = unwrap(
      createIngestObservation({
        scopeHash: scope.scopeHash,
        sourceRecordKey: "within-bounds",
        observedAt: "2026-07-30T10:00:30.000Z",
        raw: {},
      }),
    );
    const afterCompletion = unwrap(
      createIngestObservation({
        scopeHash: scope.scopeHash,
        sourceRecordKey: "after-completion",
        observedAt: "2026-07-30T10:01:00.001Z",
        raw: {},
      }),
    );

    expect(
      completeIngestScope(started, scope.scopeHash, "2026-07-30T10:01:00.000Z", [beforeStart]),
    ).toMatchObject({
      _tag: "err",
      error: { code: "ILLEGAL_TRANSITION" },
    });
    expect(
      completeIngestScope(started, scope.scopeHash, "2026-07-30T10:01:00.000Z", [afterCompletion]),
    ).toMatchObject({
      _tag: "err",
      error: { code: "ILLEGAL_TRANSITION" },
    });
    expect(
      failIngestScope(started, scope.scopeHash, "2026-07-30T10:01:00.000Z", "source_failure", [
        beforeStart,
      ]),
    ).toMatchObject({
      _tag: "err",
      error: { code: "ILLEGAL_TRANSITION" },
    });
    expect(
      failIngestScope(started, scope.scopeHash, "2026-07-30T10:01:00.000Z", "source_failure", [
        afterCompletion,
      ]),
    ).toMatchObject({
      _tag: "err",
      error: { code: "ILLEGAL_TRANSITION" },
    });
    const scopeFailedWithEvidence = unwrap(
      failIngestScope(started, scope.scopeHash, "2026-07-30T10:01:00.000Z", "source_failure", [
        withinBounds,
        withinBounds,
      ]),
    );
    expect(
      scopeFailedWithEvidence.scopes.find((candidate) => candidate.scopeHash === scope.scopeHash),
    ).toMatchObject({
      _tag: "failed",
      observations: [withinBounds],
    });
    expect(
      unwrap(
        failIngestScope(
          scopeFailedWithEvidence,
          scope.scopeHash,
          "2026-07-30T10:01:00.000Z",
          "source_failure",
          [withinBounds],
        ),
      ),
    ).toBe(scopeFailedWithEvidence);

    const complete = unwrap(
      completeIngestScope(started, scope.scopeHash, "2026-07-30T10:01:00.000Z", [withinBounds]),
    );
    expect(
      failIngestRun(complete, "2026-07-30T10:00:59.999Z", "post_evidence_failure"),
    ).toMatchObject({
      _tag: "err",
      error: {
        code: "ILLEGAL_TRANSITION",
        message: "An ingest run cannot fail before recorded scope or evidence lifecycle timestamps",
      },
    });
    expect(
      unwrap(failIngestRun(complete, "2026-07-30T10:01:00.000Z", "post_evidence_failure")),
    ).toMatchObject({
      _tag: "failed",
      failedAt: "2026-07-30T10:01:00.000Z",
    });
  });

  test("treats an exact ready transition replay as idempotent", () => {
    const collecting = unwrap(
      createIngestRun({
        producer: "ready-replay-fixture",
        scopes: [{ sourceId: "fixture", scopeKey: "ready-replay", request: {} }],
      }),
    );
    const scope = collecting.scopes[0];
    if (!scope) throw new Error("Expected source scope");
    const complete = unwrap(completeIngestScope(collecting, scope.scopeHash, timestamp, []));
    const ready = unwrap(prepareIngestRun(complete, timestamp));

    expect(unwrap(prepareIngestRun(ready, timestamp))).toBe(ready);
    expect(prepareIngestRun(ready, "2026-07-30T10:00:00.001Z")).toMatchObject({
      _tag: "err",
      error: { code: "ILLEGAL_TRANSITION" },
    });

    expect(failIngestRun(ready, "2026-07-30T09:59:59.999Z", "post_ready_failure")).toMatchObject({
      _tag: "err",
      error: { code: "ILLEGAL_TRANSITION" },
    });
    const failed = unwrap(failIngestRun(ready, "2026-07-30T10:00:01.000Z", "post_ready_failure"));
    expect(failed).toMatchObject({
      _tag: "failed",
      readyAt: timestamp,
      failedAt: "2026-07-30T10:00:01.000Z",
    });
    expect(unwrap(failIngestRun(failed, "2026-07-30T10:00:01.000Z", "post_ready_failure"))).toBe(
      failed,
    );
    expect(failIngestRun(failed, "2026-07-30T10:00:02.000Z", "post_ready_failure")).toMatchObject({
      _tag: "err",
      error: { code: "ILLEGAL_TRANSITION" },
    });
  });

  test("rejects readyAt before the latest required scope completion", () => {
    const collecting = unwrap(
      createIngestRun({
        producer: "ready-chronology-fixture",
        scopes: [
          { sourceId: "fixture", scopeKey: "first", request: {} },
          { sourceId: "fixture", scopeKey: "latest", request: {} },
        ],
      }),
    );
    const firstScope = collecting.scopes.find((scope) => scope.scopeKey === "first");
    const latestScope = collecting.scopes.find((scope) => scope.scopeKey === "latest");
    if (!firstScope || !latestScope) throw new Error("Expected both source scopes");

    const firstComplete = unwrap(
      completeIngestScope(collecting, firstScope.scopeHash, timestamp, []),
    );
    const allComplete = unwrap(
      completeIngestScope(firstComplete, latestScope.scopeHash, "2026-07-30T10:01:00.000Z", []),
    );

    expect(prepareIngestRun(allComplete, "2026-07-30T10:00:59.999Z")).toMatchObject({
      _tag: "err",
      error: {
        code: "ILLEGAL_TRANSITION",
        message: `Ingest run readyAt cannot precede completedAt for source scope ${latestScope.scopeHash}`,
      },
    });
    expect(unwrap(prepareIngestRun(allComplete, "2026-07-30T10:01:00.000Z"))).toMatchObject({
      _tag: "ready",
      readyAt: "2026-07-30T10:01:00.000Z",
    });
  });
});
