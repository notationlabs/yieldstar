import { defineCommand } from "@pokit/core";

export const command = defineCommand({
  label: "Watch packages, declarations and tests",
  run: async (r) => {
    await r.exec(
      "pnpm exec concurrently -r \"bun --filter '*' --parallel build --watch\" \"pnpm exec tsc -b --watch\" \"pnpm exec vitest\"",
    );
  },
});
