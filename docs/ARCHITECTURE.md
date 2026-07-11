# Swarm Testing Services Architecture

## Purpose and status

Swarm Testing Services (STS) is intended to accept a product URL, documentation, and an authorized test scope; discover the product's likely workflows, settings, roles, states, and edge cases; execute those scenarios as representative mock users; and return an evidence-backed rubric.

The repository currently implements the intake and planning half of that design. It can collect bounded public source material, create a risk-based matrix, generate personas, and persist structured planning results. It does **not** yet provide a general live browser worker. The simulated path is a plan generator and must never claim that it clicked, observed, passed, or failed a live product.

## Design principles

1. **Evidence before claims.** A pass requires live execution evidence and deterministic assertions. A model opinion is not evidence.
2. **Explicit authorization.** Every campaign records who requested it, the target, environment, scope, and authorization confirmation.
3. **Untrusted targets.** Product pages, documentation, browser content, uploads, and model output are hostile inputs.
4. **Tenant isolation.** Customer records, credentials, artifacts, and workers must be isolated by organization and campaign.
5. **Safe failure.** Missing secrets, unavailable workers, ambiguous state, and model failures produce blocked/error states, never synthetic success.
6. **Bounded exploration.** Risk-based and pairwise coverage control cost while preserving the combinations most likely to reveal defects.
7. **Reproducibility.** Every result identifies the plan version, environment, executor version, inputs, assertions, artifacts, and timestamps.

## Current logical flow

```text
Next.js web app
  - sign up / sign in
  - target + docs + environment + scope + authorization
                 |
                 v
Supabase control records
  campaigns -> matrices -> personas -> runs
                 |
                 v
Polling orchestrator
  1. claim a queued campaign
  2. collect bounded product/document text
  3. design configuration rows and scenario columns
  4. generate one mock-user persona per row
  5. dispatch each matrix cell
                 |
         +-------+--------+
         |                |
         v                v
simulated planner     browser executor
(implemented)         (not implemented)
partial/error only    required for observed pass/fail
         |                |
         +-------+--------+
                 v
structured run records and future customer report
```

### Web control plane

The Next.js application owns customer authentication, campaign intake, customer-facing status, and result presentation. Campaign creation:

- authenticates the user;
- validates the product and documentation URLs as public HTTP(S) targets;
- requires an explicit authorization checkbox;
- records staging or production intent and the written scope;
- inserts a queued campaign; and
- optionally sends a signed, timestamped event to an orchestrator endpoint.

The web app must not use the Supabase service role for customer-readable result endpoints. Customer reads should use the signed-in session and row-level security. Administrative operations belong in private worker paths.

### Source collection

The generic collector fetches the submitted product page and optional documentation page with protocol, hostname, port, DNS, redirect, timeout, and response-size checks. It removes active markup and produces bounded text plus source metadata.

This is discovery input, not trusted instruction. The collector and prompts explicitly treat embedded text as untrusted evidence. Before GA, collection still needs stronger defenses against DNS rebinding and content smuggling, plus a controlled crawler for documentation trees rather than a single-page fetch.

### Coverage planner

The planner generates two bounded axes:

- **Rows:** representative combinations of device, role, plan, data state, flags, and other relevant settings.
- **Columns:** concrete workflows and failure scenarios with risk, category, preconditions, observable success criteria, source references, and an inference flag.

The target is high-value interaction coverage, not every possible Cartesian combination. Critical flows and dangerous boundaries are exhaustive where practical; lower-risk settings use pairwise or other covering-array techniques.

### Persona generator

One persona is generated for each configuration row. Personas express goals, experience, constraints, and realistic biases. They influence exploration and usability observations but may not weaken deterministic assertions or security policy.

### Dispatch paths

The current generic dispatcher has two explicit modes:

- `simulated`: asks a model to prepare an evidence-linked execution plan and rubric estimate. It stores only `partial` or `error`, caps confidence at `0.35`, and cannot produce a pass.
- `browser`: currently returns `browser_executor_unavailable`. This fail-closed behavior is deliberate until an isolated browser runtime exists.

The orchestrator currently marks a campaign `completed` after processing its cells even if cells are partial or errors. Therefore `completed` means processing ended, not that the product passed. Before GA, campaign aggregation must derive distinct terminal states such as `report_ready`, `blocked`, `failed`, and `cancelled`, with an explicit release verdict separate from job completion.

## Repository domains

The codebase contains three historical domains that must not be conflated:

1. **Generic STS control plane and planner** in `app/`, `orchestrator/`, and the core campaign/matrix/persona/run tables.
2. **Protocol onboarding engine** in `framework/onboarding/`, with a fixed multi-step, source-oriented workflow.
3. **AWP-specific chain scanner, auditor, HLO daemon, and verifier** in `framework/`, `scanner/`, and related scripts.

The latter two are adapters and early product proving grounds. They are not evidence that arbitrary web products can be tested end to end. The target architecture keeps protocol adapters behind versioned interfaces while the generic campaign, worker, evidence, and reporting contracts remain product-independent.

## Current data model

### Core entities

