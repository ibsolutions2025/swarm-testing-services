# Phase 6 VPS emitter patch (Cash task)

Migration 0004 applied. Code shipped by CC in commit d03b72e. Now patch `swarm-drain.mjs` + `swarm-create.mjs` on VPS to emit `orchestration_events` rows so the Operations Stream actually populates.

## What the Operations tab expects

Rows flow via `POST https://ldxcenmhazelrnrlxuwq.supabase.co/rest/v1/orchestration_events` with `apikey` + `Authorization: Bearer` headers (STS_SUPABASE_KEY). Body shape:

```
{
  project_id:  'awp',
  cycle_id:    <string; all rows from one cron run share this>,
  source:      'swarm-drain' | 'swarm-create',
  event_type:  'scan' | 'decision' | 'dispatch' | 'skip' | 'error',
  persona:     'Spark' | 'Grind' | 'Judge' | 'Chaos' | 'Scout' | 'Flash' | 'Bridge' | null,
  job_id:      <integer or null>,
  directive:   'plain-English instruction given to the agent (dispatch only)',
  reasoning:   'one-line rationale',
  tx_hash:     '0x... (if known at emission)',
  meta:        { any extras }
}
```

## Step 1 — add an `emitOrchestrationEvent` helper to both scripts

Pattern (fire-and-forget, non-blocking — never let event emission fail the cron):

```js
async function emitOrchestrationEvent(fields) {
  const url = (process.env.STS_SUPABASE_URL || 'https://ldxcenmhazelrnrlxuwq.supabase.co')
    + '/rest/v1/orchestration_events';
  const key = process.env.STS_SUPABASE_KEY;
  if (!key) return;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': key,
        'Authorization': `Bearer ${key}`,
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({
        project_id: 'awp',
        cycle_id: CYCLE_ID,   // set once at top of main — 'drain-<ISO>' or 'create-<ISO>'
        source: COMPONENT,    // 'swarm-drain' or 'swarm-create'
        ...fields,
      }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      console.log(`[orch-emit] failed ${res.status}: ${t.slice(0,200)}`);
    }
  } catch (e) {
    console.log(`[orch-emit] error: ${e.message?.slice(0,200)}`);
  }
}
```

Put it near `emitHeartbeat` (already exists from Phase 5 deploy).

Add two module-level constants near the top:
```js
const CYCLE_ID  = `<component>-${new Date().toISOString()}`;  // component name hard-coded per file
const COMPONENT = '<component>';                                // 'swarm-drain' or 'swarm-create'
```

## Step 2 — insert emissions at these decision points in `swarm-drain.mjs`

### A. Start of main loop — scan row

Right after the initial `await getJobCount(...)` / scan-window calc, before the progressJob loop:

```js
await emitOrchestrationEvent({
  event_type: 'scan',
  reasoning: `scanned last ${SCAN_WINDOW} jobs`,
  meta: { total_on_chain: totalJobs, scan_low: lowJob, scan_high: highJob - 1 },
});
```

### B. In `progressJob()` — before each action the drain takes

Add a dispatch emission immediately BEFORE each `writeTx()` call. Include the persona name + the action kind + the intended directive. Example for the CLAIM branch:

