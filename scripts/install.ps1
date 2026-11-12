# Assistance d'installation du lanceur : état d'installation (horodatage),
# pièces attendues, test de fumée multimédia et consentement du raccourci.
#
# POURQUOI un module séparé ? Comme `consent.ps1`, ces décisions doivent être
# testables isolément : lecture d'un état CORROMPU, garde du raccourci (refus par
# défaut), commande exacte du test de fumée. Le lanceur ne fait que les enchaîner.

# ---------------------------------------------------------------------------
# Horodatage d'installation : `data/install.json` (déjà ignoré par git).
# ---------------------------------------------------------------------------

function Read-InstallState {
  param([string]$Path)
  # Un état ABSENT, ILLISIBLE ou CORROMPU vaut « premier lancement » : un fichier
  # tronqué ne doit JAMAIS faire planter le démarrage, et ne doit jamais non plus
  # passer pour un état valide.
  $result = @{ present = $false; data = $null; corrupted = $false }
  if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return $result }

  $raw = $null
  try { $raw = Get-Content -LiteralPath $Path -Raw -ErrorAction Stop } catch {
    $result.corrupted = $true
    return $result
  }
  if ([string]::IsNullOrWhiteSpace([string]$raw)) { $result.corrupted = $true; return $result }

  $data = $null
  try {
    # TrimStart du BOM : selon la façon dont le fichier a été produit, PowerShell
    # peut laisser le caractère de marque en tête et `ConvertFrom-Json` échouerait.
    $text = ([string]$raw).TrimStart([char]0xFEFF)
    $data = $text | ConvertFrom-Json -ErrorAction Stop
  } catch {
    $result.corrupted = $true
    return $result
  }
  # L'horodatage lui-même est la preuve attendue : sans lui, l'état est inutile.
  if (-not $data -or -not ($data.PSObject.Properties.Name -contains 'installedAt') -or -not $data.installedAt) {
    $result.corrupted = $true
    return $result
  }

  $result.present = $true
  $result.data = $data
  return $result
}

function Write-InstallState {
  param([string]$Path, [hashtable]$State)
  $dir = Split-Path -Parent $Path
  if ($dir) { try { $null = New-Item -ItemType Directory -Force -Path $dir -ErrorAction Stop } catch { } }
  $json = $State | ConvertTo-Json -Depth 4
  # Écriture UTF-8 SANS BOM : le fichier reste un JSON lisible par n'importe quel
  # outil, et `ConvertFrom-Json` le relit sans surprise au lancement suivant.
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $json, $encoding)
}

# ---------------------------------------------------------------------------
# Pièces attendues pour un démarrage sans installation
# ---------------------------------------------------------------------------

function Test-InstallPieces {
  param([string]$Root)
  $deps = (Test-Path -LiteralPath (Join-Path $Root 'node_modules\.bin\tsx.cmd')) -or
          (Test-Path -LiteralPath (Join-Path $Root 'node_modules\.bin\tsx'))
  $env = Test-Path -LiteralPath (Join-Path $Root '.env')
  $db = Test-Path -LiteralPath (Join-Path $Root 'data\chapters.db')
  return @{ deps = $deps; env = $env; db = $db; all = ($deps -and $env -and $db) }
}

# ---------------------------------------------------------------------------
# Raccourci du Bureau : DEMANDE explicite et DÉFAUT = REFUSER
# ---------------------------------------------------------------------------

function Read-ShortcutConsent {
  param([string]$Message = 'Creer un raccourci sur le Bureau ? (o/N)')
  # Même règle que les installations winget (voir consent.ps1) : par défaut on
  # refuse, et une entrée fermée (AutomationNull) refuse aussi. Rien ne s'écrit
  # hors du projet sans un « oui » clair.
  $answer = 'n'
  try { $answer = Read-Host $Message } catch { $answer = 'n' }
  return (Test-InstallConsent $answer)
}

# ---------------------------------------------------------------------------
# Test de fumée multimédia
# ---------------------------------------------------------------------------

function Get-MediaSmokeCommand {
  # Commande EXACTE du test : 1 s de silence encodée en mp3. Isolée pour être
  # vérifiable telle quelle (et pour que le diagnostic cite ce qui a été lancé).
  param([string]$OutputPath)
  return @('-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '1', '-c:a', 'libmp3lame', $OutputPath)
}

function Invoke-MediaSmokeTest {
  param([string]$TempDir)
  $output = Join-Path $TempDir 'smoke.mp3'
  $encodeArgs = Get-MediaSmokeCommand -OutputPath $output

  $encodeLog = @()
  try { $encodeLog = @(& ffmpeg @encodeArgs 2>&1) } catch { $encodeLog = @([string]$_) }
  # Une installation « essentials » amputée du codec mp3 répond à `-version` mais
  # échoue ici : c'est exactement le cas que ce test doit attraper.
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $output)) {
    return @{ ok = $false; phase = 'encodage'; output = $encodeLog }
  }

  $probeLog = @()
  try {
    $probeLog = @(& ffprobe -hide_banner -loglevel error -show_entries format=duration -of default=noprint_wrappers=1 $output 2>&1)
  } catch { $probeLog = @([string]$_) }
  if ($LASTEXITCODE -ne 0) {
    return @{ ok = $false; phase = 'relecture'; output = $probeLog }
  }

  return @{ ok = $true; phase = $null; output = @() }
}

# ---------------------------------------------------------------------------
# Renseignements d'horodatage
# ---------------------------------------------------------------------------

function Get-FfmpegVersion {
  # On capture TOUTE la sortie avant de prendre la première ligne : `Select-Object
  # -First 1` ferme le tube prématurément et fait échouer la commande native
  # (code de sortie non nul) — la version ressortait alors « inconnue ».
  try {
    $lines = @(& ffmpeg -version 2>&1)
    if ($LASTEXITCODE -ne 0 -or $lines.Count -eq 0) { return $null }
    $text = [string]$lines[0]
    $match = [regex]::Match($text, 'ffmpeg version (\S+)')
    if ($match.Success) { return $match.Groups[1].Value }
    return $text.Trim()
  } catch { return $null }
}

function Get-RepoRevision {
  param([string]$Root)
  try {
    $lines = @(& git -C $Root rev-parse HEAD 2>$null)
    if ($LASTEXITCODE -ne 0 -or $lines.Count -eq 0) { return $null }
    return ([string]$lines[0]).Trim()
  } catch { return $null }
}
