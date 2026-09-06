// NAIA 기동·준비 대기. 생성을 개시하지 않는다 — 프로세스를 띄우고 /api/status 가 응답할 때까지 기다릴 뿐.
import path from 'node:path';

const isExecutablePath = cmd => /\.(exe|bat|cmd)$/i.test(cmd) && (path.isAbsolute(cmd) || /^[A-Za-z]:[\\/]/.test(cmd));

export function launchNaia({ config, spawn, platform = process.platform, env = process.env }) {
  const { command, args = [], cwd: launchCwd = '.', env: extraEnv = {} } = config.launch;
  const exe = isExecutablePath(command);
  const cwd = exe ? path.dirname(command) : path.join(config.naia_root, launchCwd);
  const child = spawn(command, args, { cwd, env: { ...env, ...extraEnv }, detached: true, stdio: 'ignore', shell: exe ? false : platform === 'win32' });
  child.unref?.();
  return { pid: child.pid, command, args, cwd };
}

export async function waitReady({ client, timeoutSec, pollSec = 2, sleep, now = Date.now }) {
  const start = now();
  for (;;) {
    if (await client.status()) return { reachable: true, elapsed_sec: Math.round((now() - start) / 1000) };
    if (now() - start >= timeoutSec * 1000) return { reachable: false, elapsed_sec: Math.round((now() - start) / 1000) };
    await sleep(pollSec * 1000);
  }
}

export async function ensureRunning({ client, config, spawn, sleep, now = Date.now, platform, env }) {
  if (await client.status()) return { launched: false, reachable: true, elapsed_sec: 0 };
  const { pid } = launchNaia({ config, spawn, platform, env });
  const ready = await waitReady({ client, timeoutSec: config.launch.ready_timeout_sec ?? 120, pollSec: 2, sleep, now });
  return { launched: true, reachable: ready.reachable, elapsed_sec: ready.elapsed_sec, pid };
}
