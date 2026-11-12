# Démarrage en un clic de yt-chapters (Windows PowerShell 5.1 et plus).
#
# Lancé par `Démarrer.cmd` (double-clic depuis l'Explorateur). Le script est
# IDEMPOTENT : on peut le relancer autant de fois que nécessaire, tout ce qui
# existe déjà est simplement signalé puis réutilisé.
#
# Il vérifie Node.js et ffmpeg/ffprobe, propose de les installer avec winget,
# installe les dépendances, prépare la configuration (.env, base de données),
# choisit un port libre, démarre le serveur en dupliquant sa sortie dans
# `logs/serveur-*.log`, écrit ses propres étapes dans `logs/demarrage-*.log`,
# attend que le serveur réponde puis ouvre le navigateur.
#
# PREMIER LANCEMENT : quand l'horodatage d'installation (`data/install.json`,
# ignoré par git) est absent — ou qu'une pièce manque (dépendances, `.env`,
# base) — une PHASE D'INSTALLATION complète est jouée, étape par étape. Les
# lancements suivants prennent le CHEMIN RAPIDE (vérification brève, sans rien
# réinstaller). Un état illisible ou corrompu retombe sur « premier lancement ».
#
# Options :
#   -Check         préflight SEUL : rapporte l'état (dont « premier lancement » ou
#                  « déjà installé ») et sort sans rien installer, sans démarrer le
#                  serveur, et sans écrire ailleurs que dans logs/. AUCUN effet de bord.
#   -NoBrowser     n'ouvre pas le navigateur.
#   -Port <n>      force le port indiqué (3000 par défaut, sinon le premier libre).
#   -ForceInstall  rejoue la phase d'installation même si l'horodatage existe
#                  (support et tests).
#   -InstallOnly  joue la phase d'installation puis s'arrête SANS démarrer le
#                  serveur (support et tests hors ligne).
param(
  [switch]$Check,
  [switch]$NoBrowser,
  [int]$Port = 0,
  [switch]$ForceInstall,
  [switch]$InstallOnly
)

$ErrorActionPreference = 'Continue'

# Sortie UTF-8 : les accents français restent lisibles dans la fenêtre comme
# dans un fichier de trace redirigé.
try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $OutputEncoding = [System.Text.Encoding]::UTF8
} catch { }

$script:Root = Split-Path -Parent $PSScriptRoot
$script:LogDir = Join-Path $script:Root 'logs'
$script:Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$script:LauncherLog = Join-Path $script:LogDir ("demarrage-$($script:Stamp).log")
# Horodatage d'installation : sa présence (avec les pièces en place) fait passer
# les lancements suivants par le chemin rapide.
$script:InstallStatePath = Join-Path $script:Root 'data\install.json'
$script:InstallReport = New-Object System.Collections.Generic.List[object]
$script:InstallPhaseRan = $false

# Consentement d'installation : la règle (« refus par défaut, seule une réponse
# affirmative installe ») vit dans `scripts/consent.ps1`, testable isolément.
. (Join-Path $PSScriptRoot 'consent.ps1')

# Détection du premier lancement, pièces attendues, test de fumée multimédia et
# garde du raccourci : `scripts/install.ps1` (testable isolément, lui aussi).
. (Join-Path $PSScriptRoot 'install.ps1')

# Le dossier des journaux est créé à la demande ; un échec n'arrête jamais le
# démarrage (on continue simplement sans trace fichier).
try { $null = New-Item -ItemType Directory -Force -Path $script:LogDir -ErrorAction Stop } catch { }

function Write-Log {
  param([string]$Message, [string]$Kind = 'INFO')
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') [$Kind] $Message"
  try { Add-Content -LiteralPath $script:LauncherLog -Value $line -Encoding UTF8 -ErrorAction SilentlyContinue } catch { }
}

function Say {
  param([string]$Message, [string]$Kind = 'INFO')
  $color = switch ($Kind) {
    'OK' { 'Green' }
    'MANQUANT' { 'Yellow' }
    'ERREUR' { 'Red' }
    'TITRE' { 'Cyan' }
    'INFO' { 'Gray' }
    default { 'Gray' }
  }
  Write-Host ("[{0}] {1}" -f $Kind, $Message) -ForegroundColor $color
  Write-Log $Message $Kind
}

function Say-Title {
  param([string]$Message)
  Write-Host ''
  Write-Host ("=== {0} ===" -f $Message) -ForegroundColor Cyan
  Write-Log $Message 'TITRE'
}

function Say-Raw {
  param([string]$Message)
  Write-Host $Message
  Write-Log $Message 'SORTIE'
}

function Open-Url {
  param([string]$Url)
  try { Start-Process $Url | Out-Null } catch {
    Write-Host ("Ouvrez cette adresse dans votre navigateur : {0}" -f $Url) -ForegroundColor Yellow
  }
}

