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
# Options :
#   -Check        préflight SEUL : rapporte l'état et sort sans rien installer,
#                 sans démarrer le serveur, et sans écrire ailleurs que dans logs/.
#   -NoBrowser    n'ouvre pas le navigateur.
#   -Port <n>     force le port indiqué (3000 par défaut, sinon le premier libre).
param(
  [switch]$Check,
  [switch]$NoBrowser,
  [int]$Port = 0
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

# Consentement d'installation : la règle (« refus par défaut, seule une réponse
# affirmative installe ») vit dans `scripts/consent.ps1`, testable isolément.
. (Join-Path $PSScriptRoot 'consent.ps1')

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
  } else {
    Say 'ffmpeg et ffprobe trouves' 'OK'
  }

  # ---------- 3. Dépendances ----------
  $tsx = (Test-Path -LiteralPath (Join-Path $script:Root 'node_modules\.bin\tsx.cmd')) -or
         (Test-Path -LiteralPath (Join-Path $script:Root 'node_modules\.bin\tsx'))
  if (-not $tsx) {
    Say 'Installation des dependances (npm ci)…' 'INFO'
    Push-Location -LiteralPath $script:Root
    try {
      $code = Invoke-Npm -Arguments @('ci') -Label 'npm ci'
      if ($code -ne 0) {
        Say 'npm ci a echoue : nouvel essai avec npm install.' 'MANQUANT'
        $code = Invoke-Npm -Arguments @('install') -Label 'npm install'
      }
    } finally {
      Pop-Location
    }
    if ($code -ne 0) {
      Say "L'installation des dependances a echoue. Verifiez votre connexion Internet, puis relancez ce fichier." 'ERREUR'
      [void](Read-Host)
      return 1
    }
    Say 'Dependances installees.' 'OK'
  } else {
    Say 'Dependances deja installees' 'OK'
  }

  # ---------- 4. Configuration (.env) ----------
  $envFile = Join-Path $script:Root '.env'
  if (-not (Test-Path -LiteralPath $envFile)) {
    $example = Join-Path $script:Root '.env.example'
    if (Test-Path -LiteralPath $example) {
      try {
        Copy-Item -LiteralPath $example -Destination $envFile -ErrorAction Stop
        Say 'Fichier .env cree a partir de .env.example (la cle OpenRouter se renseigne dans la page Administration).' 'OK'
      } catch {
        Say "Impossible de creer le fichier .env : la suite continue avec les valeurs par defaut." 'MANQUANT'
      }
    } else {
      Say 'Fichier .env.example absent : la suite continue avec les valeurs par defaut.' 'MANQUANT'
    }
  } else {
    Say 'Fichier .env present' 'OK'
  }

  # ---------- 5. Base de données ----------
  $dbFile = Join-Path $script:Root 'data\chapters.db'
  if (-not (Test-Path -LiteralPath $dbFile)) {
    Say 'Base de donnees absente : application du schema (npm run db:push)…' 'INFO'
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
      Say ("La creation du schema a echoue (npm run db:push, code {0}) : le serveur ne sera PAS demarre." -f $dbCode) 'ERREUR'
      Say 'Dernieres lignes de la commande :' 'INFO'
      foreach ($line in ($script:LastNpmOutput | Select-Object -Last 10)) { Write-Host $line }
      Say 'Corrigez la cause ci-dessus (droits d ecriture sur data\, connexion Internet), puis relancez Demarrer.cmd.' 'ERREUR'
      [void](Read-Host)
      return 1
    }
    Say 'Schema applique (data/chapters.db).' 'OK'
  } else {
    Say 'Base de donnees presente' 'OK'
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
      [void](Read-Host)
      return 1
    }

    Say ("Serveur pret : {0}" -f $url) 'OK'
    if (-not $NoBrowser) {
      Say 'Ouverture du navigateur…' 'INFO'
      Open-Url $url
    } else {
      Say 'Navigateur non ouvert (-NoBrowser) : ouvrez l adresse affichee ci-dessus.' 'INFO'
    }
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
