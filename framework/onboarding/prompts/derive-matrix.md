You are deriving a test-coverage matrix for a smart-contract protocol.

Given the JSON ABI of the protocol's primary "create" function (the one that produces the central asset of the protocol — a job, a campaign, an order, etc.), enumerate the configuration AXES the function exposes.

An AXIS is an INDEPENDENT input parameter that meaningfully changes contract behavior. The bar is:
  - it's a parameter the caller supplies at action time
  - the contract treats different values differently (different code paths, different events, different terminal states)
  - **its value is NOT computable from another candidate axis** (i.e., it's not derived)

DERIVED PROPERTIES are NOT axes — drop them. Examples:
  - `allowResubmission: bool` — if it's documented or tested as "true when subMode==multi", drop it.
  - A boolean that's always true when another axis equals X — drop it (it's a derived consequence).
  - A flag mentioned in a comment as "auto-set based on Y" — drop it.

Audit each candidate axis: can its value be predicted from other candidate axes via a deterministic rule? If yes, it's NOT an axis — it's a derived property. Only the RULE survives (in axis_constraints), not the parameter.

# Axis collapse — fold parameters that gate the SAME concept

Multiple parameters can each be DIFFERENT WAYS of gating the same concept. They must be FOLDED into a single axis with more values, not enumerated as separate axes.

Heuristic: if two candidate axes constrain the same role (e.g. who can be a validator) or the same lifecycle decision, and only one is "active" for a given config, they are the SAME axis with multiple values — not two axes.

**AWP example (correct):** `approvedValidators: address[]` and `minValidatorRating: uint16` are both ways to restrict who can claim the validator role. Wrong: enumerate them as `validator-access: [open, approved]` + `validator-rating-gate: [none, low, high]` (this gives 6 cells, most nonsensical because a hard-only job rejects both). Right: ONE axis `validator-access: [open, approved-list, rating-gate]` (3 cells, mutually exclusive by design).

**General rule:** when two candidate axes have an axis_constraint of the form "axisA=X ⇒ axisB=default" or "axisA and axisB cannot both be non-default," they are almost always the same axis. Fold.

**Boolean toggles vs axes — FLAG TEST:** a boolean parameter that adds a single conditional revert (e.g. `requireSecurityAudit: bool`) is a FLAG, not an axis. Flags don't expand the lifecycle space — they enable an extra precondition on one function. Drop flags from the matrix; they belong in rules.ts only.

**Flag test — apply this concretely:** if you can describe a candidate axis as "this single boolean decision determines whether one extra branch in one function fires," it is a FLAG belonging in rules.ts — drop it from the matrix entirely. Examples in AWP:
  - `allowResubmission` — a flag controlling whether `submitWork`'s loop accepts a second submission from the same worker. Belongs in rules, not matrix.
  - `allowRejectAll` — a flag enabling one batch-reject path (`rejectAllSubmissions` reverts when false). Belongs in rules, not matrix.
  - `requireSecurityAudit` — a flag enabling one extra precondition in `approveSubmission`. Belongs in rules, not matrix.
None of these expand the lifecycle space — they each gate a single conditional inside one function. They look like axes because they're boolean inputs to createJob, but they don't multiply meaningful lifecycle paths.

**Target: aim for 4-5 axes for AWP-shaped protocols.** If you have 6 and any of them is a single-bool flag enabling one branch in one function, fold it back into rules.ts.

After collapse, you should have FEWER axes with MORE values per axis. If you end up with 7+ axes, you almost certainly missed a collapse.

Aim for the SMALLEST set of axes that captures all meaningful behavioral variation. A well-designed protocol's matrix is 4-6 axes typically; >6 means you've enumerated flags or unfolded synonyms.

After picking the minimal axis set, axis types are typically:
  - enum-like uint8 / uint256 with a small discrete value set (e.g. `validationMode: 0..2` → labels [soft, hard, hardsift])
  - "mode toggle" parameter pair where one param's value affects another (e.g. `submissionMode = TIMED` ↔ `submissionWindow > 0`)
  - access-control axis with multiple gating mechanisms folded together (e.g. validator-access: [open, approved-list, rating-gate])

For each axis, output:
  - name: short kebab-case (e.g. "val-mode", "deadline", "sub-mode", "worker-access")
  - description: 1-line about what the axis controls
  - source_param: the createX argument name(s) this axis maps to (may be multiple if folded)
  - values: array of human-readable value labels (e.g. ["soft", "hard", "hardsift"])
  - maps_to: object: each value label → on-chain param value(s) (e.g. {"soft": {"validationMode": 1, "validationScriptCID": ""}, "hard": {"validationMode": 0, "validationScriptCID": "Qm..."}})

After enumerating axes, also enumerate AXIS CONSTRAINTS — combinations the contract REJECTS (e.g. "valMode=hard requires validatorAccess=na"). Source these from comments / require statements in the contract.

**Use axis_constraints as a sanity check on your axis count:** if you have many constraints (>3) and most have the form "axisA=X ⇒ axisB=default", you have NOT collapsed enough — go back and fold.

Output JSON ONLY:
{
  "axes": [
    { "name": "...", "description": "...", "source_param": "...", "values": [...], "maps_to": {...} }
  ],
  "constraints": [
    { "rule": "valMode=hard ⇒ validatorAccess=na", "rationale": "HARD_ONLY rejects validator-axis config (V15 C4)" }
  ],
  "config_key_format": "{val-mode}-{deadline}-{sub-mode}-{worker-access}-{validator-access}",
  "estimated_total_configs": 84
}

Contract function ABI + nearby contract source comments follow.
