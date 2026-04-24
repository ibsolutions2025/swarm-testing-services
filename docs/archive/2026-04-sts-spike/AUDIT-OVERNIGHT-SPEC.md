# End-to-end audit before overnight run (Cash task)

Three-layer reconciliation: on-chain ↔ STS Supabase ↔ UI. Plus agent/swarm liveness + agent workspace inventory. Output must be structured so Agent 0 can make a go/no-go call.

## Layer 1 — STS scanner liveness on VPS

```bash
ssh root@45.32.82.83 "pm2 jlist | node -e 'let d=\"\";process.stdin.on(\"data\",c=>d+=c).on(\"end\",()=>{const a=JSON.parse(d);const s=a.find(p=>p.name===\"sts-scanner\");if(!s){console.log(\"MISSING\");process.exit()}console.log(JSON.stringify({name:s.name,status:s.pm2_env.status,restarts:s.pm2_env.restart_time,uptime_ms:Date.now()-s.pm2_env.pm_uptime,cpu:s.monit.cpu,memory_mb:Math.round(s.monit.memory/1048576)}))})'"
```

Then:

```bash
ssh root@45.32.82.83 "pm2 logs sts-scanner --lines 100 --nostream 2>&1 | tail -80"
```

Pull: last scan start timestamp, last "inserted N rows" or equivalent, any error tracebacks in last 100 lines.

## Layer 2 — STS Supabase row health

