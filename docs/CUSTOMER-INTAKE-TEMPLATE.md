# Customer Test Intake Template

Use this template to define an authorized, safe, and useful STS campaign. Complete it before billable browser execution. The current product can ingest a target URL, documentation URL, environment, and scope; the fuller fields below define the intended production intake and plan-review workflow.

> Do not paste passwords, API keys, cookies, recovery codes, payment data, personal data, production secrets, or private connection strings into this document or a campaign description. Test credentials must be supplied through the approved vault workflow when that capability is available.

## 1. Request and authorization

**Organization:**

**Request owner and contact:**

**Technical contact during the run:**

**Target owner:**

**Product name:**

**Primary product URL:**

**Authorized domains/origins:**

**Documentation URL(s):**

**Environment:** staging / preview / production

**Desired test window and time zone:**

**Authorization basis:** I own/control this target, or I have written permission from the owner.

**Evidence of authorization or domain verification reference:**

**Explicitly prohibited paths, origins, tenants, accounts, regions, or actions:**

**Emergency stop contact and procedure:**

- [ ] I confirm that the organization is authorized to test the listed target and actions.
- [ ] I confirm that listed third-party systems are included in the authorization or excluded from execution.
- [ ] I understand that production testing requires additional review and tighter side-effect controls.

## 2. Campaign objective

**Release, feature, or decision this campaign supports:**

**Primary question:**

**Top workflows that must work:**

1.
2.
3.

**Known risks or recent changes:**

**Definition of acceptable result:**

**Out of scope:**

**Required report/export format and audience:**

## 3. Product and documentation sources

Provide stable, authorized sources where possible:

- Product/help center:
- Getting started/onboarding:
- Role and permission model:
- Plan/entitlement matrix:
- Settings/configuration reference:
- API documentation or schema:
- Error and recovery guidance:
- Accessibility statement/support policy:
- Security/privacy/data-handling documentation:
- Supported browsers/devices/locales:
- Changelog/release notes for the tested version:
- Existing test cases or acceptance criteria:

**Tested product version, commit, build, or deployment ID:**

**Documentation version/date:**

**Known documentation gaps or contradictions:**

**Pages/files STS may not crawl or retain:**

## 4. Users, roles, plans, and permissions

List every relevant actor. Add rows as needed.

| Actor/role | Plan/tier | Organization state | Key permissions | Important restrictions | Test account vault reference |
| --- | --- | --- | --- | --- | --- |
| New user | | | | | |
| Standard member | | | | | |
| Administrator/owner | | | | | |
| Read-only/guest | | | | | |

**Invitation and membership lifecycle:**

**Role changes or approval workflows:**

**Cross-organization/tenant isolation expectations:**

**MFA, SSO, OAuth, magic link, password, passkey, or recovery behavior:**

**Session expiry, device, and concurrency expectations:**

## 5. Configuration factors

List relevant values and constraints. STS will use risk-based and pairwise coverage unless a factor requires exhaustive testing.

| Factor | Values to test | Default | Interactions/constraints | Risk if wrong | Coverage requirement |
| --- | --- | --- | --- | --- | --- |
| Role | | | | | |
| Plan/entitlement | | | | | |
| Feature flag | | | | | |
| Account/data state | | | | | |
| Browser | | | | | |
| Device/viewport | | | | | |
| Locale/time zone | | | | | |
| Network condition | | | | | |
| Integration state | | | | | |

**Forbidden or impossible combinations:**

**Critical combinations that must be exhaustive:**

**Acceptable sampled/pairwise factors:**

## 6. Workflow specification

Repeat this section for each important workflow.

### Workflow: [name]

**Business/user goal:**

**Applicable roles/configurations:**

**Entry point:**

**Preconditions and fixtures:**

**Expected path:**

1.
2.
3.

**Observable success criteria:**

-
-

**Expected persistence or downstream effect:**

**Validation and boundary cases:**

**Permission/entitlement boundaries:**

**Failure, timeout, interruption, and recovery behavior:**

**Cancellation, undo, or cleanup behavior:**

**Accessibility expectations:**

**Performance target:**

**Trust/privacy/safety expectations:**

**Source requirement or documentation link:**

**Allowed side effects:**

**Prohibited side effects:**

## 7. Test data and fixtures

**Fixture owner:**

**Fixture creation/reset method:**

**Data states required (empty, new, populated, limit reached, expired, suspended, etc.):**

**Approved synthetic data:**

**Data that must never be used:**

**Upload fixture types and size limits:**

**Download expectations and quarantine requirements:**

**Disposable email/SMS/OTP behavior:**

**Webhook or integration test endpoints:**

**Payment sandbox and maximum authorized amount:**

**Cleanup verification:**

- [ ] Fixtures are synthetic or expressly approved.
- [ ] No real customer/patient/cardholder/employee data is required.
- [ ] Test accounts cannot access unrelated production data.
- [ ] Reset and cleanup can be performed safely and repeatedly.

