import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, slugify } from '../src/main/store.js';

const PRESETS = fileURLToPath(new URL('../src/presets', import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tapedeck-store-'));
const layoutText = (name, extra = {}) => JSON.stringify({ format: 'tapedeck-layout', version: 2, name, elements: [], ...extra }, null, 2) + '\n';

test('built-in layouts are copied in once and never overwritten or brought back', () => {
  const dir = tmp();
  const s = new Store({ userDir: dir, presetsDir: PRESETS });
  s.initSync();
  const ids = s.listSync().map(l => l.id);
  assert.deepEqual(ids.sort(), ['label-wrap', 'plain']);
  assert.ok(s.listSync().every(l => l.preset && !l.error));

  // the user edits Label wrap and deletes Plain; a newer release starts up
  const wrap = path.join(dir, 'layouts', 'label-wrap.json');
  fs.writeFileSync(wrap, layoutText('Label wrap', { padding: 3 }));
  fs.rmSync(path.join(dir, 'layouts', 'plain.json'));
  const s2 = new Store({ userDir: dir, presetsDir: PRESETS });
  s2.initSync();
  assert.equal(JSON.parse(fs.readFileSync(wrap, 'utf8')).padding, 3);
  assert.deepEqual(s2.listSync().map(l => l.id), ['label-wrap']);
});

test('a built-in added by a later release is offered once', () => {
  const dir = tmp(), presets = tmp();
  fs.copyFileSync(path.join(PRESETS, 'plain.json'), path.join(presets, 'plain.json'));
  new Store({ userDir: dir, presetsDir: presets }).initSync();
  fs.writeFileSync(path.join(presets, 'fancy.json'), layoutText('Fancy'));
  const s = new Store({ userDir: dir, presetsDir: presets });
  s.initSync();
  assert.deepEqual(s.listSync().map(l => l.id).sort(), ['fancy', 'plain']);
});

test('restore missing built-ins and revert one', async () => {
  const dir = tmp();
  const s = new Store({ userDir: dir, presetsDir: PRESETS });
  s.initSync();
  await s.remove('plain');
  assert.deepEqual(await s.restoreMissing(), ['plain']);
  await s.write('label-wrap', layoutText('Mine'));
  const r = await s.revert('label-wrap');
  assert.equal(JSON.parse(r.text).name, 'Label wrap');
  assert.equal(JSON.parse(s.readSync('label-wrap').text).name, 'Label wrap');
  await assert.rejects(s.revert('nope'), /not a built-in/);
});

test('create, rename, delete with unique file names', async () => {
  const dir = tmp();
  const s = new Store({ userDir: dir, presetsDir: PRESETS });
  s.initSync();
  assert.equal((await s.create('Label wrap', layoutText('Label wrap'))).id, 'label-wrap-2');
  assert.equal((await s.create('Héllo Wörld!', layoutText('Héllo Wörld!'))).id, 'hello-world');
  const r = await s.rename('hello-world', 'Shelf tags');
  assert.equal(r.id, 'shelf-tags');
  assert.ok(!fs.existsSync(path.join(dir, 'layouts', 'hello-world.json')));
  assert.equal(JSON.parse(s.readSync('shelf-tags').text).name, 'Shelf tags');
  assert.equal((await s.rename('shelf-tags', 'SHELF tags')).id, 'shelf-tags');      // same slug: stays put
  assert.equal((await s.rename('shelf-tags', 'Plain')).id, 'plain-2');               // taken: next free id
  await s.remove('plain-2');
  assert.ok(!s.listSync().some(l => l.id === 'plain-2'));
  await assert.rejects(s.create('x', '{"name":"x"}'), /not a layout/);
  assert.equal(slugify('  '), 'layout');
});

test('ids cannot escape the layouts folder', async () => {
  const s = new Store({ userDir: tmp(), presetsDir: PRESETS });
  s.initSync();
  for (const bad of ['../settings', '.seeded', 'a/b', 'a\\b', '', 'x'.repeat(200)]) await assert.rejects(s.read(bad), /Invalid layout id/);
});

test('writes land in order and a synchronous flush is never overtaken', async () => {
  const s = new Store({ userDir: tmp(), presetsDir: PRESETS });
  s.initSync();
  const writes = [];
  for (let i = 0; i < 20; i++) writes.push(s.write('label-wrap', layoutText(`v${i}`)));
  await Promise.all(writes);
  assert.equal(JSON.parse(s.readSync('label-wrap').text).name, 'v19');
  const pending = s.write('label-wrap', layoutText('old'));
  s.flushSync({ layout: { id: 'label-wrap', text: layoutText('final') }, settings: { tapeMm: 12 } });
  await pending; await s.idle();
  assert.equal(JSON.parse(s.readSync('label-wrap').text).name, 'final');
  assert.equal(s.readSettingsSync().tapeMm, 12);
  assert.deepEqual(fs.readdirSync(s.layoutsDir).filter(f => f.endsWith('.tmp')), []);
});

test('settings: missing, saved, and a damaged file is kept aside', async () => {
  const dir = tmp();
  const s = new Store({ userDir: dir, presetsDir: PRESETS });
  s.initSync();
  assert.equal(s.readSettingsSync(), null);
  await s.writeSettings({ tapeMm: 9, layoutId: 'plain' });
  assert.deepEqual(s.readSettingsSync(), { tapeMm: 9, layoutId: 'plain' });
  fs.writeFileSync(path.join(dir, 'settings.json'), '{ broken');
  assert.equal(s.readSettingsSync(), null);
  assert.ok(fs.readdirSync(dir).some(f => f.startsWith('settings.json.damaged-')));
});

test('a broken layout file is listed with its error instead of breaking the list', () => {
  const s = new Store({ userDir: tmp(), presetsDir: PRESETS });
  s.initSync();
  fs.writeFileSync(path.join(s.layoutsDir, 'oops.json'), 'nope');
  const oops = s.listSync().find(l => l.id === 'oops');
  assert.ok(oops && oops.error);
});