# Recharge `PATH` depuis le registre : après une installation winget, le
# processus EN COURS ne voit pas le nouveau PATH (piège classique). On relit
# Machine + Utilisateur, on fusionne avec la valeur courante et on déduplique.
function Update-SessionPath {
  $parts = New-Object System.Collections.Generic.List[string]
  foreach ($scope in @('Machine', 'User')) {
    try {
      $value = [Environment]::GetEnvironmentVariable('Path', $scope)
      if ($value) { foreach ($p in $value.Split(';')) { if ($p.Trim()) { $parts.Add($p.Trim()) } } }
    } catch { }
  }
  foreach ($p in ([string]$env:PATH).Split(';')) { if ($p.Trim()) { $parts.Add($p.Trim()) } }
  $unique = New-Object System.Collections.Generic.List[string]
  foreach ($p in $parts) { if (-not $unique.Contains($p)) { $unique.Add($p) } }
  $env:PATH = ($unique -join ';')
}

function Get-NodeInfo {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $cmd) { return @{ ok = $false; version = $null; major = 0 } }
  $raw = ''
  try { $raw = (& node --version 2>$null | Select-Object -First 1) } catch { return @{ ok = $false; version = $null; major = 0 } }
  $text = ([string]$raw).Trim().TrimStart('v')
  $major = 0
  try { $major = [int]($text.Split('.')[0]) } catch { $major = 0 }
  return @{ ok = ($major -ge 20); version = $text; major = $major }
}

function Test-CommandAvailable {
  param([string]$Name)
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Invoke-Npm {
  param([string[]]$Arguments, [string]$Label)
  Say-Raw ("> npm " + ($Arguments -join ' '))
  $output = & npm @Arguments 2>&1
  $code = $LASTEXITCODE
  # Sortie conservée pour les diagnostics (« pourquoi db:push a échoué ? »).
  $script:LastNpmOutput = @()
  foreach ($line in $output) {
    $text = if ($line -is [System.Management.Automation.ErrorRecord]) { $line.ToString() } else { [string]$line }
    $script:LastNpmOutput += $text
    Write-Host $text
    Write-Log $text 'NPM'
  }
  if ($code -ne 0) { Write-Host ("{0} : code de sortie {1}" -f $Label, $code) -ForegroundColor Yellow }
  return $code
}

function Test-PortFree {
  param([int]$P)
  if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
    try {
      $used = Get-NetTCPConnection -State Listen -LocalPort $P -ErrorAction SilentlyContinue
      if ($used) { return $false }
      return $true
    } catch { }
  }
  # Repli (pas de cmdlet réseau) : liaison éphémère puis libération immédiate.
  try {
    $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $P)
    $listener.Start()
    $listener.Stop()
    return $true
  } catch {
    return $false
  }
}

function Select-Port {
  if ($Port -gt 0) {
    if (Test-PortFree -P $Port) { return @{ port = $Port; forced = $true; free = $true } }
    return @{ port = $Port; forced = $true; free = $false }
  }
  for ($p = 3000; $p -le 3010; $p++) {
    if (Test-PortFree -P $p) { return @{ port = $p; forced = $false; free = $true } }
  }
  return @{ port = 3000; forced = $false; free = $false }
}

function Show-StartupLogPath {
  Say ("Journaux de ce démarrage : {0}" -f $script:LogDir)
}

# ---------------------------------------------------------------------------
# Premier lancement / chemin rapide
# ---------------------------------------------------------------------------

# Décide du mode : la phase d'installation est jouée si l'horodatage manque, si
# une pièce manque, ou si `-ForceInstall` est demandé. Un état corrompu vaut
# « premier lancement » (voir Read-InstallState).
function Get-LaunchMode {
  param([string]$Root, [string]$StatePath, [bool]$ForceInstall)
  $state = Read-InstallState -Path $StatePath
  $pieces = Test-InstallPieces -Root $Root
  $firstLaunch = (-not $state.present) -or (-not $pieces.all)
  return @{
    firstLaunch = $firstLaunch
    state = $state
    pieces = $pieces
    installPhase = ($ForceInstall -or $firstLaunch)
  }
}

# Clé OpenRouter configurée ? La source de vérité est le SERVEUR (il résout la
# clé en base PUIS dans `.env`) ; hors serveur (mode -InstallOnly), on lit `.env`
# avec les mêmes règles d'exemple que le résolveur TypeScript.
function Get-KeyConfigured {
  param([int]$ServerPort = 0)
  if ($ServerPort -gt 0) {
    try {
      $health = Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/local/health" -f $ServerPort) -TimeoutSec 3 -ErrorAction Stop
      if ($health -and $health.openrouterKey) { return [bool]$health.openrouterKey.ok }
    } catch { }
  }
  return Test-KeyConfiguredFromEnv -EnvFile (Join-Path $script:Root '.env')
}

function Test-KeyConfiguredFromEnv {
  param([string]$EnvFile)
  if (-not $EnvFile -or -not (Test-Path -LiteralPath $EnvFile)) { return $false }
  $lines = @()
  try { $lines = @(Get-Content -LiteralPath $EnvFile -ErrorAction Stop) } catch { return $false }
  foreach ($line in $lines) {
    if ($line -match '^\s*OPENROUTER_API_KEY\s*=\s*(.*)$') {
      $value = $Matches[1].Trim().Trim('"').Trim("'")
      if (-not $value) { return $false }
      if ($value.Length -lt 20) { return $false }
      if ($value.Contains('...') -or $value.Contains([char]0x2026)) { return $false }
      if ($value -match '(?i)(votre|your|change|remplace|replace|exemple|example|placeholder|todo|xxx)') { return $false }
      return $true
    }
  }
  return $false
}

