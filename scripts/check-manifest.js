/**
 * Checks zoia-addon.json the way Zoia will, as far as it can be checked here:
 * the image is filled in by the release workflow, so only --strict, run
 * there after it is, requires a real digest.
 */

import { readFile } from 'node:fs/promises';

const strict = process.argv.includes('--strict');
const manifest = JSON.parse(await readFile(new URL('../zoia-addon.json', import.meta.url), 'utf8'));
const problems = [];

if (!/^[a-z][a-z0-9-]{1,31}$/.test(manifest.id)) problems.push('id');
if (!manifest.name || manifest.name.length > 40) problems.push('name');
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) problems.push('version');
const image = /^ghcr\.io\/[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)+@sha256:[0-9a-f]{64}$/;
if (strict && !image.test(manifest.image)) problems.push('image');
const commands = manifest.commands ?? [];
if (commands.length > 0 && !manifest.permissions.includes('commands')) problems.push('permissions');
for (const c of commands) {
  if (!/^[a-z][a-z0-9-]{0,23}$/.test(c.name) || !c.description) problems.push(`command ${c.name}`);
}
const types = ['string', 'secret', 'number', 'boolean', 'select', 'chat', 'channel'];
for (const s of manifest.settings ?? []) {
  if (!types.includes(s.type) || !/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(s.key)) {
    problems.push(`setting ${s.key}`);
  }
}

if (problems.length > 0) {
  console.error(`zoia-addon.json: ${problems.join(', ')}`);
  process.exit(1);
}
console.log('zoia-addon.json is valid');
