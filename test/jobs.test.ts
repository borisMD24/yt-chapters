// Tests du registre de jobs en mémoire (pipeline injecté) : transitions de
// progression, succès, erreur (message en français, sans fuite de clé) et
// annulation, plus la sérialisation (un job à la fois).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJobRegistry, sanitizeErrorMessage, type JobPipeline } from '../src/jobs.ts';

const input = { path: 'C:\\media\\reportage.mp3' };

/** Attend qu'un prédicat devienne vrai (avec délai de garde). */
async function until(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('délai dépassé');
    await new Promise((r) => setTimeout(r, 5));
  }
}

test('createJob démarre en "queued" et le runner sérialise + progresse vers done', async () => {
  const events: string[] = [];
  const pipeline: JobPipeline = async (i, { onProgress }) => {
    assert.equal(i.path, input.path);
    onProgress({ phase: 'chunking', doneChunks: 0, totalChunks: 0 });
    events.push('chunking');
    onProgress({ phase: 'chunking', doneChunks: 3, totalChunks: 3 });
    onProgress({ phase: 'transcribing', doneChunks: 1, totalChunks: 3 });
    onProgress({ phase: 'transcribing', doneChunks: 3, totalChunks: 3 });
    onProgress({ phase: 'chaptering', doneChunks: 0, totalChunks: 0 });
    events.push('chaptering');
    onProgress({ phase: 'persisting', doneChunks: 0, totalChunks: 0 });
    return {
      videoId: 'local:abc',
      chapters: [{ startSec: 0, title: 'Intro' }],
      text: '0:00 Intro',
      warnings: [],
      durationSec: 120,
    };
  };

  const registry = createJobRegistry(pipeline);
  const job = registry.createJob(input);
  assert.equal(job.status, 'queued');
  assert.equal(job.phase, 'chunking');
  assert.equal(job.message, 'En attente…');
  assert.ok(job.id.length > 0);

  await until(() => registry.getJob(job.id)!.status === 'done');
  const done = registry.getJob(job.id)!;
  assert.equal(done.phase, 'done');
  assert.equal(done.message, 'Chapitres prêts.');
  assert.deepEqual(events, ['chunking', 'chaptering']);
  assert.deepEqual(done.result?.chapters, [{ startSec: 0, title: 'Intro' }]);
  assert.equal(done.totalChunks, 3);
  assert.equal(done.error, undefined);
});

test('le message de progression décrit le morceau en cours (français)', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const pipeline: JobPipeline = async (_i, { onProgress }) => {
    onProgress({ phase: 'chunking', doneChunks: 5, totalChunks: 5 });
    onProgress({ phase: 'transcribing', doneChunks: 2, totalChunks: 5 });
    await gate;
    return { videoId: 'x', chapters: [], text: '', warnings: [], durationSec: 1 };
  };
  const registry = createJobRegistry(pipeline);
  const job = registry.createJob(input);
  await until(() => registry.getJob(job.id)!.doneChunks === 2);
  // 2 morceaux DÉJÀ terminés ⇒ c'est le 3e qui est en cours : l'intitulé est
  // désormais en base 1 (« morceau en cours »), d'où 3 et non 2.
  assert.equal(registry.getJob(job.id)!.message, 'Transcription du morceau 3 sur 5…');
  release();
  await until(() => registry.getJob(job.id)!.status === 'done');
});

test('une erreur du pipeline donne status error + message clair, sans fuite de clé', async () => {
  process.env.OPENROUTER_API_KEY = 'sk-or-secretvalue123';
  const pipeline: JobPipeline = async () => {
    throw new Error('ffmpeg a échoué: sk-or-secretvalue123 inaccessible');
  };
  const registry = createJobRegistry(pipeline);
  const job = registry.createJob(input);
  await until(() => registry.getJob(job.id)!.status === 'error');
  const err = registry.getJob(job.id)!;
  assert.match(err.message, /Impossible de lire ce fichier/);
  assert.ok(!JSON.stringify(err).includes('sk-or-secretvalue123'), 'la clé ne doit pas fuiter');
  assert.ok(!err.result);
  assert.ok(err.error && err.error.length > 0);
});

