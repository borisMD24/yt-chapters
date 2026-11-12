# yt-chapters

Génère des chapitres YouTube à partir :
- d'une **vidéo YouTube** : sous-titres (`yt-dlp`) puis chapitrage LLM ;
- d'un **média local** (vidéo ou audio) : découpe `ffmpeg` → transcription
  Whisper (OpenRouter) → chapitrage LLM.

## Démarrage en un clic (Windows)

**Double-cliquez sur `Démarrer.cmd`** à la racine du projet : une fenêtre
s'ouvre, et l'outil fait le reste.

1. **Vérifie Node.js** (20 minimum). S'il manque ou est trop ancien, il propose
   de l'installer avec `winget` — **la réponse par défaut est de refuser** : seule
   une réponse explicitement affirmative (`o`, `oui`, `y`, `yes`) installe. En
   cas de refus, d'absence de `winget` **ou d'échec de l'installation**, il ouvre
   <https://nodejs.org/fr/download> et explique quoi installer.
2. **Vérifie `ffmpeg` et `ffprobe`.** S'ils manquent, il propose
   `winget install --id Gyan.FFmpeg` (là aussi, refus par défaut) ; sinon il
   ouvre <https://www.gyan.dev/ffmpeg/builds/> et indique quoi télécharger et où
   le placer (`PATH`). Après une installation `winget`, le script **relit le
   `PATH` du registre** : si l'outil n'est toujours pas visible, il vous demande
   de fermer la fenêtre puis de double-cliquer de nouveau.
3. **Installe les dépendances** (`npm ci`, repli `npm install`) si nécessaire.
4. **Prépare la configuration** : `.env` créé depuis `.env.example` s'il manque
   (la clé OpenRouter se renseigne ensuite dans la page Administration).
5. **Prépare la base** (`npm run db:push`) lors d'une première installation : si
   la commande échoue, il affiche les dernières lignes de la sortie et **s'arrête
   sans démarrer le serveur** (plutôt que de lancer une application sans schéma).
6. **Choisit un port libre** : 3000, sinon 3001…3010 ; il annonce lequel.
7. **Démarre le serveur**, duplique sa sortie dans `logs/serveur-<horodatage>.log`
   **et** ses propres étapes dans `logs/demarrage-<horodatage>.log`.
8. **Attend que le serveur réponde** (`GET /local/health`, jusqu'à 30 s) puis
   **ouvre le navigateur**. En cas d'échec, il affiche les dernières lignes du
   journal et un diagnostic en français (port occupé, ffmpeg manquant, base
   verrouillée…).
9. **À la fermeture** (Ctrl+C ou fenêtre fermée), il arrête proprement le serveur.

> Les étapes **3 à 7** ne sont jouées qu'au **premier lancement** (ou avec
> `-ForceInstall`). Ensuite, le lanceur prend le **chemin rapide** (vérification
> brève puis démarrage) — voir « Premier lancement : ce qui se passe » ci-dessous.

> Le dossier `logs/` est créé à la demande et **ignoré par git**. Son chemin est
> affiché au démarrage et dans la page d'administration.

Démarrage en ligne de commande, avec des options :

```bat
Démarrer.cmd -Check          :: préflight seul : rapporte l'état et sort sans rien installer ni démarrer
Démarrer.cmd -NoBrowser      :: démarre sans ouvrir le navigateur
Démarrer.cmd -Port 3001      :: force le port
Démarrer.cmd -ForceInstall   :: rejoue la phase d'installation même si elle est déjà faite
Démarrer.cmd -InstallOnly    :: joue l'installation puis s'arrête sans démarrer le serveur (support et vérification)
```

`-InstallOnly` est une option de **support** : elle exécute la phase d'installation
complète puis affiche le résumé **sans démarrer le serveur** — utile pour vérifier
une installation ou pour les tests hors ligne. Comme aucun serveur ne tourne, le
résumé ne comporte **aucune adresse de serveur** et désigne `/admin` comme étape
suivante si la clé OpenRouter manque.

`-Check` n'écrit que dans `logs/` et ne démarre rien : c'est ce qu'utilisent les
tests pour vérifier l'environnement.