## 8. High-impact action policy

Mark every action STS may encounter.

| Action class | Allowed? | Environment | Limit | Approval required? | Verification/cleanup |
| --- | --- | --- | --- | --- | --- |
| Create records/content | | | | | |
| Modify settings/profile | | | | | |
| Invite or message users | | | | | |
| Change roles/permissions | | | | | |
| Publish externally | | | | | |
| Delete/archive data | | | | | |
| Submit payment/refund | | | | | |
| Trigger webhook/email/SMS | | | | | |
| Download/upload files | | | | | |
| Access admin/security areas | | | | | |

Any unlisted destructive, financial, permission-changing, messaging, or publication action defaults to **not allowed**.

**Human approver for gated actions:**

**Maximum total records/messages/transactions:**

**Maximum spend:**

**Recipients/domains that are allowed:**

**Stop conditions:**

## 9. Dependencies and degraded states

| Dependency | Purpose | Authorized origin | Test/sandbox mode | Expected degraded behavior | Owner/contact |
| --- | --- | --- | --- | --- | --- |
| Identity provider | | | | | |
| Payment provider | | | | | |
| Email/SMS | | | | | |
| File/object storage | | | | | |
| Analytics/support | | | | | |
| Other integration | | | | | |

**Maintenance windows or rate limits:**

**Mock/stub options:**

**Third parties explicitly excluded:**

## 10. Accessibility, compatibility, and performance

**Supported browsers and minimum versions:**

**Required desktop/mobile/tablet viewports:**

**Keyboard-only and screen-reader targets:**

**Zoom/reflow target:**

**Color contrast/reduced motion expectations:**

**Supported locales, scripts, date/number formats, and time zones:**

**Slow/offline/network profiles:**

**Page/task performance targets and measurement conditions:**

**Maximum acceptable task completion time:**

## 11. Privacy, logging, artifacts, and retention

**Data classification of the target and fixtures:**

**Sensitive fields/selectors/areas to mask:**

**Pages/actions where screenshots are prohibited:**

**Console/network/DOM capture restrictions:**

**Approved storage region:**

**Raw artifact retention:**

**Report retention:**

**Deletion deadline or event:**

**People/roles allowed to view raw artifacts:**

**Export or legal-hold requirements:**

- [ ] No secrets should appear in prompts, screenshots, traces, logs, or reports.
- [ ] Personal data is unnecessary or explicitly approved and minimized.
- [ ] Retention and deletion requirements are documented.

## 12. Campaign budgets and scheduling

**Maximum scenarios/cells:**

**Maximum attempts per cell:**

**Maximum concurrent browsers:**

**Maximum campaign runtime:**

**Maximum total cost:**

**Artifact size limit:**

**Retry policy:**

**Schedule/blackout window:**

**Behavior when a budget is reached:** stop / request approval / other

## 13. Results and triage

**Release-blocking severity threshold:**

**People who receive the report:**

**Issue tracker/project and required fields:**

**Evidence that may be shared externally:**

**Who decides expected-vs-actual ambiguity:**

**Rerun policy after a fix:**

**Baseline/comparison campaign:**

**Required sign-off:**

## 14. STS plan-review checklist

STS and the customer should confirm before execution:

- [ ] Target ownership/authorization and allowed origins are documented.
- [ ] Staging is used unless production is necessary and separately approved.
- [ ] Product version and source documentation are identifiable.
- [ ] Critical workflows, roles, plans, states, and boundaries are included.
- [ ] Proposed scenarios have observable success criteria and source traceability.
- [ ] Inferred behavior and documentation gaps are visible for review.
- [ ] Configuration constraints and pairwise/exhaustive choices are approved.
- [ ] Test accounts and fixtures are available through approved mechanisms.
- [ ] High-impact actions, limits, approvals, stop conditions, and cleanup are explicit.
- [ ] Dependencies and excluded third parties are known.
- [ ] Accessibility, compatibility, locale, network, and performance targets are defined.
- [ ] Sensitive data, artifact capture, viewers, retention, and deletion are accepted.
- [ ] Time, concurrency, retry, artifact, token, and dollar budgets are accepted.
- [ ] Emergency stop and escalation contacts are reachable.

## Safe defaults when information is missing

Unless the approved campaign says otherwise, STS should:

- use staging, not production;
- deny destructive, financial, permission-changing, publication, messaging, and invitation actions;
- avoid real personal data and production customer records;
- use synthetic fixtures and read-only exploration;
- restrict network access to the submitted target origin and necessary reviewed dependencies;
- capture the minimum evidence needed and apply short retention;
- stop rather than improvise when credentials, authorization, expected behavior, or cleanup is unclear; and
- report missing information as a planning/scope gap, never invent it or claim a pass.
