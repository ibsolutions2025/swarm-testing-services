# Test Rubric and Evidence Standard

## Purpose

This standard defines how STS turns product documentation and authorized scope into test coverage, how mock-user runs are evaluated, and what evidence is required before a result can be called a pass or fail.

The core rule is simple:

> A model-generated plan or opinion is not an observed product result. A pass requires a live browser executor, completed deterministic assertions, and sufficient evidence for independent verification.

The current simulated dispatcher produces planning estimates only. It must store `partial` or `error`, use `executor_mode=simulated`, and cap confidence at `0.35`.

## Coverage model

Each campaign forms a bounded matrix:

- **Configuration row:** a representative combination of role, plan, feature flags, account/data state, device/viewport, browser, locale/time zone, connectivity, permissions, and other relevant settings.
- **Scenario column:** a concrete workflow or failure mode with preconditions, ordered task intent, observable success criteria, risk, category, and source references.
- **Cell:** one persona executing one scenario under one configuration.

### Required scenario categories

Include categories when relevant to the product:

1. Primary happy paths and first-value/onboarding.
2. Authentication, session lifecycle, password recovery, and MFA.
3. Roles, permissions, organization boundaries, plans, entitlements, and feature flags.
4. Validation, empty states, limits, malformed input, and duplicate submission.
5. Timeouts, offline/slow network, retry, refresh, interruption, cancellation, and recovery.
6. Destructive actions, billing, publication, invitations, messaging, and other side effects.
7. Accessibility, keyboard-only use, focus, semantics, contrast, zoom, reduced motion, and screen-reader cues.
8. Responsive layout, supported browsers, locale, time zone, date/number formatting, and long text.
9. Privacy, trust, consent, security boundaries, and sensitive-data handling.
10. Integrations, uploads/downloads, email/OTP, webhooks, and third-party degradation.
11. Edge cases inferred from product state, documentation gaps, or contradictory expectations.

### Combination strategy

Do not generate the full Cartesian product by default.

- Test critical authorization, payment, deletion, data-boundary, and first-value paths across every applicable role and boundary value.
- Use pairwise or higher-strength covering arrays for lower-risk independent settings.
- Add hand-selected combinations where variables interact semantically.
- Exclude impossible or unsafe combinations with a documented constraint and rationale.
- Report the combinations not tested; never imply exhaustive coverage when sampling was used.

The planner must preserve requirement-to-scenario traceability and mark inferred features/scenarios distinctly from documented ones.

## Scenario record

Every approved scenario should contain:

- stable `scenario_id` and `workflow_id`;
- title, category, risk, and priority;
- source requirement/document URL and source snapshot hash;
- whether the behavior is documented, customer-specified, or inferred;
- applicable configuration constraints;
- test persona and intent;
- setup and preconditions;
- test account/fixture references, never raw credentials;
- ordered actions or exploration boundaries;
- deterministic assertions and qualitative observation prompts;
- allowed origins and approved side-effect classes;
- cleanup/reset requirements;
- evidence requirements;
- timeout/retry/flakiness policy; and
- plan, prompt, model, assertion, and executor versions.

Success criteria must be observable. “Works correctly,” “looks good,” or “the user is happy” is insufficient without concrete expected state, content, navigation, response, accessibility, or persistence behavior.

## Outcome semantics

| Outcome | Meaning | Minimum requirement |
| --- | --- | --- |
| `planned` | Scenario/configuration exists but has not executed | Approved plan record only; no product verdict |
| `running` | A worker owns a valid lease and is actively executing | Lease, attempt, and heartbeat |
| `pass` | All required assertions were executed and met | `executor_mode=browser`, complete evidence, no blocking policy/infrastructure failure, verifier accepted |
| `fail` | Live evidence shows one or more required assertions were not met | `executor_mode=browser`, failing assertion and reproduction evidence, verifier accepted |
| `partial` | Some useful work/evidence exists, but execution or required assertions are incomplete | Explicit missing steps/assertions and no pass claim |
| `blocked` | The scenario could not proceed because of auth, environment, approval, fixture, policy, or product precondition | Blocker classification and evidence; no product verdict |
| `error` | STS infrastructure, planner, model, worker, parsing, or artifact pipeline failed | Error classification and retry disposition; never a product failure or pass |
| `cancelled` | Customer or system cancellation stopped execution | Cancellation actor/reason and cleanup status |
| `not_applicable` | Configuration/scenario is intentionally excluded by a validated constraint | Constraint and approval/rationale |

The current database also contains `skipped`; before GA it should be migrated or mapped explicitly to `blocked`, `cancelled`, or `not_applicable`. Ambiguous skipping is not reportable coverage.

`campaign.completed` currently means its processing loop ended. It does not mean the product passed. The production aggregate must expose job completion and product verdict as separate fields.

## Failure categories

Classify terminal non-pass states so a customer does not receive an infrastructure defect as a product defect:

