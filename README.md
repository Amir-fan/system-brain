# KIP Next

KIP Next is the project-scoped backend and administration surface used by Naqaa. It provides authorization, ingestion, retrieval, Memory, conversation/skill execution, grounded fiqh workflows, scanner contracts, and a deterministic cycle-prediction API.

## Prerequisites

- Node.js 22 or newer and npm (required by the installed Supabase client).
- Git, used by repository lint and quality tests to enumerate version-controlled files.
- A separate Supabase project for persistence, Auth, private Storage, RLS, and Vault-backed provider configuration.
- Supabase CLI or another controlled migration process when applying the SQL migrations.
- Optional OpenRouter and GitHub App credentials for their live integrations.

## Local setup

```powershell
npm ci
npm --prefix frontend ci
Copy-Item .env.example .env.local
Copy-Item frontend/.env.example frontend/.env.local
```

Fill the local environment files outside Git. Apply every file in `supabase/migrations/` in ascending timestamp order to the intended Supabase project before starting the API.

Common commands:

```powershell
npm run dev:api
npm --prefix frontend run dev
npm test
npm run typecheck
npm run lint
npm run verify:local
```

`verify:local` is the deterministic credential-free aggregate gate: it removes live Supabase, OpenRouter, admin, GitHub-secret, and demo-password variables from its child processes, then runs repository lint, root typecheck, root tests, and the frontend production build. Use the separately documented live commands when credentials are intentionally supplied. A successful local run does not prove live Supabase RLS, Vault, OpenRouter, device, deployed routing, or Naqaa application behavior.

## Vercel backend deployment

The repository includes a Node.js Vercel Function at `api/index.ts`. Vercel rewrites public `/v1/*` requests to that function, and the adapter invokes the same authenticated KIP handler used by the local listener. The function duration is capped at 60 seconds, leaving a bounded margin over Naqaa's 45-second KIP timeout.

Create the Vercel project from the repository root with the framework preset set to **Other**. Do not set the project root to `frontend`; that directory is a separate Vite application. Configure these server-side environment variables in every Vercel environment that will serve Naqaa:

- `SUPABASE_URL`
- `SUPABASE_SECRET_KEY`
- `KIP_PROXY_TOKENS`
- `MODEL_NAME`
- `KIP_FRONTEND_URL`
- `KIP_PUBLIC_API_URL` when the GitHub connector is enabled

Optional GitHub connector credentials remain server-only. On Vercel, store the PEM contents in `GITHUB_APP_PRIVATE_KEY`; a local `GITHUB_APP_PRIVATE_KEY_PATH` is not part of the serverless function bundle. Configure the remaining `GITHUB_APP_*` variables normally.

After production deployment, set Naqaa's `KIP_NEXT_BASE_URL` secret to the stable Vercel origin, without a trailing slash, and rerun the deployed `naqaa-kip-proxy/health` check. Never put `SUPABASE_SECRET_KEY`, `KIP_PROXY_TOKENS`, or another backend credential in a `NEXT_PUBLIC_*` or `VITE_*` variable.

## Environment variables

Server-only secrets must remain in `.env.local`, the deployment secret store, or Supabase Vault. Never place `SUPABASE_SECRET_KEY`, `OPENROUTER_API_KEY`, `KIP_PLATFORM_ADMIN_TOKEN`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY`, or private-key contents in frontend variables or Git.

| Variable | Scope | Purpose |
| --- | --- | --- |
| `SUPABASE_URL` | server/live tests | Supabase project URL. |
| `SUPABASE_PUBLISHABLE_KEY` | live scripts | Public Supabase client key; not a server authority. |
| `SUPABASE_SECRET_KEY` | server/live tests, secret | Server database/Auth/Storage authority. |
| `KIP_PLATFORM_ADMIN_TOKEN` | server, secret | Temporary bootstrap admin credential. |
| `KIP_PLATFORM_ADMIN_EMAILS` | server | Comma-separated allowlist for verified Supabase admin users. |
| `OPENROUTER_API_KEY` | live tests, secret | Direct live-test credential. Normal runtime loads the configured provider secret from Vault. |
| `MODEL_NAME` | server/live tests | Default OpenRouter model, defaulting to `openrouter/auto`. |
| `KIP_PORT` | server | API port, default `8787`. |
| `KIP_PUBLIC_API_URL` | server/connectors | Public API base used by connector redirects. |
| `KIP_FRONTEND_URL` | server/connectors | Allowed frontend return origin. |
| `KIP_API_TOKENS` | development/test, secret | Legacy `actor:token` pairs; do not use as browser identity in production. |
| `KIP_PROXY_TOKENS` | server-to-server, secret | Trusted proxy `actor:token` pairs for explicitly delegated end-user calls. |
| `KIP_CHAT_TIMEOUT_MS` | server | Bounded provider request timeout override. |
| `KIP_PROVIDER_SORT` | server | Optional provider routing preference. |
| `KIP_REASONING_EFFORT` | server | Optional supported reasoning-effort setting. |
| `KIP_MINIMAL_RESPONSE_MODE` | server | Minimal-skill response mode: `natural`, `flexible`, or `required`. |
| `GITHUB_APP_ID` | server | GitHub App identifier. |
| `GITHUB_APP_CLIENT_ID` | server | GitHub App client identifier. |
| `GITHUB_APP_SLUG` | server | GitHub App slug. |
| `GITHUB_APP_CLIENT_SECRET` | server, secret | OAuth/state-signing secret. |
| `GITHUB_APP_PRIVATE_KEY_PATH` | server, secret path | Path to the private PEM, read only by the server. |
| `VITE_SUPABASE_URL` | browser-safe frontend | Supabase URL used by browser Auth. |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | browser-safe frontend | Publishable client key; never substitute the secret key. |

Test-only scripts may additionally require `OPENROUTER_TEST_KEY`, `KIP_DEMO_PASSWORD`, `K24_E2E_EMAIL`, `K24_E2E_PASSWORD`, `KIP_API_TOKEN`, `KIP_PUBLIC_API_URL_LOCAL`, `CLOSURE_PORT`, `CHROME_BIN`, or `RESTART_CID`. They are harness inputs, never browser/runtime configuration, and must stay outside Git. `DEBUG_PROMPT` may expose synthetic test prompts to local stdout and should remain unset for normal runs. Standard operating-system `TEMP`/`LOCALAPPDATA` variables are used only to locate temporary fixtures.

## Ownership boundary

KIP calculates and returns versioned predictions, validates project authorization, and supplies an integration fingerprint. Naqaa remains the source of truth for onboarding data, confirmed cycle history, corrections, calendar records, notification scheduling, device scanning, and user-facing reconciliation. KIP does not persist cycle predictions and does not decide whether a bleeding estimate is a fiqh state or purification.

The prediction contract is documented in [docs/naqaa-cycle-prediction-api.md](docs/naqaa-cycle-prediction-api.md). A correction must be sent as a fresh canonical request; the new input produces a new fingerprint and forecast. For conversation writes, `409 CONVERSATION_WRITE_CONFLICT` means the client must reload current state and intentionally resubmit. Do not blindly replay an unknown side effect.

## Live acceptance

Credential-free tests skip credential-gated cases explicitly. After secrets are supplied securely, run the live Supabase and OpenRouter selections described in [docs/client-acceptance-status.md](docs/client-acceptance-status.md). Device scanning, the deployed KIP-failure path, Naqaa calendar updates, and notification reconciliation require the separate Naqaa/staging environment and are not implied by local PASS results.
