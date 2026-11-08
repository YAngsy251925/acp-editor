/**
 * WorkspaceSnapshot: find what an agent changed on disk, for agents that write
 * files themselves and report only generic tool calls.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorkspaceSnapshot } from '../src/snapshot.js';

/** Snapshot comparisons key on mtime + size; make sure a rewrite is visible. */
async function bump(path: string): Promise<void> {
  const later = new Date(Date.now() + 5_000);
  await utimes(path, later, later);
}

test('snapshot: reports edits, creations and deletions made after prime()', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acp-snap-'));
  await writeFile(join(root, 'a.cpp'), 'int a = 1;\n', 'utf8');
  await writeFile(join(root, 'gone.h'), '#pragma once\n', 'utf8');
  const snapshot = new WorkspaceSnapshot(root);
  await snapshot.prime();

  await writeFile(join(root, 'a.cpp'), 'int a = 2;\n', 'utf8');
  await bump(join(root, 'a.cpp'));
  await writeFile(join(root, 'new.md'), '# new\n', 'utf8');
  await rm(join(root, 'gone.h'));

  const edits = await snapshot.collect();
  assert.deepEqual(
    edits.map((e) => [e.path, e.oldText, e.newText]),
    [
      [join(root, 'a.cpp'), 'int a = 1;\n', 'int a = 2;\n'],
      [join(root, 'gone.h'), '#pragma once\n', null],
      [join(root, 'new.md'), null, '# new\n'],
    ],
  );
  // The snapshot moved on: nothing new to report.
  assert.deepEqual(await snapshot.collect(), []);
});

test('snapshot: edits between turns are absorbed by prime(), not reported', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acp-snap-'));
  await writeFile(join(root, 'b.ini'), '[A]\nx=1\n', 'utf8');
  const snapshot = new WorkspaceSnapshot(root);
  await snapshot.prime();

  // The user edits in the IDE between turns ...
  await writeFile(join(root, 'b.ini'), '[A]\nx=2\n', 'utf8');
  await bump(join(root, 'b.ini'));
  await snapshot.prime();
  // ... and the agent touches nothing.
  assert.deepEqual(await snapshot.collect(), []);
});

test('snapshot: skips build output, assets, binaries and non-UTF-8 text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acp-snap-'));
  for (const dir of ['Intermediate', 'Saved', 'Content', 'node_modules', '.git']) {
    await mkdir(join(root, dir), { recursive: true });
  }
  const snapshot = new WorkspaceSnapshot(root);
  await snapshot.prime();

  await writeFile(join(root, 'Intermediate', 'gen.h'), '// generated\n', 'utf8');
  await writeFile(join(root, 'Saved', 'log.txt'), 'log\n', 'utf8');
  await writeFile(join(root, 'node_modules', 'x.js'), 'x\n', 'utf8');
  await writeFile(join(root, 'Hero.uasset'), Buffer.from([0, 1, 2, 3]));
  await writeFile(join(root, 'gbk.cpp'), Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0a]));
  await writeFile(join(root, 'utf16.ini'), Buffer.from([0xff, 0xfe, 0x41, 0x00]));
  await writeFile(join(root, 'kept.h'), '\ufeff// bom kept\n', 'utf8');

  const edits = await snapshot.collect();
  assert.deepEqual(
    edits.map((e) => e.path),
    [join(root, 'kept.h')],
  );
  assert.equal(edits[0]!.newText, '\ufeff// bom kept\n', 'a UTF-8 BOM is kept');
});

test('snapshot: checkFile reports a single file under its tool call', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acp-snap-'));
  await writeFile(join(root, 'n.txt'), 'one\n', 'utf8');
  const snapshot = new WorkspaceSnapshot(root);
  await snapshot.prime();

  assert.equal(await snapshot.checkFile(join(root, 'n.txt')), null, 'unchanged file');
  assert.equal(await snapshot.checkFile(join(root, 'outside.txt')), null, 'paths outside the root');

  await writeFile(join(root, 'n.txt'), 'one\ntwo\n', 'utf8');
  bump(join(root, 'n.txt'));
  const edit = await snapshot.checkFile(join(root, 'n.txt'));
  assert.deepEqual(edit, { path: join(root, 'n.txt'), oldText: 'one\n', newText: 'one\ntwo\n' });
  assert.deepEqual(await snapshot.collect(), [], 'checkFile already absorbed the change');

  await rm(join(root, 'n.txt'));
  const deleted = await snapshot.checkFile(join(root, 'n.txt'));
  assert.deepEqual(deleted, { path: join(root, 'n.txt'), oldText: 'one\ntwo\n', newText: null });
});

test('snapshot: tracks() mirrors what is scanned', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acp-snap-'));
  const snapshot = new WorkspaceSnapshot(root);
  assert.equal(snapshot.tracks(join(root, 'Src/A.h')), true);
  assert.equal(snapshot.tracks(join(root, 'Intermediate/x.h')), false);
  assert.equal(snapshot.tracks(join(root, 'Hero.uasset')), false);
  assert.equal(snapshot.tracks(join(root, '..', 'elsewhere.txt')), false);
});
