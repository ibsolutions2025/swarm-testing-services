# HLO daemon — ops notes

## Outage 2026-04-27 18:25 → 2026-04-28 21:04 (~26h silence)

**Cause:** Windows pm2 daemon died — most likely cause is a sleep / reboot
of Isaiah's Windows box during Phase C work, since:
- `hlo-daemon-err.log` is **0 bytes** (no crash, no error written)
- `hlo-daemon-out.log` ends mid-stream on a clean dispatch
  (`agent-98c5 verify=true`) at 18:25 PT; nothing after
- pm2 restart count was 0 in the saved dump.pm2 — autorestart never
  fired, meaning pm2 itself wasn't running to attempt the restart
- Only one pm2 daemon process was visible at recovery time, and it was
  the one Cowork freshly spawned (PID 39028)

When Windows pm2 dies (process kill, user logout, sleep with no resume,
explicit pm2 kill), all supervised apps die with it. Autorestart only
helps if pm2 daemon stays alive.

## Recovery (2026-04-28 20:59 PT)

```
cd C:\Users\isaia\.openclaw\hlo-daemon
pm2 start ecosystem.config.cjs
pm2 save
```

First successful dispatch fired at 21:04:08 (5 min post-restart on the
30s tick + RPC backfill). Three more in the following 10 min, all
verify=true. Daemon is healthy.

## Open ops gap — pm2 not auto-launched at Windows boot

Default pm2 install on Windows does NOT register as a service. After a
reboot or logout, hlo-daemon stays down until someone manually runs
`pm2 resurrect` or `pm2 start ecosystem.config.cjs`.

**Fix options (Phase E or operator concern):**
1. `pm2-installer` (npm package that registers pm2 as a Windows service)
2. Task Scheduler entry: "At logon, run pm2 resurrect"
3. Cowork session-start hook that pm2-resurrects if hlo-daemon isn't online

Recommendation: option 2 — Task Scheduler is native, no extra deps.

## Steady-state monitoring

Heartbeat: hlo-daemon writes one log line every 30s (the tick). If the
log file's mtime exceeds 5 min without a new line, the daemon has
wedged. A separate watchdog could check this every 5 min and bounce pm2
if needed — but that's secondary; the upstream fix is keeping pm2 alive.
