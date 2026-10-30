import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { registerEffectClientConformance } from "@yieldstar/runtime-conformance";
import { MemoryRuntime } from "@yieldstar/test-runtime";
import { SqliteRuntime } from "@yieldstar/sqlite-runtime";

const isBun = "Bun" in globalThis;
const { createSqliteDb } = isBun
  ? await import("@yieldstar/sqlite-runtime/bun")
  : await import("@yieldstar/sqlite-runtime/node");

type SqliteDb = ReturnType<typeof createSqliteDb>;

// The trigger aborts the waiter insert inside watch's transaction.
function failEffectWatches(db: SqliteDb) {
  db.run(`
    CREATE TEMP TRIGGER fail_effect_watch BEFORE INSERT ON effect_waiters
    BEGIN SELECT RAISE(ABORT, 'injected watch failure'); END
  `);
  return () => db.run("DROP TRIGGER temp.fail_effect_watch");
}

registerEffectClientConformance({
  name: "memory",
  create(options) {
    return { runtime: new MemoryRuntime(options) };
  },
});

registerEffectClientConformance({
  name: isBun ? "sqlite-bun" : "sqlite-node",
  create(options) {
    const db = createSqliteDb({ path: ":memory:", wal: false });
    return {
      runtime: new SqliteRuntime(db, options),
      createPeer() {
        return new SqliteRuntime(db, options);
      },
      restart() {
        return new SqliteRuntime(db, options);
      },
      failEffectWatches: () => failEffectWatches(db),
      dispose() {
        db.close();
      },
    };
  },
});

// Separate connections to one database file, as separate processes would use.
registerEffectClientConformance({
  name: isBun ? "sqlite-bun-file" : "sqlite-node-file",
  create(options) {
    const dir = mkdtempSync(join(tmpdir(), "yieldstar-effects-"));
    const path = join(dir, "effects.db");
    const dbs = [createSqliteDb({ path, wal: true })];
    const open = () => {
      const db = createSqliteDb({ path, wal: true });
      dbs.push(db);
      return new SqliteRuntime(db, options);
    };
    return {
      runtime: new SqliteRuntime(dbs[0], options),
      createPeer: open,
      restart: open,
      failEffectWatches: () => failEffectWatches(dbs[0]),
      dispose() {
        for (const db of dbs) db.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  },
});

test("a database created before effects could fail reads its conflict reports as results and stores failures", async () => {
  const db = createSqliteDb({ path: ":memory:", wal: false });
  try {
    db.run(`
      CREATE TABLE effects (
        effect_id TEXT PRIMARY KEY,
        operation TEXT NOT NULL,
        input TEXT NOT NULL,
        status TEXT NOT NULL,
        result TEXT
      );
      CREATE TABLE effect_conflicts (
        effect_id TEXT NOT NULL,
        result TEXT NOT NULL,
        conflicting_result TEXT NOT NULL,
        reported_at INTEGER NOT NULL,
        PRIMARY KEY (effect_id, conflicting_result)
      );
      INSERT INTO effects VALUES ('pay:old', 'charge-v1', '{}', 'settled', '"first"');
      INSERT INTO effect_conflicts VALUES ('pay:old', '"first"', '"second"', 5);
    `);

    const runtime = new SqliteRuntime(db);
    expect(await runtime.effects.getEffect("pay:old")).toEqual({
      effectId: "pay:old",
      operation: "charge-v1",
      input: {},
      status: "settled",
      result: "first",
      conflicts: [
        {
          outcome: { status: "settled", result: "first" },
          conflictingOutcome: { status: "settled", result: "second" },
          reportedAt: 5,
        },
      ],
    });

    await runtime.effects.settle({
      effectId: "pay:old",
      operation: "charge-v1",
      status: "failed",
      error: new Error("declined"),
    });
    const record = await new SqliteRuntime(db).effects.getEffect("pay:old");
    expect(record!.conflicts[1]).toMatchObject({
      outcome: { status: "settled", result: "first" },
      conflictingOutcome: { status: "failed", error: { message: "declined" } },
    });
  } finally {
    db.close();
  }
});