Supabase project ref: `ldxcenmhazelrnrlxuwq`. Service role key at `/sessions/ecstatic-tender-fermat/mnt/.openclaw/swarm-testing-credentials.md` (or Isaiah's env — you have it).

Via `curl` against PostgREST:

```bash
# Total rows + earliest/latest for project_id=awp
curl -sSL "https://ldxcenmhazelrnrlxuwq.supabase.co/rest/v1/lifecycle_results?project_id=eq.awp&select=count" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" -H "Prefer: count=exact" -I | grep -i content-range

# Rows inserted in last 60 min
curl -sSL "https://ldxcenmhazelrnrlxuwq.supabase.co/rest/v1/lifecycle_results?project_id=eq.awp&created_at=gte.$(date -u -d '60 minutes ago' +%FT%TZ)&select=count" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" -H "Prefer: count=exact" -I | grep -i content-range

# Rows UPDATED in last 30 min (scanner re-scans = evidence of liveness even if no new jobs)
curl -sSL "https://ldxcenmhazelrnrlxuwq.supabase.co/rest/v1/lifecycle_results?project_id=eq.awp&updated_at=gte.$(date -u -d '30 minutes ago' +%FT%TZ)&select=count" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" -H "Prefer: count=exact" -I | grep -i content-range

# Status distribution
curl -sSL "https://ldxcenmhazelrnrlxuwq.supabase.co/rest/v1/lifecycle_results?project_id=eq.awp&select=status" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const a=JSON.parse(d);const tally={};for(const r of a)tally[r.status]=(tally[r.status]||0)+1;console.log(JSON.stringify(tally))})'

# Data-completeness spot check — top 5 most recent rows, full shape
curl -sSL "https://ldxcenmhazelrnrlxuwq.supabase.co/rest/v1/lifecycle_results?project_id=eq.awp&order=updated_at.desc&limit=5&select=id,onchain_job_id,config_key,scenario_key,status,steps,step_audits,cell_audit,wallets,agent_wallets,created_at,updated_at" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const a=JSON.parse(d);console.log(JSON.stringify(a.map(r=>({id:r.id,onchain_job_id:r.onchain_job_id,cell:r.config_key+"×"+r.scenario_key,status:r.status,steps_count:Array.isArray(r.steps)?r.steps.length:null,has_step_audits:r.step_audits!=null,has_cell_audit:r.cell_audit!=null,agent_wallets_count:Array.isArray(r.agent_wallets)?r.agent_wallets.length:null,updated_at:r.updated_at})),null,2))})'
```

## Layer 3 — On-chain ground truth (Base Sepolia)

JobNFT V14 is at `0x267e831e...` — read from `C:\Users\isaia\.openclaw\app-factory-fresh\agents\dev\projects\agentwork-protocol\src\lib\awp-contracts.ts` for the exact address if needed.

Using Alchemy (`ALCHEMY_BASE_SEPOLIA_KEY` env) raw-fetch per the evm-indexing skill:

```bash
# Latest block
curl -sS -X POST "https://base-sepolia.g.alchemy.com/v2/$ALCHEMY_BASE_SEPOLIA_KEY" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);console.log("latest_block",parseInt(j.result,16))})'

# Last 1000 blocks of JobNFT Transfer events (= job mints) — count and latest tokenId
# Replace <JOBNFT_ADDR> with the V14 address from awp-contracts.ts
# Replace <LATEST-1000> with (latest_block - 1000) in hex
```

Pull the top-5 most recent JobNFT tokenIds emitted in the last ~1h of blocks and check each against lifecycle_results:

```bash
for TID in <the 5 ids>; do
  curl -sSL "https://ldxcenmhazelrnrlxuwq.supabase.co/rest/v1/lifecycle_results?project_id=eq.awp&onchain_job_id=eq.$TID&select=id,status,updated_at" \
    -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
  echo
done
```

Every recent on-chain tokenId should appear in lifecycle_results. Any that don't = scanner gap.

## Layer 4 — Swarm liveness (is the flywheel producing?)

```bash
# Windows side — scheduled tasks for awp-test-1..7 should all be Ready + LastRunTime within last ~10 min
powershell -NoProfile -Command "Get-ScheduledTask -TaskName 'OpenClaw-*' | ForEach-Object { [pscustomobject]@{Name=\$_.TaskName; State=\$_.State; LastRun=(\$_ | Get-ScheduledTaskInfo).LastRunTime; NextRun=(\$_ | Get-ScheduledTaskInfo).NextRunTime; LastResult=(\$_ | Get-ScheduledTaskInfo).LastTaskResult} } | Format-Table -AutoSize"
```

If any awp-test-N task has LastResult ≠ 0 or LastRun > 30 min ago → swarm is idle. That alone isn't a scanner fault but it's the upstream of the flywheel.

## Layer 5 — Agent workspace inventory gap check

```bash
ssh root@45.32.82.83 "for i in 1 2 3 4 5 6 7; do echo '=== awp-test-'\$i' ==='; ls -la /root/openclaw/agents/awp-test-\$i/ 2>/dev/null || ls -la /root/test-swarm/agent-\$i/ 2>/dev/null; done"
```

List every file in each agent dir on VPS. Compare to what we have in `C:\Users\isaia\.openclaw\swarm-testing-services\agents\awp-test-N\` (should be only IDENTITY.md, SOUL.md, USER.md post-scrub). Any file on VPS that isn't in the Cowork repo and ISN'T a private-key or runtime-state file = something the UI could render but currently doesn't.

Expected misses (fine): `awp-config/`, `last-run*.json`, any `.env`.

Unexpected misses (flag): AGENTS.md, README.md, PROMPT.md, etc.

## Layer 6 — UI deploy sanity

Hit the live API from curl:

```bash
curl -sSL "https://swarm-testing-services.vercel.app/api/test-results/lifecycle?limit=10" \
  -H "Authorization: Bearer $STS_API_BEARER" 2>&1 | head -2000
```

(If the endpoint is auth-free, drop the header. The response should contain at minimum 10 rows matching what's in STS Supabase.)

Also: `curl -sI https://swarm-testing-services.vercel.app/dashboard/campaigns/<awp-id>` — expect 200 or 307 (auth redirect), NOT 500.

## Report format

Output a single markdown block with sections:

1. **Scanner:** running / dead — last log line, restarts count, uptime
2. **DB health:** total rows awp, rows inserted last 60m, rows updated last 30m, status tally
3. **Data completeness:** out of 5 recent rows — how many had step_audits, cell_audit, agent_wallets populated
4. **On-chain ↔ DB match:** 5 recent JobNFT tokenIds checked, N found in lifecycle_results
5. **Swarm:** 7 scheduled tasks — state + LastRun + LastResult for each
6. **Workspace gap:** files in VPS agent dirs that aren't mirrored into repo
7. **UI deploy:** API status code, row count in response
8. **Go/no-go recommendation:** one line — "OK to run overnight" or "BLOCKED: <reason>"

## Do NOT

- Modify any repo files, STATUS.md, scanner code, or AWP infra
- Restart the scanner unless it's dead and a restart is the obvious fix (note it in the report)
- Commit or push anything
- Touch Supabase via DDL — read-only queries only
