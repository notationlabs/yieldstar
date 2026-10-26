## Contributing to YieldStar

### Before You Start

- Please open an issue to discuss significant changes before submitting a pull request. This helps align on scope and approach, and avoids wasted effort.

### Pull Requests

- Keep PRs focused and reasonably small; include a clear description and motivation.
- Add tests if you change behavior or fix a bug.
- Update documentation where relevant.
- Ensure `pok test bun` and `pok test node` pass locally.

This repository is a TypeScript monorepo using pnpm workspaces and Bun. It contains the core SDK, runtimes, server integrations, examples, and tests.


### Contributor License Agreement (CLA)

By contributing, you affirm that you have the right to submit your contributions and you agree to license them under the project’s license (MIT).


### Repository Layout

- `packages/core` – Base types and runtime abstractions (scheduler, heap, steps)
- `packages/yieldstar` – Main SDK: workflow API, local/HTTP client
- `packages/http-server` – HTTP route handlers and middleware
- `packages/sqlite-runtime` – SQLite-backed heap, timers, task queue, event loop
- `packages/worker-invoker` – Subprocess-based step invoker and worker
- `packages/test-runtime` – In‑memory scheduler, heap, event loop (for tests)
- `packages/test-invoker` – Minimal invoker to run workflows in tests
- `packages/test-utils` – Internal test utilities (see note below)
- `examples/` – Workflow and runtime examples (HTTP server, local execution)
- `test/` – Integration tests with Vitest

Workspace configuration is in `pnpm-workspace.yaml`.

### Prerequisites

- pnpm installed
- Bun installed
- Node.js available for tooling where needed

### Install Dependencies

```
pnpm install
```

### Type Checking / Declarations

Generate and check types across the workspace:

```
pok dts
```

### Build All Packages

Compile the packages and emit declarations via project references:

```
pok build
```

This runs each package’s `build` script (`bun build`) and then `pnpm exec tsc -b`.

### Run Tests

```
pok test bun
pok test node
```

`pok test all` runs every suite in sequence.

Tests live in `test/` and import from Vitest. The full suite runs under both Bun and Node.

### Dev Workflow

Run type‑checking, builds, and tests concurrently in watch mode:

```
pok dev
```

Run `pok` with no arguments for the full command menu.

### Documentation

`docs/` holds both the Markdown and the site that publishes it: `pok docs dev`
to preview, `pok docs build`, `pok docs deploy`. Each category keeps its sidebar
in a `nav.ts` beside its Markdown, and the build fails on a broken link or a
duplicate slug. See [docs/README.md](docs/README.md) for the layout and for how
to refresh the `@notation/docs` framework, which is not published yet.

### Examples

Examples are in `examples/`.

- Interactive import/inspect helper:
  - `pok start` (select a workflow module to import; it does not execute workflows automatically)
- Direct example runs:
  - `bun examples/local-execution/app.ts`
  - `bun examples/http-server/server.ts` and in a second terminal `bun examples/http-server/app.ts`

### Releases

Releases use the pok-plugins `release()` flow configured in `pok.config.ts`.

- Bump, commit, tag and push: `pok version` (`pok version prerelease` for an alpha)
- Package and inspect every publish target without contacting npm: `pok publish --dry-run`
- Release: `pok publish` (installs and rebuilds first)

Every manifest is versioned in lockstep; `@yieldstar/*` and the unscoped `yieldstar` package publish together.

### Internal Packages

`@yieldstar/test-utils` is intended for this repo’s tests and development. It wires an in‑memory runtime for `triggerAndWait` in tests. Application users should prefer the SQLite runtime for local running.

### Coding Guidelines

- Keep changes minimal and focused on the task.
- Match existing coding style and TypeScript patterns.
- Avoid unrelated refactors in the same change.
