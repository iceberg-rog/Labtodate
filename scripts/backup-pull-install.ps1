# Sets up the off-site copy of the lab2date backups on a Windows PC (docs/BACKUPS.md):
# copies backup-pull.sh to <Dest>\bin and registers the scheduled task "Labtodate backup pull"
# (08:30, 20:30 and 10 minutes after logon; a missed run starts as soon as the PC is on again).
#
#   powershell -ExecutionPolicy Bypass -File scripts\backup-pull-install.ps1 [-Dest D:\Labtodate-Backups]
#
# Run it as the Windows user whose SSH key (~/.ssh/id_ed25519) can log in to the server.
# Then store the encryption key once (it is never printed):
#   ssh root@87.107.206.76 cat /etc/lab2date-backup/key | "C:\Program Files\Git\bin\bash.exe" /d/Labtodate-Backups/bin/backup-pull.sh --import-key
param(
  [string]$Dest = 'D:\Labtodate-Backups',
  [string]$GitDir = 'C:\Program Files\Git',
  [string]$TaskName = 'Labtodate backup pull'
)
$ErrorActionPreference = 'Stop'
$bash = Join-Path $GitDir 'bin\bash.exe'
$cygpath = Join-Path $GitDir 'usr\bin\cygpath.exe'
if (-not (Test-Path $bash)) { throw "Git Bash not found at $bash (install Git for Windows or pass -GitDir)" }

New-Item -ItemType Directory -Force -Path (Join-Path $Dest 'bin'), (Join-Path $Dest 'archives') | Out-Null
$target = Join-Path $Dest 'bin\backup-pull.sh'
Copy-Item -Force (Join-Path $PSScriptRoot 'backup-pull.sh') $target
$posix = (& $cygpath -u $target).Trim()
$destPosix = (& $cygpath -u $Dest).Trim()

$user = "$env:USERDOMAIN\$env:USERNAME"
# conhost --headless: no console window pops up while it runs. It has no usable stdin/stdout,
# so both are redirected (coreutils fail on the bad handles); stderr goes to task-run.log.
# conhost always exits 0: the script alerts by itself (notification + desktop file + STATUS.txt).
$cmd = "'$posix' </dev/null >/dev/null 2>>'$destPosix/task-run.log'"
$action = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\conhost.exe" -Argument "--headless `"$bash`" -c `"$cmd`""
$logon = New-ScheduledTaskTrigger -AtLogOn -User $user
$logon.Delay = 'PT10M'
$triggers = @(
  (New-ScheduledTaskTrigger -Daily -At '08:30'),
  (New-ScheduledTaskTrigger -Daily -At '20:30'),
  $logon
)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RunOnlyIfNetworkAvailable -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 3) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Settings $settings -Principal $principal `
  -Description 'Pulls the encrypted lab2date backups from the server, verifies them and keeps 30 daily + 12 monthly. docs/BACKUPS.md' `
  -Force | Out-Null
Write-Output "installed $target and the scheduled task '$TaskName' (runs as $user)"
Write-Output "next: store the key with --import-key (see the top of this file), then: Start-ScheduledTask '$TaskName'"
