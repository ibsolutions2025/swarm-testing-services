# Phase 5 deploy (Cash task)

Phase 5 shipped to GitHub as commit `751fa53`. Now deploy to VPS. Isaiah is applying the Supabase migration in parallel.

## Step 1 — scp the three scripts + docs to VPS

```
scp C:\Users\isaia\.openclaw\swarm-testing-services\scripts\swarm-agent-runner.mjs root@45.32.82.83:/root/test-swarm/
scp C:\Users\isaia\.openclaw\swarm-testing-services\scripts\swarm-drain.mjs      root@45.32.82.83:/root/test-swarm/
scp C:\Users\isaia\.openclaw\swarm-testing-services\scripts\swarm-create.mjs     root@45.32.82.83:/root/test-swarm/
scp C:\Users\isaia\.openclaw\swarm-testing-services\scripts\PERSONA-PROMPTS.md   root@45.32.82.83:/root/test-swarm/
scp C:\Users\isaia\.openclaw\swarm-testing-services\scripts\scanner-heartbeat-patch.md root@45.32.82.83:/root/test-swarm/
```

Then chmod the scripts:
```
ssh root@45.32.82.83 "chmod +x /root/test-swarm/swarm-agent-runner.mjs /root/test-swarm/swarm-drain.mjs /root/test-swarm/swarm-create.mjs"
```

## Step 2 — verify required env vars on VPS

```
ssh root@45.32.82.83 "grep -E '^export (OPENROUTER_API_KEY|STS_SUPABASE_KEY|STS_SUPABASE_URL)' /root/.awp-env"
```

Expect at minimum:
- `OPENROUTER_API_KEY=sk-or-v1-...`
- `STS_SUPABASE_KEY=eyJhbGciOi...` (service-role key)

If STS_SUPABASE_KEY is missing, grab the service-role value from `pm2 env 16` (the sts-scanner env has it exposed) — the right key is either the `STS_SUPABASE_KEY` or `SUPABASE_SERVICE_ROLE_KEY` entry. Add it to `/root/.awp-env` with `chmod 600` preserved. If `STS_SUPABASE_URL` is missing, add it — value is `https://ldxcenmhazelrnrlxuwq.supabase.co`.

Report back which env vars were present and which you had to add.

## Step 3 — smoke test the new agent-runner

Run ONE manual drain cycle to verify agent-runner works end-to-end (OpenRouter call succeeds, insider-info assertion doesn't throw, JSON parses, on-chain tx lands):

```
ssh root@45.32.82.83 "cd /root/test-swarm; source /root/.awp-env; timeout 300 node swarm-drain.mjs 2>&1"
```

Paste the last 80 lines. Expect to see `[agent-runner] persona=X task=Y turns=N tokens=in/out ms=D outcome=ok` lines interleaved with the drain's normal progress output. At least ONE such line = pass. If every call goes to `outcome=fallback`, report that — means OpenRouter is erroring or Gemma-4 isn't returning JSON cleanly.

## Step 4 — apply the scanner heartbeat patch

Read `scripts/scanner-heartbeat-patch.md` for the exact snippet. Apply to `/root/sts-scanner/sts-scanner.mjs`. Placement rule: at the END of the main loop, after the final upsert batch, before `console.log` / `process.exit`. Bind the placeholders to the scanner's actual counters (likely `upsertedCount` and `skippedCount` — check the scanner's existing log lines to find real names).

Since modifying source via ssh is quote-fragile, the safest path: `ssh root@... "cat /root/sts-scanner/sts-scanner.mjs | wc -l"` to get total lines, then use sed to insert at the right line. Or simpler — `cat > /tmp/heartbeat-block.js <<EOF ... EOF` then use a one-liner to append-before-pattern.

Alternatively: scp a patched copy from Windows. Easiest if you grab the current scanner, apply the patch locally to a temp file, and scp it back.

After patch lands:
```
ssh root@45.32.82.83 "pm2 restart 16"
```

Wait 15 min, then tail the scanner log for a `heartbeat ok` line:
```
ssh root@45.32.82.83 "pm2 logs sts-scanner --lines 50 --nostream | tail -40"
```

## Step 5 — verify Operations tab cards go green

Query Supabase for heartbeat rows:
```
ssh root@45.32.82.83 'source /root/.awp-env; curl -sS "$STS_SUPABASE_URL/rest/v1/system_heartbeats?project_id=eq.awp&select=component,ran_at,outcome,actions_count&order=ran_at.desc&limit=10" -H "apikey: $STS_SUPABASE_KEY" -H "Authorization: Bearer $STS_SUPABASE_KEY"'
```

Expect within 15 min of deploy: at least ONE row each for `swarm-drain`, `swarm-create`, `sts-scanner` (in their respective cron windows).

## Report back

1. scp outcomes (all 5 files landed)
2. Env var state (which were present vs added)
3. Drain smoke-test output (last 80 lines)
4. Scanner patch applied (y/n, any issues)
5. Heartbeat rows present (list of components + latest ran_at)
6. Any failures that need my attention

## Do NOT

- Modify anything else in /root/sts-scanner
- Modify VPS crontab (already set correctly in Phase 1)
- Run swarm-create.mjs manually on VPS during deploy — cron will fire it
- Hardcode any API key in scripts — all env lookups go through process.env with /root/.awp-env sourced
