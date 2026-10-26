import { defineConfig } from "@pokit/core";
import { docs, release } from "pok-plugins";

/** Bundles every package, then emits declarations; identical across packages, so it runs once. */
const BUILD = "bun --filter '*' build && pnpm exec tsc -b";

const published = (dir: string) => ({ file: `packages/${dir}/package.json`, build: BUILD });
const versionOnly = (file: string) => ({ file, publish: false as const });

export default defineConfig({
  commandsDir: "./commands",
  appName: "yieldstar",
  plugins: [
    release({
      // Lockstep: every manifest moves to the same version.
      packages: [
        versionOnly("package.json"),
        published("core"),
        published("http-server"),
        published("sqlite-runtime"),
        published("store-conformance"),
        published("worker-invoker"),
        published("yieldstar"),
        versionOnly("packages/test-invoker/package.json"),
        versionOnly("packages/test-runtime/package.json"),
        versionOnly("packages/test-utils/package.json"),
        versionOnly("examples/package.json"),
        versionOnly("test/package.json"),
      ],
      preid: "alpha",
    }),
    docs({ name: "yieldstar-docs" }),
  ],
});
