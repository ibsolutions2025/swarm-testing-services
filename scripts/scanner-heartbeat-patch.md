# sts-scanner.mjs heartbeat patch

Scanner source lives on the VPS at `/root/sts-scanner/sts-scanner.mjs` —
**not** in this repo. This doc is the one-line diff Cowork needs to apply
there. Do not edit the scanner from Windows.

## Goal

After every scanner cycle, emit one row to `system_heartbeats` so the
Operations tab's `sts-scanner` card lights up.

## Where to insert

At the **end of the main loop**, after the final upsert batch has
completed and before the cycle's `console.log(...DONE...)` / `process.exit`
call. The patch runs once per cycle (every 15 min) regardless of whether
any rows were touched — idle cycles are useful liveness signal.

## Snippet (matches the shape used by `swarm-drain.mjs` and `swarm-create.mjs`)

```js
// ============================================================
// Heartbeat
// ============================================================
try {
  const rowsTouched = upsertedCount;      // number of rows touched this cycle
  const rowsSkipped = skippedCount;       // number of rows unchanged / skipped
  const durationMs  = Date.now() - startedAt;

  const supabaseUrl = process.env.STS_SUPABASE_URL
    || 'https://ldxcenmhazelrnrlxuwq.supabase.co';
  const supabaseKey = process.env.STS_SUPABASE_KEY;   // service-role key
  if (!supabaseKey) throw new Error('STS_SUPABASE_KEY not set');

  const resp = await fetch(`${supabaseUrl}/rest/v1/system_heartbeats`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': supabaseKey,
      'Authorization': `Bearer ${supabaseKey}`,
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify({
      project_id:    'awp',
      component:     'sts-scanner',
      outcome:       'ok',
      actions_count: rowsTouched,
      note:          `upserted ${rowsTouched} rows, skipped ${rowsSkipped}`,
      meta:          { duration_ms: durationMs },
    }),
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    console.log(`[scanner] heartbeat POST failed: ${resp.status} ${t.slice(0,200)}`);
  }
} catch (e) {
  console.log(`[scanner] heartbeat error: ${e.message?.slice(0, 200)}`);
}
```

## Variable names to wire up

The scanner likely already tracks per-cycle counters. Bind them to the
snippet's placeholders:

- `upsertedCount` → however many rows the cycle INSERTed or UPDATEd
- `skippedCount`  → rows visited but unchanged (existing == new state)
- `startedAt`     → `Date.now()` captured at the top of the cycle

If the scanner doesn't separately track these today, the simplest bind
is: count the length of its "results-to-upsert" array for `upsertedCount`
and zero for `skippedCount`. The Operations tab only uses
`actions_count` for the card headline; granularity is nice-to-have, not
load-bearing.

## Env

`STS_SUPABASE_KEY` — service-role key for `ldxcenmhazelrnrlxuwq`. Already
in `/root/.awp-env` alongside `OPENROUTER_API_KEY` and the other swarm
secrets. No new env needed.

## Verification

After scp + pm2 restart, the next cycle should show:

```
[scanner] heartbeat ok actions_count=N
```

(if you also add a success `console.log`), and within ~15 min the
Operations tab's `sts-scanner` card flips from **"No heartbeat yet"**
(amber dot) to **green dot / N rows**.