### Premier lancement : ce qui se passe

Au **premier lancement**, le lanceur joue une **phase d'installation complète**,
annoncée étape par étape (à l'écran **et** dans `logs/demarrage-<horodatage>.log`).
Chaque étape est **idempotente** : si elle est déjà faite, elle est signalée puis
**sautée**.

1. **Node.js** et **ffmpeg/ffprobe** : vérifiés, avec les installations `winget`
   proposées (voir ci-dessus ; **réponse par défaut = refus**).
2. **Dossiers d'exécution** : `data/` et `logs/` créés si besoin.
3. **Dépendances** : `npm ci` (repli `npm install` si le verrou manque ou si
   `npm ci` échoue) si `node_modules` est absent.
4. **`.env`** : copié depuis `.env.example` s'il manque.
5. **Base de données** : `npm run db:push` si `data/chapters.db` est absent.
6. **Test de fumée multimédia** : environ 1 s de silence est **encodée en mp3**
   par `ffmpeg` puis **relue** par `ffprobe`. Si l'encodage échoue, le lanceur
   affiche « *votre installation de ffmpeg est incomplète : elle ne sait pas
   encoder en mp3* » et **s'arrête sans démarrer le serveur** (tout le chapitrage
   local en dépend).
7. **Horodatage d'installation** : `data/install.json` (ignoré par git) est écrit
   avec la date, les versions de Node et ffmpeg et la révision du dépôt. Sa
   présence (avec les pièces en place) fait passer les lancements suivants par le
   **chemin rapide** : vérification brève (versions, base, port) puis démarrage,
   sans rien réinstaller. Un fichier **illisible ou corrompu** retombe sur
   « premier lancement » — jamais de plantage.
8. **Raccourci du Bureau** (optionnel) : le lanceur **demande** s'il doit créer un
   raccourci `yt-chapters.lnk` vers `Démarrer.cmd`. **Défaut = refus** : rien ne
   s'écrit hors du projet sans un « oui » clair, et jamais en mode `-Check`.
9. **Résumé final** : ce qui a été installé ou existait déjà, le dossier des
   journaux (`logs/`), et **l'étape suivante**. Si aucune clé OpenRouter n'est
   configurée, le navigateur s'ouvre directement sur **`/admin`** (au lieu de la
   page principale) et le résumé vous invite à y coller votre clé.

**Relancer l'installation** à tout moment (support, dépannage) :

```bat
Démarrer.cmd -ForceInstall
```

### Dépannage

| Symptôme | Que faire |
| --- | --- |
| « Node.js introuvable » ou version trop ancienne | Acceptez l'installation `winget` proposée, ou installez Node.js LTS depuis <https://nodejs.org/fr/download>, puis relancez `Démarrer.cmd`. |
| ffmpeg/ffprobe introuvables | Acceptez l'installation `winget` (Gyan.FFmpeg), ou téléchargez « ffmpeg-release-full.7z » sur <https://www.gyan.dev/ffmpeg/builds/>, décompressez-le et **ajoutez son dossier `bin` au `PATH`**, puis rouvrez une fenêtre. |
| Le port 3000 est occupé | `Démarrer.cmd -Port 3001` (ou fermez le programme qui occupe le port). Le lanceur teste déjà 3000 à 3010. |
| Windows demande l'autorisation du Pare-feu | Acceptez pour « Réseaux privés » : l'outil écoute sur `0.0.0.0` pour être joignable depuis votre réseau local. Sinon autorisez seulement « Réseaux privés », ou faites écouter le serveur sur la boucle locale (voir plus bas). |
| « Aucune clé OpenRouter n'est configurée » | Ouvrez <http://localhost:3000/admin>, collez la clé, **Enregistrez** puis **Testez la clé**. |
| Installation des dépendances impossible | Vérifiez la connexion Internet, puis relancez `Démarrer.cmd`. Les journaux détaillés sont dans `logs/`. |
| Le lanceur s'arrête sur « votre installation de ffmpeg est incomplète » | Votre `ffmpeg` ne sait pas encoder en mp3. Réinstallez-le (`winget install --id Gyan.FFmpeg -e`, ou « ffmpeg-release-full » depuis <https://www.gyan.dev/ffmpeg/builds/>), puis relancez `Démarrer.cmd`. |
| Rien ne se réinstalle alors que je viens de mettre à jour le code | C'est le chemin rapide (installation déjà faite). Forcez la phase complète : `Démarrer.cmd -ForceInstall`. |

