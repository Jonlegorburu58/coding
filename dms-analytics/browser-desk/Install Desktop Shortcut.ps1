param([string]$PythonPath = '')
$ErrorActionPreference = 'Stop'
$appRoot = $PSScriptRoot
if (-not $PythonPath) {
    $PythonPath = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\python\pythonw.exe'
}
if (-not (Test-Path -LiteralPath $PythonPath)) { throw 'Python runtime not found. Pass -PythonPath with a Python 3.10+ executable.' }
$desktopPath = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktopPath 'BWS DMS Desk.lnk'
$localData = Join-Path $appRoot 'data'
New-Item -ItemType Directory -Path $localData -Force | Out-Null
$preparedShortcutPath = Join-Path $localData 'desktop-shortcut.lnk'
$shellObject = New-Object -ComObject WScript.Shell
$shortcut = $shellObject.CreateShortcut($preparedShortcutPath)
$shortcut.TargetPath = $PythonPath
$shortcut.Arguments = '"' + (Join-Path $appRoot 'launch.py') + '" --app'
$shortcut.WorkingDirectory = $appRoot
$shortcut.Description = 'Open BWS DMS Desk on this laptop'
$iconPath = Join-Path $appRoot 'app.ico'
if (Test-Path -LiteralPath $iconPath) { $shortcut.IconLocation = $iconPath + ',0' }
$shortcut.Save()
Copy-Item -LiteralPath $preparedShortcutPath -Destination $shortcutPath -Force
$verified = $shellObject.CreateShortcut($shortcutPath)
if ($verified.TargetPath -ne $PythonPath -or -not (Test-Path -LiteralPath $shortcutPath)) { throw 'Shortcut verification failed' }
[pscustomobject]@{Shortcut=$shortcutPath;Target=$verified.TargetPath;Arguments=$verified.Arguments;Verified=$true} | ConvertTo-Json
