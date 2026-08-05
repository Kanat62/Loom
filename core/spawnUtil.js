// core/spawnUtil.js - кроссплатформенный spawn. §19.8 ТЗ: на Windows claude
// (и другие .cmd-шимы вроде npm) ставятся как .cmd -> spawn(..., {shell:true}),
// иначе EINVAL. §5.1: child.stdin.on('error') глотает EPIPE.
import { spawn } from 'node:child_process';

const IS_WINDOWS = process.platform === 'win32';

/**
 * runProcess - запускает команду, пишет input в STDIN (если задан), собирает
 * STDOUT/STDERR, убивает по таймауту. Никогда не бросает - результат всегда
 * объект с полями { stdout, stderr, code, timedOut, durationMs }.
 */
export function runProcess(
  cmd,
  args = [],
  { cwd, env, input, timeoutMs = 300_000, shell } = {}
) {
  const useShell = shell ?? IS_WINDOWS;
  const start = Date.now();

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, {
        cwd,
        env: env ?? process.env,
        shell: useShell,
        windowsHide: true,
      });
    } catch (err) {
      resolve({
        stdout: '',
        stderr: String(err?.message ?? err),
        code: -1,
        timedOut: false,
        durationMs: Date.now() - start,
        spawnError: err,
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });

    if (child.stdin) {
      // Глотаем EPIPE: процесс мог завершиться до того, как мы дописали STDIN.
      child.stdin.on('error', () => {});
      if (input !== undefined) {
        child.stdin.write(input);
      }
      child.stdin.end();
    }

    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    }

    child.on('error', (err) => {
      finish({
        stdout,
        stderr: stderr + (stderr ? '\n' : '') + String(err.message),
        code: -1,
        timedOut,
        durationMs: Date.now() - start,
        spawnError: err,
      });
    });

    child.on('close', (code) => {
      finish({ stdout, stderr, code, timedOut, durationMs: Date.now() - start });
    });
  });
}

export const IS_WIN32 = IS_WINDOWS;