## Prérequis

- Node 22+ (fetch natif), `ffmpeg`/`ffprobe` dans le `PATH`.
- `yt-dlp` pour la partie YouTube (`YTDLP_BIN` pour un chemin explicite).

## Configuration (`.env`)

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | — | clé OpenRouter (repli : la clé enregistrée dans la base est prioritaire, voir ci-dessous) |
| `OPENROUTER_MODEL` | `qwen/qwen3.5-27b` | modèle de chapitrage |
| `STT_MODEL` | `openai/whisper-large-v3-turbo` | modèle de transcription |
| `CHUNK_SEC` | `300` | longueur des chunks audio (secondes) |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | base OpenRouter |
| `DB_PATH` | `data/chapters.db` | base SQLite |
| `PORT` | `3000` | port HTTP |
| `MEDIA_DIR` | deux niveaux au-dessus du projet | dossier scanné par l'interface (fichiers audio/vidéo) |
| `UPLOAD_MAX_MB` | `2048` | plafond d'un fichier envoyé depuis la page (Mo) |
| `UPLOAD_CACHE_DIR` | `data/uploads` | cache d'envoi (médias conservés pour l'éditeur de bornes) |
| `UPLOAD_RETENTION_DAYS` | `7` | durée de conservation du cache d'envoi (jours) |
| `CHAPTER_MIN_GAP_SEC` | `180` | espacement minimal entre chapitres locaux (secondes) |

## Clé OpenRouter : la base d'abord, puis le `.env`

La clé qui sert au chapitrage LLM **et** à la transcription (STT) est résolue par
**un seul** ordre de priorité :

1. la clé **enregistrée dans la base** (table `app_settings`), si elle est
   exploitable ;
2. sinon la variable `OPENROUTER_API_KEY` du `.env`, si elle est exploitable ;
3. sinon **aucune** clé : le chapitrage s'arrête **avant tout appel réseau** avec
   un message actionnable (au lieu d'un 401 ambigu attribué à la mauvaise phase).

Plus besoin de toucher au `.env` : ouvrez la section d'administration.

### Section d'administration (`/admin`)

- **Statut de la clé** : configurée / absente / refusée, avec **la source**
  (base ou `.env`), un **masque** court (`sk-or-…3f9a`) et la date de dernière
  mise à jour. La clé n'est **jamais** réaffichée en entier, ni renvoyée par une
  route, ni journalisée.
- **Enregistrer** : la clé collée est jugée par les mêmes règles que la
  disponibilité (vide, trop courte ou restée à un exemple → refus en français).
  Le client de transcription/LLM est **reconstruit** dès que la clé change : aucun
  client périmé ne conserve l'ancienne valeur.
- **Supprimer la clé** : retour au `.env` s'il existe.
- **Tester la clé** : en **deux temps** — `GET /api/v1/key` pour l'état du compte
  (utilisation/limite/restant, date d'expiration, drapeaux d'administration),
  puis une **vraie sonde d'inférence minimale** (`POST /chat/completions` avec le
  modèle de chapitrage et `max_tokens: 1`, jamais d'audio) — et affiche un verdict
  français : `ok`, `provisioning`, `inference-refused`, `expired`, `no-credit`,
  `rate-limited` ou `unreachable`. Le test n'est lancé que sur demande explicite
  (bouton), jamais au chargement de la page, et jamais sans clé configurée.
  > ⚠️ Une clé **d'administration** (dite « provisioning/management ») est
  > acceptée par `GET /key` mais **ne peut pas transcrire** : OpenRouter refuse
  > l'inférence (`401 « User not found »`, le même code qu'une clé expirée ou
  > révoquée). Pour transcrire, utilisez une **clé d'API normale** créée sur
  > <https://openrouter.ai/settings/keys>.