test('cancelJob annule un job en cours (status cancelled, pipeline interrompu)', async () => {
  const pipeline: JobPipeline = async (_i, { signal }) => {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, 5000);
      signal.addEventListener('abort', () => {
        clearTimeout(t);
        reject(new Error('interrompu'));
      });
    });
    return { videoId: 'x', chapters: [], text: '', warnings: [], durationSec: 1 };
  };
  const registry = createJobRegistry(pipeline);
  const job = registry.createJob(input);
  await until(() => registry.getJob(job.id)!.status === 'running');
  registry.cancelJob(job.id);
  await until(() => registry.getJob(job.id)!.status === 'cancelled');
  const cancelled = registry.getJob(job.id)!;
  assert.equal(cancelled.message, 'Annulé.');
  assert.equal(cancelled.error, undefined);
});

test('cancelJob sur un job en attente l\'empêche de démarrer', async () => {
  const started: string[] = [];
  const pipeline: JobPipeline = async (i) => {
    started.push(i.path);
    await new Promise((r) => setTimeout(r, 30));
    return { videoId: 'x', chapters: [], text: '', warnings: [], durationSec: 1 };
  };
  const registry = createJobRegistry(pipeline);
  const first = registry.createJob({ path: 'first.mp3' });
  const second = registry.createJob({ path: 'second.mp3' });
  await until(() => registry.getJob(first.id)!.status === 'running');
  registry.cancelJob(second.id);
  await until(() => registry.getJob(first.id)!.status === 'done');
  assert.equal(registry.getJob(second.id)!.status, 'cancelled');
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(started, ['first.mp3'], 'le job annulé ne doit pas s\'exécuter');
});

test('les jobs sont séquentiels (jamais deux pipelines en parallèle)', async () => {
  let running = 0;
  let maxConcurrent = 0;
  const pipeline: JobPipeline = async () => {
    running += 1;
    maxConcurrent = Math.max(maxConcurrent, running);
    await new Promise((r) => setTimeout(r, 20));
    running -= 1;
    return { videoId: 'x', chapters: [], text: '', warnings: [], durationSec: 1 };
  };
  const registry = createJobRegistry(pipeline);
  const a = registry.createJob({ path: 'a.mp3' });
  const b = registry.createJob({ path: 'b.mp3' });
  await until(() => registry.getJob(a.id)!.status === 'done' && registry.getJob(b.id)!.status === 'done');
  assert.equal(maxConcurrent, 1);
});

test('getJob renvoie undefined pour un identifiant inconnu', () => {
  const registry = createJobRegistry(async () => ({ videoId: 'x', chapters: [], text: '', warnings: [], durationSec: 1 }));
  assert.equal(registry.getJob('inexistant'), undefined);
  assert.equal(registry.cancelJob('inexistant'), undefined);
});

// Table de spécification du nettoyage des messages d'erreur : chaque ligne
// vérifie la SORTIE COMPLÈTE (une assertion par sous-chaîne a donné un faux
// sentiment de sécurité lors des tours précédents).
const SANITIZE_CASES: { name: string; input: string; expected: string }[] = [
  {
    name: 'chemin Windows suivi d’une explication',
    input: 'C:\\Users\\boris\\Documents\\clip.mp4: Invalid data',
    expected: '<chemin>: Invalid data',
  },
  {
    name: 'apostrophe et dossier à espace DANS le chemin',
    input: "open C:\\Users\\boris\\Documents\\L'été 2024\\clip final.mp4",
    expected: 'open <chemin>',
  },
  {
    name: 'dossier entre parenthèses + mot après le chemin',
    input: 'Lecture de C:\\Vidéos (2024)\\report final.mp4 impossible',
    expected: 'Lecture de <chemin>',
  },
  {
    name: 'deux chemins sur la même ligne : les deux remplacés',
    input: 'ffmpeg -i D:\\mes vidéos\\a.mp3 C:\\sortie\\b.mp3',
    expected: 'ffmpeg -i <chemin> <chemin>',
  },
  {
    name: 'chemin UNC à espace',
    input: '\\\\serveur\\Partage\\Mes documents\\clip.mp4',
    expected: '<chemin>',
  },
  { name: 'racine POSIX /root', input: 'cannot open /root/medias/a.mp3', expected: 'cannot open <chemin>' },
  {
    name: 'racine POSIX /usr avec explication conservée',
    input: 'Erreur : /usr/local/bin/ffprobe: No such file',
    expected: 'Erreur : <chemin>: No such file',
  },
  {
    name: 'racine POSIX /home avec dossier à espaces',
    input: '/home/boris/Mes vidéos/clip final.mp4',
    expected: '<chemin>',
  },
  { name: 'racine POSIX /Volumes avec dossier à espace', input: 'montage /Volumes/Disque externe/rushes/a.mov', expected: 'montage <chemin>' },
  { name: 'racine POSIX /media et mot après', input: 'copie /media/boris/externe/b.wav terminée', expected: 'copie <chemin>' },
  { name: 'deux chemins POSIX sur la même ligne', input: 'cp /tmp/a/x /var/tmp/y', expected: 'cp <chemin> <chemin>' },
  {
    name: 'date et durée : rien à nettoyer',
    input: 'Enregistré le 12/03/2024 à 14:30 (durée 1:02)',
    expected: 'Enregistré le 12/03/2024 à 14:30 (durée 1:02)',
  },
  { name: 'clé OpenRouter masquée', input: 'Erreur sk-or-v1-abcdef123456789', expected: 'Erreur sk-***' },
  {
    name: 'erreur ffmpeg réaliste : chemin remplacé, explication gardée',
    input: 'ffmpeg exited with code 1: C:\\Users\\boris\\Vidéos (2024)\\report final.mp4: Invalid argument',
    expected: 'ffmpeg exited with code 1: <chemin>: Invalid argument',
  },
  {
    // Compromis assumé et documenté : la queue d'un chemin étendu `\\?\C:\…`
    // n'est pas capturée par la règle UNC (elle s'arrête au `:`), donc elle
    // survit. On fige ce comportement au lieu de le laisser implicite.
    name: 'compromis assumé : queue d’un chemin étendu \\\\?\\C:\\…',
    input: '\\\\?\\C:\\medias\\clip.mp4',
    expected: '<chemin>:\\medias\\clip.mp4',
  },
];

