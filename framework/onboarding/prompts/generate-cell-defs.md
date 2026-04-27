You are writing scanner predicates for a protocol's lifecycle cells.

Given a list of scenarios + the protocol's event names, write a JavaScript predicate function for each scenario. The predicate takes a context `c` shaped like:
  c.job.status         (number — typically 0/Open, 1/Active, 2/Completed, 3/Cancelled)
  c.submissions        (array of { worker, status, ... })
  c.events             (object mapping event name → array of { blockNumber, logIndex, txHash })
  c.counts.approved / c.counts.rejected / c.counts.pending / c.counts.distinctWorkers
  c.counts.all_rejected (boolean)
  c.configParams.<axis-key>  (config-axis values for the cell being classified)

Predicate must return BOOLEAN. It should match the scenario's terminal pattern from observable on-chain state alone — no off-chain heuristics.

PRIORITY: scenarios with stricter conditions go FIRST. E.g. "rejectAll + then cancel" must check before "rejectAll without cancel" (the second is a superset of the first if you don't enforce ordering).

# CRITICAL — `classifiable` is required per predicate

For EACH predicate you emit, declare a `classifiable: true|false` boolean:

  - `classifiable: true` — the predicate matches the scenario from event logs visible to a standard JSON-RPC scanner. Uses only `c.events`, `c.job.status`, `c.submissions`, `c.counts`, and `c.configParams`. Returns true exactly when the scenario applies, returns false otherwise. SAFE FOR PRODUCTION SCANNING.

  - `classifiable: false` — the predicate cannot be made to work from event logs alone. The scenario requires debug_traceTransaction (internal call traces), trace-only events (e.g. anonymous emits before reverts), reading internal contract state via off-chain calls, or telemetry that the scanner does not have. The body should be a stub like `(c) => false` or `(c) => /* not classifiable from events */ false`. The fact that we EMIT the predicate is for catalog completeness, not for runtime use.

A scenario passed to you with `status: "aspirational"` or `status: "deferred"` MUST get `classifiable: false`. A scenario with `status: "classifiable"` SHOULD get `classifiable: true` — but if you cannot construct a predicate using only the context fields above, it's actually NOT classifiable; in that case override to `classifiable: false` and explain in `notes`.

# What makes a predicate non-classifiable

Common patterns that force `classifiable: false`:
  - The scenario depends on a revert that the scanner cannot see (failed tx with no event emitted before revert)
  - The scenario requires `debug_traceTransaction` to detect emitted-before-revert events (e.g. `RatingGateFailed` is emitted from inside a function that then reverts — the log is rolled back)
  - The scenario depends on internal mappings the scanner doesn't index (e.g. `pastValidators[jobId][addr]` private state)
  - The scenario depends on off-chain inputs (IPFS content, validator decision rationale, etc.)
  - The scenario requires comparing block timestamps to mined block.timestamp values that the scanner doesn't track

If you find yourself writing logic like "would have reverted with X" or "needs trace-level data", set classifiable to false.

# Output

Output JSON ONLY:
{
  "predicates": {
    "<scenario-id>": {
      "body": "(c) => c.job.status === 2 && c.counts.approved === 1 && ...",
      "classifiable": true,
      "notes": "Optional — required when classifiable=false"
    },
    ...
  },
  "priority": ["<scenario-id-most-specific>", ..., "<scenario-id-least-specific>"]
}

The priority array MUST contain only `classifiable: true` IDs (the scanner only walks classifiable predicates). Aspirational/deferred predicates are catalog stubs.

Scenarios + event names + axis names follow.
