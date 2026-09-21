const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, execFileSync } = require('child_process');

function getDbPath() {
  const platform = process.platform;
  if (platform === 'win32') {
    const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appdata, 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb');
  } else if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb');
  } else {
    const configDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    return path.join(configDir, 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb');
  }
}

const DB_PATH = getDbPath();
const BRIDGE_SCRIPT = path.join(__dirname, 'vscdb_bridge.py');


let cachedPythonCmd = null;

/**
 * Tự động dò tìm lệnh Python hoạt động trên hệ thống (python / py -3 / py / python3)
 */
function resolvePythonCommand() {
  if (cachedPythonCmd) return cachedPythonCmd;

  const candidates = [
    { cmd: 'python', args: ['--version'] },
    { cmd: 'py', args: ['-3', '--version'] },
    { cmd: 'py', args: ['--version'] },
    { cmd: 'python3', args: ['--version'] }
  ];

  for (const item of candidates) {
    try {
      execFileSync(item.cmd, item.args, { stdio: 'ignore', timeout: 1000 });
      cachedPythonCmd = item.cmd;
      return cachedPythonCmd;
    } catch (e) {}
  }

  cachedPythonCmd = 'python'; // Fallback mặc định
  return cachedPythonCmd;
}

/**
 * Đọc auth state bất đồng bộ từ SQLite state.vscdb (Non-blocking Extension Host)
 */
async function exportVscdbAuth() {
  if (!fs.existsSync(DB_PATH) || !fs.existsSync(BRIDGE_SCRIPT)) {
    return null;
  }

  const pyCmd = resolvePythonCommand();
  const pyArgs = (pyCmd === 'py' && !process.env.PY_NO_3) ? ['-3', BRIDGE_SCRIPT, 'export'] : [BRIDGE_SCRIPT, 'export'];

  return new Promise((resolve) => {
    execFile(pyCmd, pyArgs, {
      encoding: 'utf8',
      timeout: 4000
    }, (err, stdout) => {
      if (err || !stdout || !stdout.trim()) {
        if (err) console.warn('[VscdbHelper] Lỗi export auth state:', err.message);
        return resolve(null);
      }
      try {
        const parsed = JSON.parse(stdout.trim());
        resolve(parsed);
      } catch (e) {
        console.warn('[VscdbHelper] Lỗi parse JSON export:', e.message);
        resolve(null);
      }
    });
  });
}

/**
 * Ghi đè auth state bất đồng bộ vào SQLite state.vscdb của Antigravity IDE
 */
async function importVscdbAuth(authData) {
  if (!fs.existsSync(DB_PATH) || typeof authData !== 'object' || authData === null || !fs.existsSync(BRIDGE_SCRIPT)) {
    return false;
  }

  const tempFile = path.join(path.dirname(DB_PATH), `_auth_swap_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.json`);
  const pyCmd = resolvePythonCommand();
  const pyArgs = (pyCmd === 'py' && !process.env.PY_NO_3) 
    ? ['-3', BRIDGE_SCRIPT, 'import', tempFile] 
    : [BRIDGE_SCRIPT, 'import', tempFile];

  try {
    fs.writeFileSync(tempFile, JSON.stringify(authData), 'utf8');
  } catch (err) {
    console.error('[VscdbHelper] Không thể tạo tệp tạm để import:', err.message);
    return false;
  }

  return new Promise((resolve) => {
    execFile(pyCmd, pyArgs, {
      encoding: 'utf8',
      timeout: 4000
    }, (err, stdout) => {
      try {
        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
      } catch (e) {}

      if (err) {
        console.error('[VscdbHelper] Lỗi import auth state:', err.message);
        return resolve(false);
      }
      resolve((stdout || '').trim() === 'OK');
    });
  });
}

/**
 * Wrapper đồng bộ dùng trong trường hợp cần thiết
 */
function exportVscdbAuthSync() {
  if (!fs.existsSync(DB_PATH) || !fs.existsSync(BRIDGE_SCRIPT)) return null;
  const pyCmd = resolvePythonCommand();
  try {
    const stdout = execFileSync(pyCmd, [BRIDGE_SCRIPT, 'export'], { encoding: 'utf8', timeout: 3000 });
    if (!stdout || !stdout.trim()) return null;
    return JSON.parse(stdout.trim());
  } catch (e) {
    return null;
  }
}

module.exports = {
  DB_PATH,
  resolvePythonCommand,
  exportVscdbAuth,
  importVscdbAuth,
  exportVscdbAuthSync
};
