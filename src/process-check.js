// src/process-check.js — 检测和终止 Codex 进程
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/** 各平台的进程名常量 */
export const CODEX_PROCESS_NAMES = {
  windows: ['codex.exe', 'codex-windows-sandbox'],
  posix: ['codex'],
};

const isWindows = process.platform === 'win32';

/**
 * 检测 Codex 是否正在运行
 * - Windows：解析 `tasklist /fo csv /nh` 输出
 * - macOS/Linux：使用 `pgrep -x codex`
 * @returns {Promise<boolean>}
 */
export async function isCodexRunning() {
  if (isWindows) {
    return isCodexRunningWindows();
  }
  return isCodexRunningPosix();
}

async function isCodexRunningWindows() {
  try {
    const { stdout } = await execAsync('tasklist /fo csv /nh');
    // tasklist CSV 格式：每行 "进程名","PID","会话名","会话编号","内存"
    const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      // 第一列是带引号的进程名
      const nameMatch = line.match(/^"([^"]+)"/);
      if (!nameMatch) continue;
      const procName = nameMatch[1].toLowerCase();
      if (CODEX_PROCESS_NAMES.windows.some(n => n.toLowerCase() === procName)) {
        return true;
      }
    }
    return false;
  } catch {
    // 命令执行失败时保守地返回 false
    return false;
  }
}

async function isCodexRunningPosix() {
  try {
    // pgrep -x 精确匹配进程名；找到时退出码 0，找不到时退出码 1
    for (const name of CODEX_PROCESS_NAMES.posix) {
      try {
        await execAsync(`pgrep -x ${name}`);
        return true; // 找到进程
      } catch (err) {
        if (err.code !== 1) throw err; // code 1 = 未找到，其他错误重新抛出
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * 终止 Codex 进程
 * @param {{ force?: boolean }} opts
 * @returns {Promise<void>}
 * @throws 终止失败时抛出错误
 */
export async function terminateCodex(opts = {}) {
  if (isWindows) {
    await terminateCodexWindows(opts);
  } else {
    await terminateCodexPosix(opts);
  }
}

async function terminateCodexWindows(_opts) {
  // Windows 始终用 /f 强制终止，确保可靠
  for (const name of CODEX_PROCESS_NAMES.windows) {
    try {
      await execAsync(`taskkill /im "${name}" /f`);
    } catch (err) {
      // 进程不存在时 taskkill 会报错（退出码 128），忽略该情况
      if (!err.stderr?.includes('not found') && !err.stderr?.includes('找不到')) {
        throw new Error(`Failed to terminate ${name}: ${err.message}`);
      }
    }
  }
}

async function terminateCodexPosix(opts) {
  const sig = opts.force ? '-9' : '-15';
  for (const name of CODEX_PROCESS_NAMES.posix) {
    try {
      await execAsync(`pkill ${sig} -x ${name}`);
    } catch (err) {
      // pkill 退出码 1 表示进程未找到，忽略
      if (err.code !== 1) {
        throw new Error(`Failed to terminate ${name}: ${err.message}`);
      }
    }
  }
}
