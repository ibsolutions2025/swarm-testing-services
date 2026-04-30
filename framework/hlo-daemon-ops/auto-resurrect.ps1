# auto-resurrect.ps1 - boot/logon hook for HLO daemon (Phase E.1).
#
# Registered as a Task Scheduler entry that fires at user logon. Brings
# hlo-daemon back up via pm2 resurrect after Windows reboots / logouts /
# resumes from sleep, where the pm2 daemon doesn't auto-relaunch on its
# own. See clients/.shared/HLO-OPS-NOTES.md for the outage history that
# motivated this.
#
# Idempotent: running on top of an already-running pm2 daemon is a no-op
# (resurrect re-applies the saved dump but doesn't duplicate processes).
#
# Logs to logs/auto-resurrect.log so we can audit boot-time behavior.

$ErrorActionPreference = "Continue"
$baseDir = "C:\Users\isaia\.openclaw\hlo-daemon"
$logFile = Join-Path $baseDir "logs\auto-resurrect.log"
$pm2Cmd  = "C:\Users\isaia\AppData\Roaming\npm\pm2.cmd"

function Log($msg) {
  $ts = Get-Date -Format "yyyy-MM-ddTHH:mm:ss"
  "$ts $msg" | Out-File -FilePath $logFile -Append -Encoding utf8
}

Log "=== auto-resurrect triggered (user=$env:USERNAME) ==="

# Brief delay so networking + user profile services are up before pm2
# tries to restore. Skip if you ever need faster boot - pm2 resurrect
# is generally robust to transient networking issues.
Start-Sleep -Seconds 15

# Sanity: pm2 binary present?
if (-not (Test-Path $pm2Cmd)) {
  Log "FATAL: pm2.cmd missing at $pm2Cmd - fix npm install path"
  exit 1
}

# Resurrect from saved dump.pm2. Output goes to log.
$resurrectOut = & $pm2Cmd resurrect 2>&1
$resurrectOut | Out-String | Out-File -FilePath $logFile -Append -Encoding utf8
Log "resurrect exit: $LASTEXITCODE"

# Quick health check: list pm2 processes 5s later.
Start-Sleep -Seconds 5
$listOut = & $pm2Cmd list 2>&1
$listOut | Out-String | Out-File -FilePath $logFile -Append -Encoding utf8
Log "=== auto-resurrect complete ==="
