# Security and Trust Model

## Scope

STS deliberately opens untrusted websites, ingests untrusted documentation, asks models to reason about that content, and will eventually execute browser actions with customer-authorized accounts. Its browser worker is therefore a hostile-code boundary, not an ordinary application process.

Security goals:

- test only targets and actions the customer is authorized to test;
- prevent a target from reaching STS infrastructure, secrets, other tenants, or unrelated Internet systems;
- keep customer credentials, source material, and artifacts isolated and minimally retained;
- make every privileged action attributable and every result evidence-backed;
- fail closed when identity, authorization, policy, secrets, workers, or evidence are unavailable; and
- make compromise containable to one short-lived run.

This document distinguishes controls present on the production-readiness branch from controls required before GA.

## Assets

- Customer identity, organization membership, authorization record, and billing entitlement.
- Submitted targets, documentation, scopes, product models, test plans, and reports.
- Test accounts, session tokens, OTPs, API keys, payment-sandbox credentials, and uploaded fixtures.
- Browser screenshots, traces, DOM/accessibility snapshots, console/network logs, and downloads.
- Supabase service role, webhook secrets, model-provider credentials, RPC credentials, GitHub credentials, and deployment credentials.
- Scheduler state, worker tokens, quotas, audit events, cost records, and incident evidence.
- STS reputation and the availability/integrity of customer targets.

## Trust boundaries

1. Anonymous Internet to public web application.
2. Authenticated customer to organization-scoped control plane.
3. Control plane to Supabase and object storage.
4. Intake/discovery service to arbitrary customer-supplied URLs.
5. Planner/evaluator to model providers.
6. Scheduler to untrusted browser workers.
7. Browser worker to the authorized target and its approved dependencies.
8. Worker to evidence ingestion without control-plane credentials.
9. Maintainer/support access to customer records and artifacts.
10. CI/CD and source control to production environments.

No boundary should rely only on prompt instructions or application filtering. Database policy, narrow credentials, egress enforcement, sandbox isolation, and audit logs are required defense in depth.

## Threats and required responses

| Threat | Example | Required response |
| --- | --- | --- |
| Unauthorized testing | A customer submits a bank, competitor, or admin panel they do not control | Explicit authorization, verified identity for risky use, target/domain verification where appropriate, scoped actions, abuse review, suspension/kill switch |
| SSRF and network pivot | Target resolves or redirects to metadata, localhost, a database, or control-plane service | Validate scheme/host/port/DNS/redirect; enforce connection-time egress policy; block private/reserved ranges and internal DNS; log denials |
| DNS rebinding | A hostname validates publicly, then resolves privately during connect | Resolve through controlled DNS and pin/verify the connected address; enforce network policy outside application code |
| Prompt injection | Documentation tells the planner or agent to reveal secrets or ignore policy | Treat page text as data, separate system policy, schema-validate output, deterministic action policy, never expose control secrets to the model |
| Browser escape | Malicious JS exploits browser/OS or abuses downloads/protocols | Patched short-lived sandbox, seccomp/VM/container isolation, no host mounts, resource limits, controlled browser features, rapid teardown |
| Cross-tenant access | Guessed campaign ID returns another customer's runs | Organization-scoped RLS, no service-role customer reads, short-lived scoped artifact URLs, automated two-tenant negative tests |
| Credential leakage | Password appears in prompt, screenshot, trace, URL, or log | Vault references, field-aware injection, no model visibility when possible, redaction before export, query-string stripping, short TTL and revocation |
| Side-effect abuse | Agent buys, deletes, publishes, invites, emails, or changes permissions | Action classes, staging default, explicit customer approvals, spend/recipient limits, dry-run where meaningful, reversible fixtures, audit evidence |
| Replay/duplicate work | Webhook retry skips an incomplete step or repeats a payment-like action | Signed timestamped events, event ID/payload hash, processing status, status-aware re-drive, idempotency keys and compensating controls |
| Synthetic success | Model outage or parser error creates an APPROVE/pass record | Fail closed, pass requires live executor and evidence, independent verifier, regression tests for every fallback path |
| Denial of service/cost attack | Huge docs, infinite redirects, crawl traps, massive matrix, repeated campaigns | Byte/page/depth/time limits, bounded matrix, quotas, rate limits, concurrency caps, budgets, cancellation, circuit breakers |
| Artifact malware/data exfiltration | Target serves an executable or sensitive download | Download quarantine, type/size policy, malware scan, no execution, tenant-scoped storage, short retention, controlled analyst access |
| Supply-chain compromise | Vulnerable framework, dependency, action, image, or browser | Supported versions, lockfiles, minimal dependencies/images, signed artifacts, SBOM, vulnerability and provenance checks, patch SLA |
| Insider/support misuse | Operator browses customer screenshots or impersonates user | Least privilege, just-in-time access, approvals for sensitive access, immutable audit log, customer-visible support events where feasible |

