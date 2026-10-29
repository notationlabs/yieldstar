import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const directory = await mkdtemp(join(tmpdir(), "yieldstar-runtime-conformance-"));

function run(command: string[], cwd = root) {
  const result = Bun.spawnSync(command, {
    cwd,
    env: process.env,
    stderr: "inherit",
    stdout: "inherit",
  });
  if (result.exitCode !== 0) {
    throw new Error(`${command.join(" ")} exited with ${result.exitCode}`);
  }
}

try {
  for (const packageDirectory of ["core", "runtime-conformance", "test-runtime"]) {
    run([
      "pnpm",
      "--dir",
      join(root, "packages", packageDirectory),
      "pack",
      "--pack-destination",
      directory,
    ]);
  }

  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      devDependencies: {
        "@yieldstar/core": "file:./yieldstar-core-0.5.0.tgz",
        "@yieldstar/runtime-conformance": "file:./yieldstar-runtime-conformance-0.5.0.tgz",
        "@yieldstar/test-runtime": "file:./yieldstar-test-runtime-0.5.0.tgz",
        vitest: "3.2.7",
      },
    })
  );
  await writeFile(
    join(directory, "runtime-conformance.test.ts"),
    `import {
  registerEffectClientConformance,
  registerExecutionClientConformance,
  registerStoreClientConformance,
} from "@yieldstar/runtime-conformance";
import { MemoryRuntime } from "@yieldstar/test-runtime";

registerStoreClientConformance({
  name: "installed-memory",
  create() {
    return { runtime: new MemoryRuntime() };
  },
});

registerExecutionClientConformance({
  name: "installed-memory",
  create(options) {
    return { runtime: new MemoryRuntime(options) };
  },
});

registerEffectClientConformance({
  name: "installed-memory",
  create(options) {
    return { runtime: new MemoryRuntime(options) };
  },
});
`
  );
  await writeFile(
    join(directory, "pnpm-workspace.yaml"),
    `allowBuilds:
  esbuild: true
# test-runtime's packed manifest depends on @yieldstar/core by version, so pin
# it to the local tarball rather than the published release.
overrides:
  "@yieldstar/core": "file:./yieldstar-core-0.5.0.tgz"
minimumReleaseAgeExclude:
  - "@yieldstar/core@0.5.0"
  - "@yieldstar/runtime-conformance@0.5.0"
  - "@yieldstar/test-runtime@0.5.0"
`
  );

  run(["pnpm", "install"], directory);
  run(["pnpm", "exec", "vitest", "run", "runtime-conformance.test.ts"], directory);
} finally {
  await rm(directory, { recursive: true, force: true });
}
