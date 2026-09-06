// 설정: env(NAIA_BASE_URL·NAIA_ROOT) > ${NAIA_INBOX_DATA}/config.json > DEFAULTS. fs 주입(테스트).
import path from 'node:path';

export const DEFAULTS = Object.freeze({
  base_url: 'http://127.0.0.1:7243',
  naia_root: 'F:/ai/NAIA2.0',
  launch: {
    cwd: 'app/electron', command: 'npm', args: ['start'],
    env: { REQUESTS_CA_BUNDLE: 'F:/ai/NAIA2.0/venv/ca-bundle.pem', SSL_CERT_FILE: 'F:/ai/NAIA2.0/venv/ca-bundle.pem' },
    ready_timeout_sec: 120,
  },
  default_source: 'claude-code',
  max_jobs: 9,
});
export const FORBIDDEN_ENV_KEY = /TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY/i;
const ENV_MAP = { NAIA_BASE_URL: 'base_url', NAIA_ROOT: 'naia_root' };

export function resolveDataDir(env, homedir) {
  return env.NAIA_INBOX_DATA || path.join(homedir, '.claude', 'plugins', 'data', 'naia-inbox');
}

const clone = v => JSON.parse(JSON.stringify(v));

export function mergeConfig(base, set) {
  const out = clone(base);
  for (const [k, v] of Object.entries(set || {})) {
    if (k === 'launch' && v && typeof v === 'object') {
      out.launch = { ...out.launch, ...v };
      if (v.env && typeof v.env === 'object') out.launch.env = { ...(base.launch?.env || {}), ...v.env };
    } else out[k] = v;
  }
  return out;
}

export function loadConfig({ env, fs, dataDir }) {
  const errors = [];
  const sources = Object.fromEntries(Object.keys(DEFAULTS).map(k => [k, 'default']));
  let config = clone(DEFAULTS);
  const file = path.join(dataDir, 'config.json');
  if (fs.existsSync(file)) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      config = mergeConfig(config, saved);
      for (const k of Object.keys(saved)) if (k in sources) sources[k] = 'config';
    } catch (e) { errors.push(`config.json 읽기 실패: ${e.message}`); }
  }
  for (const [envKey, cfgKey] of Object.entries(ENV_MAP)) {
    if (env[envKey]) { config[cfgKey] = env[envKey]; sources[cfgKey] = 'env'; }
  }
  return { config, sources, errors, file };
}

export function validateConfig(cfg, { fs }) {
  const errs = [];
  if (!/^https?:\/\/[^\s/]+(:\d+)?\/?$/.test(String(cfg.base_url || ''))) errs.push(`base_url 형식이 아닙니다: ${cfg.base_url}`);
  if (!cfg.naia_root || !fs.existsSync(cfg.naia_root)) errs.push(`naia_root 디렉터리가 없습니다: ${cfg.naia_root}`);
  const n = Number(cfg.max_jobs);
  if (!Number.isInteger(n) || n < 1 || n > 32) errs.push(`max_jobs 는 1~32 정수여야 합니다: ${cfg.max_jobs}`);
  for (const k of Object.keys(cfg.launch?.env || {})) if (FORBIDDEN_ENV_KEY.test(k)) errs.push(`launch.env 에 자격증명 키를 넣을 수 없습니다: ${k}`);
  if (!cfg.launch?.command) errs.push('launch.command 가 비었습니다');
  return errs;
}

export function saveConfig({ fs, dataDir }, cfg) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'config.json');
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  return file;
}