function Add-InstallReport {
  param([string]$Label, [string]$Status)
  $null = $script:InstallReport.Add(@{ label = $Label; status = $Status })
}

function Show-InstallSummary {
  param([bool]$KeyConfigured, [int]$ServerPort, [bool]$ServerReady = $true, [switch]$InstallOnlyMode)
  Say-Title 'Résumé de l installation'
  Say 'Ce qui a été préparé (installé ou déjà présent) :' 'INFO'
  foreach ($item in $script:InstallReport) { Say ("  - {0} : {1}" -f $item.label, $item.status) 'INFO' }
  # Une URL de serveur n'est affichée QUE si un serveur tourne réellement sur un
  # port valide : jamais « :0 », jamais d'adresse quand rien n'écoute.
  $showUrl = ($ServerReady -and $ServerPort -gt 0)
  if ($KeyConfigured) {
    if ($showUrl) {
      Say ("Étape suivante : ouvrez http://127.0.0.1:{0}/ et lancez un chapitrage." -f $ServerPort) 'OK'
    } elseif ($InstallOnlyMode) {
      Say 'Étape suivante : démarrez le serveur (Demarrer.cmd), puis ouvrez la page principale.' 'OK'
    } else {
      Say 'Étape suivante : corrigez la cause ci-dessus, puis relancez Demarrer.cmd.' 'OK'
    }
  } else {
    if ($showUrl) {
      Say ("Étape suivante : aucune clé OpenRouter n est configurée. Ouvrez http://127.0.0.1:{0}/admin, collez votre clé, puis cliquez Enregistrer et Tester." -f $ServerPort) 'MANQUANT'
    } elseif ($InstallOnlyMode) {
      Say 'Étape suivante : aucune clé OpenRouter n est configurée. Démarrez le serveur (Demarrer.cmd), puis ouvrez /admin pour la renseigner.' 'MANQUANT'
    } else {
      Say 'Étape suivante : aucune clé OpenRouter n est configurée. Une fois le serveur démarré, ouvrez /admin pour la renseigner.' 'MANQUANT'
    }
  }
}

# Création du raccourci du Bureau : réservée à une réponse affirmative explicite
# (`Read-ShortcutConsent`), et JAMAIS atteinte en mode `-Check` (Invoke-Check ne
# l appelle pas). Rien ne s écrit hors du projet sans un « oui » clair.
function New-DesktopShortcut {
  $desktop = [Environment]::GetFolderPath('Desktop')
  $target = Join-Path $script:Root 'Demarrer.cmd'
  if (-not $desktop -or -not (Test-Path -LiteralPath $desktop) -or -not (Test-Path -LiteralPath $target)) { return $null }
  $linkPath = Join-Path $desktop 'yt-chapters.lnk'
  try {
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut($linkPath)
    $link.TargetPath = $target
    $link.WorkingDirectory = $script:Root
    $link.Description = 'Demarrer yt-chapters'
    $link.Save()
    return $linkPath
  } catch { return $null }
}

# ---------------------------------------------------------------------------
# Phase d'installation complète (premier lancement, ou -ForceInstall)
# ---------------------------------------------------------------------------

