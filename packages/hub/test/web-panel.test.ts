/**
 * Tests for the web panel's diff engine, run against the exact code the panel
 * ships: the block between the @diff-engine markers in packages/web/index.html.
 * (Unreal serves the panel from memory as one document, so it cannot load a
 * separate script file; the engine has to live inline.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const here = fileURLToPath(new URL('.', import.meta.url));
const repo = resolve(here, '../../..');
const PANEL = resolve(repo, 'packages/web/index.html');
const PLUGIN_COPY = resolve(repo, 'hosts/unreal/AcpEditor/Resources/web/index.html');

type Op = { op: '=' | '-' | '+'; a?: number; b?: number };
interface Engine {
  CONTEXT: number;
  splitLines(text: string | null): string[];
  diffOps(a: string[], b: string[]): Op[];
  buildModel(
    oldText: string | null,
    newText: string,
  ): {
    a: string[];
    b: string[];
    blocks: Array<{ type: 'gap'; count: number } | { type: 'hunk'; ops: Op[] }>;
    adds: number;
    dels: number;
    created: boolean;
    unchanged: boolean;
    eolOnly: boolean;
  };
  inlineRange(oldLine: string, newLine: string): { a: [number, number]; b: [number, number] } | null;
}

async function loadEngine(): Promise<Engine> {
  const html = await readFile(PANEL, 'utf8');
  const match = /\/\* @diff-engine:begin \*\/([\s\S]*?)\/\* @diff-engine:end \*\//.exec(html);
  assert.ok(match, 'diff engine markers present in index.html');
  return new Function(`${match[1]}\nreturn createDiffEngine();`)() as Engine;
}

/** Edits an optimal script needs: n + m - 2 * LCS. */
function optimalEdits(a: string[], b: string[]): number {
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i]![j] = a[i - 1] === b[j - 1] ? dp[i - 1]![j - 1]! + 1 : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
    }
  }
  return a.length + b.length - 2 * dp[a.length]![b.length]!;
}

/** Rebuild both sides from a script, checking every equal pair really is equal. */
function replay(a: string[], b: string[], ops: Op[]): { left: string[]; right: string[] } {
  const left: string[] = [];
  const right: string[] = [];
  for (const o of ops) {
    if (o.op === '=') {
      assert.equal(a[o.a!], b[o.b!], 'equal op pairs equal lines');
      left.push(a[o.a!]!);
      right.push(b[o.b!]!);
    } else if (o.op === '-') {
      left.push(a[o.a!]!);
    } else {
      right.push(b[o.b!]!);
    }
  }
  return { left, right };
}

test('diff engine: random scripts are valid and minimal', async () => {
  const engine = await loadEngine();
  let seed = 12345;
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const sample = () => Array.from({ length: rand(13) }, () => 'abcd'[rand(4)]!);

  for (let round = 0; round < 600; round++) {
    const a = sample();
    const b = sample();
    const ops = engine.diffOps(a, b);
    const { left, right } = replay(a, b, ops);
    assert.deepEqual(left, a);
    assert.deepEqual(right, b);
    const edits = ops.filter((o) => o.op !== '=').length;
    assert.equal(edits, optimalEdits(a, b), `minimal for ${a.join('')} -> ${b.join('')}`);
  }
});

test('diff engine: deletions come before insertions inside a run', async () => {
  const engine = await loadEngine();
  const ops = engine.diffOps(['x', 'old1', 'old2', 'y'], ['x', 'new1', 'new2', 'y']);
  assert.deepEqual(
    ops.map((o) => o.op).join(''),
    '=--++=',
  );
});

test('diff engine: hunks keep context and hide the rest behind gaps', async () => {
  const engine = await loadEngine();
  const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
  const edited = [...lines];
  edited[4] = 'line 5 changed';
  edited[30] = 'line 31 changed';
  const model = engine.buildModel(lines.join('\n') + '\n', edited.join('\n') + '\n');

  assert.equal(model.adds, 2);
  assert.equal(model.dels, 2);
  assert.deepEqual(
    model.blocks.map((b) => b.type),
    ['gap', 'hunk', 'gap', 'hunk', 'gap'],
  );
  const hunks = model.blocks.filter((b): b is { type: 'hunk'; ops: Op[] } => b.type === 'hunk');
  // 3 context lines, the change (delete + insert), 3 context lines.
  assert.equal(hunks[0]!.ops.length, 3 + 2 + 3);
  const hidden = model.blocks.reduce((n, b) => (b.type === 'gap' ? n + b.count : n), 0);
  const shown = hunks.reduce((n, h) => n + h.ops.filter((o) => o.op === '=').length, 0);
  assert.equal(hidden + shown, 38, 'every unchanged line is either shown or counted in a gap');
});

