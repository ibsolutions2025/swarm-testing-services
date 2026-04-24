# Archive — STS build spike April 22-24, 2026

This directory preserves the spec files, deploy specs, audits, and CC
prompts generated during the two-day build of Swarm Testing Services
(STS) out of the AWP monorepo. They shipped Phases 2 through 6 —
Personas, Transactions, Operations, re-agented swarm, and the
orchestration stream.

Everything here is a paper trail, not active documentation. For the
current state of STS, start with:

  - ../../STATUS.md         — running status of infra + outstanding work
  - ../../SWARM-TESTING-PRODUCT-SPEC.md
  - ../../SWARM-TESTING-SPLIT-PLAN.md
  - ../../scripts/          — live VPS scripts (swarm-drain, swarm-create, swarm-agent-runner)

Commits that delivered each phase —
  Phase 2   — 41bfbc8  (Personas tab)
  Phase 2.5 — 48894e2  (persona enrichment)
  Phase 3   — 1c0f884  (Transactions tab)
  Phase 4   — 481f9eb  (Operations tab + heartbeats)
  Phase 5   — 751fa53  (re-agent swarm via OpenRouter)
  Phase 5.1 — 160294a  (nonce fix + error-slice bump)
  Phase 6   — d03b72e  (orchestration stream UI)
  Phase 6   — a1558a8  (orchestration event emissions in drain+create)
  Phase 6.1 — 325f732  (validationInstructions fix — createJob no longer reverts)
