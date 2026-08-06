// core/spawnUtil.js - кроссплатформенный spawn. §19.8 ТЗ: на Windows claude
// (и другие .cmd-шимы вроде npm) ставятся как .cmd -> spawn(..., {shell:true}),
// иначе EINVAL. §5.1: child.stdin.on('error') глотает EPIPE.
import { spawn, execFileSync } from 'node:child_process';

const IS_WINDOWS = process.platform === 'win32';

/**
 * killTree - убивает процесс НАДЁЖНО, вместе с потомками.
 *
 * Найдено тестом таймаута (не шрам ТЗ, реальный баг сборки): на Windows
 * spawn(cmd, args, {shell:true}) порождает cmd.exe, а реальная программа
 * (node.exe/claude.exe/...) становится ЕГО ребёнком. `child.kill()` убивает
 * только cmd.exe - реальный процесс остаётся сиротой, продолжает держать
 * открытым унаследованный stdout/stderr pipe, и событие 'close' никогда не
 * приходит (промис висит до тех пор, пока осиротевший процесс не завершится
 * сам, что сводит таймаут на нет). `taskkill /t /f` убивает всё дерево -
 * но ТОЛЬКО если успевает найти cmd.exe живым. Первая версия звала
 * `execFile` (асинхронно) параллельно с немедленным `child.kill()` - SIGKILL
 * убивал cmd.exe РАНЬШЕ, чем taskkill успевал его найти, и taskkill молча
 * проваливался, оставляя внука-сироту в живых. Фикс: taskkill СИНХРОННО и
 * ПЕРВЫМ, пока cmd.exe ещё жив; child.kill() - только как подчистка после.
 */
function killTree(child) {
  if (IS_WINDOWS && child.pid) {
    try {
      execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
    } catch {
      /* taskkill возвращает ненулевой код, если процесс уже умер сам - не ошибка */
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    /* процесс мог уже завершиться */
  }
}

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

    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      resolve(result);
    }

    // Страховка сверх killTree: если 'close' всё равно не пришёл (taskkill не
    // успел/процесс завис на уровне ОС) - не виснем вечно, разрешаем промис
    // с тем, что успели собрать. .unref() - не держит процесс живым сам по себе.
    let forceTimer;

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      forceTimer = setTimeout(() => {
        finish({ stdout, stderr, code: -1, timedOut: true, durationMs: Date.now() - start });
      }, 3000);
      forceTimer.unref?.();
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
