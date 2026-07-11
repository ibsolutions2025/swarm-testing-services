# Production Readiness Plan

## Definition of ready

Swarm Testing Services is ready for general availability only when a customer can submit an authorized target and documentation, receive useful risk-based coverage, execute that coverage in isolated browser workers, and trust that every reported outcome is supported by reproducible evidence. The service must contain failures, protect tenants and targets, recover from worker interruption, enforce cost limits, delete data on schedule, and explain exactly what it did.

The current branch is a production-readiness foundation. It is not a production declaration.

Status terms used here:

- **Branch:** implemented or materially improved on this branch, but not accepted until the required tests and deployment review pass.
- **Partial:** some controls exist; material gaps remain.
- **Blocker:** must be complete before GA.
- **Later:** useful after the safe core is operational.

## Current capability assessment

| Area | Status | Notes |
| --- | --- | --- |
| Authenticated campaign intake | Branch | Captures product URL, docs URL, environment, scope, and authorization confirmation |
| Public target collection | Branch / Partial | URL, DNS, redirect, port, timeout, and size controls exist; strengthen against DNS rebinding and broaden docs discovery safely |
| Risk-based coverage planning | Branch | Source-backed rows/scenarios with bounded matrix size and observable criteria |
| Mock-user persona planning | Branch | Persona generation exists; remains model-generated input to execution |
| Planning-only run semantics | Branch | Simulated runs are limited to `partial`/`error`, confidence <= 0.35 |
| General live browser execution | **Blocker** | No arbitrary-product browser worker exists |
| Browser isolation and credential vault | **Blocker** | Must be designed and adversarially tested |
| Durable queue and leases | **Blocker** | Current polling/optimistic claim is not sufficient for production recovery |
| Evidence capture and verification | Partial / **Blocker** | Schema foundation exists; live artifacts and independent verification do not |
| Tenant model and RLS | Partial / **Blocker** | Owner-scoped policies improved; organization boundary and runtime policy tests remain |
| Secrets response | **Blocker** | Source scrub is not rotation or history removal; all exposed credentials must be revoked and replaced |
| Webhook replay/idempotency | Branch | Signed timestamp, event ID, payload hash, and status-aware event ledger require integration tests |
| Quotas, rate limits, billing controls | **Blocker** | Not complete |
| Privacy, retention, deletion | **Blocker** | Policy and automated enforcement required |
| Framework/runtime support | **Blocker** | Next.js 14.2.35 is an emergency patch floor; move to a supported major before GA |
| CI, release, rollback, observability | Partial / **Blocker** | Local QA exists; production release evidence and runbooks remain |

## P0 release blockers

### 1. Credential incident closure

- [ ] Revoke and rotate every provider, RPC, and GitHub credential ever committed or embedded in artifacts.
- [ ] Identify each secret's privileges, usage, owner, last use, and downstream systems.
- [ ] Search the complete Git history, tags, releases, build logs, deployment artifacts, caches, and mirrors.
- [ ] Purge historical values using an approved history-rewrite process; coordinate force-push and clone replacement.
- [ ] Review provider audit logs for abuse and document the incident timeline.
- [ ] Verify production and preview deployments use new, environment-specific secret-manager values.
- [ ] Require secret scanning in pre-commit/CI and block releases on findings.

Acceptance evidence: provider revocation receipts or timestamps, clean full-history scans, clean build artifacts, reviewed incident record, and a tested rotation runbook.

### 2. Live browser executor

- [ ] Define a versioned job contract for steps, assertions, allowed origins, credentials, budgets, and artifacts.
- [ ] Implement deterministic browser actions and assertions with bounded exploratory behavior.
- [ ] Capture action trace, screenshots, DOM/accessibility state, console, network summary, and performance signals.
- [ ] Produce `pass` only when all required assertions ran and their evidence is complete.
- [ ] Classify target defects separately from infrastructure, planner, policy, and credential failures.
- [ ] Support cancellation and deadline enforcement during navigation, model calls, and artifact upload.
- [ ] Prove replay/retry idempotency for actions with side effects.

