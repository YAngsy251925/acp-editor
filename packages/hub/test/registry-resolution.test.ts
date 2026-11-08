/**
 * Executable resolution is a product contract: the hub must never silently drive an
 * older binary just because it sits earlier on PATH, and it must say so when the only
 * build it can find lacks a feature.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AgentRegistry,
  compareVersions,
  resetVersionCache,
  satisfies,
} from '../src/registry.js';

/** A fake CLI in `dir` whose `--version` prints `version`. */
async function fakeCli(dir: string, name: string, version: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  if (process.platform === 'win32') {
    const path = join(dir, `${name}.cmd`);
    await writeFile(path, `@echo off\r\necho ${version}\r\n`, 'utf8');
    return path;
  }
  const path = join(dir, name);
  await writeFile(path, `#!/bin/sh\necho "${version}"\n`, 'utf8');
  await chmod(path, 0o755);
  return path;
}

async function registryWith(definition: Record<string, unknown>): Promise<AgentRegistry> {
  const dir = await mkdtemp(join(tmpdir(), 'acp-registry-'));
  const config = join(dir, 'agents.json');
  await writeFile(config, JSON.stringify({ agents: [definition] }), 'utf8');
  return new AgentRegistry({ userConfigPath: config });
}

function withPath<T>(path: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.PATH;
  process.env.PATH = path;
  return run().finally(() => {
    process.env.PATH = previous;
  });
}

test('version ordering follows semver, including prereleases', () => {
  assert.equal(compareVersions('0.2.2-rc.1', '0.1.5-rc.2') > 0, true);
  assert.equal(compareVersions('0.2.2', '0.2.2-rc.1') > 0, true, 'release beats prerelease');
  assert.equal(compareVersions('v1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('1.10.0', '1.9.9') > 0, true);
  assert.equal(compareVersions(undefined, '1.0.0') < 0, true);

  assert.equal(satisfies('>=0.2.2-rc.1', '0.2.2-rc.1'), true);
  assert.equal(satisfies('>=0.2.2-rc.1', '0.1.5-rc.2'), false);
  assert.equal(satisfies('*', 'anything'), true);
  assert.equal(satisfies('>=1.0.0', undefined), false);
});

test('resolution prefers the newest eligible install, not the first on PATH', async () => {
  resetVersionCache();
  const root = await mkdtemp(join(tmpdir(), 'acp-resolve-'));
  const older = join(root, 'older');
  const newer = join(root, 'newer');
  const oldPath = await fakeCli(older, 'dsh', '0.1.5-rc.2');
  const newPath = await fakeCli(newer, 'dsh', '0.2.2-rc.1');

  const registry = await registryWith({
    id: 'probe-agent',
    name: 'Probe',
    command: ['dsh', '--profile', 'acp'],
    features: { mcp: '>=0.2.2-rc.1' },
  });

  await withPath([older, newer].join(process.platform === 'win32' ? ';' : ':'), async () => {
    const status = (await registry.getStatus('probe-agent', { force: true }))!;
    assert.equal(status.available, true);
    assert.equal(status.resolvedPath, newPath, 'the capable build wins');
    assert.equal(status.version, '0.2.2-rc.1');
    assert.equal(status.capabilities?.mcp, true);
    assert.deepEqual(status.warnings, undefined);
    assert.ok(
      (status.candidates?.length ?? 0) >= 2,
      'every candidate is reported, including ones outside PATH',
    );
    assert.ok(
      status.candidates?.some((c) => c.path === oldPath),
      'the older one is still listed for diagnosis',
    );
    assert.ok(
      status.candidates?.some((c) => c.path === newPath),
      'the chosen one is listed too',
    );
  });
});

test('an old build stays usable but loses the feature and says why', async () => {
  resetVersionCache();
  const root = await mkdtemp(join(tmpdir(), 'acp-resolve-old-'));
  const only = join(root, 'only');
  await fakeCli(only, 'dsh', '0.1.5-rc.2');

  const registry = await registryWith({
    id: 'probe-agent',
    name: 'Probe',
    command: ['dsh', '--profile', 'acp'],
    features: { mcp: '>=0.2.2-rc.1' },
  });

  await withPath(only, async () => {
    const status = (await registry.getStatus('probe-agent', { force: true }))!;
    assert.equal(status.available, true, 'chat must keep working on an old build');
    assert.equal(status.capabilities?.mcp, false);
    assert.match(status.warnings?.join(' ') ?? '', /mcp 需要 >=0\.2\.2-rc\.1/);
  });
});

test('minVersion is a hard floor: below it the agent is unavailable, with evidence', async () => {
  resetVersionCache();
  const root = await mkdtemp(join(tmpdir(), 'acp-resolve-floor-'));
  const only = join(root, 'only');
  const path = await fakeCli(only, 'dsh', '0.1.5-rc.2');

  const registry = await registryWith({
    id: 'probe-agent',
    name: 'Probe',
    command: ['dsh', '--profile', 'acp'],
    minVersion: '>=0.2.0',
  });

  await withPath(only, async () => {
    const status = (await registry.getStatus('probe-agent', { force: true }))!;
    assert.equal(status.available, false);
    assert.match(status.reason ?? '', /不满足要求/);
    assert.match(status.reason ?? '', /0\.1\.5-rc\.2/, 'the found version is named');
    assert.match(status.reason ?? '', new RegExp(path.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')));
    assert.match(status.reason ?? '', /ACP_PROBE_AGENT_BIN/, 'the override is advertised');
  });
});

test('ACP_<ID>_BIN pins one executable, and a broken pin is not papered over', async () => {
  resetVersionCache();
  const root = await mkdtemp(join(tmpdir(), 'acp-resolve-env-'));
  const older = join(root, 'older');
  const newer = join(root, 'newer');
  const oldPath = await fakeCli(older, 'dsh', '0.1.5-rc.2');
  await fakeCli(newer, 'dsh', '0.2.2-rc.1');

  const registry = await registryWith({
    id: 'probe-agent',
    name: 'Probe',
    command: ['dsh', '--profile', 'acp'],
    features: { mcp: '>=0.2.2-rc.1' },
  });

  const envKey = 'ACP_PROBE_AGENT_BIN';
  const previous = process.env[envKey];

  await withPath(older, async () => {
    process.env[envKey] = oldPath;
    try {
      const pinned = (await registry.getStatus('probe-agent', { force: true }))!;
      assert.equal(pinned.resolvedPath, oldPath, 'an explicit pin wins over ranking');
      assert.equal(pinned.capabilities?.mcp, false);

      process.env[envKey] = join(root, 'missing', 'dsh.cmd');
      const broken = (await registry.getStatus('probe-agent', { force: true }))!;
      assert.equal(broken.available, false, 'a broken pin is an error, never a silent fallback');
    } finally {
      if (previous === undefined) delete process.env[envKey];
      else process.env[envKey] = previous;
    }
  });
});