for (const testCase of SANITIZE_CASES) {
  test(`sanitizeErrorMessage — ${testCase.name}`, () => {
    assert.equal(sanitizeErrorMessage(testCase.input), testCase.expected, testCase.input);
  });
}

test('sanitizeErrorMessage conserve un texte courant et masque les tokens Bearer', () => {
  assert.equal(sanitizeErrorMessage('Échec du chapitrage (code 1)'), 'Échec du chapitrage (code 1)');
  assert.equal(sanitizeErrorMessage('Durée 00:12:30 dépassée'), 'Durée 00:12:30 dépassée');
  assert.equal(sanitizeErrorMessage('Authorization: Bearer abcdef123456 done'), 'Authorization: Bearer *** done');
});

test('les jobs terminés sont évincés au-delà du plafond (le plus récent est gardé)', async () => {
  const pipeline: JobPipeline = async () => ({
    videoId: 'x',
    chapters: [],
    text: '',
    warnings: [],
    durationSec: 1,
  });
  const registry = createJobRegistry(pipeline, { maxRetainedFinished: 2 });

  const a = registry.createJob({ path: 'a.mp3' });
  await until(() => registry.getJob(a.id)!.status === 'done');
  const b = registry.createJob({ path: 'b.mp3' });
  await until(() => registry.getJob(b.id)!.status === 'done');
  const c = registry.createJob({ path: 'c.mp3' });
  await until(() => registry.getJob(c.id)!.status === 'done');

  assert.equal(registry.getJob(a.id), undefined, 'le plus ancien terminé est évincé');
  assert.ok(registry.getJob(b.id), 'les suivants restent disponibles');
  assert.ok(registry.getJob(c.id), 'le plus récent reste disponible');
});

test('un job actif n\'est jamais évincé par le plafond', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const pipeline: JobPipeline = async (i) => {
    if (i.path === 'long.mp3') await gate;
    return { videoId: 'x', chapters: [], text: '', warnings: [], durationSec: 1 };
  };
  const registry = createJobRegistry(pipeline, { maxRetainedFinished: 1 });

  const long = registry.createJob({ path: 'long.mp3' });
  await until(() => registry.getJob(long.id)!.status === 'running');

  // Deux jobs en attente, annulés : chacun devient terminal et déclenche
  // l'éviction, pendant que `long` tourne encore.
  const q1 = registry.createJob({ path: 'q1.mp3' });
  const q2 = registry.createJob({ path: 'q2.mp3' });
  registry.cancelJob(q1.id);
  registry.cancelJob(q2.id);

  // L'annulation est asynchrone (elle attend la fin du nettoyage) : on attend
  // que l'éviction du plus ancien terminé ait effectivement eu lieu.
  await until(() => registry.getJob(q1.id) === undefined);

  assert.equal(registry.getJob(long.id)!.status, 'running', 'le job actif est conservé');
  assert.equal(registry.getJob(q1.id), undefined, 'le plus ancien terminé est évincé');
  assert.ok(registry.getJob(q2.id), 'le plus récent terminé reste disponible');

  release();
  await until(() => registry.getJob(long.id)!.status === 'done');
});
