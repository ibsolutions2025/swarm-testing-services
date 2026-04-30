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

## Auto-launch fix shipped (Phase E.1, 2026-04-29)

Default pm2 install on Windows does NOT register as a service. After a
reboot or logout, hlo-daemon stays down until someone manually runs
`pm2 resurrect`. Two outages in a 24h window made this Phase E priority 1.

**Shipped:** Task Scheduler entry `HLO-AutoResurrect` running
`scripts/auto-resurrect.ps1` at user logon. Native Windows, no extra
service deps.

**Files:**
- `C:\Users\isaia\.openclaw\hlo-daemon\scripts\auto-resurrect.ps1` —
  PowerShell wrapper. Sleeps 15s for networking + user services, runs
  `pm2 resurrect`, follows up with `pm2 list`. Logs everything to
  `logs/auto-resurrect.log` for boot-time auditing. Idempotent —
  re-running on top of a healthy pm2 is a no-op.
- Task Scheduler entry `HLO-AutoResurrect`:
  - Trigger: At logon (user `isaia`)
  - Action: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File <script>`
  - Settings: `AllowStartIfOnBatteries`, `DontStopIfGoingOnBatteries`,
    `StartWhenAvailable`, `ExecutionTimeLimit 5m`, `RestartCount 3` /
    `RestartInterval 1m` for transient-failure recovery
  - Principal: interactive logon, RunLevel `Limited` (no admin needed)

**Recreate from scratch:**
```powershell
$taskName = "HLO-AutoResurrect"
$scriptPath = "C:\Users\isaia\.openclaw\hlo-daemon\scripts\auto-resurrect.ps1"
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME `
  -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal
```

**Verification:** simulated post-boot by killing pm2 + triggering the
task manually:
```
pm2 kill                         # both pm2 + hlo-daemon down
Start-ScheduledTask -TaskName "HLO-AutoResurrect"
# 15s pre-resurrect delay + work + 5s post-list
# auto-resurrect.log shows: resurrect exit: 0
# pm2 list shows: hlo-daemon online
```

Logs (`logs/auto-resurrect.log`) record every boot for audit. If a
future boot doesn't bring HLO back, that's the first place to look.

## Other fix options considered (kept for record)

1. `pm2-installer` (npm package that registers pm2 as a Windows service)
   — heavier, more invasive, runs as SYSTEM rather than user, would
   complicate Spark wallet env-var inheritance.
2. Cowork session-start hook that pm2-resurrects if hlo-daemon isn't
   online — only runs when Cowork is open, doesn't help with reboots
   while Isaiah's away.

## Steady-state monitoring

Heartbeat: hlo-daemon writes one log line every 30s (the tick). If the
log file's mtime exceeds 5 min without a new line, the daemon has
wedged. A separate watchdog could check this every 5 min and bounce pm2
if needed — but that's secondary; the upstream fix is keeping pm2 alive.
