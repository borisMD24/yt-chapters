# yt-chapters

Génère des chapitres YouTube à partir :
- d'une **vidéo YouTube** : sous-titres (`yt-dlp`) puis chapitrage LLM ;
- d'un **média local** (vidéo ou audio) : découpe `ffmpeg` → transcription
  Whisper (OpenRouter) → chapitrage LLM.

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
  avertissement s'il est introuvable), plafond d'envoi, chemin de la base.

Les actions d'**écriture** (enregistrer, supprimer, tester) ne sont possibles
que depuis **cet ordinateur** (boucle locale `127.0.0.1`/`::1`) ; toute autre
adresse reçoit un `403` en français. La lecture (`GET /admin/settings`) reste
ouverte mais ne révèle jamais la clé.

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
  transmet le fichier au serveur, qui l'écrit dans un **dossier temporaire
  privé** (`ckr-upload-…` sous le dossier temporaire du système) ;
- **un fichier déjà présent** dans `MEDIA_DIR` (liste déroulante) ;
- **un chemin saisi** à la main (repli).

Un envoi est **transitoire** : le dossier temporaire est supprimé dès que le
chapitrage est terminé, en erreur, ou **annulé**. L'annulation n'est pas
instantanée : la page affiche « Annulation en cours… » et l'état « annulé »
n'est publié qu'une fois le fichier effectivement supprimé. Au démarrage
suivant, le serveur supprime aussi les dossiers d'envoi restés d'un arrêt
brutal (uniquement ceux de plus d'une heure, pour ne jamais gêner un serveur
en cours). Rien n'est écrit dans le dépôt. Deux envois du **même contenu**
réutilisent la même ligne d'historique (identifiant dérivé du fichier,
`local:up-<empreinte>`).

### Exposition de l'envoi de fichier (limite connue)

La route d'envoi n'est **pas authentifiée** et le serveur écoute sur `0.0.0.0` :
sur un réseau local, n'importe quel hôte joignable peut envoyer un fichier et
occuper jusqu'à `UPLOAD_MAX_MB` dans le dossier temporaire du système. Les
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
- `POST /videos/:id/chapters/generate` — chapitrage LLM d'une vidéo YouTube
- `POST /local/chapters` — `{ path, chunkSec?, lang?, maxChunks? }` → `{ chapters, text, warnings }`.
  Persiste une ligne `videos` (id synthétique `local:<sha1 du chemin absolu, 16 hex>`)
  et les chapitres générés (`source = llm`) dans une transaction.
- `GET /` — page d'interface (HTML autonome, en français).
- `POST /local/jobs/upload` — envoi d'un fichier (corps brut, `x-filename`
  encodé, `chunkSec`/`lang`/`maxChunks` en requête) → `202 { jobId }`.
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
  Les trois dernières routes sont **réservées à la boucle locale** (`403` sinon).

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
4. **Recollage** : les segments de chaque chunk sont décalés de l'offset absolu du
   chunk puis triés.
5. **Chapitrage** : chat completions OpenRouter (`qwen`), `json_schema` strict puis
   repli `json_object`, parsing défensif, puis normalisation (1er chapitre à 0:00,
   écart mini 10 s, avertissements < 3 chapitres…).

> Le transcript d'un média local reste **en mémoire** : il n'est pas écrit dans
> `transcript_segments` et ne modifie pas le comportement de `/videos/:id/transcript`.

## Développement

```bash
npm start          # serveur (tsx --env-file=.env)
npm run dev        # serveur en watch
npm run db:push    # applique le schéma Drizzle
npm run typecheck  # tsc --noEmit
npm test           # node --test (ffmpeg requis pour le test d'intégration)
```
