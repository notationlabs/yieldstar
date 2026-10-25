import { defineCommand } from "@pokit/core";

export const command = defineCommand({
  label: "Build all packages",
  run: async (r) => {
    await r.exec("bun --filter '*' build");
    await r.exec("pnpm exec tsc -b");
  },
});
