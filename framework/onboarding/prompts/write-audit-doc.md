You are writing the AUDIT-AND-DESIGN.md document for an on-chain protocol that just completed onboarding to the Swarm Testing Services (STS).

This document has two roles:
  1. An AUDIT of the protocol's docs / contracts / MCP server (what's in good shape, what has gaps)
  2. The CUSTOM STS DESIGN tailored to this protocol (matrix axes, scenarios, agent config)

Use the ONBOARDING_REPORT data below — it captures every signal the engine collected during this run.

Output Markdown ONLY (no fences, no JSON wrapper). Structure:

# <Protocol Name> — Client Audit & Custom STS Design

(short preamble: 2-3 lines naming the protocol, its slug, the network, the contract version)

## Section 1 — Client Audit

### 1.1 Contracts inventory
Table: contract name | address | role | abi source

### 1.2 Website + docs
Sub-section per docs page evaluated, with clarity rating + 1-line summary. Include the engine's docs findings.

### 1.3 MCP server
Name, version, npm install command, tool list, coverage notes. Include engine's MCP findings.

### 1.4 .well-known + manifests
Note schema_version, list of fields the manifest exposed (or didn't), anything missing.

### 1.5 Findings backlog
Table: # | category | severity | description | status

Include EVERY finding the engine surfaced:
  - From step 04 (fetch-abis): unverified contract ABIs
  - From step 05 (crawl-docs): docs gaps
  - From step 06 (audit-mcp): MCP gaps
  - From step 07 (generate-rules): rules with low confidence (if any flagged)
  - From step 09 (derive-matrix): unusual axis constraints
  - From step 10 (derive-scenarios): aspirational scenarios that need product work to become classifiable

## Section 2 — STS Custom Design

### 2.1 HLO configuration
Matrix size (configs × scenarios), decision priority, eligibility checks (derive from rules.ts).

### 2.2 Agent configuration
Notes on what agents need (wallet only, since engine is protocol-agnostic).

### 2.3 Scanner configuration
Events watched (from events.ts), block chunk size, cron cadence.

### 2.4 Auditor configuration
Failure categories, cadence.

### 2.5 Custom tooling
List of files emitted by the engine: lib/<slug>/{contracts,rules,matrix,scenarios,events,cell-defs,state-machine,index}.ts

## Section 3 — Living Findings Backlog
(Auto-appended by the running auditor. Empty on first emit.)

Be specific and quantitative. Use numbers from the report (rule count, scenario count, ABI entry count). Don't editorialize beyond what the data shows.

ONBOARDING_REPORT follows below.
