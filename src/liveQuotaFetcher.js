const http = require('http');
const https = require('https');
const { execFile } = require('child_process');
let vscode;
try {
  vscode = require('vscode');
} catch (e) {
  vscode = null;
}

class LiveQuotaFetcher {
  constructor() {
    this.cachedConfig = null;
    this.lastConfigTime = 0;
  }

  /**
   * Xóa cache để bắt buộc phát hiện lại process Language Server mới
   */
  invalidateCache() {
    this.cachedConfig = null;
    this.lastConfigTime = 0;
  }

  /**
   * Thử nghiệm cổng kết nối (Dual-Protocol: thử HTTPS trước, nếu lỗi EPROTO thử tiếp HTTP)
   */
  _probePort(port, csrfToken) {
    return new Promise((resolve) => {
      // 1. Thử HTTPS (self-signed cert của Language Server)
      const reqHttps = https.request({
        hostname: '127.0.0.1',
        port: port,
        path: '/exa.language_server_pb.LanguageServerService/GetUserStatus',
        method: 'POST',
        rejectUnauthorized: false,
        timeout: 1000,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': 2,
          'x-codeium-csrf-token': csrfToken,
          'connect-protocol-version': '1'
        }
      }, (res) => {
        if (res.statusCode === 200) {
          return resolve({ port, protocol: 'https' });
        }
        resolve(null);
      });

      reqHttps.on('error', () => {
        // 2. Nếu HTTPS lỗi (ví dụ lỗi EPROTO do cổng đang chạy HTTP thuần), thử HTTP
        const reqHttp = http.request({
          hostname: '127.0.0.1',
          port: port,
          path: '/exa.language_server_pb.LanguageServerService/GetUserStatus',
          method: 'POST',
          timeout: 1000,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': 2,
            'x-codeium-csrf-token': csrfToken,
            'connect-protocol-version': '1'
          }
        }, (res2) => {
          if (res2.statusCode === 200) {
            return resolve({ port, protocol: 'http' });
          }
          resolve(null);
        });

        reqHttp.on('error', () => resolve(null));
        reqHttp.on('timeout', () => { reqHttp.destroy(); resolve(null); });
        reqHttp.write('{}');
        reqHttp.end();
      });

      reqHttps.on('timeout', () => { reqHttps.destroy(); resolve(null); });
      reqHttps.write('{}');
      reqHttps.end();
    });
  }

  /**
   * Lấy danh sách cổng LISTENING chính xác của PID từ netstat
   */
  _getListeningPortsForPid(pid) {
    return new Promise((resolve) => {
      execFile('netstat', ['-ano'], { encoding: 'utf8', timeout: 3000 }, (err, stdout) => {
        if (err || !stdout) return resolve([]);
        const ports = [];
        // Khớp chính xác: 127.0.0.1:<port> ... LISTENING <pid>$
        const lines = stdout.split(/\r?\n/);
        for (const line of lines) {
          if (!line.includes('LISTENING')) continue;
          if (line.trim().endsWith(` ${pid}`)) {
            const m = line.match(/127\.0\.0\.1:(\d+)/);
            if (m) {
              const p = parseInt(m[1], 10);
              if (!ports.includes(p)) ports.push(p);
            }
          }
        }
        resolve(ports);
      });
    });
  }

  /**
   * Quét tìm tiến trình Language Server (bằng wmic phi đồng bộ, fallback sang PowerShell CIM)
   */
  _findProcesses() {
    return new Promise((resolve) => {
      // Thử wmic trước (nhẹ và nhanh nhất trên Windows thông dụng)
      execFile('wmic', ['process', 'where', 'name like \'%language_server%\'', 'get', 'ProcessId,CommandLine,CreationDate', '/format:list'], {
        encoding: 'utf8',
        timeout: 3000
      }, (err, stdout) => {
        if (!err && stdout && stdout.includes('CommandLine')) {
          const blocks = stdout.split(/\r?\n\r?\n/).filter(b => b.trim().length > 0);
          const results = [];
          for (const block of blocks) {
            const item = {};
            for (const line of block.split(/\r?\n/)) {
              const idx = line.indexOf('=');
              if (idx !== -1) item[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
            }
            if (item.ProcessId && item.CommandLine) {
              results.push({
                pid: parseInt(item.ProcessId, 10),
                commandLine: item.CommandLine,
                creationDate: item.CreationDate || ''
              });
            }
          }
          if (results.length > 0) return resolve(results);
        }

        // Fallback PowerShell nếu wmic bị gỡ bỏ trên Windows 11
        const psCmd = `Get-CimInstance Win32_Process | Where-Object { $_.Name -like '*language_server*' } | Select-Object ProcessId, CommandLine, CreationDate | ConvertTo-Json -Compress`;
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCmd], {
          encoding: 'utf8',
          timeout: 4000
        }, (psErr, psStdout) => {
          if (psErr || !psStdout || !psStdout.trim()) return resolve([]);
          try {
            let data = JSON.parse(psStdout.trim());
            if (!Array.isArray(data)) data = [data];
            const list = data.map(d => ({
              pid: d.ProcessId,
              commandLine: d.CommandLine,
              creationDate: d.CreationDate ? d.CreationDate.toString() : ''
            })).filter(x => x.pid && x.commandLine);
            resolve(list);
          } catch (e) {
            resolve([]);
          }
        });
      });
    });
  }

  /**
   * Zero-CPU Fast Health Check: Thử ping nhẹ cổng đã biết (1-2ms, không chạy powershell/wmic)
   */
  async checkCachedHealth(config = this.cachedConfig) {
    if (!config || !config.port || !config.csrfToken) return false;
    try {
      await this._doRequest(config, '/exa.language_server_pb.LanguageServerService/GetUserStatus', {}, 600);
      return true;
    } catch (e) {
      return false;
    }
  }

  async _checkCachedHealth(config) {
    return this.checkCachedHealth(config);
  }

  /**
   * Tự động phát hiện port và CSRF token của language_server_windows_x64.exe đang hoạt động
   */
  async detectLanguageServer() {
    // 1. Kiểm tra cache cấu hình: Thử ping nhẹ cổng đã biết trước khi tốn CPU quét tiến trình (Zero-CPU Fast Check)
    if (this.cachedConfig && this.cachedConfig.port && this.cachedConfig.csrfToken) {
      const isAlive = await this.checkCachedHealth(this.cachedConfig);
      if (isAlive) {
        this.lastConfigTime = Date.now();
        return this.cachedConfig;
      }
      this.invalidateCache();
    }

    const procs = await this._findProcesses();
    if (procs.length === 0) {
      this.cachedConfig = null;
      return null;
    }

    // Ưu tiên server có cờ --enable_lsp và mới nhất
    procs.sort((a, b) => {
      const aLsp = a.commandLine.includes('--enable_lsp');
      const bLsp = b.commandLine.includes('--enable_lsp');
      if (aLsp && !bLsp) return -1;
      if (!aLsp && bLsp) return 1;
      return (b.creationDate || '').localeCompare(a.creationDate || '');
    });

    for (const proc of procs) {
      const csrfMatch = proc.commandLine.match(/--csrf_token\s+([a-zA-Z0-9-]+)/);
      if (!csrfMatch) continue;
      const csrfToken = csrfMatch[1];

      // Tìm các cổng LISTENING của PID này
      const ports = await this._getListeningPortsForPid(proc.pid);

      for (const p of ports) {
        const probe = await this._probePort(p, csrfToken);
        if (probe) {
          this.cachedConfig = {
            pid: proc.pid,
            port: probe.port,
            protocol: probe.protocol, // 'https' hoặc 'http'
            csrfToken: csrfToken,
            isLsp: proc.commandLine.includes('--enable_lsp'),
            creationDate: proc.creationDate
          };
          this.lastConfigTime = Date.now();
          return this.cachedConfig;
        }
      }
    }

    this.cachedConfig = null;
    return null;
  }

  /**
   * Chờ đợi Language Server sẵn sàng (hỗ trợ quá trình khởi động lại sau khi đổi tài khoản)
   */
  async waitForServer(maxWaitMs = 12000) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      this.invalidateCache();
      const config = await this.detectLanguageServer();
      if (config) {
        return config;
      }
      await new Promise(r => setTimeout(r, 250));
    }
    return null;
  }

  /**
   * Chờ đợi Language Server với PID mới (khác oldPid) hoặc server mới sẵn sàng
   */
  async waitForNewServer(oldPid = null, maxWaitMs = 12000) {
    const start = Date.now();
    // Chờ 400ms để process cũ bắt đầu thoát
    await new Promise(r => setTimeout(r, 400));

    while (Date.now() - start < maxWaitMs) {
      this.invalidateCache();
      const config = await this.detectLanguageServer();
      if (config && (!oldPid || config.pid !== oldPid)) {
        return config;
      }
      await new Promise(r => setTimeout(r, 250));
    }
    return await this.detectLanguageServer();
  }

  /**
   * Khởi động lại Language Server (dùng command Antigravity hoặc SIGKILL để Extension Host tự động respawn)
   */
  async restartServer() {
    const oldPid = this.cachedConfig ? this.cachedConfig.pid : null;
    this.invalidateCache();

    let restarted = false;
    if (vscode && vscode.commands && typeof vscode.commands.getCommands === 'function') {
      try {
        const allCmds = await vscode.commands.getCommands();
        if (allCmds.includes('antigravity.restartLanguageServer')) {
          await vscode.commands.executeCommand('antigravity.restartLanguageServer');
          restarted = true;
        }
      } catch (e) {
        console.warn('[LiveQuotaFetcher] restartLanguageServer error:', e.message);
      }
    }

    // Nếu chạy trong môi trường test độc lập mà không bật cờ ANTIGRAVITY_FORCE_KILL, không kill tiến trình IDE thật
    const isTestMode = (process.env.NODE_ENV === 'test' || process.env.ANTIGRAVITY_TEST_MODE === '1');
    if (!restarted && !isTestMode) {
      if (oldPid) {
        try { process.kill(oldPid, 'SIGKILL'); } catch (e) {}
      } else {
        const procs = await this._findProcesses();
        for (const p of procs) {
          try { process.kill(p.pid, 'SIGKILL'); } catch (e) {}
        }
      }
    }

    return await this.waitForNewServer(oldPid, isTestMode ? 2000 : 12000);
  }

  /**
   * Gọi Connect-RPC API thật trên Language Server (tự động phát hiện và retry nếu server restart)
   */
  async callRpc(path, payload = {}, retryCount = 3) {
    let config = await this.detectLanguageServer();
    if (!config) {
      config = await this.waitForServer(8000);
      if (!config) {
        throw new Error('Language Server đang khởi động lại hoặc chưa sẵn sàng.');
      }
    }

    try {
      return await this._doRequest(config, path, payload);
    } catch (err) {
      this.invalidateCache();
      if (retryCount > 0) {
        await new Promise(r => setTimeout(r, 1000));
        return await this.callRpc(path, payload, retryCount - 1);
      }
      throw err;
    }
  }

  _doRequest(config, path, payload, timeoutMs = 4000) {
    return new Promise((resolve, reject) => {
      const postData = JSON.stringify(payload);
      const isHttps = config.protocol === 'https';
      const client = isHttps ? https : http;

      const options = {
        hostname: '127.0.0.1',
        port: config.port,
        path: path,
        method: 'POST',
        rejectUnauthorized: false,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
          'x-codeium-csrf-token': config.csrfToken,
          'connect-protocol-version': '1'
        },
        timeout: timeoutMs
      };

      const req = client.request(options, (res) => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              resolve(JSON.parse(body));
            } catch (e) {
              resolve({ raw: body });
            }
          } else {
            reject(new Error(`RPC ${path} trả về HTTP ${res.statusCode}: ${body}`));
          }
        });
      });

      req.on('error', err => reject(err));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('RPC request timed out'));
      });

      req.write(postData);
      req.end();
    });
  }

  /**
   * Lấy thông tin tài khoản và quota thật 100% của từng model (tự phục hồi khi server đang restart)
   */
  async getRealAccountAndQuota(retries = 2) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const userStatusData = await this.callRpc('/exa.language_server_pb.LanguageServerService/GetUserStatus');
        const quotaSummaryData = await this.callRpc('/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary').catch(() => null);

        const userStatus = userStatusData.userStatus || {};
        const userTier = userStatusData.userTier || userStatus.userTier || {};
        const planStatus = userStatus.planStatus || {};
        const planInfo = planStatus.planInfo || {};
        const models = (userStatus.clientModelConfigs && userStatus.clientModelConfigs.models) || [];

        let fiveHourFraction = 1.0;
        let weeklyFraction = 1.0;
        let claudeFraction = 1.0;
        let fiveHourResetTime = null;
        let weeklyResetTime = null;
        let claudeResetTime = null;
        let fiveHourDescription = '';
        let weeklyDescription = '';

        if (quotaSummaryData && quotaSummaryData.response && quotaSummaryData.response.groups) {
          for (const group of quotaSummaryData.response.groups) {
            if (group.displayName && group.displayName.includes('Gemini')) {
              const fiveHourBucket = (group.buckets || []).find(b => b.window === '5h');
              if (fiveHourBucket && typeof fiveHourBucket.remainingFraction === 'number') {
                fiveHourFraction = fiveHourBucket.remainingFraction;
                fiveHourResetTime = fiveHourBucket.resetTime;
                fiveHourDescription = fiveHourBucket.description || '';
              }
              const weeklyBucket = (group.buckets || []).find(b => b.window === 'weekly');
              if (weeklyBucket && typeof weeklyBucket.remainingFraction === 'number') {
                weeklyFraction = weeklyBucket.remainingFraction;
                weeklyResetTime = weeklyBucket.resetTime;
                weeklyDescription = weeklyBucket.description || '';
              }
            }
            if (group.displayName && (group.displayName.includes('Claude') || group.displayName.includes('GPT'))) {
              const claudeBucket = (group.buckets || []).find(b => b.window === '5h') || (group.buckets || [])[0];
              if (claudeBucket && typeof claudeBucket.remainingFraction === 'number') {
                claudeFraction = claudeBucket.remainingFraction;
                claudeResetTime = claudeBucket.resetTime;
              }
            }
          }
        } else {
          const flashModel = models.find(m => m.label && m.label.includes('Flash'));
          if (flashModel && flashModel.quotaInfo) {
            fiveHourFraction = flashModel.quotaInfo.remainingFraction;
            fiveHourResetTime = flashModel.quotaInfo.resetTime;
          }

          const claudeModel = models.find(m => m.label && m.label.includes('Claude'));
          if (claudeModel && claudeModel.quotaInfo) {
            claudeFraction = claudeModel.quotaInfo.remainingFraction;
            claudeResetTime = claudeModel.quotaInfo.resetTime;
          }
        }

        const fiveHourQuota = Math.round(fiveHourFraction * 100);
        const weeklyQuota = Math.round(weeklyFraction * 100);
        const claudeQuota = Math.round(claudeFraction * 100);

        return {
          isLive: true,
          email: userStatus.email || 'Chưa đăng nhập',
          name: userStatus.name || 'Người dùng',
          tier: userTier.name || userStatus.tier || 'Google AI',
          planName: planInfo.planName || (userTier.name || ''),
          promptCredits: (typeof planStatus.availablePromptCredits === 'number') ? planStatus.availablePromptCredits : undefined,
          flowCredits: (typeof planStatus.availableFlowCredits === 'number') ? planStatus.availableFlowCredits : undefined,
          fiveHourQuota: fiveHourQuota,
          weeklyQuota: weeklyQuota,
          fiveHourResetTime: fiveHourResetTime,
          weeklyResetTime: weeklyResetTime,
          fiveHourDescription: fiveHourDescription,
          weeklyDescription: weeklyDescription,
          flashQuota: fiveHourQuota,
          proQuota: fiveHourQuota,
          claudeQuota: claudeQuota,
          resetTime: fiveHourResetTime,
          modelDetails: [
            { name: 'Gemini 2.5 Flash (5-Giờ)', quota: fiveHourQuota, reset: fiveHourResetTime },
            { name: 'Gemini Pro (Hạn mức Tuần)', quota: weeklyQuota, reset: weeklyResetTime },
            { name: 'Claude & GPT (3P Models)', quota: claudeQuota, reset: claudeResetTime }
          ]
        };
      } catch (err) {
        if (attempt < retries) {
          this.invalidateCache();
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }

        return {
          isLive: false,
          error: err.message,
          email: 'Không phát hiện phiên',
          tier: 'N/A',
          flashQuota: 0,
          proQuota: 0,
          claudeQuota: 0,
          modelDetails: []
        };
      }
    }
  }

  /**
   * Đăng xuất phiên khỏi Language Server trực tiếp
   */
  async logoutLanguageServer() {
    try {
      await this.callRpc('/exa.language_server_pb.LanguageServerService/AuthLogout');
      this.invalidateCache();
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
}

module.exports = new LiveQuotaFetcher();
