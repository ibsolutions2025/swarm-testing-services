# STS Scanner

Onchain lifecycle scanner for STS. Reads AWP JobNFT + ReviewGate events on Base Sepolia, writes results directly into STS Supabase under `project_id='awp'`.

AWP's existing scanner (`awp-lifecycle-scanner`) keeps running untouched. This is a separate independent process.

## Environment variables

| Var | Required | Description |
|-----|----------|-------------|
| `STS_SUPABASE_URL` | no | Defaults to `https://ldxcenmhazelrnrlxuwq.supabase.co` |
| `STS_SUPABASE_KEY` | **yes** | STS service_role key (bypasses RLS) |
| `ALCHEMY_RPC` | no | Defaults to PAYG endpoint in code |

## Deploy on VPS

```bash
# Create scanner directory
mkdir -p /root/sts-scanner
cd /root/sts-scanner

# Copy files
cp /root/test-swarm/awp-helpers.mjs .  # NOT used by sts-scanner, but keep for reference
cp /path/to/sts-scanner.mjs .

# Install deps (reuse test-swarm node_modules or install fresh)
npm init -y
npm install @supabase/supabase-js viem

# Create .env
cat > .env << 'EOF'
STS_SUPABASE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
EOF

# Start via pm2
pm2 start sts-scanner.mjs \
  --name sts-scanner \
  --interpreter node \
  -- --loop
pm2 save
```

## CLI flags

| Flag | Description |
|------|-------------|
| `--loop` | Run continuously every 15 minutes |
| `--dry-run` | Print changes without writing to Supabase |
| `--since N` | Start scanning from job ID N |
| `--batch N` | Concurrent job batch size (default: 5) |

## Architecture notes

- Uses Fix E5: bulk Alchemy `eth_getLogs` prefetch — O(chunks) not O(jobs×chunks)
- Uses Fix E6: event-proof-only passed determination — V14 storage never advances past `submitted(2)`
- `run_id` is stable: `awp-job-<jobId>` — upserts are idempotent
- Unique constraint on `(project_id, run_id)` prevents duplicates

## Tables written

- `lifecycle_results` (STS Supabase: `ldxcenmhazelrnrlxuwq`)
  - `project_id = 'awp'` on all rows
  - See `supabase/migrations/0002_sts_ownership.sql` for schema
