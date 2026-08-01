import { expect, test } from "bun:test";
import {
  executeReservedTransaction,
  type PsqlReservedConnection,
  withPsqlClientCleanup,
} from "../psql";

test("rolls back a failed transaction before releasing its pooled connection", async () => {
  const calls: string[] = [];
  let released = false;
  const failure = new Error("migration statement failed");
  const reserved: PsqlReservedConnection = {
    async unsafe(sql) {
      calls.push(sql);
      if (sql.startsWith("BEGIN;")) throw failure;
      return [];
    },
    release() {
      released = true;
    },
  };

  await expect(executeReservedTransaction(reserved, "BEGIN; SELECT invalid; COMMIT;")).rejects.toBe(
    failure,
  );
  expect(calls).toEqual(["BEGIN; SELECT invalid; COMMIT;", "ROLLBACK;"]);
  expect(released).toBe(true);
});

test("closes pooled clients after a one-shot command succeeds", async () => {
  const calls: string[] = [];

  await expect(
    withPsqlClientCleanup(
      async () => {
        calls.push("run");
        return "done";
      },
      async () => {
        calls.push("close");
      },
    ),
  ).resolves.toBe("done");

  expect(calls).toEqual(["run", "close"]);
});

test("closes pooled clients after a one-shot command fails", async () => {
  const calls: string[] = [];
  const failure = new Error("command failed");

  await expect(
    withPsqlClientCleanup(
      async () => {
        calls.push("run");
        throw failure;
      },
      async () => {
        calls.push("close");
      },
    ),
  ).rejects.toBe(failure);

  expect(calls).toEqual(["run", "close"]);
});