```js
// Before claimJobAsValidator writeTx
await emitOrchestrationEvent({
  event_type: 'dispatch',
  persona: agent.name,
  job_id: job.id,
  directive: `Claim this job as validator — you'll be responsible for deciding if submitted work meets the spec`,
  reasoning: `eligible validator (no activeValidator set, persona not poster)`,
});
```

Similarly for SUBMIT, APPROVE, REJECT, REJECT-ALL, CANCEL, FINALIZE. Each gets a persona, a directive that would naturally describe what a human operator would tell that agent, and a short reasoning.

After the successful `writeTx` returns, emit a second update on the same dispatch with tx_hash — BUT that requires keeping references. Simpler path: emit the dispatch with tx_hash set to empty string BEFORE the tx, and emit a NEW orchestration row with event_type='dispatch' and the tx_hash AFTER the tx lands. That way the merge util dedupes on tx_hash and shows the directive + the on-chain outcome on one row.

Actually simpler: emit ONE dispatch row AFTER the writeTx returns successfully, with tx_hash set. If the writeTx fails, emit event_type='error' instead. The UI merge logic keys on tx_hash + cycle_id so this works.

Pseudocode for the write-and-emit pattern:

```js
try {
  const r = await writeTx(agent, 'claimJobAsValidator', [BigInt(jobId)], 400_000n);
  await emitOrchestrationEvent({
    event_type: 'dispatch',
    persona: agent.name,
    job_id: job.id,
    directive: 'Claim this job as validator...',
    reasoning: 'eligible validator',
    tx_hash: r.hash,
    meta: { action: 'claim', receipt_status: r.status, block: Number(r.blockNumber) },
  });
} catch (e) {
  await emitOrchestrationEvent({
    event_type: 'error',
    persona: agent.name,
    job_id: job.id,
    reasoning: `claim failed: ${e.shortMessage || e.message?.slice(0,120)}`,
    meta: { action: 'claim', error: String(e.shortMessage || e.message).slice(0, 500) },
  });
}
```

Emit at these sites in swarm-drain.mjs (roughly):
- CLAIM branch (line ~332)
- SUBMIT branch (line ~351)
- SECOND-SUBMIT branch (line ~372)
- APPROVE branch (inside the validator-decision if block)
- REJECT branch
- REJECT-ALL branch
- CANCEL branch (inside s10 follow-up)
- FINALIZE branch (timed jobs)
- REVIEW submission (both approve and reject comment paths — these become dispatch rows tied to ReviewGate tx)

### C. At SKIP points — emit skip rows

Currently the drain logs `SKIP-SUBMIT (s08 intent)`. Add an orchestration row there:

```js
await emitOrchestrationEvent({
  event_type: 'skip',
  persona: agent.name || null,
  job_id: job.id,
  reasoning: `intentionally skipping submit (scenario annotation = ${scenario})`,
});
```

### D. End of run — keep the existing heartbeat, unchanged

No orchestration row at end — the heartbeat already covers liveness.

## Step 3 — insert emissions in `swarm-create.mjs`

### A. At start — scan row

After reading target-gaps / scenario priority:
```js
await emitOrchestrationEvent({
  event_type: 'scan',
  reasoning: `selecting next job to post: scenario=${targetScenario}, config=${targetConfig}`,
  meta: { target_scenario: targetScenario, target_config: targetConfig, poster: poster.name },
});
```

### B. Before createJob — dispatch row

```js
await emitOrchestrationEvent({
  event_type: 'dispatch',
  persona: poster.name,
  directive: `Post a new job with these constraints: ${constraints.join(' / ')}. Reward: 5 USDC.`,
  reasoning: `round-robin poster + matrix-gap target`,
  meta: { constraints, target_config: targetConfig },
});
```

### C. After createJob succeeds — emit dispatch row WITH tx_hash + job_id

```js
await emitOrchestrationEvent({
  event_type: 'dispatch',
  persona: poster.name,
  job_id: createdJobId,
  directive: `Posted job #${createdJobId}: "${tpl.title}"`,
  reasoning: `create tx landed`,
  tx_hash: hash,
  meta: { agent_fell_back: agentOut.fell_back === true },
});
```

### D. On failure — error row

## Step 4 — deploy + verify

```
ssh root@45.32.82.83 "cd /root/test-swarm; mkdir -p .bak && cp swarm-drain.mjs swarm-create.mjs .bak/"
```

scp the patched files back. Then trigger a manual drain:
```
ssh root@45.32.82.83 "cd /root/test-swarm; source /root/.awp-env; timeout 240 node swarm-drain.mjs 2>&1 | tail -120"
```

Expect `[orch-emit]` debug lines only on errors (fire-and-forget succeeds silently).

Verify rows landed:
```
ssh root@45.32.82.83 "source /root/.awp-env; curl -sS \"$STS_SUPABASE_URL/rest/v1/orchestration_events?project_id=eq.awp&select=source,event_type,persona,job_id,directive&order=ran_at.desc&limit=15\" -H \"apikey: $STS_SUPABASE_KEY\" -H \"Authorization: Bearer $STS_SUPABASE_KEY\""
```

Expect a mix of `scan` / `dispatch` / `error` rows with real persona + job_id + directive values.

## Report back

1. Helper added to both scripts (y/n)
2. Emission points added (list: claim, submit, approve, reject, reject-all, cancel, finalize, skip, error)
3. Manual drain smoke-test — any orchestration rows visible in Supabase (paste count + top 5)
4. Any issues

## Do NOT

- Modify sts-scanner.mjs (separate follow-up — scanner can emit scan rows later if useful)
- Change mechanical orchestration logic (just add emissions, no behavior changes)
- Remove the Phase 5 heartbeat emission (it stays)
- Wrap writeTx calls in extra retry logic — emit what happens, good or bad
