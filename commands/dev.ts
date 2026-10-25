import { defineCommand } from "@pokit/core";

export const command = defineCommand({
  label: "Watch packages, declarations and tests",
  run: async (r) => {
    await r.exec(
      "concurrently -r \"bun --filter '*' build --watch\" \"pnpm exec tsc -b --watch\" \"vitest\"",
    );
  },
});
