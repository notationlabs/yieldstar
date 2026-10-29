import { defineCommand } from "@pokit/core";

export const command = defineCommand({
  label: "Smoke test the runtime conformance package",
  run: async (r) => {
    await r.exec("bun scripts/smoke-runtime-conformance-package.ts");
  },
});
