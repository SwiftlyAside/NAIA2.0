import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(PLUGIN, '..', '..');
const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8'));

test('marketplace points at the plugin directory', () => {
  const m = readJson(path.join(REPO, '.claude-plugin', 'marketplace.json'));
  assert.equal(m.name, 'naia');
  assert.equal(m.owner.name, 'SwiftlyAside');
  const entry = m.plugins.find(p => p.name === 'naia-inbox');
  assert.equal(entry.source, './claude-plugin/naia-inbox');
  assert.equal(fs.existsSync(path.join(REPO, entry.source, '.claude-plugin', 'plugin.json')), true);
});

test('plugin manifest and mcp server entry', () => {
  const p = readJson(path.join(PLUGIN, '.claude-plugin', 'plugin.json'));
  assert.equal(p.name, 'naia-inbox');
  assert.match(p.version, /^\d+\.\d+\.\d+$/);
  const mcp = readJson(path.join(PLUGIN, '.mcp.json'));
  const srv = mcp.mcpServers['naia-inbox'];
  assert.equal(srv.command, 'node');
  assert.deepEqual(srv.args, ['${CLAUDE_PLUGIN_ROOT}/server/naia-inbox-mcp.mjs']);
  assert.equal(srv.env.NAIA_INBOX_DATA, '${CLAUDE_PLUGIN_DATA}');
  assert.equal(srv.timeout, 86400000);
});

test('skill and README are exempt from the repo-wide *.md ignore (plugin docs must ship)', () => {
  const ignore = fs.readFileSync(path.join(REPO, '.gitignore'), 'utf8');
  assert.equal(ignore.includes('!/claude-plugin/**/*.md'), true);
  assert.equal(fs.existsSync(path.join(PLUGIN, 'skills', 'naia-inbox', 'SKILL.md')), true);
});

test('no package.json or node_modules inside the plugin (zero-dependency contract)', () => {
  assert.equal(fs.existsSync(path.join(PLUGIN, 'package.json')), false);
  assert.equal(fs.existsSync(path.join(PLUGIN, 'node_modules')), false);
});
