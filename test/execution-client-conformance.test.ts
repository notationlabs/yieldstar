import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerExecutionClientConformance } from "@yieldstar/runtime-conformance";
import { MemoryRuntime } from "@yieldstar/test-runtime";
import { SqliteRuntime } from "@yieldstar/sqlite-runtime";

const isBun = "Bun" in globalThis;
const { createSqliteDb } = isBun
  ? await import("@yieldstar/sqlite-runtime/bun")
  : await import("@yieldstar/sqlite-runtime/node");

type SqliteDb = ReturnType<typeof createSqliteDb>;

// The trigger aborts the start-request insert, after the target's insert in the
// same transaction, so the case checks that the target rolls back with it.
function failStartCommits(db: SqliteDb) {
  db.run(`
    CREATE TEMP TRIGGER fail_start_commit BEFORE INSERT ON start_requests
    BEGIN SELECT RAISE(ABORT, 'injected start failure'); END
  `);
  return () => db.run("DROP TRIGGER temp.fail_start_commit");
}

registerExecutionClientConformance({
  name: "memory",
  create(options) {
    return { runtime: new MemoryRuntime(options) };
  },
});

registerExecutionClientConformance({
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
      failStartCommits: () => failStartCommits(db),
      dispose() {
        db.close();
      },
    };
  },
});

// Separate connections to one database file, as separate processes would use.
registerExecutionClientConformance({
  name: isBun ? "sqlite-bun-file" : "sqlite-node-file",
  create(options) {
    const dir = mkdtempSync(join(tmpdir(), "yieldstar-executions-"));
    const path = join(dir, "executions.db");
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
      failStartCommits: () => failStartCommits(dbs[0]),
      dispose() {
        for (const db of dbs) db.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  },
});
