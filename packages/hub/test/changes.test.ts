import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChangeError, ChangeTracker, changedRegion, planRestore } from '../src/changes.js';

const lines = (n: number, edit: (i: number) => string | undefined = () => undefined) =>
  Array.from({ length: n }, (_, i) => edit(i + 1) ?? `line ${i + 1}`).join('\n') + '\n';

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'acp-changes-'));
  const cwd = join(root, 'project');
  await mkdir(cwd);
  return cwd;
}

// ---------------------------------------------------------------------------
// planRestore
// ---------------------------------------------------------------------------

test('planRestore: whole file still matches -> restore old, delete a new file', () => {
  assert.deepEqual(planRestore({ oldText: 'a\n', newText: 'b\n', exact: true }, 'b\n'), {
    kind: 'write',
    text: 'a\n',
  });
  assert.deepEqual(planRestore({ oldText: null, newText: 'b\n', exact: true }, 'b\n'), { kind: 'delete' });
});

test('planRestore: file already back to the original -> noop', () => {
  assert.equal(planRestore({ oldText: 'a', newText: 'b', exact: true }, 'a').kind, 'noop');
  assert.equal(planRestore({ oldText: null, newText: 'b', exact: true }, null).kind, 'noop');
});

test('planRestore: a later unrelated edit survives, the change is swapped back in place', () => {
  const original = lines(20);
  const agent = lines(20, (i) => (i === 5 ? 'line 5 (agent)' : undefined));
  const disk = lines(20, (i) => (i === 5 ? 'line 5 (agent)' : i === 18 ? 'line 18 (user)' : undefined));
  const expected = lines(20, (i) => (i === 18 ? 'line 18 (user)' : undefined));

  assert.deepEqual(planRestore({ oldText: original, newText: agent, exact: true }, disk), {
    kind: 'write',
    text: expected,
  });
});

test('planRestore: a later edit inside the changed region -> conflict', () => {
  const original = lines(20);
  const agent = lines(20, (i) => (i === 5 ? 'line 5 (agent)' : undefined));
  const disk = lines(20, (i) => (i === 5 ? 'line 5 (agent, then user)' : undefined));
  const plan = planRestore({ oldText: original, newText: agent, exact: true }, disk);
  assert.equal(plan.kind, 'conflict');
});

test('planRestore: a snippet report is reverted where it sits', () => {
  const plan = planRestore(
    { oldText: 'foo(1);', newText: 'foo(2);', exact: false },
    'int a;\nfoo(2);\nint b;\n',
  );
  assert.deepEqual(plan, { kind: 'write', text: 'int a;\nfoo(1);\nint b;\n' });
});

test('planRestore: an ambiguous snippet -> conflict', () => {
  const plan = planRestore({ oldText: 'foo(1);', newText: 'foo(2);', exact: false }, 'foo(2);\nfoo(2);\n');
  assert.equal(plan.kind, 'conflict');
});

test('planRestore: reported LF texts restore into a CRLF file as CRLF', () => {
  const plan = planRestore({ oldText: 'a\nb\n', newText: 'a\nc\n', exact: false }, 'a\r\nc\r\n');
  assert.deepEqual(plan, { kind: 'write', text: 'a\r\nb\r\n' });
});

test('planRestore: exact texts are restored byte for byte', () => {
  // The hub read 'x\r\n' and wrote 'y\n'; undo must bring back the CRLF original.
  const plan = planRestore({ oldText: 'x\r\n', newText: 'y\n', exact: true }, 'y\n');
  assert.deepEqual(plan, { kind: 'write', text: 'x\r\n' });
});

test('planRestore: missing file -> conflict', () => {
  assert.equal(planRestore({ oldText: 'a', newText: 'b', exact: true }, null).kind, 'conflict');
});