Acceptance evidence: end-to-end runs against a controlled reference application containing seeded functional, permission, accessibility, recovery, and security defects; no synthetic passes on worker/model failure.

### 3. Browser sandbox and egress policy

- [ ] Create one ephemeral sandbox and browser profile per attempt.
- [ ] Block cloud metadata, loopback, link-local, RFC1918/private IPv4, private/reserved IPv6, databases, control-plane hosts, and other tenant targets.
- [ ] Restrict egress to the authorized target and approved dependencies; re-check redirects and DNS at connection time.
- [ ] Enforce CPU, memory, disk, process, wall-clock, download, upload, and artifact limits.
- [ ] Disable extensions and dangerous protocol handlers; control popups, downloads, clipboard, and file access.
- [ ] Deliver only short-lived, campaign-scoped credentials; revoke them at teardown.
- [ ] Redact secrets and personal data before logs/artifacts leave the sandbox.
- [ ] Run adversarial escape, DNS rebinding, redirect, download, decompression, and prompt-injection tests.

Acceptance evidence: isolation test report, egress-denial logs, teardown audit, redaction tests, and third-party security review for the worker boundary.

### 4. Durable scheduling, leases, and recovery

- [ ] Introduce explicit job and attempt records rather than treating campaign status as a queue.
- [ ] Claim work atomically with a lease owner and expiry.
- [ ] Heartbeat long-running jobs and safely recover expired leases.
- [ ] Add bounded exponential retries, terminal classifications, and a dead-letter queue.
- [ ] Make cancellation monotonic and cooperative, including cleanup and credential revocation.
- [ ] Enforce tenant concurrency, global capacity, campaign budgets, and fair scheduling.
- [ ] Use idempotency keys for job creation, evidence upload, webhook processing, and external side effects.
- [ ] Re-drive partially processed events; never treat “seen” as “complete.”

Acceptance evidence: crash/restart, network partition, duplicate event, stale worker, concurrent claimant, cancellation, and dead-letter tests.

### 5. Tenant isolation and authorization

- [ ] Add organizations, memberships, roles, invitations, and entitlements.
- [ ] Add `organization_id` to every customer-owned record and artifact key.
- [ ] Define separate customer, worker, administrator, billing, and support authorization paths.
- [ ] Remove service-role use from all customer-facing read endpoints.
- [ ] Enable RLS on every exposed table and view; deny `anon` unless a deliberately sanitized public view exists.
- [ ] Test policies with two organizations, multiple roles, revoked membership, deleted users, and guessed identifiers.
- [ ] Audit every privileged action and support-access event.
- [ ] Verify database functions use safe `search_path`, privilege grants, and security invoker/definer semantics.

Acceptance evidence: automated negative authorization suite and Supabase security review with no cross-tenant reads or writes.

### 6. Truthful outcomes and report verification

- [ ] Separate job completion from product verdict.
- [ ] Define `planned`, `running`, `blocked`, `pass`, `fail`, `partial`, `error`, `cancelled`, and `not_applicable` semantics across database, API, and UI.
- [ ] Require `executor_mode=browser` and complete evidence for pass/fail.
- [ ] Treat missing required assertions or artifacts as incomplete/error, not pass.
- [ ] Add an independent verifier that checks evidence presence, hashes, assertion support, and retry lineage.
- [ ] Surface inference, confidence, flakiness, excluded combinations, and untested scope in every report.
- [ ] Prevent aggregate scores from hiding critical failures or unexecuted cells.

Acceptance evidence: golden report fixtures and tests that reject fabricated, missing, mismatched, stale, or planning-only evidence.

### 7. Supported platform and dependency baseline

- [ ] Upgrade Next.js from the patched 14.2.35 floor to a currently supported major release.
- [ ] Upgrade React, Supabase clients, TypeScript, lint tooling, and Node LTS as a tested unit.
- [ ] Remove deprecated configuration and confirm Server Actions, middleware, caching, and auth behavior.
- [ ] Generate and review a dependency inventory/SBOM.
- [ ] Add automated vulnerability and license policy checks with a documented exception process.
- [ ] Pin production runtimes and lockfile-based installs; define monthly patch and emergency upgrade SLAs.