# Chaque étape est IDEMPOTENTE : si elle est déjà faite, elle est signalée puis
# SAUTÉE. Renvoie 0 en cas de succès, un code non nul si le démarrage doit
# s'arrêter (test de fumée en échec, base impossible à créer…).
function Invoke-InstallPhase {
  param([string]$Trigger)

  if ($Trigger -eq 'force') {
    Say 'Phase d installation demandée (-ForceInstall) : les étapes déjà faites sont signalées puis sautées.' 'INFO'
  } else {
    Say 'Premier lancement : installation complète, étape par étape.' 'INFO'
  }

  # ---------- a. dossiers d'exécution ----------
  Say-Title 'Installation : dossiers d exécution'
  foreach ($dir in @((Join-Path $script:Root 'data'), $script:LogDir)) {
    $existed = Test-Path -LiteralPath $dir
    try { $null = New-Item -ItemType Directory -Force -Path $dir -ErrorAction Stop } catch {
      Say ("Dossier inutilisable : {0}" -f $dir) 'ERREUR'
      return 1
    }
    if ($existed) { Say ("Dossier déjà présent : {0}" -f $dir) 'OK' }
    else { Say ("Dossier créé : {0}" -f $dir) 'OK' }
  }
  Add-InstallReport 'Dossiers' 'data\ et logs\ disponibles'

  # ---------- b. dépendances ----------
  Say-Title 'Installation : dépendances'
  $tsx = (Test-Path -LiteralPath (Join-Path $script:Root 'node_modules\.bin\tsx.cmd')) -or
         (Test-Path -LiteralPath (Join-Path $script:Root 'node_modules\.bin\tsx'))
  if ($tsx) {
    Say 'Dépendances déjà installées (node_modules/.bin/tsx présent) — étape sautée.' 'OK'
    Add-InstallReport 'Dépendances' 'déjà présentes'
  } else {
    Say 'Installation des dépendances…' 'INFO'
    Push-Location -LiteralPath $script:Root
    try {
      # `npm ci` exige un verrou ; s'il est absent, on passe directement à
      # `npm install`. Un échec de `npm ci` (verrou périmé) retombe aussi dessus.
      if (Test-Path -LiteralPath (Join-Path $script:Root 'package-lock.json')) {
        $code = Invoke-Npm -Arguments @('ci') -Label 'npm ci'
        if ($code -ne 0) {
          Say 'npm ci a échoué : nouvel essai avec npm install.' 'MANQUANT'
          $code = Invoke-Npm -Arguments @('install') -Label 'npm install'
        }
      } else {
        Say 'Verrou absent (package-lock.json) : installation avec npm install.' 'INFO'
        $code = Invoke-Npm -Arguments @('install') -Label 'npm install'
      }
    } finally {
      Pop-Location
    }
    if ($code -ne 0) {
      Say "L'installation des dépendances a échoué. Vérifiez votre connexion Internet, puis relancez ce fichier." 'ERREUR'
      [void](Read-Host)
      return 1
    }
    Say 'Dépendances installées.' 'OK'
    Add-InstallReport 'Dépendances' 'installées'
  }

  # ---------- c. configuration (.env) ----------
  Say-Title 'Installation : configuration (.env)'
  $envFile = Join-Path $script:Root '.env'
  if (Test-Path -LiteralPath $envFile) {
    Say 'Fichier .env déjà présent — étape sautée.' 'OK'
    Add-InstallReport '.env' 'déjà présent'
  } else {
    $example = Join-Path $script:Root '.env.example'
    if (Test-Path -LiteralPath $example) {
      try {
        Copy-Item -LiteralPath $example -Destination $envFile -ErrorAction Stop
        Say 'Fichier .env créé depuis .env.example (la clé se renseigne dans /admin).' 'OK'
        Add-InstallReport '.env' 'créé depuis .env.example'
      } catch {
        Say 'Impossible de créer le fichier .env : la suite continue avec les valeurs par défaut.' 'MANQUANT'
        Add-InstallReport '.env' 'non créé (valeurs par défaut)'
      }
    } else {
      Say 'Fichier .env.example absent : la suite continue avec les valeurs par défaut.' 'MANQUANT'
      Add-InstallReport '.env' 'non créé (.env.example absent)'
    }
  }

  # ---------- d. base de données ----------
  Say-Title 'Installation : base de données'
  $dbFile = Join-Path $script:Root 'data\chapters.db'
  if (Test-Path -LiteralPath $dbFile) {
    Say 'Base de données déjà présente (data/chapters.db) — étape sautée.' 'OK'
    Add-InstallReport 'Base de données' 'déjà présente'
  } else {
    Say 'Base de données absente : application du schéma (npm run db:push)…' 'INFO'
    Push-Location -LiteralPath $script:Root
    try {
      # Arguments passés SÉPARÉMENT (`run`, `db:push`) : les joindre en une seule
      # chaîne ferait répondre « Unknown command: "run db:push" » à npm.
      $dbCode = Invoke-Npm -Arguments @('run', 'db:push') -Label 'npm run db:push'
    } finally {
      Pop-Location
    }
    if ($dbCode -ne 0) {
      # Ne JAMAIS démarrer sur une base sans schéma : l'erreur serait ensuite
      # attribuée à tort au serveur (« il ne repond pas »). On explique et on stop.
      Say ("La création du schéma a échoué (npm run db:push, code {0}) : le serveur ne sera PAS demarre." -f $dbCode) 'ERREUR'
      Say 'Dernières lignes de la commande :' 'INFO'
      foreach ($line in ($script:LastNpmOutput | Select-Object -Last 10)) { Write-Host $line }
      Say 'Corrigez la cause ci-dessus (droits d ecriture sur data\, connexion Internet), puis relancez Demarrer.cmd.' 'ERREUR'
      [void](Read-Host)
      return 1
    }
    Say 'Schéma appliqué (data/chapters.db).' 'OK'
    Add-InstallReport 'Base de données' 'schéma appliqué'
  }

  # ---------- e. test de fumée multimédia ----------
  Say-Title 'Installation : test de la chaîne multimédia'
  $smokeDir = $null
  try {
    $smokeDir = Join-Path ([System.IO.Path]::GetTempPath()) ("ckr-smoke-" + [System.Guid]::NewGuid().ToString('N'))
    $null = New-Item -ItemType Directory -Force -Path $smokeDir -ErrorAction Stop
  } catch { $smokeDir = $null }

  $smoke = @{ ok = $false; phase = 'preparation'; output = @() }
  if ($smokeDir) {
    Say 'Encodage de 1 s de silence en mp3 (ffmpeg), puis relecture (ffprobe)…' 'INFO'
    $smoke = Invoke-MediaSmokeTest -TempDir $smokeDir
    try { Remove-Item -LiteralPath $smokeDir -Recurse -Force -ErrorAction SilentlyContinue } catch { }
  }
  if (-not $smoke.ok) {
    # Tout le chapitrage local dépend de cette capacité : on s'arrête ICI, avant
    # de démarrer un serveur qui échouerait à chaque découpage.
    Say 'Votre installation de ffmpeg est incomplète : elle ne sait pas encoder en mp3.' 'ERREUR'
    Say ("Le test a échoué pendant la phase « {0} » : le chapitrage local en depend." -f $smoke.phase) 'ERREUR'
    Say 'Réinstallez FFmpeg (winget install --id Gyan.FFmpeg -e) ou téléchargez « ffmpeg-release-full » sur https://www.gyan.dev/ffmpeg/builds/, puis relancez Demarrer.cmd.' 'INFO'
    foreach ($line in @($smoke.output)) { Write-Log ("smoke: " + [string]$line) 'SMOKE' }
    Add-InstallReport 'Test multimédia' ("ÉCHEC (" + $smoke.phase + " mp3)")
    return 1
  }
  Say 'Test réussi : ffmpeg a encodé le mp3 et ffprobe l a relu.' 'OK'
  Add-InstallReport 'Test multimédia' 'réussi (mp3 encodé puis relu)'

  # ---------- f. horodatage d'installation ----------
  Say-Title 'Installation : horodatage'
  $nodeInfo = Get-NodeInfo
  $ffmpegVersion = Get-FfmpegVersion
  $revision = Get-RepoRevision -Root $script:Root
  $shortRev = if ($revision) { $revision.Substring(0, [Math]::Min(7, $revision.Length)) } else { 'inconnue' }
  $state = @{
    installedAt = (Get-Date).ToUniversalTime().ToString('o')
    node = $nodeInfo.version
    ffmpeg = $ffmpegVersion
    revision = $revision
  }
  try {
    Write-InstallState -Path $script:InstallStatePath -State $state
    Say ("Horodatage écrit dans {0} (Node {1}, ffmpeg {2}, révision {3})." -f $script:InstallStatePath, $nodeInfo.version, ($(if ($ffmpegVersion) { $ffmpegVersion } else { 'inconnue' })), $shortRev) 'OK'
    Add-InstallReport 'Horodatage' 'écrit (data\install.json)'
  } catch {
    Say 'Impossible d écrire l horodatage : il sera retenté au prochain lancement.' 'MANQUANT'
    Add-InstallReport 'Horodatage' 'non écrit (nouvel essai au prochain lancement)'
  }

  # ---------- g. raccourci du Bureau (optionnel) ----------
  Say-Title 'Installation : raccourci (optionnel)'
  if (Read-ShortcutConsent -Message 'Creer un raccourci « yt-chapters » sur le Bureau ? (o/N)') {
    $created = New-DesktopShortcut
    if ($created) {
      Say ("Raccourci créé : {0}" -f $created) 'OK'
      Add-InstallReport 'Raccourci Bureau' 'créé'
    } else {
      Say 'Le raccourci n a pas pu être créé (sans conséquence sur le démarrage).' 'MANQUANT'
      Add-InstallReport 'Raccourci Bureau' 'non créé'
    }
  } else {
    Say 'Raccourci du Bureau ignoré (refus par défaut : rien ne s écrit hors du projet sans un oui clair).' 'OK'
    Add-InstallReport 'Raccourci Bureau' 'ignoré (refus)'
  }

  return 0
}