test('changedRegion keeps identical context on both sides', () => {
  const region = changedRegion(lines(10), lines(10, (i) => (i === 5 ? 'five' : undefined)), 2);
  assert.deepEqual(region, {
    before: 'line 3\nline 4\nline 5\nline 6\nline 7',
    after: 'line 3\nline 4\nfive\nline 6\nline 7',
  });
  assert.equal(changedRegion('same\n', 'same\n', 3), null);
});

// ---------------------------------------------------------------------------
// ChangeTracker
// ---------------------------------------------------------------------------

test('tracker: an announced diff and the hub write fold into one exact change', async () => {
  const cwd = await workspace();
  const tracker = new ChangeTracker({ cwd });
  const path = join(cwd, 'a.txt');
  const diff = { type: 'diff', path, oldText: 'x\n', newText: 'y\n' };

  const [announced] = tracker.observeToolCall({ toolCallId: 't1', status: 'pending', content: [diff] });
  assert.ok(announced);
  assert.equal(announced.applied, false);
  assert.equal(announced.exact, false);
  assert.equal(announced.displayPath, 'a.txt');

  const written = tracker.recordWrite(path, 'x\r\n', 'y\n');
  assert.equal(written, announced, 'the write completes the announced change');
  assert.equal(written!.exact, true);
  assert.equal(written!.applied, true);
  assert.equal(written!.oldText, 'x\r\n', 'exact disk content replaces the report');

  // The completion report must not overwrite the exact texts.
  assert.deepEqual(tracker.observeToolCall({ toolCallId: 't1', status: 'completed', content: [diff] }), []);
  assert.equal(tracker.list().length, 1);
  assert.equal(tracker.list()[0]!.oldText, 'x\r\n');
});

test('tracker: a write reported afterwards adopts the tool call id', async () => {
  const cwd = await workspace();
  const tracker = new ChangeTracker({ cwd });
  const path = join(cwd, 'b.txt');

  const written = tracker.recordWrite(path, null, 'hello\n');
  assert.equal(written?.toolCallId, null);
  const [adopted] = tracker.observeToolCall({
    toolCallId: 't2',
    status: 'completed',
    content: [{ type: 'diff', path, oldText: null, newText: 'hello\n' }],
  });
  assert.equal(adopted, written);
  assert.equal(adopted!.toolCallId, 't2');
  assert.equal(tracker.list().length, 1);
});

test('tracker: a snippet diff folds into the whole-file write', async () => {
  const cwd = await workspace();
  const tracker = new ChangeTracker({ cwd });
  const path = join(cwd, 'c.cpp');

  tracker.observeToolCall({
    toolCallId: 't3',
    status: 'pending',
    content: [{ type: 'diff', path, oldText: 'foo(1)', newText: 'foo(2)' }],
  });
  const change = tracker.recordWrite(path, 'a\nfoo(1)\nb\n', 'a\nfoo(2)\nb\n');
  assert.equal(tracker.list().length, 1);
  assert.equal(change!.toolCallId, 't3');
  assert.equal(change!.newText, 'a\nfoo(2)\nb\n');
  assert.equal(change!.exact, true);
});

test('tracker: completed status marks reported changes applied', async () => {
  const cwd = await workspace();
  const tracker = new ChangeTracker({ cwd });
  const path = join(cwd, 'd.txt');
  tracker.observeToolCall({ toolCallId: 't4', status: 'in_progress', content: [{ type: 'diff', path, newText: 'z' }] });
  assert.equal(tracker.undecided, 0);
  const [done] = tracker.observeToolCall({ toolCallId: 't4', status: 'completed' });
  assert.equal(done!.applied, true);
  assert.equal(tracker.undecided, 1);
});

