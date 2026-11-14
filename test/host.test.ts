// Tests de l'interface d'écoute HTTP : boucle locale par défaut, HOST en opt-in.
// Un défaut réseau exposerait `/admin` au LAN et déclencherait la pop-up pare-feu.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_HOST, resolveHost } from '../src/host.ts';

test('interface d’écoute : boucle locale par défaut, HOST explicite', () => {
  assert.equal(DEFAULT_HOST, '127.0.0.1');
  assert.equal(resolveHost(undefined), '127.0.0.1', 'aucune variable ⇒ boucle locale');
  assert.equal(resolveHost(''), '127.0.0.1', 'valeur vide ⇒ boucle locale');
  assert.equal(resolveHost('   '), '127.0.0.1', 'espaces ⇒ boucle locale');
  assert.equal(resolveHost('0.0.0.0'), '0.0.0.0', 'ouverture explicite respectée');
  assert.equal(resolveHost('  ::1  '), '::1', 'espaces ignorés');
});

test('server.ts écoute via HOST (aucune écoute réseau en dur)', () => {
  const src = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  assert.ok(src.includes('resolveHost(process.env.HOST)'), 'la résolution de HOST doit être utilisée');
  assert.ok(!/host:\s*['"]0\.0\.0\.0['"]/.test(src), 'aucune écoute sur 0.0.0.0 en dur');
});