## Controls present on this branch

These are foundations and still require production-like verification:

- Campaign intake requires authentication, bounded scope text, staging/production designation, and explicit authorization confirmation.
- Product and documentation URLs must be public HTTP(S) targets. Embedded credentials, local/internal hosts, private/reserved IP ranges, disallowed ports, excessive redirects, oversized responses, and timeouts are rejected.
- Every redirect is revalidated by the collector.
- Product/document content is bounded and treated as untrusted evidence in planning prompts.
- Planning-only cells are `partial` or `error`; confidence is capped; unavailable browser execution returns an error.
- Supabase policies scope core campaign reads through authenticated ownership; customer lifecycle updates are revoked; transaction attempts and webhook events are service-only.
- Dispatch/webhook messages use a secret, timestamp, event ID, signature over timestamp plus body, payload hash, short time window, and durable processing ledger.
- Broad wildcard Server Action origins were removed and common browser security headers were added.
- Signup uses normal Supabase signup behavior and does not auto-confirm or mutate an existing account through admin APIs.
- Dynamic evaluation fallbacks were removed from two onboarding parsing paths.
- A repository secret scan runs before the Node test suite.

Application URL validation alone is not an adequate browser-worker network boundary. It has time-of-check/time-of-use limitations and cannot contain a compromised browser. Connection-time infrastructure policy remains a GA blocker.

## Credential incident and secret management

Historical repository material contained live-looking provider and RPC credentials. Removing or redacting values in the current tree does not make them safe. Treat every exposed value as compromised.

Required incident actions:

1. Revoke and rotate each value at its provider; do not wait for history cleanup.
2. Identify privileges, related accounts, deployment use, and audit-log activity.
3. Replace values independently in local, preview, staging, production, CI, VPS, and scheduled-job environments.
4. Search all branches, tags, commit history, release archives, issue attachments, build logs, caches, object storage, and mirrors.
5. Rewrite history through a coordinated process, invalidate old clones, and re-run complete-history scans.
6. Record the event, impact assessment, actions, owners, timestamps, and remaining risk.

Long-term rules:

- Secrets live in an approved secret manager, not Git, documentation, SQL, screenshots, prompts, or chat logs.
- Use separate, least-privilege credentials per environment and service.
- Prefer short-lived workload identity over long-lived tokens.
- Rotate high-value credentials on schedule and immediately after suspected exposure.
- Never place the Supabase service role, deployment token, or shared GitHub credential in browser workers.
- A secret scanner is a release gate, including full-history and built-artifact scans.
- Logs name the missing variable but never output its value or a connection URL containing it.

## Identity, sessions, and tenant authorization

Before GA:

- Model ownership through `organizations`, `organization_members`, roles, invitations, and entitlements.
- Require verified email; add MFA for administrators and encourage it for customers with production campaigns.
- Rate-limit signup, login, password reset, invitations, and sensitive account changes.
- Rotate sessions after privilege changes; support session inventory and revocation.
- Use same-site secure cookies and server-side authorization on every request.
- Validate relative redirects and approved OAuth redirect origins.
- Apply RLS to every exposed table and view with explicit `authenticated` roles.
- Test anonymous, signed-out, wrong-user, wrong-organization, revoked-member, deleted-user, and downgraded-role cases.
- Make support/admin access separate, time-bounded, reason-coded, and audited.

Service-role access is an administrative capability. It may be used by a private control-plane worker, but not as a shortcut for public result APIs.

