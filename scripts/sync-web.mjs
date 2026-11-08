#!/usr/bin/env node
/**
 * Copy the web panel into the Unreal plugin.
 *
 * The editor serves Resources/web/index.html from memory, so the plugin needs
 * its own copy of packages/web/index.html. A hub test fails when they drift.
 *
 *   node scripts/sync-web.mjs
 */
import { copyFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const source = resolve(root, 'packages/web/index.html');
const target = resolve(root, 'hosts/unreal/AcpEditor/Resources/web/index.html');

const [before, wanted] = await Promise.all([readFile(target, 'utf8').catch(() => ''), readFile(source, 'utf8')]);
if (before === wanted) {
  console.log('web panel already in sync');
} else {
  await copyFile(source, target);
  console.log(`synced ${source}\n    -> ${target}`);
}
