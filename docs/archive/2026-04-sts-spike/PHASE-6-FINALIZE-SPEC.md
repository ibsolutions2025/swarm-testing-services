# Phase 6 finalize — ship VPS emitter + verify Operations Stream goes live

Cash started the VPS-side work for Phase 6 (orchestration event emission) but timed out mid-task after patching the local files. The patched scripts already live at `C:\Users\isaia\.openclaw\swarm-testing-services\scripts\swarm-drain.mjs` and `swarm-create.mjs` with `emitOrchestrationEvent()` helper + 10 drain emissions + 4 create emissions. Three things remain: add the missing `scan` event, scp both files to VPS, and verify rows land in Supabase.

## Verification before starting

Confirm the patched scripts are in the expected local state:

```powershell
Select-String -Path C:\Users\isaia\.openclaw\swarm-testing-services\scripts\swarm-drain.mjs -Pattern 'emitOrchestrationEvent' | Measure-Object
Select-String -Path C:\Users\isaia\.openclaw\swarm-testing-services\scripts\swarm-create.mjs -Pattern 'emitOrchestrationEvent' | Measure-Object
```

Expected: `Count: 11` for drain (1 helper def + 10 call sites), `Count: 5` for create (1 helper + 4 call sites). If counts are different, stop and report — something unexpected happened.

## Step 1 — add missing `scan` event to drain

Cash patched 10 emission points in `swarm-drain.mjs` but missed ONE — the `scan` event at the start of the main loop. Add it.

Find this block in `scripts/swarm-drain.mjs` (around line 530 in the main loop):

```js
const totalJobs = Number(await pub.readContract({ address: JOB_NFT, abi: JOB_ABI, functionName: 'jobCount', args: [] }));
const highJob = totalJobs;
const lowJob = Math.max(1, highJob - SCAN_WINDOW);

console.log(`[${RUN_ID}] Scanning jobs ${lowJob}..${highJob - 1} (total on-chain: ${totalJobs})`);
```

Immediately AFTER the `console.log` line above, BEFORE the `for` loop that walks jobs, insert:

```js
await emitOrchestrationEvent({
  event_type: 'scan',
  reasoning: `scanned last ${SCAN_WINDOW} jobs (on-chain count = ${totalJobs})`,
  meta: { total_on_chain: totalJobs, scan_low: lowJob, scan_high: highJob - 1 },
});
```

Run `node --check scripts/swarm-drain.mjs` afterwards to confirm syntax is clean.

## Step 2 — scp both scripts to VPS

```powershell
scp C:\Users\isaia\.openclaw\swarm-testing-services\scripts\swarm-drain.mjs  root@45.32.82.83:/root/test-swarm/
scp C:\Users\isaia\.openclaw\swarm-testing-services\scripts\swarm-create.mjs root@45.32.82.83:/root/test-swarm/
```

(If scp fails with permission errors, Cash has the working SSH config at `C:\Users\isaia\.ssh\cash_vultr`. Use `scp -i C:\Users\isaia\.ssh\cash_vultr -o StrictHostKeyChecking=no ...`.)

Quick sanity check on VPS file size / emission count:

```powershell
ssh root@45.32.82.83 "grep -c emitOrchestrationEvent /root/test-swarm/swarm-drain.mjs /root/test-swarm/swarm-create.mjs"
```

Expect drain=12 (11 pattern matches + 1 for the `scan` event we just added — actually re-count: helper def + 11 call sites = 12), create=5.

## Step 3 — manual drain smoke test

```powershell
ssh root@45.32.82.83 "cd /root/test-swarm; source /root/.awp-env; timeout 240 node swarm-drain.mjs 2>&1 | tail -80"
```

Paste last 80 lines. Expected signals:
- Normal drain progression (`CLAIM`, `SUBMIT`, `APPROVE` log lines)
- NO `[orch-emit]` error lines (fire-and-forget succeeds silently)
- `[agent-runner]` lines if this cycle hits a submit/review

If you see `[orch-emit] failed` lines — that's a real issue; paste them. If silent, the emissions worked.

## Step 4 — verify rows in Supabase

```powershell
ssh root@45.32.82.83 'source /root/.awp-env; curl -sS "$STS_SUPABASE_URL/rest/v1/orchestration_events?project_id=eq.awp&select=source,event_type,persona,job_id,directive,reasoning&order=ran_at.desc&limit=20" -H "apikey: $STS_SUPABASE_KEY" -H "Authorization: Bearer $STS_SUPABASE_KEY"'
```

Expected: at least one `scan` row from swarm-drain, plus `dispatch` rows with persona names (Spark / Judge / etc.), job_id integers, and a directive string like "Claim this job as validator…".

## Step 5 — commit + push the scan-event addition

```powershell
cd C:\Users\isaia\.openclaw\swarm-testing-services
git add scripts/swarm-drain.mjs
git commit -m "feat: swarm-drain emits scan event at start of each cycle (Phase 6 finalize)"
Get-Content C:\Users\isaia\.openclaw\secrets\github.env | ForEach-Object { if ($_ -match '^([A-Z_]+)=(.+)$') { [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process') } }
"protocol=https`nhost=github.com`n`n" | git credential reject 2>$null
git push "https://x-access-token:$env:GITHUB_PAT_RW@github.com/ibsolutions2025/swarm-testing-services.git" HEAD:main
```

## Step 6 — spot-check the live UI

Open https://swarm-testing-services.vercel.app/dashboard/campaigns/d15d0f42-e238-49c1-b911-8b7399675384 and click the Operations tab. The new Orchestration Stream should show your `scan` + `dispatch` + `act` rows within ~30 seconds of polling. No browser action needed; just confirm visually that rows carry persona pills (blue/green) and directive text.

## Report back

1. Pre-check counts (drain/create emission counts match expected)
2. Scan event added (y/n; syntax check clean)
3. scp results (both files on VPS, VPS grep counts match expected)
4. Drain smoke-test output (last 80 lines)
5. Supabase row sample (paste the JSON for top 5 orchestration_events rows)
6. Commit SHA + push result

## Do NOT

- Modify other VPS files (scanner, cron, pm2 state)
- Touch the agents/ persona docs
- Modify the mechanical orchestration logic beyond adding the single `scan` emission
- Skip the Supabase verification — this is the whole point of the phase