# ---------------------------------------------------------------------------
# Préflight : lecture seule, aucune installation, aucun démarrage.
# ---------------------------------------------------------------------------
function Invoke-Check {
  $node = Get-NodeInfo
  if ($node.ok) {
    Say ("Node.js {0} (20 minimum requis)" -f $node.version) 'OK'
  } elseif ($node.version) {
    Say ("Node.js {0} est trop ancien : 20 minimum requis" -f $node.version) 'MANQUANT'
  } else {
    Say 'Node.js introuvable dans le PATH (20 minimum requis)' 'MANQUANT'
  }

  $ffmpeg = Test-CommandAvailable 'ffmpeg'
  $ffprobe = Test-CommandAvailable 'ffprobe'
  if ($ffmpeg) { Say 'ffmpeg trouve' 'OK' } else { Say 'ffmpeg introuvable' 'MANQUANT' }
  if ($ffprobe) { Say 'ffprobe trouve' 'OK' } else { Say 'ffprobe introuvable' 'MANQUANT' }

  $tsx = (Test-Path -LiteralPath (Join-Path $script:Root 'node_modules\.bin\tsx.cmd')) -or
         (Test-Path -LiteralPath (Join-Path $script:Root 'node_modules\.bin\tsx'))
  if ($tsx) {
    Say 'Dependances installees (node_modules/.bin/tsx present)' 'OK'
  } else {
    Say 'Dependances absentes : npm ci sera lance au demarrage' 'MANQUANT'
  }

  $envFile = Join-Path $script:Root '.env'
  if (Test-Path -LiteralPath $envFile) {
    Say 'Fichier .env present' 'OK'
  } else {
    Say 'Fichier .env absent : il sera cree depuis .env.example au demarrage' 'MANQUANT'
  }

  $dbFile = Join-Path $script:Root 'data\chapters.db'
  if (Test-Path -LiteralPath $dbFile) {
    Say 'Base de donnees presente (data/chapters.db)' 'OK'
  } else {
    Say 'Base de donnees absente (data/chapters.db) : npm run db:push sera lance au demarrage' 'MANQUANT'
  }

  $choice = Select-Port
  if ($choice.forced) {
    if ($choice.free) { Say ("Port force {0} : libre" -f $choice.port) 'OK' }
    else { Say ("Port force {0} : deja utilise" -f $choice.port) 'MANQUANT' }
  } elseif ($choice.free) {
    Say ("Port {0} : libre (il sera utilise)" -f $choice.port) 'OK'
  } else {
    Say 'Aucun port libre entre 3000 et 3010' 'MANQUANT'
  }

  $mode = Get-LaunchMode -Root $script:Root -StatePath $script:InstallStatePath -ForceInstall ([bool]$ForceInstall)
  if ($mode.state.corrupted) {
    Say "Fichier d'état d'installation illisible ou corrompu : traité comme un premier lancement." 'MANQUANT'
  }
  if ($ForceInstall) {
    Say 'Premier lancement forcé (-ForceInstall) : la phase d installation serait rejouée.' 'INFO'
  } elseif ($mode.firstLaunch) {
    Say 'Premier lancement : la phase d installation sera jouée au démarrage.' 'INFO'
  } else {
    Say 'Déjà installé : le démarrage passera par le chemin rapide.' 'OK'
  }

  Show-StartupLogPath
  Say 'Preflight termine : rien n a ete installe ni demarre.' 'OK'
  Write-Host ''
  return 0
}