- **Outils et dossiers** : ffmpeg/ffprobe (versions), dossier des médias (avec
  avertissement s'il est introuvable), plafond d'envoi,
  cache d'envoi (nombre de fichiers, taille, rétention), chemin de la base et
  **dossier des journaux** (`logs/`, écrits par `Démarrer.cmd`).
  Le bouton **Vider le cache** (boucle locale uniquement) supprime les médias conservés ;
  les chapitres déjà enregistrés ne sont pas touchés.
- **Crédits OpenRouter** : usage, limite, restant, date d'expiration et dernière
  lecture, plus une phrase en clair (« Il vous reste 12,40 $ sur 250 $ », « Aucune
  limite définie sur cette clé »). Les chiffres viennent de
  `GET /api/v1/key`, sont **mis en cache 60 s** et relus à la demande avec le
  bouton **Rafraîchir**. Comme ce sont des chiffres **financiers**, la lecture
  elle-même (`GET /admin/credits`) est **réservée à cet ordinateur** : un client
  du réseau local reçoit un `403`. La clé n'est jamais exposée. La page principale
  affiche un avertissement **discret et non bloquant** quand le restant connu
  passe sous 1 $ — cette page n'obtient, elle, **aucun montant** : le serveur ne
  lui renvoie qu'un booléen (`low`), et la phrase affichée est sans chiffre.

Les actions d'**écriture** (enregistrer, supprimer, tester) et la **lecture des
crédits** ne sont possibles que depuis **cet ordinateur** (boucle locale
`127.0.0.1`/`::1`) ; toute autre adresse reçoit un `403` en français. Seules
`GET /admin/settings` (masque de clé) et `GET /local/credits` (booléen
d'avertissement, sans montant) restent ouvertes en lecture.

> ⚠️ **Stockage en clair.** La clé est écrite **en clair dans le fichier de base
> SQLite local** — le même niveau de protection que le fichier `.env` qu'elle
> remplace. Ne partagez pas ce fichier (ni une sauvegarde qui le contient) et ne
> le versionnez pas.

La table `app_settings` est créée de deux façons : par `npm run db:push` (le
schéma Drizzle reste la source de vérité) **et** de façon idempotente au
démarrage. Un `db:push` oublié n'entraîne donc pas d'erreur SQL : la page
d'administration fonctionne quand même.

## Utiliser l'interface (sans ligne de commande)

1. Démarrez le serveur : `npm start` (le port par défaut est `3000`).
2. Ouvrez <http://localhost:3000/> dans un navigateur.
3. Cliquez sur **Choisir un fichier** (ou glissez-déposez le fichier sur la
   zone prévue), puis **Générer les chapitres**. Suivez la progression, puis
   cliquez sur **Copier pour YouTube** et collez le texte dans la description
   de la vidéo.

La page propose trois sources, exclusives l'une de l'autre :

- **envoyer un fichier** de l'ordinateur (voie principale) : le navigateur
  transmet le fichier au serveur, qui l'écrit dans le **cache d'envoi**
  (`UPLOAD_CACHE_DIR`, `data/uploads` par défaut) sous le nom `<sha1>.<ext>` ;
- **un fichier déjà présent** dans `MEDIA_DIR` (liste déroulante) ;
- **un chemin saisi** à la main (repli).

Un envoi est **conservé** : c'est le contrat de rétention. Le fichier reste dans
le cache `UPLOAD_RETENTION_DAYS` jours (7 par défaut), ce qui permet d'ouvrir
l'**éditeur de bornes** (`/edit`) et de réécouter un passage sans réenvoyer le
média. Au-delà de cet âge il est supprimé au démarrage suivant, et il peut l'être
immédiatement depuis l'administration (« Vider le cache »). Deux envois du
**même contenu** ne dupliquent rien : le nom du fichier est l'empreinte du
contenu, et l'identifiant `local:up-<empreinte>` réutilise la même ligne
d'historique. Aucun finaliseur n'est attaché au job pour ce fichier — une
annulation ne peut donc pas rester bloquée en attente d'un nettoyage. Les
dossiers temporaires de découpage ffmpeg, eux, restent supprimés à la fin du job
(annulation comprise) : rien n'est écrit dans le dépôt.

### Exposition de l'envoi de fichier (limite connue)

La route d'envoi n'est **pas authentifiée** et le serveur écoute sur `0.0.0.0` :
sur un réseau local, n'importe quel hôte joignable peut envoyer un fichier et
occuper jusqu'à `UPLOAD_MAX_MB` dans le cache d'envoi (`UPLOAD_CACHE_DIR`). Les
autres routes sont bornées par `MEDIA_DIR` ; l'envoi, non. Mesures possibles :

- baisser `UPLOAD_MAX_MB` (plafond d'un envoi) ;
- si l'outil ne sert qu'en local, écouter uniquement sur la boucle locale :
  dans `src/server.ts`, remplacer `host: '0.0.0.0'` par `host: '127.0.0.1'`.


La page fonctionne hors-ligne : aucun CDN, aucune police externe, aucun build.

- Progression suivie côté navigateur (`GET /local/jobs/:id`, sondage ~1 s),
  bouton **Annuler** (`DELETE /local/jobs/:id`).
- Envoi d'un fichier : `POST /local/jobs/upload` (corps brut
  `application/octet-stream`, nom d'origine dans l'en-tête `x-filename`
  encodé, options en paramètres de requête). Réponses : `202` avec `jobId`,
  `413` si le plafond `UPLOAD_MAX_MB` est dépassé, `415` si le format n'est
  pas accepté.
- Résultat copiable, téléchargeable en `.txt`, avec les avertissements YouTube
  en clair (ex. « Il faudrait au moins 3 chapitres »).
- « Derniers chapitrages » reprend les générations locales récentes.
- Depuis un chapitrage généré (bouton **Ajuster les bornes**) ou depuis
  « Derniers chapitrages », la page `/edit?video=<id>` permet de **prévisualiser
  le média autour de chaque borne** et de déplacer les bornes : une borne par
  chapitre sur une chronologie graduée, lecteur intégré (`<video>` ou `<audio>`
  selon le média), déplacement à la souris ou au clavier (Tabulation, flèches,
  `Maj` pour 5 s), « Définir la borne ici », ajout/suppression de chapitres,
  titres et horodatages modifiables, avertissements YouTube **non bloquants** et
  texte d'export tenu à jour après enregistrement.

**Densité des chapitres.** Sur un média local, le modèle a tendance à découper
trop finement. La page applique donc un **espacement minimal entre chapitres
locaux** (`CHAPTER_MIN_GAP_SEC`, 180 s par défaut) : un chapitre qui commence
moins de trois minutes après le précédent est écarté. Rien n'est inventé,
fusionné ni renuméroté — les horodatages et les titres proposés sont conservés
tels quels — et il est normal d'obtenir moins de chapitres qu'annoncé (un
avertissement s'affiche alors sous la liste). Le chapitrage des vidéos YouTube
n'est pas concerné.



## API

- `POST /videos`, `POST /channel/sync`, `GET /videos`, `GET /videos/:id`
- `GET /videos/:id/transcript` (sous-titres YouTube, persistés dans `transcript_segments`)
- `GET /videos/:id/words?from=<sec>&to=<sec>` — mots horodatés d'un chapitrage
  **local** prononcés dans une fenêtre (`0 < to − from ≤ 120 s`), lus en base
  (aucun ffmpeg). Réponse `{ from, to, truncated, words: [{ startSec, endSec, word }] }`,
  triée par début et plafonnée à 2 000 mots (`truncated` signale la troncature).
  Fenêtre invalide → `400`, vidéo inconnue → `404` (messages français) ; `to`
  au-delà de la durée connue est tronquée ; `{ words: [] }` si le média n'en a pas.
- `POST /videos/:id/chapters/generate` — chapitrage LLM d'une vidéo YouTube
- `POST /local/chapters` — `{ path, chunkSec?, lang?, maxChunks? }` → `{ chapters, text, warnings }`.
  Persiste une ligne `videos` (id synthétique `local:<sha1 du chemin absolu, 16 hex>`)
  et les chapitres générés (`source = llm`) dans une transaction.
- `GET /` — page d'interface (HTML autonome, en français).
- `POST /local/jobs/upload` — envoi d'un fichier (corps brut, `x-filename`
  encodé, `chunkSec`/`lang`/`maxChunks` en requête) → `202 { jobId }`.
- `GET /media/:id` — sert le média d'un chapitrage local (`Accept-Ranges: bytes`,
  `Content-Type` selon l'extension, `206` + `Content-Range` pour une plage
  `Range` unique, `416` si elle est insatisfaisable, `HEAD` supporté). Une plage
  multiple ou une syntaxe inconnue renvoie `200` avec le fichier entier.
  L'identifiant doit résoudre à un fichier média **dans** le cache d'envoi ou
  `MEDIA_DIR` (fichier régulier, extension autorisée), sinon `403`/`404` en
  français : aucun chemin n'est jamais accepté du client.
- `GET /videos/:id/edit` — charge utile de l'éditeur de bornes
  (`{ videoId, title, durationSec, hasVideo, hasWords, mediaUrl, chapters }`) ;
  `hasVideo` vient d'une vraie sonde `ffprobe` (fichier avec piste vidéo, ou
  audio seul) et `hasWords` indique si des mots horodatés existent en base pour
  ce média (pour afficher l'état dégradé du panneau de texte).
- `GET /edit?video=<id>` — page « Ajuster les bornes » : chronologie avec une
  borne par chapitre, lecteur intégré, aperçu court, titres et horodatages
  modifiables, panneau **« Texte autour de la borne »** (mots prononcés de −15 s
  à +15 s, mot de la borne mis en évidence), enregistrement via les routes de
  chapitres existantes.
- `GET /local/media` — fichiers audio/vidéo de `MEDIA_DIR` (`{ dir, files, hint? }`).
- `POST /local/jobs` — démarre un job (`202 { jobId }`) ; le chemin doit être un
  fichier de `MEDIA_DIR` (sinon `400`/`404`).
- `GET /local/jobs/:id` — état du job (`queued|running|done|error|cancelled`,
  phase, progression, message en français, `result`).
- `DELETE /local/jobs/:id` — annule le job.
- `GET /local/history` — derniers chapitrages locaux (id, titre, nb de chapitres, date).
- `GET /videos/:id/export` — description au format YouTube + avertissements
- `GET /admin` — page d'administration (clé OpenRouter, outils, chemins).
- `GET /admin/settings` — état (clé masquée, outils, dossier des médias, plafond,
  base). Ne renvoie jamais la clé.
- `PUT /admin/openrouter-key` `{ key }` — enregistre la clé (refus en français si
  vide / trop courte / restée à un exemple).
- `DELETE /admin/openrouter-key` — supprime la clé enregistrée (repli `.env`).
- `POST /admin/openrouter-key/test` — teste la clé effective en deux temps
  (`GET /api/v1/key` pour l'état du compte, puis une sonde d'inférence minimale
  `POST /chat/completions`, `max_tokens: 1`, jamais d'audio) et renvoie un verdict
  français. Une clé **d'administration** (provisioning/management) est signalée
  comme inapte à la transcription : utilisez une clé d'API normale
  (<https://openrouter.ai/settings/keys>).
- `GET /admin/credits` — crédits du compte (`usage`, `limit`, `limit_remaining`,
  `expires_at`, `fetchedAt`) mis en cache 60 s ; jamais la clé. Sans clé, aucun
  appel réseau et un message en français.
- `POST /admin/credits/refresh` — relit les crédits immédiatement (boucle locale
  uniquement).
- `GET /local/credits` — version minimale pour la page principale :
  `{ configured, ok, low }` où **`low` est un simple booléen** (« le crédit
  connu est sous 1 $ »). **Aucun montant** n'y figure, ni chiffre ni phrase
  chiffrée : la page compose elle-même la phrase, sans montant.
  Sont **réservées à la boucle locale** (`403` sinon) : `GET /admin/credits`,
  `POST /admin/credits/refresh`, ainsi que l'écriture et le test de la clé
  (`PUT`/`DELETE /admin/openrouter-key`, `POST /admin/openrouter-key/test`).
  `GET /admin/settings` reste **ouverte en lecture** (masque de clé uniquement),
  et `/local/credits` reste lisible, sans montant.

## CLI (média local)

```bash
npm run chapters -- "<fichier>" [--chunk 300] [--lang fr] [--max-chunks N] [--json]
```

`--max-chunks` borne le nombre de chunks coupés/transcrits (runs de validation courts).

## Pipeline « chapitrage local »

1. **Découpe ffmpeg** : un seul passage avec le muxer `segment` →
   `chunk_%04d.mp3` (mono, 16 kHz, 64 kbps) dans un dossier temporaire
   (`mkdtemp` sous `os.tmpdir()`, jamais dans le dépôt).
2. **Offsets réels** : la durée de chaque chunk est mesurée par `ffprobe` ;
   l'offset de départ est la **somme des durées précédentes** (jamais `index * CHUNK_SEC`),
   ce qui garde les horodatages précis malgré la dérive du muxer.
3. **Transcription** : `POST /audio/transcriptions` d'OpenRouter avec
   `input_audio` en base64 (sans préfixe `data:`) et `response_format: verbose_json`.
   Repli automatique sur `json` (un segment couvrant le chunk) si le provider routé
   refuse `verbose_json` ; réessais avec backoff sur `429`/`5xx`.
4. **Recollage** : les segments (et les mots horodatés, quand le provider en
   fournit) de chaque chunk sont décalés de l'offset absolu du chunk puis triés.
5. **Chapitrage** : chat completions OpenRouter (`qwen`), `json_schema` strict puis
   repli `json_object`, parsing défensif, puis normalisation (1er chapitre à 0:00,
   écart mini 10 s, avertissements < 3 chapitres…).

> Le transcript d'un média local reste **en mémoire** : il n'est pas écrit dans
> `transcript_segments` et ne modifie pas le comportement de `/videos/:id/transcript`.

### Mots horodatés conservés (table `media_words`)

Le STT renvoie des horodatages **par mot** (granularité `['word','segment']`,
précision sous les 100 ms) ; ces mots sont désormais conservés dans une table
**DÉDIÉE**, `media_words` (`id`, `video_id`, `start_ms`, `end_ms`, `text`, index
sur `(video_id, start_ms)`), créée automatiquement au démarrage (DDL idempotent
dans `src/db/media-words.ts`, dont la forme est **canonique pour Drizzle** afin
que `npm run db:push` ne détecte aucun changement). Ils servent uniquement à
l'**éditeur de bornes** : le panneau « Texte autour de la borne » lit
`GET /videos/:id/words` pour afficher ce qui est prononcé de −15 s à +15 s autour
de la borne sélectionnée, avec le mot de la borne mis en évidence.

- **`transcript_segments` n'est PAS utilisée** pour un média local : elle reste
  réservée aux sous-titres YouTube, et `/videos/:id/transcript` garde son
  comportement. Un test vérifie explicitement que cette table reste vide alors
  que `media_words` est remplie.
- Un nouveau chapitrage du même média **remplace** ses mots (suppression puis
  insertion **par lots**) ; sans mot disponible, les anciens ne sont ni effacés
  ni écrasés.
- **Espace disque** : de l'ordre de **≈ 27 000 mots pour 3 h de parole** (rythme
  observé d'environ 2,5 mots/s), soit ≈ 1,5 Mio — négligeable. Les médias
  **antérieurs à cette version** n'ont pas de mots : l'éditeur l'indique
  honnêtement et propose de relancer un chapitrage.

## Développement

```bash
npm start          # serveur (tsx --env-file=.env)
npm run dev        # serveur en watch
npm run db:push    # applique le schéma Drizzle
npm run typecheck  # tsc --noEmit
npm test           # node --test (ffmpeg requis pour le test d'intégration)
```
