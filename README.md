# Swarm Testing Services

Swarm Testing Services (STS) turns a product URL, its documentation, and an authorized test scope into a risk-based test matrix for mock-user testing.

> **Pre-GA status:** the generic intake, safe source collection, coverage planning, persona generation, and evidence schema are implemented. A general-purpose live browser executor is not. Planning-only runs are stored as `partial` or `error` and must never be presented as product passes.

## What works today

- Authenticated campaign intake for a product URL, documentation URL, staging/production designation, and authorized scope.
- Public-target validation, redirect revalidation, response-size limits, and timeouts for product and documentation collection.
- Source-backed workflow, configuration, persona, failure-mode, accessibility, and trust/safety planning.
- Risk-based and pairwise-oriented matrix design rather than an unbounded Cartesian product.
- Structured run records with executor mode, confidence, failure category, rubric estimates, evidence, and timestamps.
- Owner-scoped Supabase reads, service-owned lifecycle writes, and signed, replay-resistant webhook handling.
- Secret scanning and regression checks in the local QA command.

## What is not GA-ready

- Live browser execution for arbitrary products.
- Per-run browser isolation, network egress policy, credential injection, and destructive-action controls.
- A durable queue with leases, heartbeats, retry budgets, cancellation, and dead-letter handling.
- Complete tenant, quota, rate-limit, retention, deletion, privacy, and audit controls verified in a production-like environment.
- Migration from the emergency Next.js 14 patch floor to a currently supported major release.
- Evidence-backed customer reports whose pass/fail claims have been independently verified.

The full gate list is in [Production readiness](docs/PRODUCTION-READINESS.md).

## System shape

```text
authenticated intake
        |
        v
campaign + authorization record (Supabase)
        |
        v
safe product/docs collection -> product context
        |
        v
risk-based matrix -> mock-user personas -> matrix cells
        |
        +--> simulated planner (available; partial/error only)
        |
        +--> isolated browser workers (pre-GA blocker)
        |
        v
structured rubric + evidence + campaign report
```

The repository also contains AWP-specific onboarding, scanner, and verifier code from the original service. Those protocol adapters are not the generic browser-testing runtime. See [Architecture](docs/ARCHITECTURE.md) for the boundary.

## Documentation

- [Architecture](docs/ARCHITECTURE.md) - current and target system design, data model, and trust boundaries.
- [Production readiness](docs/PRODUCTION-READINESS.md) - release gates, build sequence, and operating requirements.
- [Security](docs/SECURITY.md) - threat model, browser sandbox requirements, secrets, tenancy, and incident response.
- [Test rubric](docs/TEST-RUBRIC.md) - outcome semantics, scoring anchors, evidence minimums, and report QA.
- [Customer intake template](docs/CUSTOMER-INTAKE-TEMPLATE.md) - the information required for safe, useful testing.

## Local development

Requirements:

- Node.js 18.17 or newer. Production should use a pinned, supported LTS runtime.
- A Supabase project for authentication and durable records.
- An OpenRouter-compatible model credential for the planning orchestrator.

```bash
npm install
cp .env.example .env.local
npm run dev
```

Never commit real credentials. `.env.example` contains names and placeholders only.

### Environment groups

- Web application: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.
- Planner/orchestrator: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENROUTER_API_KEY`.
- Signed dispatch: `ORCHESTRATOR_WEBHOOK_URL`, `ORCHESTRATOR_WEBHOOK_SECRET`.
- Optional protocol adapters: values such as `ALCHEMY_RPC`; these must remain in a secret manager.
- Safe collection controls: `STS_ALLOWED_TARGET_PORTS`, `STS_FETCH_TIMEOUT_MS`, `STS_MAX_FETCH_BYTES`.

Use separate credentials and projects for local, preview, staging, and production environments.

## Database setup

Apply the SQL migrations in `supabase/migrations/` in filename order. Migration `0011_production_readiness_foundation.sql` adds the generic intake/evidence fields, a durable webhook event ledger, and stricter row-level security. Validate every migration and rollback path against an empty database and a production-like snapshot before release.

## Quality checks

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

`npm test` runs the secret scanner before the Node test suite. A green local run is necessary but not sufficient for release; the production gates require database policy tests, browser-worker tests, isolation tests, and end-to-end evidence verification.

## Security and responsible use

Only test a target when its owner has explicitly authorized the scope. Prefer staging. Do not place passwords, API keys, payment data, personal data, or production secrets in the free-text scope. Browser credentials must eventually be delivered through a short-lived vault mechanism, never through prompts, logs, screenshots, or source control.

Report security issues privately to the maintainers. Do not open a public issue containing credentials, exploit details, customer data, or target URLs.

## Release policy

This branch is a production-readiness workstream, not a production declaration. No simulated result may be marketed as a live observation, no campaign-level `completed` state should be interpreted as a product approval, and no GA release should occur until every blocking gate in [Production readiness](docs/PRODUCTION-READINESS.md) has objective evidence.
