import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  HISTORY_FILE_NAME,
  LIVE_FILE_NAME,
  LIVE_SCHEMA,
  LedgerReadError,
  createLedger,
  planRoleRecovery,
  planStormRecovery
} from "../src/index.js";

test("a second start replaces the live pid and keeps both history rows", () => {
  const root = tempRoot("replace");
  const ledger = createLedger(root);
  assert.equal(ledger.register({ role: "gateway", pid: 1 }), false);
  assert.equal(
    ledger.register({ role: "gateway", pid: 4100, at: "2026-09-30T20:00:00.000Z" }),
    true
  );
  assert.equal(
    ledger.register({ role: "gateway", pid: 4108, at: "2026-09-30T20:01:00.000Z" }),
    true
  );
  assert.equal(ledger.live().roles.gateway.pid, 4108);
  const lines = fs.readFileSync(path.join(root, HISTORY_FILE_NAME), "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
});

test("recovery keeps the listener and kills the duplicate", () => {
  const plan = planRoleRecovery(
    "gateway",
    [
      { pid: 4100, startedAt: "2026-09-15T11:26:00.000Z", listening: true },
      { pid: 63184, startedAt: "2026-09-23T14:51:00.000Z", listening: false }
    ],
    () => true
  );
  assert.equal(plan.keep, 4100);
  assert.deepEqual(plan.kill, [63184]);
  assert.equal(plan.start, false);
});

test("a dead role is started once, not beside a corpse", () => {
  const plan = planRoleRecovery(
    "worker",
    [{ pid: 900, startedAt: "2026-09-30T19:00:00.000Z", listening: false }],
    () => false
  );
  assert.equal(plan.keep, null);
  assert.deepEqual(plan.kill, []);
  assert.equal(plan.start, true);
});

test("storm recovery stops the oldest overflow", () => {
  const kills = planStormRecovery(
    {
      shell: [
        { pid: 11, startedAt: "2026-09-30T19:00:00.000Z" },
        { pid: 12, startedAt: "2026-09-30T19:01:00.000Z" },
        { pid: 13, startedAt: "2026-09-30T19:02:00.000Z" }
      ]
    },
    { shell: 2 },
    () => true
  );
  assert.deepEqual(kills, [{ role: "shell", pid: 11 }]);
});

test("the history file trims from a line boundary", () => {
  const root = tempRoot("trim");
  const ledger = createLedger(root, { maxBytes: 180 });
  for (let index = 2; index < 12; index += 1) {
    ledger.register({
      role: "worker",
      pid: 1000 + index,
      at: `2026-09-30T20:00:0${index % 10}.000Z`
    });
  }
  const text = fs.readFileSync(path.join(root, HISTORY_FILE_NAME), "utf8");
  assert.ok(text.length < 400);
  assert.equal(text[0], "{");
  for (const line of text.trim().split("\n")) {
    JSON.parse(line);
  }
});

test("a corrupt live file is not an empty ledger", () => {
  const root = tempRoot("corrupt");
  const ledger = createLedger(root);
  const livePath = path.join(root, LIVE_FILE_NAME);

  assert.deepEqual(ledger.live(), { schema: LIVE_SCHEMA, at: "", roles: {} });

  fs.writeFileSync(livePath, `${JSON.stringify({ roles: {} })}\n`, "utf8");
  assert.deepEqual(ledger.live().roles, {});

  fs.writeFileSync(livePath, "{not json\n", "utf8");
  assert.throws(() => ledger.live(), LedgerReadError);
  assert.throws(() => ledger.livePids(), LedgerReadError);
  assert.throws(
    () => ledger.register({ role: "gateway", pid: 4100, at: "2026-09-30T20:00:00.000Z" }),
    LedgerReadError
  );
  assert.equal(fs.existsSync(path.join(root, HISTORY_FILE_NAME)), false);

  fs.writeFileSync(livePath, "{}\n", "utf8");
  assert.throws(
    () => ledger.live(),
    (error) => {
      assert.equal(error instanceof LedgerReadError, true);
      assert.equal(error.code, "LIVE_CORRUPT");
      return true;
    }
  );
});

test("a pid of 0 is refused", () => {
  const root = tempRoot("pid-zero");
  const ledger = createLedger(root);
  assert.equal(ledger.register({ role: "gateway", pid: 0, at: "2026-09-30T20:00:00.000Z" }), false);
  assert.equal(ledger.register({ role: "", pid: 4100, at: "2026-09-30T20:00:00.000Z" }), false);
  assert.equal(fs.existsSync(path.join(root, HISTORY_FILE_NAME)), false);
  assert.deepEqual(ledger.live().roles, {});
  assert.equal(ledger.register({ role: "gateway", pid: 2, at: "2026-09-30T20:00:00.000Z" }), true);
  assert.equal(ledger.live().roles.gateway.pid, 2);
});

test("storm recovery caps each role in one map", () => {
  const kills = planStormRecovery(
    {
      shell: [
        { pid: 11, startedAt: "2026-09-30T19:00:00.000Z" },
        { pid: 12, startedAt: "2026-09-30T19:01:00.000Z" },
        { pid: 13, startedAt: "2026-09-30T19:02:00.000Z" }
      ],
      worker: [
        { pid: 21, startedAt: "2026-09-30T18:00:00.000Z" },
        { pid: 22, startedAt: "2026-09-30T19:03:00.000Z" },
        { pid: 23, startedAt: "2026-09-30T19:04:00.000Z" }
      ]
    },
    { shell: 2, worker: 1 },
    () => true
  );
  assert.deepEqual(kills, [
    { role: "shell", pid: 11 },
    { role: "worker", pid: 21 },
    { role: "worker", pid: 22 }
  ]);
});

test("register does not share one temp path across writes", () => {
  const root = tempRoot("temp");
  const sharedNext = path.join(root, `${LIVE_FILE_NAME}.next`);
  fs.writeFileSync(sharedNext, "occupied", "utf8");
  const ledger = createLedger(root);
  assert.equal(ledger.register({ role: "gateway", pid: 20, at: "2026-09-30T20:00:00.000Z" }), true);
  assert.equal(ledger.register({ role: "worker", pid: 21, at: "2026-09-30T20:01:00.000Z" }), true);
  assert.equal(fs.readFileSync(sharedNext, "utf8"), "occupied");
  assert.equal(ledger.live().roles.gateway.pid, 20);
  assert.equal(ledger.live().roles.worker.pid, 21);
  const leftovers = fs.readdirSync(root).filter((name) => name.endsWith(".json.next"));
  assert.deepEqual(leftovers, [`${LIVE_FILE_NAME}.next`]);
});

test("role recovery ranks the requested role and leaves other roles out", () => {
  const plan = planRoleRecovery(
    "gateway",
    [
      { role: "worker", pid: 20, startedAt: "2026-09-15T11:26:00.000Z", listening: true },
      { role: "gateway", pid: 30, startedAt: "2026-09-23T14:51:00.000Z", listening: false },
      { pid: 40, startedAt: "2026-09-24T14:51:00.000Z", listening: true }
    ],
    () => true
  );
  assert.equal(plan.keep, 40);
  assert.deepEqual(plan.kill, [30]);
  assert.equal(plan.start, false);
});

function tempRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ledger-${label}-`));
}