| Entity | Purpose | Key security owner |
| --- | --- | --- |
| `campaigns` | Target, docs, scope, authorization, environment, lifecycle, product context, plan version | Customer owns reads/inserts; worker owns lifecycle writes |
| `matrices` | Configuration rows and scenario columns | Read through parent campaign ownership |
| `personas` | Mock-user definitions bound to matrix rows | Read through parent campaign ownership |
| `runs` | One result per row/column cell, including outcome, executor mode, confidence, rubric, and evidence | Read through parent campaign ownership |
| `webhook_events` | Signed-event idempotency ledger with payload hash and processing state | Service role only |
| protocol-specific tables | Onboarding, lifecycle, heartbeat, orchestration, transaction, and verifier evidence | Private unless a deliberately sanitized view exists |

### Evidence contract

A production browser run should persist, at minimum:

- tenant, campaign, scenario, configuration, persona, plan version, and attempt identifiers;
- target environment and immutable worker/executor versions;
- start/end time, duration, region, and terminal state;
- assertion results with expected and observed values;
- ordered action trace with redacted inputs;
- screenshots at meaningful checkpoints;
- DOM/accessibility snapshots or trace references where relevant;
- console, network, performance, and download summaries with sensitive values redacted;
- source and documentation references used to design the scenario;
- failure category, confidence, retry lineage, and reviewer disposition; and
- cryptographic hashes for large artifacts stored outside Postgres.

Large binaries should live in tenant-scoped object storage with short-lived signed URLs. Postgres should contain metadata, hashes, retention deadlines, and access/audit records.

## Target production architecture

### Durable jobs and leases

Replace polling plus optimistic campaign status with a durable work queue or a transactional Postgres queue. A job record should include:

- immutable input and plan version;
- priority, scheduled time, and tenant concurrency class;
- `available`, `leased`, `succeeded`, `failed`, `cancelled`, and `dead_letter` states;
- lease owner and expiration;
- heartbeat and last-progress timestamps;
- attempt count, retry policy, and idempotency key;
- cancellation request and cooperative shutdown status; and
- structured terminal error.

Workers claim jobs atomically with `FOR UPDATE SKIP LOCKED` or equivalent. Expired leases are recoverable. Retries must re-drive incomplete work without duplicating completed evidence or external side effects.

### Browser worker data plane

Every browser attempt should run in a short-lived sandbox with:

- a new browser profile and filesystem;
- CPU, memory, process, disk, and wall-clock limits;
- no cloud metadata, private network, loopback, database, control-plane, or other-tenant access;
- egress restricted to the authorized target and explicitly approved third-party dependencies;
- download, upload, clipboard, popup, protocol-handler, and extension controls;
- vault-issued, campaign-scoped credentials delivered only at execution time;
- automatic secret and personal-data redaction before logs or artifacts leave the sandbox; and
- guaranteed teardown and credential revocation after the attempt.

Browser workers should have no Supabase service-role credential. They receive narrow, expiring job tokens and upload evidence through scoped endpoints or pre-signed object URLs.

### Control-plane services

Separate responsibilities behind explicit contracts:

- **Intake service:** authorization, target validation, scope, quota, and policy checks.
- **Discovery service:** documentation crawling, route/workflow inference, and source inventory.
- **Planner:** coverage model, scenarios, configurations, personas, assertions, and plan review.
- **Scheduler:** budgets, queueing, leases, cancellation, retries, and concurrency.
- **Browser workers:** execution and raw evidence capture only.
- **Evaluator:** deterministic assertions first; model-assisted qualitative scoring second.
- **Verifier:** independently checks evidence completeness, claim support, and flaky/retry behavior.
- **Reporter:** produces customer-readable rubrics with links to redacted evidence.

## State and event semantics

Webhook delivery is at least once. Events therefore require:

- a unique event ID;
- schema version and event type;
- campaign or job identity;
- timestamp with a short acceptance window;
- signature over timestamp plus exact body;
- durable payload hash and processing state; and
- monotonic or compare-and-set state transitions.

Only a fully processed ledger entry may short-circuit a retry. A prior partial or failed entry must be safely re-driven. Conflicting payloads for the same event ID are rejected and alerted.

## Tenant and environment boundaries

The production model should introduce an `organizations` boundary rather than using only `user_id`. Membership, role, entitlement, campaign ownership, artifact keys, audit logs, rate limits, and billing must all be organization-scoped. Queries should carry an explicit organization ID and be enforced again with database policies.

Production, staging, preview, and local environments need separate Supabase projects, secrets, worker pools, object-storage prefixes, OAuth applications, webhook secrets, and target allowlists. Production test campaigns require stronger approval and destructive-action policy than staging.

## Observability

Metrics should cover queue age, lease expiry, time to first evidence, run duration, browser crash rate, infrastructure error rate, target error rate, retries, flaky scenarios, cost per campaign, model-token usage, artifact volume, redaction failures, and report verification failures. Logs and traces must use campaign/job IDs without including secrets, complete URLs with sensitive query strings, raw form values, or unredacted page content.

Alerts need an owner and runbook. At minimum: queue stall, signature failures, repeated lease expiry, cross-tenant authorization denial spikes, unusual egress, secret-scan failures, artifact upload failures, verifier disagreement, and budget exhaustion.

## Key architectural decisions still required

- Browser isolation platform and its egress enforcement model.
- Queue technology and transactional relationship between jobs and evidence.
- Organization/membership schema and billing boundary.
- Credential vault and test-account lifecycle.
- Documentation crawl limits, robots/authorization policy, and source versioning.
- Artifact storage, redaction, encryption, retention, legal hold, and deletion design.
- Deterministic assertion DSL and evaluator/verifier separation.
- Supported Next.js/Node upgrade path and production runtime policy.
- Public API contract, SDK, CI integration, and webhook versioning.