test('tracker: revert restores, is idempotent, deletes new files', async () => {
  const cwd = await workspace();
  const tracker = new ChangeTracker({ cwd });

  const edited = join(cwd, 'edited.txt');
  await writeFile(edited, 'new\n', 'utf8');
  const change = tracker.recordWrite(edited, 'old\n', 'new\n')!;
  const first = await tracker.revert(change.changeId);
  assert.equal(first.result, 'reverted');
  assert.equal(await readFile(edited, 'utf8'), 'old\n');
  assert.equal(first.change.decision, 'reverted');

  const again = await tracker.revert(change.changeId);
  assert.equal(again.result, 'already-reverted');

  const created = join(cwd, 'created.txt');
  await writeFile(created, 'x', 'utf8');
  const fresh = tracker.recordWrite(created, null, 'x')!;
  await tracker.revert(fresh.changeId);
  assert.equal(await exists(created), false, 'reverting a new file removes it');
});

test('tracker: conflict leaves the file and the decision untouched', async () => {
  const cwd = await workspace();
  const tracker = new ChangeTracker({ cwd });
  const path = join(cwd, 'e.txt');
  await writeFile(path, 'something else\n', 'utf8');
  const change = tracker.recordWrite(path, 'old\n', 'new\n')!;

  await assert.rejects(tracker.revert(change.changeId), (err: unknown) => {
    assert.ok(err instanceof ChangeError);
    assert.equal(err.code, 'conflict');
    return true;
  });
  assert.equal(await readFile(path, 'utf8'), 'something else\n');
  assert.equal(change.decision, null);
});

test('tracker: a diff outside the session root is shown but never reverted', async () => {
  const cwd = await workspace();
  const tracker = new ChangeTracker({ cwd });
  const outside = join(cwd, '..', 'elsewhere.txt');
  const [change] = tracker.observeToolCall({
    toolCallId: 't5',
    status: 'completed',
    content: [{ type: 'diff', path: outside, oldText: 'a', newText: 'b' }],
  });
  assert.equal(change!.revertable, false);
  await assert.rejects(tracker.revert(change!.changeId), (err: unknown) => {
    assert.ok(err instanceof ChangeError);
    assert.equal(err.code, 'not_revertable');
    return true;
  });
});

test('tracker: keep records the decision; unknown ids are not_found', async () => {
  const cwd = await workspace();
  const tracker = new ChangeTracker({ cwd });
  const change = tracker.recordWrite(join(cwd, 'f.txt'), 'a', 'b')!;
  assert.equal(tracker.keep(change.changeId).decision, 'kept');
  assert.equal(tracker.undecided, 0);
  assert.throws(() => tracker.keep('nope'), (err: unknown) => err instanceof ChangeError && err.code === 'not_found');
});

test('tracker: a write over a non-UTF-8 file is shown but never reverted', async () => {
  const cwd = await workspace();
  const tracker = new ChangeTracker({ cwd });
  const path = join(cwd, 'gbk.cpp');
  const change = tracker.recordWrite(path, '\ufffd\ufffd', 'utf8 now\n', { lossy: true })!;
  assert.equal(change.revertable, false);
  assert.equal(change.revertBlock, 'not_utf8');
  await writeFile(path, 'utf8 now\n', 'utf8');
  await assert.rejects(tracker.revert(change.changeId), (err: unknown) => {
    assert.ok(err instanceof ChangeError);
    assert.equal(err.code, 'not_utf8');
    return true;
  });
  assert.equal(await readFile(path, 'utf8'), 'utf8 now\n', 'file untouched');
});

test('tracker: revert refuses to rewrite a file that is no longer UTF-8', async () => {
  const cwd = await workspace();
  const tracker = new ChangeTracker({ cwd });
  const path = join(cwd, 'h.txt');
  const change = tracker.recordWrite(path, 'old\n', 'new\n')!;
  const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0a]); // "中文\n" in GBK
  await writeFile(path, gbk);
  await assert.rejects(tracker.revert(change.changeId), (err: unknown) => {
    assert.ok(err instanceof ChangeError);
    assert.equal(err.code, 'not_utf8');
    return true;
  });
  assert.deepEqual(await readFile(path), gbk, 'bytes untouched');
});