# ---------------------------------------------------------------------------
# Démarrage réel
# ---------------------------------------------------------------------------
function Invoke-Start {
  Say-Title 'Demarrage de yt-chapters'
  Say ("Dossier du projet : {0}" -f $script:Root)

  # ---------- 1. Node.js ----------
  $nodeWasInstalled = $false
  $ffmpegWasInstalled = $false
  $node = Get-NodeInfo
  if (-not $node.ok) {
    $reason = if ($node.version) { "Node.js $($node.version) est trop ancien (20 minimum requis)." } else { 'Node.js est introuvable sur cet ordinateur (20 minimum requis).' }
    Say $reason 'MANQUANT'

    if (-not (Test-CommandAvailable 'winget')) {
      Say "winget n'est pas disponible : impossible d'installer automatiquement." 'ERREUR'
      Say "Telechargez Node.js LTS sur https://nodejs.org/fr/download, installez-le, puis relancez ce fichier." 'ERREUR'
      Open-Url 'https://nodejs.org/fr/download'
      Say 'Fenetre laissee ouverte pour lire le message. Appuyez sur Entree pour fermer.' 'INFO'
      [void](Read-Host)
      return 1
    }

    # Consentement : DÉFAUT = REFUSER. La décision est prise par
    # `Test-InstallConsent` (voir scripts/consent.ps1) : elle convertit la réponse
    # en chaîne, sinon un `Read-Host` sans entrée (AutomationNull) passerait
    # pour une valeur fausse et l'installation se ferait sans consentement.
    $answer = 'n'
    try { $answer = Read-Host 'Installer Node.js LTS maintenant avec winget ? (o/N)' } catch { $answer = 'n' }
    if (-not (Test-InstallConsent $answer)) {
      Say 'Installation refusee.' 'ERREUR'
      Say "Telechargez Node.js LTS sur https://nodejs.org/fr/download, installez-le, puis relancez ce fichier." 'ERREUR'
      Open-Url 'https://nodejs.org/fr/download'
      [void](Read-Host)
      return 1
    }

    Say-Raw '> winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements'
    & winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements 2>&1 | ForEach-Object {
      Write-Host $_; Write-Log ([string]$_) 'WINGET'
    }
    # Le processus courant ne voit pas le nouveau PATH : relecture du registre.
    Update-SessionPath
    $node = Get-NodeInfo
    if (-not $node.ok) {
      Say "Node.js n'est toujours pas utilisable dans cette fenetre." 'MANQUANT'
      Open-Url 'https://nodejs.org/fr/download'
      Say 'Installez Node.js LTS depuis la page ouverte, puis relancez Demarrer.cmd (ou fermez cette fenetre et double-cliquez de nouveau : le nouveau PATH sera pris en compte).' 'MANQUANT'
      [void](Read-Host)
      return 1
    }
    $nodeWasInstalled = $true
  }
  Say ("Node.js {0}" -f $node.version) 'OK'

  # ---------- 2. ffmpeg / ffprobe ----------
  $ffmpeg = Test-CommandAvailable 'ffmpeg'
  $ffprobe = Test-CommandAvailable 'ffprobe'
  if (-not ($ffmpeg -and $ffprobe)) {
    $missing = @()
    if (-not $ffmpeg) { $missing += 'ffmpeg' }
    if (-not $ffprobe) { $missing += 'ffprobe' }
    Say ("{0} introuvable(s) : le chapitrage local ne peut pas fonctionner sans eux." -f ($missing -join ' et ')) 'MANQUANT'

    $installed = $false
    if (Test-CommandAvailable 'winget') {
      # Même règle de consentement que pour Node.js (refus par défaut, et
      # AutomationNull refuse : voir scripts/consent.ps1).
      $answer = 'n'
      try { $answer = Read-Host ("Installer {0} maintenant avec winget ? (o/N)" -f ($missing -join ' et ')) } catch { $answer = 'n' }
      if (-not (Test-InstallConsent $answer)) {
        Say ("Installation de {0} refusee : l installation manuelle est expliquee ci-dessous." -f ($missing -join ' et ')) 'MANQUANT'
      } else {
        Say-Raw '> winget install --id Gyan.FFmpeg -e --accept-source-agreements --accept-package-agreements'
        & winget install --id Gyan.FFmpeg -e --accept-source-agreements --accept-package-agreements 2>&1 | ForEach-Object {
          Write-Host $_; Write-Log ([string]$_) 'WINGET'
        }
        Update-SessionPath
        $ffmpeg = Test-CommandAvailable 'ffmpeg'
        $ffprobe = Test-CommandAvailable 'ffprobe'
        $installed = ($ffmpeg -and $ffprobe)
      }
    }

    if (-not $installed) {
      Say "ffmpeg et ffprobe restent introuvables : installez-les manuellement." 'ERREUR'
      Say 'Telechargez « ffmpeg-release-full.7z » (ou « essentials ») sur https://www.gyan.dev/ffmpeg/builds/' 'INFO'
      Say 'Decompressez l archive, puis ajoutez le dossier « bin » au PATH (variables d environnement), et relancez ce fichier.' 'INFO'
      Open-Url 'https://www.gyan.dev/ffmpeg/builds/'
      Say 'Fermez cette fenetre, puis double-cliquez de nouveau sur Demarrer.cmd apres installation.' 'MANQUANT'
      [void](Read-Host)
      return 1
    }
    Say 'ffmpeg et ffprobe sont maintenant disponibles.' 'OK'
    $ffmpegWasInstalled = $true
  } else {
    Say 'ffmpeg et ffprobe trouves' 'OK'
  }

  # ---------- 3. Premier lancement ou chemin rapide ----------
  # La phase d'installation est jouée si l'horodatage manque, si une pièce manque
  # (dépendances, .env, base) ou si `-ForceInstall` est demandé. Sinon, on prend
  # le chemin rapide : rien n'est réinstallé, l'horodatage n'est pas réécrit.
  $mode = Get-LaunchMode -Root $script:Root -StatePath $script:InstallStatePath -ForceInstall ([bool]$ForceInstall)
  if ($mode.state.corrupted) {
    Say "Fichier d'état d'installation illisible ou corrompu : traité comme un premier lancement." 'MANQUANT'
  }

  if ($mode.installPhase) {
    $trigger = if ($ForceInstall) { 'force' } else { 'premier-lancement' }
    Add-InstallReport 'Node.js' ($(if ($nodeWasInstalled) { "installé (winget), version $($node.version)" } else { "présent, version $($node.version)" }))
    Add-InstallReport 'ffmpeg/ffprobe' ($(if ($ffmpegWasInstalled) { 'installés (winget)' } else { 'présents' }))
    $code = Invoke-InstallPhase -Trigger $trigger
    if ($code -ne 0) { return $code }
    $script:InstallPhaseRan = $true
  } else {
    Say-Title 'Chemin rapide : déjà installé'
    # Pièces forcément en place ici (sinon on serait en phase d'installation) : on
    # n'annonce donc jamais une pièce absente. En revanche, Node/ffmpeg ont pu
    # être installés PENDANT ce lancement (winget) : le résumé doit le dire.
    Say ("Node.js {0}, ffmpeg/ffprobe presents, dependances, .env et base en place" -f $node.version) 'OK'
    Say 'Installation deja faite : aucune etape rejouee, horodatage inchange.' 'OK'
    Add-InstallReport 'Node.js' ($(if ($nodeWasInstalled) { "installe (winget), version $($node.version)" } else { "present, version $($node.version)" }))
    Add-InstallReport 'ffmpeg/ffprobe' ($(if ($ffmpegWasInstalled) { 'installes (winget)' } else { 'presents' }))
    Add-InstallReport 'Dependances' 'deja presentes'
    Add-InstallReport '.env' 'deja present'
    Add-InstallReport 'Base de donnees' 'deja presente'
    Add-InstallReport 'Installation' 'deja faite (chemin rapide)'
    $script:InstallPhaseRan = $false
  }

  # ---------- 3bis. Arrêt après installation (-InstallOnly) ----------
  if ($InstallOnly) {
    # Aucun serveur ne tourne : le résumé ne doit afficher AUCUNE URL de serveur
    # (ni un port 0), mais désigner /admin quand la clé manque.
    $keyOnly = Get-KeyConfigured -ServerPort 0
    Say-Title 'Mode installation seule (-InstallOnly) : le serveur n est pas demarre'
    Show-InstallSummary -KeyConfigured $keyOnly -ServerPort 0 -ServerReady $false -InstallOnlyMode
    Show-StartupLogPath
    return 0
  }

  # ---------- 6. Port ----------
  $choice = Select-Port
  if (-not $choice.free) {
    if ($choice.forced) {
      Say ("Le port {0} est deja utilise. Fermez le programme qui l occupe, ou relancez avec -Port <autre port>." -f $choice.port) 'ERREUR'
    } else {
      Say 'Aucun port libre entre 3000 et 3010. Fermez les programmes qui les occupent, puis relancez.' 'ERREUR'
    }
    [void](Read-Host)
    return 1
  }
  $port = $choice.port
  Say ("Port {0} libre : le serveur sera joignable sur http://127.0.0.1:{0}/" -f $port) 'OK'

  # ---------- 7. Démarrage + duplication des journaux ----------
  $serverLog = Join-Path $script:LogDir ("serveur-$($script:Stamp).log")
  $inner = @"
`$ErrorActionPreference = 'Continue'
`$env:PORT = '$port'
Set-Location -LiteralPath '$($script:Root)'
& npm start 2>&1 | Tee-Object -FilePath '$serverLog'
"@
  $encoded = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($inner))
  Say ("Demarrage du serveur (sortie visible ici ET enregistree dans {0})" -f $serverLog) 'INFO'

  $server = $null
  try {
    $server = Start-Process -FilePath 'powershell.exe' `
      -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $encoded) `
      -WorkingDirectory $script:Root -NoNewWindow -PassThru

    # ---------- 8. Attente de disponibilité puis navigateur ----------
    $url = "http://127.0.0.1:$port/"
    $healthUrl = "http://127.0.0.1:$port/local/health"
    $ready = $false
    for ($i = 0; $i -lt 60; $i++) {
      if ($server.HasExited) { break }
      try {
        $response = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
        if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300) { $ready = $true; break }
      } catch { }
      Start-Sleep -Milliseconds 500
    }

    if (-not $ready) {
      Say "Le serveur n'a pas repondu dans les 30 secondes." 'ERREUR'
      if (Test-Path -LiteralPath $serverLog) {
        Say 'Dernieres lignes du journal du serveur :' 'INFO'
        Get-Content -LiteralPath $serverLog -Tail 25 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
        $tail = (Get-Content -LiteralPath $serverLog -Tail 25 -ErrorAction SilentlyContinue) -join "`n"
        if ($tail -match 'EADDRINUSE') { Say ("Diagnostic : le port {0} est deja occupe par un autre programme." -f $port) 'ERREUR' }
        elseif ($tail -match 'ffmpeg|ENOENT') { Say 'Diagnostic : ffmpeg/ffprobe introuvable pour ce processus.' 'ERREUR' }
        elseif ($tail -match 'SQLITE_BUSY|database is locked') { Say 'Diagnostic : la base de donnees est verrouillee par un autre programme.' 'ERREUR' }
        else { Say 'Diagnostic : consultez le journal ci-dessus (cause exacte en anglais).' 'ERREUR' }
      }
      if ($script:InstallPhaseRan) { Show-InstallSummary -KeyConfigured (Get-KeyConfigured -ServerPort 0) -ServerPort $port -ServerReady $false }
      [void](Read-Host)
      return 1
    }

    # Page d'accueil : /admin quand AUCUNE clé n'est configurée (c'est la seule
    # action utile à ce moment), la page principale sinon. L'état vient du
    # serveur lui-même (/local/health), donc de la vraie résolution base + .env.
    $keyConfigured = Get-KeyConfigured -ServerPort $port
    $openUrl = if ($keyConfigured) { $url } else { "http://127.0.0.1:$port/admin" }
    Say ("Serveur pret : {0}" -f $openUrl) 'OK'
    if (-not $NoBrowser) {
      Say 'Ouverture du navigateur…' 'INFO'
      Open-Url $openUrl
    } else {
      Say ("Navigateur non ouvert (-NoBrowser) : ouvrez {0}" -f $openUrl) 'INFO'
    }
    if ($script:InstallPhaseRan) { Show-InstallSummary -KeyConfigured $keyConfigured -ServerPort $port }
    Show-StartupLogPath
    Write-Host ''
    Write-Host 'Le serveur tourne dans cette fenetre. Pour l arreter : Ctrl+C, ou fermez cette fenetre.' -ForegroundColor Cyan
    Write-Host ''

    # ---------- 9. Attente de l'arrêt ----------
    if ($server) { Wait-Process -Id $server.Id -ErrorAction SilentlyContinue }
    Say 'Le serveur s est arrete.' 'INFO'
    return 0
  } finally {
    # Arrêt propre : toute la descendance (npm -> node) est supprimée.
    if ($server -and -not $server.HasExited) {
      try { & taskkill /PID $server.Id /T /F 2>&1 | Out-Null } catch { }
      Say 'Serveur arrete proprement.' 'OK'
    }
  }
}

# ---------------------------------------------------------------------------
# Point d'entrée
# ---------------------------------------------------------------------------
Write-Host ''
Write-Host 'yt-chapters - demarrage en un clic' -ForegroundColor Cyan
Write-Log ("Demarrage du lanceur (Check={0}, NoBrowser={1}, Port={2})" -f [bool]$Check, [bool]$NoBrowser, $Port) 'TITRE'

if ($Check) {
  $code = Invoke-Check
} else {
  $code = Invoke-Start
}
exit $code