- `product_functional`
- `product_validation`
- `product_permissions`
- `product_accessibility`
- `product_performance`
- `product_trust_safety`
- `documentation_gap`
- `scope_or_requirement_gap`
- `test_data_or_fixture`
- `credential_or_auth`
- `authorization_or_policy`
- `target_unavailable`
- `planner_or_model`
- `browser_or_worker`
- `network_or_dependency`
- `artifact_or_verifier`
- `budget_or_quota`
- `cancelled`
- `unknown_needs_review`

Product severity and STS execution health are separate dimensions. A critical product failure can occur in a healthy run; a broken worker creates no product verdict.

## Rubric dimensions

Scores use integers from 0 to 4. `0` means unknown/unverified unless live evidence explicitly demonstrates a total failure. Reports must distinguish “not observed” from “observed score zero.”

### Task completion

- **0 - Unknown/not executed:** no reliable live evidence.
- **1 - Cannot complete:** primary goal fails or unsafe workaround is required.
- **2 - Completes with major friction:** serious errors, repeated confusion, or fragile workaround.
- **3 - Completes with minor friction:** goal succeeds with non-blocking usability issues.
- **4 - Clear and robust:** goal succeeds directly and repeatably; state is confirmed.

### Clarity

- **0 - Unknown/not observed.**
- **1 - Misleading:** labels/state/instructions cause wrong action or dangerous misunderstanding.
- **2 - Ambiguous:** user needs trial and error or external help.
- **3 - Understandable:** small terminology or hierarchy issues do not block progress.
- **4 - Self-explanatory:** intent, state, consequence, and next action are clear.

### Recoverability

- **0 - Unknown/not exercised.**
- **1 - Data loss or dead end:** no safe recovery.
- **2 - Recovery is fragile:** refresh/repetition/support or lost work is likely.
- **3 - Recoverable:** clear error and practical retry/correction path.
- **4 - Resilient:** preserves work, prevents duplicates, explains state, and safely resumes.

### Accessibility

- **0 - Unknown/not checked.**
- **1 - Blocking barrier:** core task is unavailable to keyboard/screen-reader/zoom use or violates a critical rule.
- **2 - Major barrier:** task is possible only with substantial difficulty.
- **3 - Minor issues:** core task is operable; some semantics, focus, contrast, or announcement defects remain.
- **4 - Strong:** automated and manual checks show the task is perceivable, operable, understandable, and robust for the tested modes.

An automated scan alone cannot earn a 4.

### Trust and safety

- **0 - Unknown/not exercised.**
- **1 - Unsafe/deceptive:** unexpected side effect, privilege/data exposure, missing consent, or misleading claim.
- **2 - Material concern:** consequence, privacy, authorization, or destructive behavior is poorly controlled.
- **3 - Adequate guardrails:** consequence is clear and action is authorized/reversible with minor gaps.
- **4 - Strong guardrails:** least privilege, confirmation proportional to risk, safe defaults, auditability, and recovery.

### Performance

- **0 - Unknown/not measured.**
- **1 - Unusable:** timeout, crash, severe stall, or repeated input loss.
- **2 - Slow/unstable:** completion is possible but delays or layout shifts materially impede the task.
- **3 - Acceptable:** measured task meets the campaign target with minor degradation.
- **4 - Strong:** consistently meets defined latency/responsiveness targets under the tested condition.

Performance scores require timestamps or trace metrics and a stated target, not a persona impression.

## Confidence

Confidence communicates evidence quality, not severity:

- `0.00-0.35`: planning estimate, weak source, or incomplete execution.
- `0.36-0.69`: live observation with incomplete assertions/artifacts or suspected environmental ambiguity.
- `0.70-0.89`: repeatable live result with complete core evidence.
- `0.90-1.00`: deterministic assertions, complete artifacts, stable reproduction, and verifier acceptance; use sparingly.

A high confidence score cannot convert a partial, blocked, or error result into a pass. Model self-confidence cannot raise evidence confidence.

## Evidence standard

### Evidence types

- Source snapshot: product/docs URL, capture time, final URL, content hash, and referenced excerpt metadata.
- Action trace: ordered, timestamped actions with selectors/targets and redacted values.
- Assertion: assertion ID, expected condition, observed value/state, pass/fail, and checkpoint.
- Screenshot: meaningful before/after/failure image with redaction and hash.
- DOM/accessibility: selected snapshot, accessibility tree, focus order, or audit output.
- Network/console: bounded summary for errors, status codes, timing, and dependencies, with sensitive data removed.
- Performance: navigation/task timings, responsiveness/layout metrics, environment, and thresholds.
- State verification: API/database fixture check through a purpose-built, read-only test probe when authorized.
- Cleanup: proof that generated data, sessions, permissions, or external side effects were reset.

### Minimum evidence by outcome

**Pass** requires:

- complete required action trace;
- every required assertion with an observed value and evidence reference;
- at least one artifact showing the terminal user-visible state when visual behavior matters;
- no unresolved browser, artifact, policy, credential, or infrastructure error;
- worker/executor, browser, plan, source, and attempt versions;
- successful cleanup or an explicit non-mutating scenario; and
- independent verifier acceptance.

**Fail** requires:

- the failed assertion and expected/observed difference;
- the shortest reliable reproduction trace;
- artifact at or immediately around failure;
- environment/configuration/persona and attempt identity;
- confirmation that STS infrastructure did not cause the observation; and
- verifier acceptance or a clearly labeled “needs review” state.

