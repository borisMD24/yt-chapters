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
| `OPENROUTER_API_KEY` | — | clé OpenRouter (chapitrage LLM + STT) |
| `OPENROUTER_MODEL` | `qwen/qwen3.5-27b` | modèle de chapitrage |
| `STT_MODEL` | `openai/whisper-large-v3-turbo` | modèle de transcription |
| `CHUNK_SEC` | `300` | longueur des chunks audio (secondes) |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | base OpenRouter |
| `DB_PATH` | `data/chapters.db` | base SQLite |
| `PORT` | `3000` | port HTTP |
| `MEDIA_DIR` | deux niveaux au-dessus du projet | dossier scanné par l'interface (fichiers audio/vidéo) |

## Utiliser l'interface (sans ligne de commande)

1. Démarrez le serveur : `npm start` (le port par défaut est `3000`).
2. Ouvrez <http://localhost:3000/> dans un navigateur.
3. Choisissez un fichier de votre dossier de médias, cliquez sur
   **Générer les chapitres**, suivez la progression, puis cliquez sur
   **Copier pour YouTube** et collez le texte dans la description de la vidéo.

La page liste automatiquement les fichiers du dossier `MEDIA_DIR` (si la
variable est absente, le dossier situé deux niveaux au-dessus du projet).
Elle fonctionne hors-ligne : aucun CDN, aucune police externe, aucun build.

- Progression suivie côté navigateur (`GET /local/jobs/:id`, sondage ~1 s),
  bouton **Annuler** (`DELETE /local/jobs/:id`).
- Résultat copiable, téléchargeable en `.txt`, avec les avertissements YouTube
  en clair (ex. « Il faudrait au moins 3 chapitres »).
- « Derniers chapitrages » reprend les générations locales récentes.


## API

- `POST /videos`, `POST /channel/sync`, `GET /videos`, `GET /videos/:id`
- `GET /videos/:id/transcript` (sous-titres YouTube, persistés dans `transcript_segments`)
- `POST /videos/:id/chapters/generate` — chapitrage LLM d'une vidéo YouTube
- `POST /local/chapters` — `{ path, chunkSec?, lang?, maxChunks? }` → `{ chapters, text, warnings }`.
  Persiste une ligne `videos` (id synthétique `local:<sha1 du chemin absolu, 16 hex>`)
  et les chapitres générés (`source = llm`) dans une transaction.
- `GET /` — page d'interface (HTML autonome, en français).
- `GET /local/media` — fichiers audio/vidéo de `MEDIA_DIR` (`{ dir, files, hint? }`).
- `POST /local/jobs` — démarre un job (`202 { jobId }`) ; le chemin doit être un
  fichier de `MEDIA_DIR` (sinon `400`/`404`).
- `GET /local/jobs/:id` — état du job (`queued|running|done|error|cancelled`,
  phase, progression, message en français, `result`).
- `DELETE /local/jobs/:id` — annule le job.
- `GET /local/history` — derniers chapitrages locaux (id, titre, nb de chapitres, date).
- `GET /videos/:id/export` — description au format YouTube + avertissements

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