test('diff engine: a single hidden line is merged instead of a gap', async () => {
  const engine = await loadEngine();
  const lines = Array.from({ length: 12 }, (_, i) => `l${i + 1}`);
  const edited = [...lines];
  edited[1] = 'L2';
  edited[9] = 'L10'; // 7 unchanged lines between: 3 + 1 + 3
  const model = engine.buildModel(lines.join('\n'), edited.join('\n'));
  assert.ok(!model.blocks.some((b) => b.type === 'gap' && b.count === 1));
});

test('diff engine: new files, unchanged texts and line endings', async () => {
  const engine = await loadEngine();

  const created = engine.buildModel(null, 'a\nb\n');
  assert.equal(created.created, true);
  assert.equal(created.adds, 2);
  assert.equal(created.dels, 0);

  assert.equal(engine.buildModel('same\n', 'same\n').unchanged, true);

  const eol = engine.buildModel('a\r\nb\r\n', 'a\nb\n');
  assert.equal(eol.eolOnly, true);
  assert.equal(eol.adds + eol.dels, 0);

  assert.equal(engine.buildModel('a\nb', 'a\nb\n').eolOnly, true, 'final newline only');
  assert.deepEqual(engine.splitLines(''), []);
  assert.deepEqual(engine.splitLines('x\r\ny\r\n'), ['x', 'y']);
});

test('diff engine: a large file with scattered edits stays exact', async () => {
  const engine = await loadEngine();
  const lines = Array.from({ length: 5000 }, (_, i) => `const v${i} = ${i};`);
  const edited = lines.map((line, i) => (i % 500 === 0 ? line.replace('const', 'let') : line));
  edited.splice(2500, 0, '// inserted');
  const model = engine.buildModel(lines.join('\n'), edited.join('\n'));
  assert.equal(model.dels, 10);
  assert.equal(model.adds, 11);
});

test('diff engine: inline range marks only the changed span', async () => {
  const engine = await loadEngine();
  assert.deepEqual(engine.inlineRange('foo(1, 2);', 'foo(1, 3);'), { a: [7, 8], b: [7, 8] });
  assert.deepEqual(engine.inlineRange('ab', 'aXb'), { a: [1, 1], b: [1, 2] });
  assert.equal(engine.inlineRange('abc', 'xyz'), null, 'nothing shared');
  // Never split a surrogate pair: U+1F600 vs U+1F601 share their high surrogate.
  const r = engine.inlineRange('x\u{1F600}', 'x\u{1F601}');
  assert.deepEqual(r, { a: [1, 3], b: [1, 3] });
});

test('web panel: the Unreal plugin ships the same index.html', async () => {
  const [panel, copy] = await Promise.all([readFile(PANEL, 'utf8'), readFile(PLUGIN_COPY, 'utf8')]);
  assert.ok(
    panel === copy,
    'hosts/unreal/AcpEditor/Resources/web/index.html is stale: run `node scripts/sync-web.mjs`',
  );
});

/**
 * Regression guard for a bug that cost a whole debugging session: switching
 * sessions left the composer dead.
 *
 * The view switch used to toggle `input.disabled`, and only one of the paths back
 * to a live session undid it. A disabled <textarea> cannot take DOM focus, so the
 * panel looked like it had lost keyboard focus (in CEF it also looked like a
 * WebBrowser focus bug). Exactly one helper may own the composer state.
 */
test('web panel: the composer has a single owner and never uses disabled', async () => {
  const panel = await readFile(PANEL, 'utf8');

  assert.ok(
    !/\$\('input'\)\.disabled\s*=/.test(panel),
    'the composer input must not be disabled directly: use setComposerEnabled(), ' +
      'a disabled textarea can never regain focus',
  );

  const calls = panel.match(/setComposerEnabled\((?:true|false)\)/g) ?? [];
  assert.equal(
    calls.length,
    3,
    'all three session paths (view history, back to live, start/resume session) must set the composer state',
  );

  const definition = /function setComposerEnabled\(on\)\s*\{([\s\S]*?)\n\}/.exec(panel);
  assert.ok(definition, 'setComposerEnabled is defined');
  assert.match(definition[1]!, /readOnly/, 'it must use readOnly, not disabled');
});
