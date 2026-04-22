# Orchestrator

Polls Supabase for queued campaigns, designs a matrix, generates personas, dispatches runs, and writes results back.

## Files

- `run.mjs` — entrypoint loop. `node run.mjs` runs forever; `node run.mjs --once` processes one campaign and exits (useful for cron).
- `env.mjs` — env var contract + defaults.
- `db.mjs` — Supabase service-role client + state transitions.
- `llm.mjs` — OpenRouter chat wrapper (`chat`, `chatJson`).
- `matrix-designer.mjs` — turns `{url, description}` into `{rows, columns}`.
- `persona-generator.mjs` — one persona per matrix row, inspired by `../personas/library/`.
- `dispatcher.mjs` — runs one cell, and dispatches a whole campaign with concurrency.
- `smoke.mjs` — end-to-end smoke test that doesn't touch Supabase.

## Running

```bash
cd orchestrator
npm install
export SUPABASE_URL=https://<project>.supabase.co
export SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
export OPENROUTER_API_KEY=<openrouter-key>
node run.mjs
```

## Running in production

On the VPS, run under pm2:

```bash
pm2 start run.mjs --name swarm-orchestrator \
  --cwd /root/swarm-testing-services/orchestrator \
  --update-env
pm2 save
```

Or as a cron (every 10 min, process one campaign then exit):

```
*/10 * * * * cd /root/swarm-testing-services/orchestrator && /usr/bin/node run.mjs --once >> /var/log/swarm-orchestrator.log 2>&1
```

## State machine

```
queued → designing → generating_personas → running → completed
                                              ↓
                                            failed (with error message)
```

The loop is idempotent: if the orchestrator crashes mid-campaign, the
campaign stays in whatever status it was in and the next run will NOT
pick it up (`claimNextQueued` only claims `queued`). Operator can flip it
back to `queued` manually to retry.

## v1 → v2 upgrades (not yet implemented)

- **Real browser automation.** Today personas describe what they'd do; in v2 we wire up Playwright or a browser-MCP and actually drive the page.
- **Retry budget per cell.** Today a cell errors exactly once. Add 1 retry on transient LLM failures.
- **Per-run cost attribution.** Log tokens/cents per cell so we can bill accurately.
- **Webhook out** after `completed` so buyers can integrate with their CI.
