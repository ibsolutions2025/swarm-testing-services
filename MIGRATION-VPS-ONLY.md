# STS Migration — VPS-side only (Cash task)

Smaller slice of MIGRATION-PLAN.md for Cash. Only the VPS work. Agent-dirs scp and git commit are separate follow-ups.

## Scope

1. Execute `supabase/migrations/0002_sts_ownership.sql` against STS Supabase (`ldxcenmhazelrnrlxuwq`)
2. Deploy `sts-scanner` under pm2 on the VPS
3. Verify rows populating in STS `lifecycle_results`

## Do NOT

- Touch AWP Supabase (`nyhwpkxezlwkwmjuklaj`), AWP scanner, or AWP `/testing`
- Run git or push
- Touch `STATUS.md`, `CLAUDE-CODE-PROMPT.md`, `MIGRATION-PLAN.md`

## Inputs you already have

- STS Supabase ref: `ldxcenmhazelrnrlxuwq`
- STS service role key + Supabase Mgmt PAT: in `C:\Users\isaia\.openclaw\swarm-testing-credentials.md` (also in `.env.local` via `vercel env pull`)
- Migration SQL (already on disk): `C:\Users\isaia\.openclaw\swarm-testing-services\supabase\migrations\0002_sts_ownership.sql`
- Scanner source (already on disk): `C:\Users\isaia\.openclaw\swarm-testing-services\scanner\sts-scanner.mjs` + `scanner/README.md`
- Alchemy RPC: see memory `reference_alchemy_rpc.md`
- Skills: `openclaw-ops`, `vps-deploy`, `evm-indexing`

## Steps

### 1. Execute migration

Use Supabase Management API with the PAT (the same path that worked for AWP `nyhwpkxezlwkwmjuklaj` — memory `reference_supabase_orgs.md`). Endpoint:

```
POST https://api.supabase.com/v1/projects/ldxcenmhazelrnrlxuwq/database/query
Authorization: Bearer <PAT>
Content-Type: application/json

{ "query": "<contents of 0002_sts_ownership.sql>" }
```

Run from VPS via curl so PAT stays off Cowork. After: confirm `lifecycle_results` exists:

```sql
select to_regclass('public.lifecycle_results');
```

Should return `lifecycle_results` not null.

### 2. Deploy sts-scanner under pm2

```bash
ssh root@45.32.82.83 << 'EOF'
  mkdir -p /root/sts-scanner
  cd /root/sts-scanner
EOF
```

Then scp `sts-scanner.mjs` + `README.md` from the Windows repo to `/root/sts-scanner/` on VPS. (You're running from Cowork / Windows side — use whatever transfer path works. If the files are already in the Cowork mount, use rsync/scp from there.)

On VPS:

```bash
cd /root/sts-scanner
npm init -y
npm install @supabase/supabase-js viem
cat > .env << EOF
STS_SUPABASE_KEY=<STS service role key>
EOF
pm2 start sts-scanner.mjs --name sts-scanner --interpreter node -- --loop
pm2 save
```

Verify: `pm2 list | grep sts-scanner` shows online.

### 3. Verify rows

Wait ~2 min for first scan loop, then:

```
curl -s "https://ldxcenmhazelrnrlxuwq.supabase.co/rest/v1/lifecycle_results?select=count&project_id=eq.awp" \
  -H "apikey: <STS service role>" \
  -H "Authorization: Bearer <STS service role>" \
  -H "Prefer: count=exact" -H "Range: 0-0" -I
```

Look for `Content-Range: 0-N/X` header. X > 0 means pipeline is writing.

## Report back

In your response, include:
- `pm2 list` line for `sts-scanner` (status + memory)
- `lifecycle_results` row count for `project_id='awp'`
- Any blockers

## NOT in this task

- SCP of `/root/openclaw/agents/awp-test-*` to Windows — separate task
- Git commit + push — separate task
- Touching AWP side — never
