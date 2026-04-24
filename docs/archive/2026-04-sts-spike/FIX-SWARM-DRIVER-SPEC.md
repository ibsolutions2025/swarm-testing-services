# Swarm driver fix — Cash task

Context: full audit at `AUDIT-2026-04-23.md`. Infra is healthy; swarm drivers are all off or stale; jobs 657/658 were posted today by wallet `0x35bd1F28e93afdd929b82fF47612d00BEfc136CE` (Spark) by an unknown mechanism. Find it, then restart the flywheel.

## Part 1 — Discovery (don't break anything yet)

Enumerate every possible place a swarm driver could be running. Output findings to stdout, do NOT kill/restart anything in Part 1.

```bash
ssh root@45.32.82.83 '
echo "=== pm2 list ==="
pm2 list
echo
echo "=== pm2 processes matching awp/agent/swarm ==="
pm2 jlist | node -e "let d=\"\";process.stdin.on(\"data\",c=>d+=c).on(\"end\",()=>{const a=JSON.parse(d);for(const p of a){if(/awp|agent|swarm|cycle|loop/i.test(p.name)){console.log(JSON.stringify({name:p.name,status:p.pm2_env.status,script:p.pm2_env.pm_exec_path,uptime_min:Math.round((Date.now()-p.pm2_env.pm_uptime)/60000),restarts:p.pm2_env.restart_time}))}}})"
echo
echo "=== systemctl units matching awp/swarm ==="
systemctl list-units --all --no-pager 2>/dev/null | grep -Ei "awp|swarm|agent|cycle" || echo "(none)"
echo
echo "=== root crontab ==="
crontab -l 2>/dev/null || echo "(empty)"
echo
echo "=== /etc/cron.d ==="
ls -la /etc/cron.d/ 2>/dev/null
for f in /etc/cron.d/*; do [ -f "$f" ] && echo "--- $f ---" && cat "$f"; done
echo
echo "=== awp-agent-loop or similar on disk ==="
find / -maxdepth 6 -name "awp-agent-loop*" -o -name "agent-loop.mjs" -o -name "auto-cycle.mjs" 2>/dev/null | head -40
echo
echo "=== running node processes ==="
ps -eo pid,etime,cmd --sort=-etime | grep -i node | grep -v grep | head -30
echo
echo "=== what mints jobs recently? check JobNFT tx origins ==="
# Skip this on VPS — do via Alchemy query separately below
'
```

Then, on VPS, check the tx origins for jobs 657 and 658 via Alchemy (key should be in `/root/sts-scanner/.env` or `/root/awp-config/.env` — whatever the scanner uses):

```bash
ssh root@45.32.82.83 '
KEY=$(grep -h ALCHEMY /root/sts-scanner/.env 2>/dev/null | head -1 | cut -d= -f2-)
[ -z "$KEY" ] && KEY=$(grep -h ALCHEMY /root/awp-config/.env 2>/dev/null | head -1 | cut -d= -f2-)
[ -z "$KEY" ] && KEY=$(pm2 env 16 2>/dev/null | grep ALCHEMY | head -1 | cut -d= -f2-)

# Get tokenId 658 owner via JobNFT.ownerOf
curl -sS -X POST "https://base-sepolia.g.alchemy.com/v2/$KEY" -H "content-type: application/json" -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_call\",\"params\":[{\"to\":\"0x267e831e6ac1e7c9e69bd99aec7f41e03a421198\",\"data\":\"0x6352211e0000000000000000000000000000000000000000000000000000000000000292\"},\"latest\"]}" 
echo
echo "owner of 658 above (decode last 40 hex chars)"

# Get latest 20 Transfer (mint) events from JobNFT — identify who fired the mint tx
LATEST=$(curl -sS -X POST "https://base-sepolia.g.alchemy.com/v2/$KEY" -H "content-type: application/json" -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_blockNumber\",\"params\":[]}" | node -e "let d=\"\";process.stdin.on(\"data\",c=>d+=c).on(\"end\",()=>{console.log(parseInt(JSON.parse(d).result,16))})")
FROM_BLOCK=$((LATEST - 1000))
curl -sS -X POST "https://base-sepolia.g.alchemy.com/v2/$KEY" -H "content-type: application/json" -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getLogs\",\"params\":[{\"fromBlock\":\"0x$(printf %x $FROM_BLOCK)\",\"toBlock\":\"latest\",\"address\":\"0x267e831e6ac1e7c9e69bd99aec7f41e03a421198\",\"topics\":[\"0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef\",\"0x0000000000000000000000000000000000000000000000000000000000000000\"]}]}" | node -e "let d=\"\";process.stdin.on(\"data\",c=>d+=c).on(\"end\",()=>{const j=JSON.parse(d);const logs=(j.result||[]).slice(-10);console.log(\"latest 10 mints:\");for(const l of logs){console.log(\"block\",parseInt(l.blockNumber,16),\"tokenId\",parseInt(l.topics[3],16),\"tx\",l.transactionHash)}})"
'
```

For each of the 3 most recent mint tx hashes, get the tx `from` address via `eth_getTransactionByHash`. Report: **who posted jobs 657 and 658** (from address), which wallet / mechanism.

## Part 2 — Decide + restart

Branch based on discovery:

**A.** If `awp-agent-loop.mjs` (or similar) is running on pm2 or systemd and has recent activity → report it and stop. Don't touch.

**B.** If `awp-agent-loop.mjs` exists on disk but isn't running anywhere → start it under pm2:

```bash
ssh root@45.32.82.83 '
# Adapt the path based on Part 1 find results
pm2 start /root/awp-agent-loop/awp-agent-loop.mjs --name awp-agent-loop --interpreter node --cwd /root/awp-agent-loop
pm2 save
pm2 logs awp-agent-loop --lines 30 --nostream
'
```

**C.** If `awp-agent-loop.mjs` is missing entirely → stop, report, wait for instruction. Do NOT improvise a replacement.

**D.** If jobs 657/658 were posted by a wallet/service we don't recognize (not Spark, not a known swarm process) → stop, report, wait. Could be someone else using AWP on Base Sepolia — would want to know before blindly firing more traffic.

## Part 3 — Verify liveness

After restart (if applicable), wait 90 seconds, then:

```bash
ssh root@45.32.82.83 'pm2 logs awp-agent-loop --lines 60 --nostream'
```

Look for evidence of a cycle starting (e.g. "posted job", "volunteering", "submitting", "reviewing"). If the log is idle after 90s, report that — something else is wrong.

## Report format

Output a single markdown block:

```
## Discovery
- pm2 awp-* processes: <list or "none">
- systemctl awp-* units: <list or "none">
- crontab swarm entries: <list or "none">
- cron.d swarm files: <list or "none">
- awp-agent-loop.mjs on disk: <path or "not found">
- Latest 3 JobNFT mint tx origins: <tokenId → from addr>
- Mechanism posting 657/658: <identified or "unknown">

## Branch taken
<A/B/C/D and why>

## Action
<what you did, or "no-op — reporting">

## Liveness verification
<log excerpt or "not applicable">

## Remaining risk / open questions
<anything you noticed that wasn't in the brief>
```

## Do NOT

- Kill any running pm2 processes without confirming they're unrelated
- Modify scanner code or STS repo files
- Touch Supabase (read-only lookups only)
- Push to git or commit anything
- Start `awp-agent-loop.mjs` under pm2 with wrong env vars — confirm its `.env` / config exists first
- Re-enable `awp-conductor` in Cowork scheduled tasks (memory says it's disabled for a reason — Kimi fleet dispatch limit)
