# Vercel Function Bundling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package the complete KIP server graph as executable JavaScript before Vercel creates the standalone function.

**Architecture:** A TypeScript source entry remains under `src/platform/vercel/`. A pinned esbuild script produces an ignored `api/_bundle.mjs`, while a stable committed `api/index.js` re-exports the generated Web handler for Vercel discovery.

**Tech Stack:** Node.js 24, TypeScript, esbuild 0.28.2, Vercel Node Functions, Node test runner

**Spec:** `docs/superpowers/specs/2026-11-23-vercel-function-bundling-design.md`

## Global Constraints

- Do not change API contracts, credentials, Supabase configuration, authentication, or authorization.
- Keep generated bundle output out of Git.
- Pin esbuild exactly and update the npm lockfile through npm.
- Preserve the single `/v1/*` Vercel function and 60-second duration.

## Review Focus

- A clean clone with no generated bundle must produce the bundle during `build:vercel`.
- Plain Node must load the generated entry without `.ts` module resolution or unsupported syntax errors.
- The exported value must retain Vercel's `{ fetch(request): Promise<Response> }` contract.
- Bundling must not inline current environment-secret values.
- The generated bundle must remain ignored and below Vercel's 250 MB uncompressed limit.

---

### Task 1: Add a reproducible Vercel bundle pipeline

**Files:**
- Create: `scripts/build-vercel.mjs`
- Create: `src/platform/vercel/vercel-entry.ts`
- Create: `api/index.js`
- Modify: `api/index.ts` (remove after moving its implementation)
- Modify: `.gitignore`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `vercel.json`
- Test: `tests/vercel-handler.test.ts`

**Interfaces:**
- Consumes: existing `createVercelHandler`, `createWebHandler`, `bootstrapEnvironment`, and `composeHttpHandler` exports.
- Produces: `npm run build:vercel` and default `{ fetch(request: Request): Promise<Response> }` from `api/index.js` after generation.

- [ ] **Step 1: Write the failing packaging regression**

Add a test named `Vercel build produces a plain-Node-loadable function without embedding secrets`. It removes any old ignored bundle, runs `npm run build:vercel`, imports `api/index.js` with a cache-busting query, asserts `default.fetch` is a function, asserts the bundle does not contain a synthetic secret set in the test environment, and asserts its size is below 250 MB.

- [ ] **Step 2: Run the regression and verify RED**

Run: `node --import tsx --test tests/vercel-handler.test.ts`

Expected: FAIL because `build:vercel` and the stable JavaScript entry do not exist.

- [ ] **Step 3: Add pinned bundling tooling**

Run: `npm install --save-dev --save-exact esbuild@0.28.2`

Expected: `package.json` and `package-lock.json` record esbuild as a direct exact dev dependency.

- [ ] **Step 4: Implement the bundle source and build script**

Move the current Vercel composition to `src/platform/vercel/vercel-entry.ts`. Implement `scripts/build-vercel.mjs` with esbuild's Node ESM bundle targeting Node 22 and output `api/_bundle.mjs`. Create `api/index.js` as the stable re-export, ignore the generated bundle, and set `vercel.json.buildCommand` to `npm run build:vercel`.

- [ ] **Step 5: Run focused verification and verify GREEN**

Run: `node --import tsx --test tests/vercel-handler.test.ts && npm run typecheck && npm run lint`

Expected: all Vercel tests pass; typecheck and lint exit 0.

- [ ] **Step 6: Review the generated artifact**

Run: `npm run build:vercel` followed by a plain-Node import of `api/index.js`, bundle-size inspection, `git check-ignore api/_bundle.mjs`, and staged secret scanning.

Expected: import succeeds, bundle is ignored, size is under 250 MB, and no secrets are found.

### Task 2: Release and live verification

**Files:**
- Modify: `docs/superpowers/specs/2026-11-23-vercel-function-bundling-design.md`
- Create: `docs/superpowers/plans/2026-11-23-vercel-function-bundling.md`

**Interfaces:**
- Consumes: Task 1's reproducible build and Vercel entry.
- Produces: a pushed deployment whose unauthenticated project endpoint returns the canonical JSON `401`.

- [ ] **Step 1: Run the complete local gate**

Run: `npm run verify:local` and `npm audit --omit=dev --audit-level=high`.

Expected: lint, typecheck, all credential-free tests, frontend build, and production dependency audit pass.

- [ ] **Step 2: Review the final diff**

Check correctness, readability, architecture, security, performance, generated-file hygiene, and `git diff --check`.

- [ ] **Step 3: Commit and push**

Commit only the bundle pipeline, tests, lockfile, design, and plan; push `main` to `system-brain` without force.

- [ ] **Step 4: Verify deployment and live behavior**

Poll GitHub's Vercel deployment status for the pushed SHA, then request `https://system-brain-frontend-swart.vercel.app/v1/projects`.

Expected: deployment success and HTTP `401` with the canonical JSON authentication envelope; root `/` may remain `404` because this project is backend-only.
