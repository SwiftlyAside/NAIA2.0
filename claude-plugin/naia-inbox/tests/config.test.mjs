import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS, resolveDataDir, loadConfig, validateConfig, mergeConfig, saveConfig } from '../server/lib/config.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'naia-inbox-'));

test('data dir: env first, else ~/.claude/plugins/data/naia-inbox', () => {
  assert.equal(resolveDataDir({ NAIA_INBOX_DATA: 'D:/x' }, '/home/u'), 'D:/x');
  assert.equal(resolveDataDir({}, '/home/u'), path.join('/home/u', '.claude', 'plugins', 'data', 'naia-inbox'));
});

test('precedence env > config.json > defaults, with sources', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ base_url: 'http://127.0.0.1:7250', max_jobs: 4 }));
  const { config, sources } = loadConfig({ env: { NAIA_BASE_URL: 'http://127.0.0.1:7260' }, fs, dataDir: dir });
  assert.equal(config.base_url, 'http://127.0.0.1:7260'); assert.equal(sources.base_url, 'env');
  assert.equal(config.max_jobs, 4); assert.equal(sources.max_jobs, 'config');
  assert.equal(config.launch.command, DEFAULTS.launch.command); assert.equal(sources.launch, 'default');
});

test('missing or broken config.json falls back to defaults and reports the error', () => {
  const dir = tmp();
  assert.deepEqual(loadConfig({ env: {}, fs, dataDir: dir }).config, DEFAULTS);
  fs.writeFileSync(path.join(dir, 'config.json'), '{broken');
  const r = loadConfig({ env: {}, fs, dataDir: dir });
  assert.deepEqual(r.config, DEFAULTS); assert.equal(r.errors.length, 1);
});

test('validate: url format, naia_root existence, forbidden env keys, max_jobs range', () => {
  const dir = tmp();
  const ok = mergeConfig(DEFAULTS, { naia_root: dir });
  assert.deepEqual(validateConfig(ok, { fs }), []);
  const bad = mergeConfig(DEFAULTS, { base_url: 'ftp://x', naia_root: path.join(dir, 'nope'), max_jobs: 99,
    launch: { env: { NOVELAI_TOKEN: 'x', REQUESTS_CA_BUNDLE: 'c.pem' } } });
  const errs = validateConfig(bad, { fs });
  assert.equal(errs.some(e => /base_url/.test(e)), true);
  assert.equal(errs.some(e => /naia_root/.test(e)), true);
  assert.equal(errs.some(e => /NOVELAI_TOKEN/.test(e)), true);
  assert.equal(errs.some(e => /max_jobs/.test(e)), true);
  assert.equal(errs.some(e => /REQUESTS_CA_BUNDLE/.test(e)), false);
});

test('mergeConfig merges launch and launch.env objects instead of replacing', () => {
  const m = mergeConfig(DEFAULTS, { launch: { env: { SSL_CERT_FILE: 'b.pem' } } });
  assert.equal(m.launch.command, 'npm');
  assert.equal(m.launch.env.REQUESTS_CA_BUNDLE, DEFAULTS.launch.env.REQUESTS_CA_BUNDLE);
  assert.equal(m.launch.env.SSL_CERT_FILE, 'b.pem');
});

test('saveConfig writes atomically and round-trips', () => {
  const dir = tmp();
  const p = saveConfig({ fs, dataDir: path.join(dir, 'nested') }, mergeConfig(DEFAULTS, { max_jobs: 5 }));
  assert.equal(path.basename(p), 'config.json');
  assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).max_jobs, 5);
  assert.equal(fs.existsSync(p + '.tmp'), false);
});
