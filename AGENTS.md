# Repo guidance

This repository is a TypeScript monorepo set up with:
- **pnpm** for managing workspaces and dependencies
- **Bun** for building code
- **Vitest** for running tests under Bun and Node
- **TypeScript** for connecting package types using project references

## Layout

- `packages/` – source for all publishable packages (e.g. `core`, `yieldstar`, `http-server`, etc.)
- `examples/` – small apps and workflow examples
- `test/` – integration tests written using Vitest
- Workspace configuration is defined in `pnpm-workspace.yaml`:

```
packages:
  - packages/*
  - examples
  - test
```

## Installing dependencies

Run `pnpm install` in the repo root. This installs all workspace dependencies using the lock file.

## Type checking

To type check all monorepo packages (plus `test/` and `examples/`, which are checked with `noEmit`), run `pok dts` (equivalent to `pnpm exec tsc -b`), which also generates type declarations. Always use the workspace TypeScript via `pnpm exec tsc` rather than a global `tsc`.

## Building the packages

To compile all packages, run `pok build`

This runs each package's `build` script (`bun build`) and then `pnpm exec tsc -b` to generate type declarations.

## Running tests

Execute all tests under Bun or Node:

```
pok test bun
pok test node
```

Tests live in the `test/` folder and import from Vitest as shown below:

```ts
import { expect, test, vi } from "vitest";
```

## Running examples

Example workflows are stored in `examples/workflows/`. The helper command `pok start` currently only imports the chosen file and prints the module – the workflows themselves do
not run automatically. Consider this directory a work in progress.

To inspect an example interactively you can still run:

```
pok start
```

This will prompt you to select a workflow file to import.

## Package structure

The monorepo contains these packages:

- `core` - Base types and runtime abstractions
- `yieldstar` - Main workflow SDK and exports
- `http-server` - HTTP route handlers and middleware
- `sqlite-runtime` - Driver-agnostic SQLite runtime with Bun and Node connectors
- `worker-invoker` - Subprocess-based step invoker
- `test-invoker` - Test utilities for step invocation
- `test-runtime` - In-memory runtime for testing
- `test-utils` - Shared testing utilities

## Release process

Releases use the pok-plugins `release()` flow (see `pok.config.ts`), which versions every manifest in lockstep and publishes the `@yieldstar/*` packages and the unscoped `yieldstar` package together.

- `pok version` - Bump, commit, tag and push (`pok version prerelease` cuts an alpha)
- `pok publish --dry-run` - Install, build and pack every publish target without contacting npm
- `pok publish` - Install, build, then publish (prereleases go to their identifier's dist-tag)