Acceptance evidence: clean production build, route/auth regression suite, dependency scan, canary deployment, and rollback proof on supported versions.

### 8. Privacy, retention, and deletion

- [ ] Publish Terms, Privacy Notice, Acceptable Use Policy, and authorization/target-testing terms reviewed by counsel.
- [ ] Classify campaign metadata, page content, credentials, screenshots, traces, logs, and model inputs.
- [ ] Choose default retention by class, with shorter defaults for raw browser artifacts and logs.
- [ ] Store retention deadlines and enforce deletion automatically across Postgres, object storage, logs, backups, and model/vendor systems.
- [ ] Provide tenant export and deletion workflows with audit evidence.
- [ ] Define subprocessor, data residency, encryption, backup, legal hold, and incident-notification policies.
- [ ] Minimize model prompts; prohibit secrets and unnecessary personal data; document provider retention settings.

Acceptance evidence: deletion integration test spanning all stores, privacy review, published policies, and data-flow inventory.

## P1 production capabilities

### Intake and discovery

- [ ] Crawl authorized documentation trees with page/depth/byte/time budgets and canonical URL handling.
- [ ] Support OpenAPI, GraphQL schema, sitemap, help center, changelog, and supplied file ingestion safely.
- [ ] Track source snapshots and hashes so test plans are reproducible.
- [ ] Extract routes, roles, workflows, settings, flags, limits, error states, and stated expectations into a normalized product model.
- [ ] Show customers discovered scope and require review for inferred, destructive, billing, admin, and production actions.
- [ ] Detect unreachable, login-gated, contradictory, stale, or insufficient documentation.

### Coverage and planning

- [ ] Define a configuration schema with domains, constraints, dependencies, forbidden combinations, and risk weights.
- [ ] Generate pairwise/covering arrays for lower-risk combinations and exhaustive coverage for critical boundaries.
- [ ] Deduplicate semantically overlapping scenarios and preserve requirement-to-scenario traceability.
- [ ] Add deterministic baseline checks for links, forms, auth boundaries, accessibility, security headers, and core Web Vitals.
- [ ] Version the planner, prompts, models, source snapshot, assertion DSL, and rubric.
- [ ] Allow customer review, edits, approval, exclusions, and rationale before billable execution.

### Test accounts and fixtures

- [ ] Build tenant-scoped test-account pools for each role and plan.
- [ ] Deliver credentials through a vault reference, never free text or model context.
- [ ] Reset fixtures before/after runs and verify cleanup.
- [ ] Support disposable email, OTP, webhook, payment sandbox, file, locale, and time controls.
- [ ] Place explicit approval gates around deletion, payment, messaging, publication, permission changes, and other side effects.

### Reporting and customer workflow

- [ ] Provide matrix coverage, verdicts, severity, confidence, evidence, reproduction steps, and untested scope.
- [ ] Link each scenario to its source requirement and configuration combination.
- [ ] Group duplicate failures without losing affected cells.
- [ ] Add compare-to-baseline, regression history, flaky detection, and rerun selection.
- [ ] Export durable HTML/PDF/JSON and integrate with issue trackers/CI through versioned APIs.
- [ ] Make artifacts accessible while preventing secret exposure and cross-tenant sharing.

### Abuse prevention and economics

- [ ] Rate-limit signup, login, intake, crawl, plan, execute, rerun, export, and webhook endpoints by user, tenant, IP, target, and cost.
- [ ] Require email verification and stronger controls for production targets or high-risk actions.
- [ ] Enforce plan entitlements, preflight cost estimates, campaign/run budgets, and hard kill switches.
- [ ] Prevent arbitrary scanning, credential stuffing, denial-of-service, spam, and testing of targets without authorization.
- [ ] Add target complaints, abuse investigation, suspension, and evidence-preservation workflows.