**Partial/blocked/error** requires the completed steps, missing requirement, category, retryability, and available evidence. It may not inherit a pass from a previous attempt unless that evidence is explicitly version-compatible and independently linked.

## Independent verification

The verifier should run separately from the browser worker and evaluator. It checks:

- artifact hashes and attempt identity;
- required assertion and evidence completeness;
- that evidence timestamps/order match the action trace;
- that target/environment/source/plan versions match the report;
- that pass/fail semantics match executor mode and terminal state;
- that redaction ran and no canary secrets appear;
- that retries do not mix incompatible attempts;
- that a critical failure is visible in campaign aggregation; and
- that model-written summaries do not exceed the underlying evidence.

Verifier disagreement changes the result to `partial` or `needs_review`; it never silently keeps a pass.

## Severity and prioritization

Severity describes impact under the observed configuration:

- **Critical:** cross-tenant/privilege/data exposure, irreversible destructive action, material unauthorized transaction, or complete loss of the primary service with no safe recovery.
- **High:** primary workflow blocked for an important segment, serious data integrity/privacy/trust problem, or major accessibility barrier.
- **Medium:** meaningful workflow degradation, confusing recovery, recurring error, or accessibility issue with a practical workaround.
- **Low:** localized friction, cosmetic defect with user impact, or minor documentation mismatch.
- **Info:** observation, opportunity, or unverified risk with no demonstrated defect.

Priority additionally considers frequency, affected segments/configurations, workaround, detectability, confidence, business importance, and regression risk. A rubric average must never downgrade or hide a critical/high item.

## Flakiness and retries

- Record every attempt; never overwrite the only evidence.
- Retry infrastructure/transient errors according to a bounded policy.
- Do not auto-retry destructive or externally visible actions without an idempotency guarantee and explicit policy.
- Mark a scenario flaky when identical controlled attempts disagree beyond a defined threshold.
- Report first-failure and retry evidence; do not publish only the successful retry.
- Distinguish target nondeterminism, third-party variation, fixture pollution, timing sensitivity, and worker instability.

## Campaign aggregation

A report must include:

- approved scope, authorization, target environment, source snapshots, and plan version;
- total proposed, approved, executed, passed, failed, partial, blocked, error, cancelled, and not-applicable cells;
- coverage by risk, workflow, role, plan, configuration factor, and scenario category;
- critical/high defects before any aggregate score;
- evidence confidence and verifier status;
- inferred and undocumented behavior;
- excluded combinations and untested scope;
- infrastructure health, retries, and flaky scenarios; and
- cost, duration, artifact retention, and report generation time.

Recommended aggregate verdicts:

- `release_blocked`: at least one accepted critical/high release-blocking defect or a required safety scenario failed.
- `not_ready_for_verdict`: required coverage/evidence is partial, blocked, errored, or unverified.
- `meets_tested_criteria`: all required tested criteria pass and verification is complete, explicitly limited to the tested scope.

Avoid “approved,” “safe,” “secure,” “bug-free,” and “fully tested.” STS reports evidence about a bounded scope at a point in time.

## Plan and report QA gates

Before execution:

- [ ] Every critical workflow and authorization boundary has scenarios.
- [ ] Every scenario has observable success criteria and source traceability.
- [ ] Configuration constraints are valid; excluded combinations have reasons.
- [ ] Inferred behavior is labeled and customer-reviewable.
- [ ] High-impact actions have policy and approval requirements.
- [ ] Required fixtures/accounts exist without raw credentials in the plan.
- [ ] Matrix size, concurrency, time, token, artifact, and dollar budgets are accepted.

Before report publication:

- [ ] No simulated/planning cell is represented as pass/fail.
- [ ] Every pass/fail has live executor identity and complete evidence.
- [ ] The verifier accepted every published verdict or the report labels review status.
- [ ] Critical/high findings appear prominently and are not averaged away.
- [ ] Infrastructure errors are not labeled product failures.
- [ ] Retries/flakiness and incomplete cleanup are disclosed.
- [ ] Screenshots/logs/traces are redacted and tenant-scoped.
- [ ] Totals reconcile across matrix, attempts, evidence, and report.
- [ ] Untested scope, exclusions, assumptions, and retention deadline are visible.
- [ ] A report snapshot is immutable and reproducible from versioned inputs.

## Reference application qualification

Before customer beta, run STS against controlled applications containing seeded defects:

- broken and successful onboarding;
- role/tenant data leakage attempt;
- stale/expired session and account recovery;
- validation, duplicate submission, idempotency, and partial-completion defects;
- slow request, timeout, retry, offline, and recovery behavior;
- keyboard/focus/name/contrast/zoom accessibility defects;
- responsive layout and long/localized content defects;
- unsafe delete/payment/publication flows;
- malicious prompt injection, redirect, download, and network targets; and
- deliberately missing evidence and fabricated model output.

Acceptance requires correct discovery, execution, classification, evidence, verification, reporting, and cleanup, plus zero false passes for the seeded failures.
