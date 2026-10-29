import { registerStoreClientConformance } from "@yieldstar/store-conformance";
import { MemoryRuntime } from "@yieldstar/test-runtime";
import { SqliteRuntime } from "@yieldstar/sqlite-runtime";

const isBun = "Bun" in globalThis;
const { createSqliteDb } = isBun
  ? await import("@yieldstar/sqlite-runtime/bun")
  : await import("@yieldstar/sqlite-runtime/node");

registerStoreClientConformance({
  name: "memory",
  create() {
    return { runtime: new MemoryRuntime() };
  },
});

registerStoreClientConformance({
  name: isBun ? "sqlite-bun" : "sqlite-node",
  create() {
    const db = createSqliteDb({ path: ":memory:", wal: false });
    return {
      runtime: new SqliteRuntime(db),
      createPeer() {
        return new SqliteRuntime(db);
      },
      restart() {
        return new SqliteRuntime(db);
      },
      dispose() {
        db.close();
      },
    };
  },
});
