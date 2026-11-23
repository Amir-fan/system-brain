# Vercel Function Bundling Design

## Intent

Make the standalone KIP Vercel Function deploy the complete TypeScript server graph. The current deployment compiles `api/index.ts` but omits imported files under `src/`, causing `ERR_MODULE_NOT_FOUND` before the handler starts.

## Goals

- Produce one executable JavaScript bundle during Vercel's build.
- Keep the canonical KIP HTTP handler, authentication, authorization, and local development behavior unchanged.
- Fail the build if bundling fails or the generated entry cannot load under plain Node.
- Keep generated deployment output out of Git.

## Non-goals

- Deploy the separate Vite frontend.
- Refactor application modules or rewrite repository-wide TypeScript imports.
- Change API contracts, credentials, Supabase configuration, or runtime authorization.

## Constraints

- Vercel must retain one public function route for `/v1/*`.
- The bundle must stay below Vercel's function-size limit.
- Build tooling must be explicitly pinned and represented in the lockfile.
- No secret may be embedded during bundling.

## Approaches considered

1. **Build-time bundle (selected):** use pinned `esbuild` to bundle the server graph into an ignored JavaScript module consumed by a stable `api/` entry. Small, isolated, and reproducible.
2. **Repository-wide emitted JavaScript:** change every relative TypeScript import and add a complete emit pipeline. Rejected because it creates a large unrelated migration.
3. **Commit generated JavaScript:** reliable but leaves a large generated artifact in source control. Rejected because the build can generate and verify it deterministically.

## Design

- Move the TypeScript Vercel composition entry outside the function-discovery directory.
- Keep a stable JavaScript file under `api/` that imports the generated bundle.
- Add a small build script that invokes pinned `esbuild` with Node ESM settings and writes the ignored bundle.
- Configure Vercel's build command to run that script before function packaging.
- Add a regression check that builds the bundle and imports the same stable entry with plain Node, catching missing modules and unsupported TypeScript syntax.

## Verification

- Regression test fails before the bundle pipeline exists and passes afterward.
- `npm run build:vercel`
- Plain-Node import of the generated Vercel entry.
- Root typecheck, lint, tests, and dependency audit.
- Push and confirm the deployed `/v1/projects` endpoint returns the controlled JSON `401` response.