## Target authorization and abuse controls

A checkbox is necessary but not sufficient for high-risk or production testing. The service should apply risk-tiered controls:

- staging may use standard attestation for low-risk workflows;
- production, administrative, financial, healthcare, government, or high-volume targets require stronger customer and domain verification;
- scans of authentication, permissions, payment, deletion, invitations, messaging, or security boundaries require explicit named scope;
- prohibit credential stuffing, bypass attempts, destructive exploitation, unrelated third-party scanning, spam, and denial-of-service;
- maintain per-target, tenant, user, IP, and cost rate limits;
- provide target owners a complaint channel and fast emergency stop; and
- preserve relevant authorization and audit evidence while respecting retention policy.

The scheduler must enforce target and action policy independently of planner/model output.

## Browser sandbox specification

Each attempt receives a fresh sandbox with no state from another attempt. Minimum controls:

### Isolation

- Dedicated ephemeral browser profile, filesystem, process namespace, and network identity.
- No host socket, container runtime, cloud metadata, control-plane credential, database credential, or shared writable volume.
- Read-only minimal runtime image, non-root execution, syscall restrictions, and patched browser/OS.
- CPU, memory, process, disk, file, download, and hard wall-clock limits.
- Forced teardown after completion, cancellation, timeout, or worker loss.

### Network

- Default-deny egress.
- Allow only the authorized target origins and approved required dependencies.
- Deny private, reserved, link-local, loopback, multicast, metadata, database, mail, and control-plane destinations at the network layer.
- Re-resolve and verify at connection time; prevent DNS rebinding and redirect expansion.
- Restrict nonstandard ports and protocols; block raw sockets.
- Record destination metadata without sensitive query strings or bodies.

### Browser and files

- Disable extensions, developer-protocol exposure, dangerous custom protocols, password managers, and shared clipboard.
- Constrain popups, new windows, downloads, uploads, camera, microphone, geolocation, notifications, and permissions.
- Quarantine downloads; scan them; never execute them.
- Supply approved upload fixtures from a read-only, campaign-scoped area.
- Clear storage, cookies, service workers, cache, and profiles at teardown.

### Credentials and actions

- Fetch credentials using a narrow one-time reference after the worker is assigned.
- Inject values directly into permitted fields; avoid sending them through the model.
- Redact fields, headers, cookies, tokens, query strings, screenshots, console, network traces, and DOM snapshots.
- Apply action policy before navigation/form submission, with human approval for high-impact classes.
- Set financial, recipient, message, deletion, permission, and record-count limits.
- Revoke or rotate ephemeral credentials and reset fixtures after every attempt.

## Models and prompt injection

Models are nondeterministic advisers, not security principals. They may propose scenarios, personas, candidate actions, qualitative observations, and classifications. They may not decide authorization, network policy, tenant access, spending, credential scope, evidence sufficiency, or whether missing execution is a pass.

Required controls:

- Delimit product content as untrusted evidence.
- Keep policy and credentials outside target-controlled context.
- Use strict structured output with length, enum, identifier, and count validation.
- Convert model proposals into an allowlisted action language checked by deterministic policy.
- Bound tool calls, recursion, tokens, time, and cost.
- Record model/provider/version and prompt/template version for reproducibility.
- Treat parse errors, refusals, timeouts, and provider fallback as explicit failures or reviewed degradation.
- Red-team indirect prompt injection, data exfiltration, hidden text, malicious accessibility labels, and tool-output injection.

## Webhooks and asynchronous state

Webhook endpoints must:

- fail closed when their secret is missing;
- read a bounded raw body before parsing;
- require an allowed event type and schema version;
- verify timestamp and constant-time signature over timestamp plus exact body;
- require a unique event ID and store its payload hash;
- reject a reused event ID with a different payload;
- distinguish processing, completed, and failed events;
- re-drive incomplete work safely;
- enforce monotonic/compare-and-set state changes; and
- return generic errors without internal details.

Rotate webhook secrets with an overlap window and key identifier; alert on signature failure spikes and stale/replayed events.

## Data classification, retention, and deletion

Suggested default classes:

| Class | Examples | Default posture |
| --- | --- | --- |
| Account metadata | email, membership, entitlement | Retain while account is active plus legal/billing minimum |
| Campaign metadata | target origin, scope, plan, status, costs | Customer-configurable, with a bounded service default |
| Raw artifacts | screenshots, traces, DOM, console, network, downloads | Most sensitive; encrypt, redact, short retention, no public links |
| Credentials | passwords, tokens, OTPs, cookies | Vault only; shortest possible TTL; never retained in reports/logs |
| Derived reports | rubric, defects, evidence references | Tenant-scoped; retain per plan and contract |
| Security/audit events | login, access, policy denial, admin action | Append-only, limited fields, security/legal retention |
| Operational telemetry | performance, error, queue metrics | Pseudonymous identifiers; no page bodies or form values |

Retention must be encoded as an expiration timestamp and enforced in every store, including logs, queues, temporary worker disks, object storage, backups, caches, and vendor/model systems. Deletion jobs need retries, tombstones, audit receipts, and verification. Legal holds must be explicit and access-controlled.

## Logging, artifacts, and redaction

- Use opaque tenant/campaign/job/attempt IDs.
- Strip URL credentials, fragments, and sensitive query parameters.
- Never log authorization headers, cookies, passwords, OTPs, form values, service keys, full model prompts, or raw page bodies by default.
- Redact before transport and storage; do not rely only on a viewer-time filter.
- Encrypt in transit and at rest; use tenant-scoped object keys and short-lived signed URLs.
- Hash artifacts and bind them to attempt metadata so the verifier detects substitution.
- Restrict support access and log every artifact view/download.
- Test redaction with seeded canary secrets and alert if a canary reaches logs, models, or artifacts.

## Framework, dependency, and deployment security

Next.js 14.2.35 is the minimum patched floor selected for this branch, not the GA destination. Upgrade to a currently supported major release before GA and test auth, Server Actions, middleware, caching, route handlers, headers, and deployment behavior.

Release controls should include:

- lockfile installs on a pinned Node LTS runtime;
- vulnerability, license, secret, and static analysis;
- dependency provenance/SBOM and minimal production image;
- signed build artifacts and protected release environments;
- no production secrets in pull-request builds;
- database migration preview, backup, and rollback/repair plan;
- canary rollout, health checks, monitored soak, and tested rollback; and
- separation of source review, deployment approval, and production secret access.

## Incident response priorities

Maintain tested runbooks for:

- committed or logged secret;
- cross-tenant access;
- compromised browser worker or sandbox escape;
- unauthorized target testing or abuse complaint;
- anomalous network egress or credential use;
- fabricated/misleading result;
- artifact exposure or redaction failure;
- vulnerable dependency/browser zero-day; and
- destructive target-side action.

The first actions are contain, revoke, stop affected campaigns, preserve minimal evidence, assess scope, notify owners, remediate, verify, and document. A global worker/campaign kill switch and per-tenant/target suspension must not depend on the model or worker fleet being healthy.

## Security release checklist

- [ ] Historical credentials revoked, rotated, investigated, and removed from history/artifacts.
- [ ] No secret scanner findings in current tree, full history, build output, images, or logs.
- [ ] Organization-scoped RLS tests pass for every table/view/API/artifact path.
- [ ] Customer-facing routes do not use service-role access.
- [ ] Browser sandbox and connection-time egress controls pass adversarial tests.
- [ ] Credential vault, redaction, teardown, and canary-secret tests pass.
- [ ] Authorization and action policy are enforced outside model output.
- [ ] Webhook duplicate, replay, conflict, partial failure, and ordering tests pass.
- [ ] Pass/fail cannot be emitted without live evidence and verifier acceptance.
- [ ] Rate limits, quotas, campaign budgets, action limits, and kill switches are tested.
- [ ] Retention, export, deletion, backup, and vendor-data controls are verified.
- [ ] Supported framework/runtime and dependency scans are clean or have approved risk exceptions.
- [ ] Privacy, Terms, Acceptable Use, subprocessor, and incident policies are published and reviewed.
- [ ] Independent application and sandbox security reviews have no unresolved critical/high findings.
