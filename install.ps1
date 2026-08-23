<#
  BurnMeter one-line installer for Windows.

      irm https://raw.githubusercontent.com/OWNER/burnmeter/main/install.ps1 | iex

  Downloads the current release, installs it to ~/.claude/burnmeter, wires up
  the Claude Code statusline, and puts two shortcuts on your desktop.

  Nothing here needs admin rights, and nothing runs as a service.
  The repo is private, so you need a GitHub token with read access to it.
  Set it first, then run the installer:

      $env:BURNMETER_TOKEN = 'github_pat_...'
      irm https://raw.githubusercontent.com/OWNER/burnmeter/main/install.ps1 | iex

  The token is saved to ~/.claude/burnmeter/.token so updates keep working.
  Override the source with $env:BURNMETER_REPO = 'you/your-fork' first.
#>

$ErrorActionPreference = 'Stop'

$Repo   = if ($env:BURNMETER_REPO)   { $env:BURNMETER_REPO }   else { 'OWNER/burnmeter' }
$Branch = if ($env:BURNMETER_BRANCH) { $env:BURNMETER_BRANCH } else { 'main' }
$Dest   = Join-Path $HOME '.claude\burnmeter'

function Say($msg, $colour = 'Gray') { Write-Host $msg -ForegroundColor $colour }

Say ''
Say '  BurnMeter' Cyan
Say '  what your Claude Code usage is worth' DarkGray
Say ''

# --- Node ------------------------------------------------------------------
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Say '  Node.js is required and was not found on your PATH.' Red
  Say '  Install the LTS build from https://nodejs.org and run this again.' Yellow
  Say ''
  return
}
$nodeVer = (& node --version).TrimStart('v')
$major = [int]($nodeVer.Split('.')[0])
if ($major -lt 18) {
  Say "  Node $nodeVer found, but BurnMeter needs 18 or newer." Red
  Say '  Update from https://nodejs.org and run this again.' Yellow
  Say ''
  return
}
Say "  + Node $nodeVer"

# --- download --------------------------------------------------------------
$tmp = Join-Path $env:TEMP ("burnmeter-" + [guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
try {
  $zip = Join-Path $tmp 'src.zip'
  Say "  . downloading $Repo@$Branch"
  # With a token we go through the API, which is the only route that can read a
  # private repo. Without one we use the public zip endpoint.
  if ($Token) {
    $url = "https://api.github.com/repos/$Repo/zipball/$Branch"
    $headers = @{ Authorization = "Bearer $Token"; 'User-Agent' = 'burnmeter-installer' }
  } else {
    $url = "https://codeload.github.com/$Repo/zip/refs/heads/$Branch"
    $headers = @{ 'User-Agent' = 'burnmeter-installer' }
  }
  try {
    Invoke-WebRequest -Uri $url -Headers $headers -OutFile $zip -UseBasicParsing
  } catch {
    Say "  x could not download $Repo" Red
    Say "    $($_.Exception.Message)" DarkGray
    if (-not $Token) {
      Say '    If the repo is private, set a token first:' Yellow
      Say "      `$env:BURNMETER_TOKEN = 'github_pat_...'" DarkGray
    } else {
      Say '    Check the token has read access to this repo, and has not expired.' Yellow
    }
    return
  }

  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  $src = Get-ChildItem -Path $tmp -Directory | Select-Object -First 1
  if (-not $src) { Say '  x archive looked empty' Red; return }

  # --- install -------------------------------------------------------------
  Say '  . installing'
  & node (Join-Path $src.FullName 'install.js')
  if ($LASTEXITCODE -ne 0) { Say '  x install.js failed' Red; return }

  # Keep the token where the updater looks for it, so updates keep working.
  if ($Token) {
    Set-Content -Path (Join-Path $Dest '.token') -Value $Token -NoNewline -Encoding ascii
    Say '  + update token saved'
  }

  # Desktop shortcuts are generated from the installed copy, not the download,
  # so the launchers point at the right place.
  & node (Join-Path $Dest 'install-desktop.js')
}
finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

Say ''
Say '  Done.' Green
Say ''
Say '  Two icons are on your desktop:' Gray
Say '    BurnMeter         the full dashboard' DarkGray
Say '    BurnMeter Gauge   the small floating gauge' DarkGray
Say ''
Say '  Both start the background server on first launch, and it starts at login' DarkGray
Say '  from now on. Set your plan price in the dashboard header.' DarkGray
Say ''
Say '  Opening the gauge now...' Gray
Start-Process -FilePath (Join-Path $HOME 'Desktop\BurnMeter Gauge.lnk') -ErrorAction SilentlyContinue
Say ''
