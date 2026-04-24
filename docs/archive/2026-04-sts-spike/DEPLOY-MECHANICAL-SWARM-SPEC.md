# Deploy mechanical swarm (Cash task)

Replace LLM-based auto-cycle with mechanical drain + scenario-targeted create. Zero LLM calls for progression.

## Files ready locally

- `C:\Users\isaia\.openclaw\swarm-testing-services\scripts\swarm-drain.mjs` — mechanical progression engine (~450 lines)
- `C:\Users\isaia\.openclaw\swarm-testing-services\scripts\swarm-create.mjs` — scenario-targeted creation (~250 lines)

## Step 1 — SCP both scripts to VPS

```
scp C:\Users\isaia\.openclaw\swarm-testing-services\scripts\swarm-drain.mjs root@45.32.82.83:/root/test-swarm/
scp C:\Users\isaia\.openclaw\swarm-testing-services\scripts\swarm-create.mjs root@45.32.82.83:/root/test-swarm/
ssh root@45.32.82.83 "chmod +x /root/test-swarm/swarm-drain.mjs /root/test-swarm/swarm-create.mjs"
```

## Step 2 — Seed empty intended-scenarios.json

```
ssh root@45.32.82.83 "test -f /root/test-swarm/intended-scenarios.json || echo '{}' > /root/test-swarm/intended-scenarios.json"
ssh root@45.32.82.83 "touch /root/test-swarm/.create-cycle"
```

## Step 3 — Smoke test swarm-create.mjs manually (one job)

```
ssh root@45.32.82.83 "cd /root/test-swarm; node swarm-create.mjs"
```

Expect output like `[...] created jobId=N` and an updated intended-scenarios.json. If any error, STOP and report the error. Do NOT proceed to step 5.

## Step 4 — Smoke test swarm-drain.mjs manually (read-only sweep)

```
ssh root@45.32.82.83 "cd /root/test-swarm; node swarm-drain.mjs"
```

Expect to see log lines like `#N status=Open subs=0 ... | CLAIM by Xxx tx=0x...`. Some actions may fail due to state — that's fine. What matters is at least 3-5 successful writes.

## Step 5 — Replace crontab

Current state has 7 auto-cycle lines (one per agent, every 10 min staggered). Remove those, add 2 new lines:

```
*/5 * * * * /usr/bin/node /root/test-swarm/swarm-drain.mjs >> /var/log/awp-drain.log 2>&1
*/15 * * * * /usr/bin/node /root/test-swarm/swarm-create.mjs >> /var/log/awp-create.log 2>&1
```

Process to install:

```
ssh root@45.32.82.83 "crontab -l > /tmp/cron.bak.pre-mechanical"
ssh root@45.32.82.83 "crontab -l | grep -v run-cycle.sh > /tmp/cron.new"
echo "# AWP mechanical swarm — 2026-04-23" >> /tmp/cron.new-lines
echo "*/5 * * * * /usr/bin/node /root/test-swarm/swarm-drain.mjs >> /var/log/awp-drain.log 2>&1" >> /tmp/cron.new-lines
echo "*/15 * * * * /usr/bin/node /root/test-swarm/swarm-create.mjs >> /var/log/awp-create.log 2>&1" >> /tmp/cron.new-lines
ssh root@45.32.82.83 "cat /tmp/cron.new-lines >> /tmp/cron.new; crontab /tmp/cron.new; crontab -l"
```

(Adapt to whatever works. The key things: (a) backup old crontab, (b) remove all `run-cycle.sh` lines, (c) add the two new entries, (d) install.)

## Step 6 — Create log files + chmod

```
ssh root@45.32.82.83 "touch /var/log/awp-drain.log /var/log/awp-create.log; chmod 644 /var/log/awp-drain.log /var/log/awp-create.log"
```

## Step 7 — Verify crontab

```
ssh root@45.32.82.83 "crontab -l"
```

Expected: the two awp-cycle lines GONE, two new lines PRESENT, other lines intact (awp-lifecycle-scanner still there, bitmind lines still there).

## Report back

1. scp results (both files)
2. intended-scenarios.json state (`ls -la`)
3. swarm-create.mjs smoke-test output (full stdout)
4. swarm-drain.mjs smoke-test output (last 40 lines)
5. new crontab -l verbatim
6. Go / no-go assessment

## Do NOT

- Delete auto-cycle.mjs or run-cycle.sh (keep them for rollback)
- Modify any other VPS files
- Touch Supabase or the scanner
- Run both scripts in parallel; tests must be sequential