### Reliability and operations

- [ ] Define SLOs for intake availability, queue start latency, completion latency, artifact availability, and report correctness.
- [ ] Instrument metrics, traces, and redacted structured logs for each campaign/job/attempt.
- [ ] Add alerts for queue stalls, expired leases, unusual egress, auth denials, redaction failures, budget spikes, and verifier disagreement.
- [ ] Write runbooks for compromised secrets, queue backlog, worker compromise, bad deploy, database degradation, artifact loss, and vendor outage.
- [ ] Test backups, point-in-time recovery, object-store recovery, and restore permissions.
- [ ] Establish on-call ownership, customer support escalation, status communications, and post-incident review.

## QA and release gates

Every production candidate must pass:

1. **Static gate:** secret scan, typecheck, lint, dependency/security scan, migration lint, generated-file review, and build.
2. **Unit gate:** URL policy, signing, event state machine, planner normalization, outcome truthfulness, redaction, quota, and authorization helpers.
3. **Database gate:** clean migration, upgrade migration, rollback/forward repair, RLS negative tests, constraints, indexes, and concurrent job claims.
4. **Integration gate:** auth, intake, signed dispatch, duplicate/retried events, queue lifecycle, worker token exchange, artifact upload, cancellation, and deletion.
5. **Browser gate:** seeded reference products across browsers/viewports, network conditions, roles, locales, accessibility, downloads/uploads, and failure recovery.
6. **Security gate:** SSRF/DNS rebinding, prompt injection, browser escape, credential leakage, IDOR, CSRF, replay, open redirect, rate-limit bypass, dependency, and secret-history checks.
7. **Evidence gate:** all verdicts supportable from immutable artifacts; verifier rejects missing/mismatched evidence; critical failures cannot be averaged away.
8. **Resilience gate:** process crash, host loss, network partition, model/provider outage, Supabase outage, object-store outage, stale lease, and capacity exhaustion.
9. **Performance/cost gate:** defined campaign sizes stay within latency, concurrency, database, artifact, token, and dollar budgets.
10. **Human review gate:** privacy/security approval, customer-facing copy truthfulness, runbooks, rollback, dashboards, and release owner sign-off.

## Recommended build sequence

1. Close the credential incident and lock down exposed result endpoints.
2. Define outcome/evidence contracts and organization-scoped data model.
3. Introduce durable jobs, leases, attempts, cancellation, and budget enforcement.
4. Build the isolated browser-worker proof of concept against seeded reference apps.
5. Add vault-based accounts, deterministic assertions, artifact capture, redaction, and verifier.
6. Build customer plan review and evidence-backed reporting.
7. Upgrade to the supported framework/runtime baseline.
8. Complete RLS, rate limits, retention/deletion, abuse controls, and legal pages.
9. Run security, resilience, migration, performance, and cost qualification.
10. Operate a limited staging-only design-partner beta before any production-target GA.

## Launch stages

### Internal alpha

Controlled reference applications only; no customer credentials; manual review of every plan and report; hard spend caps.

### Design-partner beta

Staging targets only by default; written authorization and scope; narrow approved workflows; isolated workers; human approval for risky steps; short retention; named support owner.

### GA

All P0 gates closed with evidence, supported runtime, external security review, automated tenant/retention controls, published legal terms, stable SLOs, tested incident response, and no unresolved critical/high findings.

## Required runbooks and records

- Deployment, canary, rollback, and database migration.
- Secret rotation and compromised-credential response.
- Worker compromise and sandbox containment.
- Queue backlog, lease storm, stuck cancellation, and dead-letter recovery.
- Model/provider degradation and fail-closed behavior.
- Customer data export/deletion and retention exceptions.
- Cross-tenant access alert and support-access audit.
- Abuse complaint and target-owner verification.
- Incident communications and post-incident review.
- Cost anomaly and global campaign kill switch.

The readiness tracker should link each item to an owner, target stage, pull request, test evidence, operating document, and acceptance decision. “Implemented” without verification is not a closed gate.
