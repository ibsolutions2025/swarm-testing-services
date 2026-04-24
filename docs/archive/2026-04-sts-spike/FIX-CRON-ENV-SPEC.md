# Fix: cron env vars not sourced — drain/create crashing silently

## The bug

VPS crontab fires `/usr/bin/node /root/test-swarm/swarm-drain.mjs` directly every 5 min. Cron runs in a minimal environment — it does NOT source `/root/.awp-env`. The scripts require `OPENROUTER_API_KEY`, `STS_SUPABASE_KEY`, `STS_SUPABASE_URL`, `AWP_RPC_URL` — all undefined when cron fires them. swarm-agent-runner throws "OPENROUTER_API_KEY not set" on the very first call, drain dies before emitting a heartbeat, nothing lands in Supabase.

Cash's manual smoke tests worked because Cash ran `source /root/.awp-env; timeout 240 node swarm-drain.mjs` — sourced env explicitly.

Symptoms in UI (at https://swarm-testing-services.vercel.app → dashboard → AWP → Operations tab):
- swarm-drain card: "No heartbeat yet, 0 runs in last 24h"
- swarm-create card: "No heartbeat yet, 0 runs in last 24h"
- sts-scanner card: green (works because pm2 preserves env, only crons lack it)
- Orchestration Stream: stale rows from CC's smoke test only, nothing new

## The fix

Write a one-line wrapper script on VPS that sources env and execs the target, then point crontab at the wrapper. Keeps crontab readable and survives any future env-var additions.

## Step 1 — create `/root/test-swarm/run.sh` on VPS

Contents (exactly):

```sh
#!/bin/bash
set -e
source /root/.awp-env
exec /usr/bin/node "/root/test-swarm/$1"
```

SCP a local copy or write via SSH. Either way chmod +x it.

PowerShell approach (easiest):

```powershell
$wrapper = @"
#!/bin/bash
set -e
source /root/.awp-env
exec /usr/bin/node "/root/test-swarm/`$1"
"@
# Write to local temp file
$wrapper | Set-Content -Path "$env:TEMP\run.sh" -Encoding UTF8 -NoNewline
# scp to VPS
scp "$env:TEMP\run.sh" root@45.32.82.83:/root/test-swarm/run.sh
# chmod + verify
ssh root@45.32.82.83 "chmod +x /root/test-swarm/run.sh; head -5 /root/test-swarm/run.sh"
```

(Watch the backtick-dollar — `` `$1 `` — so PowerShell doesn't substitute its own `$1`. The literal `$1` must survive into the file.)

## Step 2 — replace the two cron lines

Current crontab (unchanged since Phase 1 deploy):

```
*/5 * * * * /usr/bin/node /root/test-swarm/swarm-drain.mjs >> /var/log/awp-drain.log 2>&1
*/15 * * * * /usr/bin/node /root/test-swarm/swarm-create.mjs >> /var/log/awp-create.log 2>&1
```

Target:

```
*/5 * * * * /root/test-swarm/run.sh swarm-drain.mjs >> /var/log/awp-drain.log 2>&1
*/15 * * * * /root/test-swarm/run.sh swarm-create.mjs >> /var/log/awp-create.log 2>&1
```

Leave the other three lines intact (bitmind log cleanup, bitmind health monitor, awp-lifecycle-scanner).

Install procedure:

```powershell
ssh root@45.32.82.83 "crontab -l > /tmp/cron.bak.fix-env"
ssh root@45.32.82.83 "crontab -l | sed 's|/usr/bin/node /root/test-swarm/swarm-drain.mjs|/root/test-swarm/run.sh swarm-drain.mjs|; s|/usr/bin/node /root/test-swarm/swarm-create.mjs|/root/test-swarm/run.sh swarm-create.mjs|' | crontab -"
ssh root@45.32.82.83 "crontab -l"
```

Verify the two lines now reference `run.sh` and the other three lines are intact.

## Step 3 — force a test run NOW via the wrapper

Don't wait 5 min for the next cron. Fire it manually through the wrapper to confirm it works:

```powershell
ssh root@45.32.82.83 "timeout 240 /root/test-swarm/run.sh swarm-drain.mjs 2>&1 | tail -60"
```

Expected signals (all in the tail):
- At least one `[agent-runner] persona=X task=Y ... outcome=ok|fallback` line (if drain hit submit/review this cycle)
- No `OPENROUTER_API_KEY not set` errors
- No `STS_SUPABASE_KEY not set` errors
- `DONE — total actions: N` at the end (means it reached process.exit gracefully)

## Step 4 — verify heartbeats + new orchestration rows landed

```powershell
ssh root@45.32.82.83 'source /root/.awp-env; curl -sS "$STS_SUPABASE_URL/rest/v1/system_heartbeats?project_id=eq.awp&component=eq.swarm-drain&order=ran_at.desc&limit=1" -H "apikey: $STS_SUPABASE_KEY" -H "Authorization: Bearer $STS_SUPABASE_KEY"'
ssh root@45.32.82.83 'source /root/.awp-env; curl -sS "$STS_SUPABASE_URL/rest/v1/orchestration_events?project_id=eq.awp&order=ran_at.desc&limit=5" -H "apikey: $STS_SUPABASE_KEY" -H "Authorization: Bearer $STS_SUPABASE_KEY"'
```

Expected:
- First query returns ONE `swarm-drain` heartbeat with a recent `ran_at` timestamp
- Second query returns 5 fresh orchestration rows (scan + dispatches) with `ran_at` within the last ~2 minutes

## Step 5 — trigger swarm-create too

```powershell
ssh root@45.32.82.83 "timeout 120 /root/test-swarm/run.sh swarm-create.mjs 2>&1 | tail -40"
```

Should see `[agent-runner] persona=<poster-name> task=create ...` and a new job posted on-chain. Followed by heartbeat + orchestration rows emitted for swarm-create component.

## Step 6 — verify the UI updates

Open https://swarm-testing-services.vercel.app/dashboard/campaigns/d15d0f42-e238-49c1-b911-8b7399675384 and click Operations tab. Within 10-30s the swarm-drain and swarm-create heartbeat cards should flip GREEN. Orchestration Stream should show fresh cycle headers at the top (within the last 3 min).

## Report back

1. run.sh created + chmod'd (y/n, contents sample)
2. Crontab replacement (paste the updated `crontab -l` verbatim)
3. Manual drain run tail (60 lines)
4. Supabase verification (paste both curl outputs)
5. swarm-create run tail
6. UI spot-check — heartbeat cards flipped green (y/n)

## Do NOT

- Modify the scripts themselves — they're fine; the bug is strictly cron env
- Delete run-cycle.sh from earlier deploy (it's dormant; harmless)
- Commit run.sh to git (it's VPS-only infra, env-specific)
- Touch pm2 or sts-scanner — only the two awp-* cron lines change
