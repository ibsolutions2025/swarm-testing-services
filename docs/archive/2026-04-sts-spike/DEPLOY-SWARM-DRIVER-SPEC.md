# Swarm driver deployment spec (Cash task)

The auto-cycle.mjs script works; MCP connects; the only block is the Chutes/OpenRouter/Moonshot API keys not being on VPS. This spec adds them and schedules the swarm via cron. After this lands, the flywheel will produce new job posts, submissions, validations, and reviews on a rolling 30-min cycle per agent.

## Keys (verified from C:\Users\isaia\.openclaw\openclaw.json)

```
CHUTES_API_KEY=cpk_d2736ffc558f40d6b1b03bea523f5a4e.e57fba818d3753cb8643409eabfe5880.l5n3JTUv4l77N3dVvjHS3qdzMdm3lLnq
OPENROUTER_API_KEY=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
MOONSHOT_API_KEY=sk-dTcSmtlSlQGOOA5aXxKxl9rqVyUxis7GHofLYdgRuKoGDuI3
```

## Step 1 — Create /root/.awp-env

On VPS, create the env file with strict perms (chmod 600):

```
cat > /root/.awp-env <<'EOF'
export CHUTES_API_KEY=cpk_d2736ffc558f40d6b1b03bea523f5a4e.e57fba818d3753cb8643409eabfe5880.l5n3JTUv4l77N3dVvjHS3qdzMdm3lLnq
export OPENROUTER_API_KEY=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
export MOONSHOT_API_KEY=sk-dTcSmtlSlQGOOA5aXxKxl9rqVyUxis7GHofLYdgRuKoGDuI3
EOF
chmod 600 /root/.awp-env
```

## Step 2 — Create /root/test-swarm/run-cycle.sh

Wrapper script that each cron line calls. Takes agent number as argument.

```
cat > /root/test-swarm/run-cycle.sh <<'EOF'
#!/bin/bash
# run-cycle.sh AGENT_NUM
set -e
source /root/.awp-env
AGENT_NUM="$1"
if [ -z "$AGENT_NUM" ]; then echo "Usage run-cycle.sh AGENT_NUM"; exit 1; fi
cd /root/test-swarm/agent-$AGENT_NUM
timeout 300 node /root/test-swarm/auto-cycle.mjs
EOF
chmod +x /root/test-swarm/run-cycle.sh
```

## Step 3 — Manual verification run on agent-1

Before scheduling, confirm end-to-end works. Run once and paste the full log:

```
bash /root/test-swarm/run-cycle.sh 1
```

Must see evidence of a successful Turn 1 model call (no more 401), a tool call being fired, and ideally a contract write succeeding. If it fails with 401 again, stop and debug. If it succeeds, proceed to Step 4.

## Step 4 — Add 7 staggered cron entries

Each agent runs every 30 min, staggered ~4 min apart so they don't collide on RPC/MCP. Append to root's crontab without clobbering existing lines:

```
crontab -l > /tmp/cron.bak
cat >> /tmp/cron.bak <<'EOF'
# AWP Swarm Agents - auto-cycle every 30 min (staggered) — re-added 2026-04-23
0,30 * * * * /root/test-swarm/run-cycle.sh 1 >> /var/log/awp-cycle-1.log 2>&1
4,34 * * * * /root/test-swarm/run-cycle.sh 2 >> /var/log/awp-cycle-2.log 2>&1
8,38 * * * * /root/test-swarm/run-cycle.sh 3 >> /var/log/awp-cycle-3.log 2>&1
12,42 * * * * /root/test-swarm/run-cycle.sh 4 >> /var/log/awp-cycle-4.log 2>&1
16,46 * * * * /root/test-swarm/run-cycle.sh 5 >> /var/log/awp-cycle-5.log 2>&1
20,50 * * * * /root/test-swarm/run-cycle.sh 6 >> /var/log/awp-cycle-6.log 2>&1
24,54 * * * * /root/test-swarm/run-cycle.sh 7 >> /var/log/awp-cycle-7.log 2>&1
EOF
crontab /tmp/cron.bak
crontab -l
```

## Step 5 — Create log files with open perms

```
for i in 1 2 3 4 5 6 7; do touch /var/log/awp-cycle-$i.log; chmod 644 /var/log/awp-cycle-$i.log; done
```

## Step 6 — Verify the flywheel

Wait until the next cron fire window (up to 30 min) or manually trigger all 7 agents by running `bash /root/test-swarm/run-cycle.sh N` for N=1..7. Check that jobs are being posted, submissions made, validations approved, etc.

After one full cycle of all 7 agents, tail each log:

```
for i in 1 2 3 4 5 6 7; do echo == agent-$i ==; tail -30 /var/log/awp-cycle-$i.log; done
```

Look for: new job_id created, submitWork tx hash, approveSubmission tx, review submission tx. At least one per agent over a 30-min window.

## Report format

```
## Step 1 — env file
<stat of /root/.awp-env + first line of contents (redact key values to first 8 chars)>

## Step 2 — wrapper
<stat + first 5 lines>

## Step 3 — manual verification
<last 60 lines of agent-1's auto-cycle output, verbatim>
<one-line go/no-go — DID-IT-WORK or SPECIFIC-ERROR>

## Step 4 — crontab
<full crontab -l output>

## Step 5 — logs
<ls -la /var/log/awp-cycle-*.log>

## Step 6 — flywheel evidence
<summarize evidence of new on-chain activity across all 7 agents>
```

## Do NOT

- Paste the raw key values back in your reply (redact to first 8 chars)
- Commit keys to any git repo
- Modify anything in the STS repo on Windows
- Restart sts-scanner or any other pm2 process
- Modify auto-cycle.mjs, awp-helpers.mjs, or awp-mcp-server