test('tracker: a BOM survives a revert', async () => {
  const cwd = await workspace();
  const tracker = new ChangeTracker({ cwd });
  const path = join(cwd, 'bom.h');
  await writeFile(path, '\ufeffnew\n', 'utf8');
  const change = tracker.recordWrite(path, '\ufeffold\n', '\ufeffnew\n')!;
  await tracker.revert(change.changeId);
  const bytes = await readFile(path);
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(bytes.toString('utf8'), '\ufeffold\n');
});

test('tracker: _meta.acpEditor.exact marks whole-file texts as exact', async () => {
  const cwd = await workspace();
  const tracker = new ChangeTracker({ cwd });
  const path = join(cwd, 'i.txt');
  const [change] = tracker.observeToolCall({
    toolCallId: 't9',
    status: 'completed',
    content: [{ type: 'diff', path, oldText: 'a\n', newText: 'b\r\n', _meta: { acpEditor: { exact: true } } }],
  });
  assert.equal(change!.exact, true);
  // Exact: the LF original comes back as LF even though the file is CRLF now.
  await writeFile(path, 'b\r\n', 'utf8');
  await tracker.revert(change!.changeId);
  assert.equal(await readFile(path, 'utf8'), 'a\n');
});

test('tracker: a deletion is reverted by recreating the file', async () => {
  const cwd = await workspace();
  const tracker = new ChangeTracker({ cwd });
  const path = join(cwd, 'removed.txt');
  const change = tracker.recordObserved(path, 'gone\n', null, null)!;
  assert.equal(change.deleted, true);
  assert.equal(change.applied, true);

  await tracker.revert(change.changeId);
  assert.equal(await readFile(path, 'utf8'), 'gone\n');
});

test('tracker: reverting a deletion recreates missing parent directories', async () => {
  const cwd = await workspace();
  const tracker = new ChangeTracker({ cwd });
  const path = join(cwd, 'sub', 'dir', 'gone.txt');
  const change = tracker.recordObserved(path, 'x\n', null, null)!;
  await tracker.revert(change.changeId);
  assert.equal(await readFile(path, 'utf8'), 'x\n');
});

test('tracker: recordObserved folds into the tool call that named the file', async () => {
  const cwd = await workspace();
  const tracker = new ChangeTracker({ cwd });
  const path = join(cwd, 'k.txt');
  // The agent announced the edit as a diff, its tool completed, then the
  // snapshot comparison sees the same result on disk.
  tracker.observeToolCall({
    toolCallId: 't10',
    status: 'completed',
    content: [{ type: 'diff', path, oldText: 'a', newText: 'b' }],
  });
  tracker.recordWrite(path, 'a\n', 'b\n');
  const observed = tracker.recordObserved(path, 'a\n', 'b\n', 't10');
  assert.equal(tracker.list().length, 1, 'one change, not three');
  assert.equal(observed!.toolCallId, 't10');
  assert.equal(observed!.exact, true);
});

test('tracker: recordObserved for an unknown tool call stands alone', async () => {
  const cwd = await workspace();
  const tracker = new ChangeTracker({ cwd });
  const path = join(cwd, 'u.txt');
  const change = tracker.recordObserved(path, 'x\n', 'y\n', 'no-such-call')!;
  assert.equal(change.origin, 'snapshot');
  assert.equal(change.toolCallId, 'no-such-call');
  assert.equal(change.applied, true);
});

test('planRestore: a deletion is undone unless something replaced the file', async () => {
  assert.deepEqual(planRestore({ oldText: 'a\n', newText: '', exact: true, deleted: true }, null), {
    kind: 'write',
    text: 'a\n',
  });
  assert.equal(planRestore({ oldText: null, newText: '', exact: true, deleted: true }, null).kind, 'noop');
  assert.equal(
    planRestore({ oldText: 'a\n', newText: '', exact: true, deleted: true }, 'a\n').kind,
    'noop',
  );
  assert.equal(
    planRestore({ oldText: 'a\n', newText: '', exact: true, deleted: true }, 'b\n').kind,
    'conflict',
  );
});
