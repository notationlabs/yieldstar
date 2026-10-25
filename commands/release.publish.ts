import { defineCommand } from "@pokit/core";

// Installs and rebuilds first: this was the `prerelease` npm lifecycle hook,
// which fired implicitly before `release`. Now it is explicit.
export const command = defineCommand({
  label: "Publish to npm",
  run: async (r) => {
    await r.exec("pnpm i");
    await r.exec("bun --filter '*' build");
    await r.exec("pnpm exec tsc -b");
    await r.exec("bin/release.sh");
  },
});
