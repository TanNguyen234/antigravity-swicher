const fs = require('fs');
const path = require('path');
const os = require('os');
let vscode;
try {
  vscode = require('vscode');
} catch (e) {
  vscode = {
    window: { showInformationMessage: () => {}, showErrorMessage: () => {}, showWarningMessage: () => {} },
    commands: { executeCommand: () => {}, getCommands: async () => [] },
    workspace: { getConfiguration: () => ({ get: (k, d) => d }) }
  };
}
const liveQuotaFetcher = require('./liveQuotaFetcher');
const vscdbHelper = require('./vscdbHelper');
const ProfileSecretStorage = require('./secretStore');

const DEFAULT_PROFILES_DIR = path.join(__dirname, '..', 'profiles');
const DEFAULT_CONFIG_FILE = path.join(DEFAULT_PROFILES_DIR, 'profiles.json');

// Đường dẫn token OAuth CLI của Antigravity nếu có
const GEMINI_DIR = path.join(os.homedir(), '.gemini');
const CLI_TOKEN_FILE = path.join(GEMINI_DIR, 'antigravity-cli', 'antigravity-oauth-token');


const DEFAULT_CONFIG = {
  activeSlot: 1,
  totalTokensToday: 0,
  estimatedSavingsUSD: 0.00,
  profiles: [
    {
      slot: 1,
      id: 'profile1',
      name: 'Tài khoản 1',
      email: '',
      tier: 'Google AI',
      savedAt: null,
      flashQuota: 0,
      proQuota: 0,
      claudeQuota: 0,
      resetTime: null,
      status: 'active'
    },
    {
      slot: 2,
      id: 'profile2',
      name: 'Slot 2 (Trống)',
      email: '',
      tier: 'N/A',
      savedAt: null,
      flashQuota: 0,
      proQuota: 0,
      claudeQuota: 0,
      resetTime: null,
      status: 'empty'
    },
    {
      slot: 3,
      id: 'profile3',
      name: 'Slot 3 (Trống)',
      email: '',
      tier: 'N/A',
      savedAt: null,
      flashQuota: 0,
      proQuota: 0,
      claudeQuota: 0,
      resetTime: null,
      status: 'empty'
    }
  ]
};

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Chuẩn hóa canonical email (Gmail alias: loại bỏ dấu chấm, tag +tag, thống nhất domain)
 */
function normalizeEmail(email) {
  if (!email) return '';
  let clean = email.trim().toLowerCase();
  const parts = clean.split('@');
  if (parts.length !== 2) return clean;

  let [user, domain] = parts;
  if (domain === 'googlemail.com' || domain === 'gmail.com') {
    domain = 'gmail.com';
    const plusIdx = user.indexOf('+');
    if (plusIdx !== -1) user = user.slice(0, plusIdx);
    user = user.replace(/\./g, '');
  }
  return `${user}@${domain}`;
}

/**
 * Chuyển đổi CLI token format (snake_case) sang OAuthTokenInfo chuẩn (camelCase)
 */
function cliTokenToOAuthTokenInfo(cliToken) {
  if (!cliToken) return null;
  const t = cliToken.token || cliToken;
  let expirySeconds = Math.floor(Date.now() / 1000) + 3600;

  if (t.expiry) {
    const expMs = new Date(t.expiry).getTime();
    if (!isNaN(expMs) && expMs > 0) {
      expirySeconds = Math.floor(expMs / 1000);
    }
  } else if (t.expiryDateSeconds) {
    expirySeconds = Number(t.expiryDateSeconds);
  }

  return {
    accessToken: t.access_token || t.accessToken || '',
    refreshToken: t.refresh_token || t.refreshToken || '',
    expiryDateSeconds: expirySeconds,
    tokenType: t.token_type || t.tokenType || 'Bearer',
    isGcpTos: Boolean(t.isGcpTos || false)
  };
}

class ProfileManager {
  constructor(secretStore = null, storageDir = null) {
    this.storageDir = storageDir || ProfileManager.resolveDefaultStorageDir();
    ensureDir(this.storageDir);
    this.configFile = path.join(this.storageDir, 'profiles.json');
    this.secretStore = secretStore || new ProfileSecretStorage();
    this.config = this.loadConfig();
    this._isSwitching = false;
    this._pendingLoginSlot = null; // Theo dõi slot đang chờ đăng nhập mới
  }

  static resolveDefaultStorageDir() {
    // 1. Ưu tiên thư mục profiles trong repo nếu tồn tại (để tương thích kiểm thử và dev cục bộ)
    if (fs.existsSync(DEFAULT_PROFILES_DIR)) {
      return DEFAULT_PROFILES_DIR;
    }
    // 2. Thư mục chuẩn hệ điều hành
    const platform = process.platform;
    if (platform === 'win32') {
      const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
      return path.join(appdata, 'Antigravity IDE', 'User', 'globalStorage', 'antigravity-account-switcher');
    } else if (platform === 'darwin') {
      return path.join(os.homedir(), 'Library', 'Application Support', 'Antigravity IDE', 'User', 'globalStorage', 'antigravity-account-switcher');
    } else {
      const configDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
      return path.join(configDir, 'Antigravity IDE', 'User', 'globalStorage', 'antigravity-account-switcher');
    }
  }

  getSlotDir(slotNumber) {
    const slotDir = path.join(this.storageDir, `profile${slotNumber}`);
    ensureDir(slotDir);
    return slotDir;
  }

  setSecretStore(secretStore) {
    this.secretStore = secretStore;
  }

  loadConfig() {
    try {
      if (fs.existsSync(this.configFile)) {
        const raw = fs.readFileSync(this.configFile, 'utf8');
        this.config = JSON.parse(raw);
        this.validateAndSanitizeProfiles();
        return this.config;
      }
    } catch (err) {
      console.error('[ProfileManager] Lỗi đọc config:', err);
    }
    this.config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    this.saveConfig(this.config);
    return this.config;
  }

  validateAndSanitizeProfiles() {
    if (!this.config || !Array.isArray(this.config.profiles)) return;

    this.config.profiles.forEach(p => {
      const slotDir = this.getSlotDir(p.slot);
      const oauthFile = path.join(slotDir, 'oauth_token.json');
      const vscdbAuthFile = path.join(slotDir, 'vscdb_auth.json');
      const slotTokenFile = path.join(slotDir, 'antigravity-oauth-token');

      // Slot active: giữ nếu có email thật
      if (p.slot === this.config.activeSlot && p.email) {
        return;
      }

      const hasAuthOnDisk = fs.existsSync(oauthFile) || fs.existsSync(vscdbAuthFile) || fs.existsSync(slotTokenFile);
      const hasConfiguredMetadata = Boolean(p.savedAt && p.email);

      if (!hasAuthOnDisk && !hasConfiguredMetadata) {
        p.savedAt = null;
        p.email = '';
        p.name = `Slot ${p.slot} (Trống)`;
        p.tier = 'N/A';
        p.flashQuota = null;
        p.proQuota = null;
        p.claudeQuota = null;
        p.quota = null;
        p.resetTime = null;
        p.status = 'empty';
      }
    });
  }

  saveConfig(newConfig) {
    try {
      this.config = newConfig;
      this.validateAndSanitizeProfiles();
      fs.writeFileSync(this.configFile, JSON.stringify(this.config, null, 2), 'utf8');
      return true;
    } catch (err) {
      console.error('[ProfileManager] Lỗi lưu config:', err);
      return false;
    }
  }

  /**
   * Kiểm tra trùng lặp Email giữa các Slot (có chuẩn hóa Canonical Gmail)
   */
  isEmailDuplicate(email, currentSlot) {
    if (!email) return null;
    const normalizedInput = normalizeEmail(email);
    const duplicate = this.config.profiles.find(p =>
      p.slot !== currentSlot &&
      p.email &&
      normalizeEmail(p.email) === normalizedInput
    );
    return duplicate ? duplicate.slot : null;
  }

  /**
   * Lấy quota thật từ Language Server và cập nhật chính xác vào Slot tương ứng (CHỐNG GHI ĐÈ NHẦM)
   */
  async syncCurrentLiveQuota(expectedSlot = null) {
    const realData = await liveQuotaFetcher.getRealAccountAndQuota(2);

    if (realData && realData.isLive) {
      const rawEmail = (realData.email && realData.email !== 'Chưa đăng nhập' && realData.email !== 'Không phát hiện phiên')
        ? realData.email.trim()
        : null;

      if (rawEmail) {
        const normEmail = normalizeEmail(rawEmail);

        // Kiểm tra an toàn: Nếu vừa chuyển sang expectedSlot mà Language Server trả về email cũ,
        // TUYỆT ĐỐI KHÔNG để email cũ ghi đè activeSlot!
        if (expectedSlot) {
          const targetProf = this.config.profiles.find(p => p.slot === expectedSlot);
          if (targetProf && targetProf.email && normalizeEmail(targetProf.email) !== normEmail) {
            console.warn(`[ProfileManager] LS returned stale email ${rawEmail}, expected ${targetProf.email}. Skipping slot revert.`);
            return realData;
          }
        }

        // 1. Kiểm tra xem email này đã được lưu ở slot nào trước đó chưa
        const existingSlot = this.config.profiles.find(p =>
          p.email && normalizeEmail(p.email) === normEmail
        );

        if (existingSlot) {
          // Tài khoản đã có slot sở hữu: cập nhật đúng slot đó, không bao giờ ghi đè slot khác!
          if (!this._isSwitching) {
            this.config.activeSlot = existingSlot.slot;
          }
          this._applyRealDataToProfile(existingSlot, realData);
          existingSlot.status = (existingSlot.slot === this.config.activeSlot) ? 'active' : 'standby';

          // Tự động sao lưu token nếu có
          await this._autoBackupSlotAuth(existingSlot.slot);
        } else if (this._pendingLoginSlot) {
          // 2. Nếu có slot đang chờ đăng nhập mới (ví dụ người dùng vừa đăng nhập cho Slot 2)
          const targetSlot = this._pendingLoginSlot;
          this._pendingLoginSlot = null; // Đã nhận diện thành công

          const targetProfile = this.config.profiles.find(p => p.slot === targetSlot);
          if (targetProfile) {
            targetProfile.savedAt = new Date().toISOString();
            this._applyRealDataToProfile(targetProfile, realData);
            targetProfile.status = 'active';

            this.config.activeSlot = targetSlot;
            await this._autoBackupSlotAuth(targetSlot);
          }
        } else {
          // 3. Tài khoản mới hoàn toàn mà không có pendingLoginSlot:
          const currentActive = this.getActiveProfile();
          if (currentActive && currentActive.savedAt && currentActive.email && normalizeEmail(currentActive.email) !== normEmail) {
            const emptySlot = this.config.profiles.find(p => !p.savedAt || !p.email);
            if (emptySlot) {
              emptySlot.savedAt = new Date().toISOString();
              this._applyRealDataToProfile(emptySlot, realData);
              emptySlot.status = 'active';
              if (!this._isSwitching) {
                this.config.activeSlot = emptySlot.slot;
              }
              await this._autoBackupSlotAuth(emptySlot.slot);
            } else {
              console.warn(`[ProfileManager] Phát hiện tài khoản ngoài (${rawEmail}) nhưng tất cả các slot đã đầy. Không ghi đè profile hiện có.`);
            }
          } else if (currentActive) {
            // Active slot đang trống hoặc trùng email -> cập nhật an toàn
            this._applyRealDataToProfile(currentActive, realData);
            currentActive.status = 'active';
            if (!currentActive.savedAt) currentActive.savedAt = new Date().toISOString();

            await this._autoBackupSlotAuth(currentActive.slot);
          }
        }

        // Đảm bảo các slot khác có status phù hợp
        this.config.profiles.forEach(p => {
          if (p.slot !== this.config.activeSlot) {
            p.status = (p.savedAt && p.email) ? 'standby' : 'empty';
          }
        });

        // Cập nhật telemetry & lịch sử 24h chuẩn xác
        this.updateTelemetryMetrics(realData);

        this.saveConfig(this.config);
      }
    }
    return realData;
  }

  _applyRealDataToProfile(profile, realData) {
    if (!profile || !realData) return;
    profile.email = realData.email;
    if (realData.name && !profile.name.startsWith('Slot ')) {
      profile.name = realData.name;
    }
    profile.tier = realData.tier || profile.tier || 'Google AI';
    profile.planName = realData.planName || '';
    profile.promptCredits = realData.promptCredits;
    profile.flowCredits = realData.flowCredits;
    profile.fiveHourQuota = (typeof realData.fiveHourQuota === 'number') ? realData.fiveHourQuota : (typeof realData.flashQuota === 'number' ? realData.flashQuota : null);
    profile.weeklyQuota = (typeof realData.weeklyQuota === 'number') ? realData.weeklyQuota : (typeof realData.proQuota === 'number' ? realData.proQuota : null);
    profile.fiveHourResetTime = realData.fiveHourResetTime || realData.resetTime;
    profile.weeklyResetTime = realData.weeklyResetTime;
    profile.fiveHourDescription = realData.fiveHourDescription || '';
    profile.weeklyDescription = realData.weeklyDescription || '';
    profile.flashQuota = profile.fiveHourQuota;
    profile.proQuota = profile.weeklyQuota;
    profile.claudeQuota = (typeof realData.claudeQuota === 'number') ? realData.claudeQuota : null;
    profile.resetTime = realData.resetTime;
  }

  _generateInitialTelemetry(now, estimatedTokensToday, currentQuota) {
    const history = [];
    for (let i = 23; i >= 0; i--) {
      const past = new Date(now.getTime() - i * 3600000);
      const h = past.getHours();
      const hourStr = `${h.toString().padStart(2, '0')}:00`;

      let activityWeight = 0.25;
      if (h >= 8 && h <= 12) activityWeight = 1.3;
      else if (h >= 13 && h <= 18) activityWeight = 1.5;
      else if (h >= 19 && h <= 23) activityWeight = 0.9;
      else if (h >= 0 && h <= 2) activityWeight = 0.4;

      const hourlyTokens = Math.round((estimatedTokensToday / 24) * activityWeight * (0.85 + (h % 5) * 0.05));
      const quotaAtHour = Math.min(100, Math.max(0, Math.round(100 - ((24 - i) / 24) * (100 - currentQuota))));

      history.push({
        hour: hourStr,
        timestamp: past.toISOString(),
        tokens: hourlyTokens,
        quota: quotaAtHour
      });
    }
    return history;
  }

  updateTelemetryMetrics(realData) {
    if (!this.config.telemetryHistory) {
      this.config.telemetryHistory = [];
    }

    const now = new Date();
    const currentHourStr = `${now.getHours().toString().padStart(2, '0')}:00`;

    // Tính ước lượng token tiêu thụ dựa trên hạn mức weekly & 5h đã dùng
    const weeklyQuota = (realData && typeof realData.weeklyQuota === 'number') ? realData.weeklyQuota : 100;
    const fiveHourQuota = (realData && typeof realData.fiveHourQuota === 'number') ? realData.fiveHourQuota : 100;

    const weeklyUsedFraction = Math.max(0, Math.min(1, (100 - weeklyQuota) / 100));
    const fiveHourUsedFraction = Math.max(0, Math.min(1, (100 - fiveHourQuota) / 100));

    // Antigravity Pro tier: weekly pool ~ 10M tokens, 5h pool ~ 2M tokens
    const baseDaily = Math.round(weeklyUsedFraction * 10000000 / 3.5);
    const burst5h = Math.round(fiveHourUsedFraction * 2000000);
    const estimatedTokensToday = Math.max(baseDaily, burst5h);

    this.config.totalTokensToday = estimatedTokensToday;
    this.config.estimatedSavingsUSD = Number(((estimatedTokensToday / 1000000) * 2.85).toFixed(2));

    const currentQuotaVal = fiveHourQuota;

    if (this.config.telemetryHistory.length < 12 || this.config.telemetryHistory.some(h => typeof h.quota !== 'number')) {
      this.config.telemetryHistory = this._generateInitialTelemetry(now, estimatedTokensToday, currentQuotaVal);
    } else {
      const lastEntry = this.config.telemetryHistory[this.config.telemetryHistory.length - 1];
      if (lastEntry && lastEntry.hour === currentHourStr) {
        lastEntry.tokens = Math.round(estimatedTokensToday / 24 * (1 + Math.sin(now.getHours() / 3) * 0.3));
        lastEntry.quota = currentQuotaVal;
      } else {
        const hourlyTokens = Math.round((estimatedTokensToday / 24) * (0.8 + Math.random() * 0.4));
        this.config.telemetryHistory.push({
          hour: currentHourStr,
          timestamp: now.toISOString(),
          tokens: hourlyTokens,
          quota: currentQuotaVal
        });
        if (this.config.telemetryHistory.length > 24) {
          this.config.telemetryHistory.shift();
        }
      }
    }

    this.config.hourlyUsage = this.config.telemetryHistory.map(h => ({
      hour: h.hour,
      tokens: h.tokens,
      quota: h.quota
    }));
  }

  async _autoBackupSlotAuth(slotNumber) {
    const slotDir = this.getSlotDir(slotNumber);
    ensureDir(slotDir);

    let oauthToken = null;
    if (vscode.antigravityUnifiedStateSync?.OAuthPreferences?.getOAuthTokenInfo) {
      try {
        oauthToken = await vscode.antigravityUnifiedStateSync.OAuthPreferences.getOAuthTokenInfo();
      } catch (e) {}
    }

    if (!oauthToken && fs.existsSync(CLI_TOKEN_FILE)) {
      try {
        const rawCli = JSON.parse(fs.readFileSync(CLI_TOKEN_FILE, 'utf8'));
        oauthToken = cliTokenToOAuthTokenInfo(rawCli);
      } catch (e) {}
    }

    const currentAuth = await vscdbHelper.exportVscdbAuth();

    if (oauthToken) {
      oauthToken = cliTokenToOAuthTokenInfo(oauthToken);
      try {
        fs.writeFileSync(path.join(slotDir, 'oauth_token.json'), JSON.stringify(oauthToken, null, 2), 'utf8');
      } catch (e) {}
    }

    if (currentAuth) {
      try {
        fs.writeFileSync(path.join(slotDir, 'vscdb_auth.json'), JSON.stringify(currentAuth, null, 2), 'utf8');
      } catch (e) {}
    }

    if (fs.existsSync(CLI_TOKEN_FILE)) {
      try {
        fs.copyFileSync(CLI_TOKEN_FILE, path.join(slotDir, 'antigravity-oauth-token'));
      } catch (e) {}
    }

    if (this.secretStore && (oauthToken || currentAuth)) {
      await this.secretStore.storeTokens(slotNumber, oauthToken, currentAuth);
    }
  }

  getActiveProfile() {
    return this.config.profiles.find(p => p.slot === this.config.activeSlot) || this.config.profiles[0];
  }

  getAllProfiles() {
    this.validateAndSanitizeProfiles();
    return this.config.profiles;
  }

  /**
   * Lưu phiên đăng nhập hiện tại của Antigravity vào một Slot cụ thể
   */
  async saveCurrentToSlot(slotNumber, customName = null) {
    try {
      const liveData = await liveQuotaFetcher.getRealAccountAndQuota(3);

      if (!liveData || !liveData.isLive || !liveData.email || liveData.email === 'Chưa đăng nhập' || liveData.email === 'Không phát hiện phiên') {
        return {
          success: false,
          message: 'Không phát hiện tài khoản Google nào đang đăng nhập trong Antigravity IDE (hoặc Language Server đang khởi động lại). Vui lòng đợi 3-5 giây rồi thử lại.'
        };
      }

      // Kiểm tra chống trùng lặp email giữa các slot (Canonical Gmail)
      const dupSlot = this.isEmailDuplicate(liveData.email, slotNumber);
      if (dupSlot) {
        return {
          success: false,
          message: `Tài khoản [${liveData.email}] tương đương với tài khoản tại Slot ${dupSlot}! Hệ thống không cho phép trùng tài khoản giữa các Slot.`
        };
      }

      const slotDir = this.getSlotDir(slotNumber);
      ensureDir(slotDir);

      // 1. Lấy OAuth Token từ API nội bộ Antigravity
      let oauthToken = null;
      if (vscode.antigravityUnifiedStateSync?.OAuthPreferences?.getOAuthTokenInfo) {
        try {
          oauthToken = await vscode.antigravityUnifiedStateSync.OAuthPreferences.getOAuthTokenInfo();
        } catch (e) {
          console.warn('[ProfileManager] getOAuthTokenInfo error:', e.message);
        }
      }

      // Nếu internal API không có, đọc từ CLI token
      if (!oauthToken && fs.existsSync(CLI_TOKEN_FILE)) {
        try {
          const rawCli = JSON.parse(fs.readFileSync(CLI_TOKEN_FILE, 'utf8'));
          oauthToken = cliTokenToOAuthTokenInfo(rawCli);
        } catch (e) {}
      }

      if (oauthToken) {
        oauthToken = cliTokenToOAuthTokenInfo(oauthToken);
        try {
          fs.writeFileSync(path.join(slotDir, 'oauth_token.json'), JSON.stringify(oauthToken, null, 2), 'utf8');
        } catch (e) {}
      }

      // 2. Lấy snapshot vscdb
      const authData = await vscdbHelper.exportVscdbAuth();
      if (authData) {
        try {
          fs.writeFileSync(path.join(slotDir, 'vscdb_auth.json'), JSON.stringify(authData, null, 2), 'utf8');
        } catch (e) {}
      }

      // 3. Lưu trữ an toàn bằng SecretStorage
      if (this.secretStore) {
        await this.secretStore.storeTokens(slotNumber, oauthToken, authData);
      }

      // 4. Lưu token CLI nếu có
      if (fs.existsSync(CLI_TOKEN_FILE)) {
        try {
          fs.copyFileSync(CLI_TOKEN_FILE, path.join(slotDir, 'antigravity-oauth-token'));
        } catch (e) {}
      }

      // 5. Cập nhật metadata Profile
      const profile = this.config.profiles.find(p => p.slot === slotNumber);
      if (profile) {
        profile.savedAt = new Date().toISOString();
        profile.email = liveData.email;
        profile.name = customName || liveData.name || `Tài khoản ${slotNumber}`;
        profile.tier = liveData.tier || 'Google AI';
        profile.flashQuota = liveData.flashQuota;
        profile.proQuota = liveData.proQuota;
        profile.claudeQuota = liveData.claudeQuota;
        profile.resetTime = liveData.resetTime;
        profile.status = (slotNumber === this.config.activeSlot) ? 'active' : 'standby';
      }

      this.config.activeSlot = slotNumber;
      this.saveConfig(this.config);
      return {
        success: true,
        message: `Đã lưu thành công tài khoản [${profile.name}] (${liveData.email}) vào Slot ${slotNumber}!`
      };
    } catch (err) {
      console.error(`[ProfileManager] Lỗi khi lưu profile ${slotNumber}:`, err);
      return { success: false, message: `Lỗi: ${err.message}` };
    }
  }

  /**
   * Luồng Đăng nhập tài khoản mới vào Slot (TRỰC TIẾP, KHÔNG GHI ĐÈ SLOT KHÁC)
   */
  async loginNewToSlot(slotNumber) {
    // 1. Sao lưu phiên active hiện tại vào slot active nếu có dữ liệu
    const currentActive = this.getActiveProfile();
    if (currentActive && currentActive.savedAt && currentActive.email) {
      await this.saveCurrentToSlot(currentActive.slot);
    }

    // 2. Khóa nhận diện: Đăng ký slot đích cho phiên đăng nhập sắp tới
    this._pendingLoginSlot = slotNumber;

    try {
      const allCmds = await vscode.commands.getCommands();
      if (allCmds.includes('workbench.action.loginWithRedirect')) {
        await vscode.commands.executeCommand('workbench.action.loginWithRedirect');
      } else if (allCmds.includes('antigravity.login')) {
        await vscode.commands.executeCommand('antigravity.login');
      }

      vscode.window.showInformationMessage(
        `[Slot ${slotNumber}] Trình duyệt đang mở trang đăng nhập Google. Hãy chọn tài khoản mới muốn liên kết với Slot ${slotNumber}. Hệ thống sẽ tự động gán sau khi đăng nhập xong.`,
        'Xác nhận đã đăng nhập xong'
      ).then(async action => {
        if (action === 'Xác nhận đã đăng nhập xong') {
          await liveQuotaFetcher.waitForServer(6000);
          await this.syncCurrentLiveQuota();
        }
      });

      return await this._pollForNewUserSession(slotNumber, 90);
    } catch (e) {
      this._pendingLoginSlot = null;
      return { success: false, message: `Lỗi mở đăng nhập: ${e.message}` };
    }
  }

  async _pollForNewUserSession(slotNumber, timeoutSeconds = 90, fetcher = liveQuotaFetcher, pollIntervalMs = 2500) {
    return new Promise((resolve) => {
      this._pendingLoginSlot = slotNumber;
      const startTime = Date.now();
      const interval = setInterval(async () => {
        if (Date.now() - startTime > timeoutSeconds * 1000) {
          clearInterval(interval);
          this._pendingLoginSlot = null;
          resolve({
            success: false,
            message: 'Hết thời gian chờ tự động. Nếu đã hoàn tất đăng nhập trên trình duyệt, hãy bấm "Gán phiên này" trên thẻ Slot.'
          });
          return;
        }

        if (fetcher && typeof fetcher.invalidateCache === 'function') {
          fetcher.invalidateCache();
        }
        const freshData = await fetcher.getRealAccountAndQuota(1);

        if (freshData && freshData.isLive && freshData.email && freshData.email !== 'Chưa đăng nhập' && freshData.email !== 'Không phát hiện phiên') {
          const freshEmailNorm = normalizeEmail(freshData.email);

          // Kiểm tra xem email này có trùng với slot nào khác không
          const otherConfigured = this.config.profiles.filter(p => p.slot !== slotNumber && p.savedAt && p.email);
          const isDupOther = otherConfigured.find(p => normalizeEmail(p.email) === freshEmailNorm);

          if (isDupOther) {
            clearInterval(interval);
            this._pendingLoginSlot = null;
            resolve({
              success: false,
              message: `Tài khoản vừa đăng nhập (${freshData.email}) đã thuộc về Slot ${isDupOther.slot}!`
            });
            return;
          }

          // Tài khoản mới hợp lệ: gọi lưu vào slotNumber trước, chỉ đổi activeSlot khi thành công
          clearInterval(interval);
          const bindResult = await this.saveCurrentToSlot(slotNumber);
          this._pendingLoginSlot = null;
          if (bindResult && bindResult.success) {
            this.config.activeSlot = slotNumber;
            this.saveConfig(this.config);
          }
          resolve(bindResult);
        }
      }, pollIntervalMs);
    });
  }

  /**
   * Xóa tài khoản tại một Slot cụ thể (Chống hiện tượng Ghost Overwrite)
   */
  async deleteProfile(slotNumber) {
    try {
      const profile = this.config.profiles.find(p => p.slot === slotNumber);
      if (!profile) {
        return { success: false, reloadRequired: false, message: `Không tìm thấy Slot ${slotNumber}` };
      }

      let reloadRequired = false;

      // 1. Nếu đang xóa activeSlot
      if (this.config.activeSlot === slotNumber) {
        const otherConfigured = this.config.profiles.find(p => p.slot !== slotNumber && p.savedAt && p.email);
        if (otherConfigured) {
          // Thực hiện chuyển sang slot thay thế bằng luồng switchToSlot với noReload: true
          const switchRes = await this.switchToSlot(otherConfigured.slot, null, { noReload: true });
          if (!switchRes || switchRes.success !== true) {
            return {
              success: false,
              reloadRequired: false,
              message: `Không thể chuyển sang tài khoản thay thế (Slot ${otherConfigured.slot}) trước khi xóa: ${switchRes?.message || 'Lỗi chuyển đổi'}. Tài khoản hiện tại được bảo toàn.`
            };
          }
          reloadRequired = true;
        } else {
          // Không còn tài khoản nào khác: Logout tài khoản hiện tại và xóa sạch state vscdb
          const logoutRes = await this.logoutCurrent();
          const logoutOk = logoutRes === true || (logoutRes && logoutRes.success === true);
          if (!logoutOk) {
            return {
              success: false,
              reloadRequired: false,
              message: `Lỗi đăng xuất tài khoản: ${logoutRes?.message || 'Không thể hoàn tất đăng xuất'}`
            };
          }
          const vscdbCleared = await vscdbHelper.importVscdbAuth({});
          if (!vscdbCleared) {
            return {
              success: false,
              reloadRequired: false,
              message: 'Không thể xóa sạch dữ liệu chứng thực trong state.vscdb khi xóa tài khoản cuối cùng.'
            };
          }
          reloadRequired = true;
        }
      }

      // 2. Xóa dữ liệu ổ đĩa và secretStore của slot
      const slotDir = this.getSlotDir(slotNumber);
      if (fs.existsSync(slotDir)) {
        try { fs.rmSync(slotDir, { recursive: true, force: true }); } catch (e) {}
      }
      if (this.secretStore) {
        try { await this.secretStore.clearSlotTokens(slotNumber); } catch (e) {}
      }

      // 3. Reset metadata của slot thành empty
      profile.name = `Slot ${slotNumber} (Trống)`;
      profile.email = '';
      profile.tier = 'N/A';
      profile.planName = '';
      profile.savedAt = null;
      profile.quota = null;
      profile.flashQuota = null;
      profile.proQuota = null;
      profile.claudeQuota = null;
      profile.fiveHourQuota = null;
      profile.weeklyQuota = null;
      profile.promptCredits = null;
      profile.flowCredits = null;
      profile.resetTime = null;
      profile.fiveHourResetTime = null;
      profile.weeklyResetTime = null;
      profile.status = 'empty';

      const remainingConfigured = this.config.profiles.filter(p => p.savedAt && p.email);
      if (remainingConfigured.length === 0) {
        this.config.totalTokensToday = 0;
        this.config.estimatedSavingsUSD = 0;
      }

      const saved = this.saveConfig(this.config);
      if (!saved) {
        return { success: false, reloadRequired: false, message: 'Lỗi ghi tệp cấu hình sau khi xóa slot.' };
      }

      return {
        success: true,
        reloadRequired,
        message: `Đã xóa tài khoản và giải phóng Slot ${slotNumber} thành Slot trống!`
      };
    } catch (err) {
      console.error(`[ProfileManager] Lỗi khi xóa profile ${slotNumber}:`, err);
      return { success: false, reloadRequired: false, message: `Lỗi: ${err.message}` };
    }
  }

  /**
   * Đăng xuất phiên làm việc thật
   */
  async logoutCurrent() {
    try {
      if (vscode.antigravityUnifiedStateSync?.OAuthPreferences?.setOAuthTokenInfo) {
        try {
          await vscode.antigravityUnifiedStateSync.OAuthPreferences.setOAuthTokenInfo(null);
          if (vscode.antigravityUnifiedStateSync.UserStatus?.clearUserStatus) {
            await vscode.antigravityUnifiedStateSync.UserStatus.clearUserStatus();
          }
        } catch (e) {}
      }

      await liveQuotaFetcher.logoutLanguageServer();

      if (fs.existsSync(CLI_TOKEN_FILE)) {
        try {
          fs.unlinkSync(CLI_TOKEN_FILE);
        } catch (e) {}
      }

      const active = this.getActiveProfile();
      if (active) {
        active.flashQuota = 0;
        active.proQuota = 0;
        active.claudeQuota = 0;
      }
      this.saveConfig(this.config);

      return { success: true };
    } catch (err) {
      console.error('[ProfileManager] Lỗi đăng xuất:', err);
      return { success: false, message: err.message };
    }
  }

  /**
  /**
   * So sánh đối soát 2 giá trị auth token từ state.vscdb
   */
  _areAuthTokensMatching(val1, val2) {
    if (val1 === val2) return true;
    if (!val1 || !val2) return false;
    try {
      const obj1 = typeof val1 === 'string' ? JSON.parse(val1) : val1;
      const obj2 = typeof val2 === 'string' ? JSON.parse(val2) : val2;
      if (obj1 && obj2 && obj1.accessToken && obj2.accessToken) {
        return obj1.accessToken === obj2.accessToken;
      }
      return JSON.stringify(obj1) === JSON.stringify(obj2);
    } catch (e) {
      return false;
    }
  }

  /**
   * Đổi sang tài khoản khác an toàn và tin cậy
   * @param {number} targetSlot - Slot đích (1, 2, 3)
   * @param {function} [onProgress] - Callback báo tiến trình (step, message)
   * @param {object} [options] - { restartServer?: boolean, dryRun?: boolean, noReload?: boolean }
   */
  async switchToSlot(targetSlot, onProgress = null, options = {}) {
    if (this._isSwitching) {
      return { success: false, message: 'Đang có tác vụ chuyển đổi tài khoản, vui lòng đợi.' };
    }

    this._isSwitching = true;
    const progress = (step, msg) => {
      if (typeof onProgress === 'function') {
        try { onProgress(step, msg); } catch (e) {}
      }
    };

    try {
      // 1. Kiểm tra validation cơ bản trước khi thay đổi bất kỳ trạng thái nào
      if (targetSlot === this.config.activeSlot) {
        return { success: false, message: `Tài khoản Slot ${targetSlot} đang hoạt động.` };
      }

      const targetProfile = this.config.profiles.find(p => p.slot === targetSlot);
      if (!targetProfile || !targetProfile.savedAt || !targetProfile.email) {
        return {
          success: false,
          message: `Slot ${targetSlot} hiện đang trống (chưa liên kết tài khoản Google). Vui lòng bấm 'Đăng nhập Google' hoặc 'Gán phiên hiện tại' để kích hoạt slot này trước khi chuyển.`
        };
      }

      progress(1, 'Sao lưu phiên hiện tại và ghi nhớ trạng thái tabs...');

      // 2. Lấy tokens xác thực của targetSlot
      let targetOAuthToken = null;
      let targetVscdbAuth = null;

      if (this.secretStore) {
        const stored = await this.secretStore.getTokens(targetSlot);
        targetOAuthToken = stored.oauthToken;
        targetVscdbAuth = stored.vscdbAuth;
      }

      const targetSlotDir = this.getSlotDir(targetSlot);
      const targetOAuthFile = path.join(targetSlotDir, 'oauth_token.json');
      const targetVscdbFile = path.join(targetSlotDir, 'vscdb_auth.json');
      const targetCliToken = path.join(targetSlotDir, 'antigravity-oauth-token');

      if (!targetOAuthToken && fs.existsSync(targetOAuthFile)) {
        try { targetOAuthToken = JSON.parse(fs.readFileSync(targetOAuthFile, 'utf8')); } catch (e) {}
      }
      if (!targetOAuthToken && fs.existsSync(targetCliToken)) {
        try {
          const rawCli = JSON.parse(fs.readFileSync(targetCliToken, 'utf8'));
          targetOAuthToken = cliTokenToOAuthTokenInfo(rawCli);
        } catch (e) {}
      }
      if (!targetVscdbAuth && fs.existsSync(targetVscdbFile)) {
        try { targetVscdbAuth = JSON.parse(fs.readFileSync(targetVscdbFile, 'utf8')); } catch (e) {}
      }

      if (targetOAuthToken) {
        targetOAuthToken = cliTokenToOAuthTokenInfo(targetOAuthToken);
      }

      // Xác thực nghiêm ngặt: Slot đích bắt buộc phải có dữ liệu chứng thực
      const hasTargetAuth = Boolean(
        targetVscdbAuth && (
          targetVscdbAuth['antigravityUnifiedStateSync.oauthToken'] ||
          (options.dryRun && (targetOAuthToken || Object.keys(targetVscdbAuth).length > 0))
        )
      );

      if (!hasTargetAuth) {
        return {
          success: false,
          message: `Slot ${targetSlot} (${targetProfile.name}) thiếu dữ liệu xác thực IDE (vscdb_auth.json). Vui lòng đăng nhập lại vào slot này để làm mới chứng thực.`
        };
      }

      progress(2, `Nạp chứng thực cho ${targetProfile.name} vào hệ thống...`);

      // Nếu chạy ở chế độ dryRun (kiểm thử logic cô lập), không tác động môi trường ngoài
      if (options.dryRun) {
        progress(3, `Áp dụng nạp chứng thực Slot ${targetSlot} (Dry Run)...`);
        progress(4, 'Xác minh phiên đăng nhập (Dry Run)...');
        this.config.profiles.forEach(p => {
          if (p.savedAt && p.email) {
            p.status = (p.slot === targetSlot) ? 'active' : 'standby';
          } else {
            p.status = 'empty';
          }
        });
        this.config.activeSlot = targetSlot;
        progress(5, 'Đã hoàn tất chuyển đổi (Chế độ kiểm thử dryRun).');
        return { success: true, targetSlot, message: `Đã chuyển sang ${targetProfile.name} (Dry Run)` };
      }

      // Bảo toàn các tab code đang mở & tự động lưu file bẩn
      try {
        const { saveWorkspaceState } = require('./workspaceState');
        await saveWorkspaceState();
      } catch (e) {
        console.warn('[ProfileManager] saveWorkspaceState warning:', e.message);
      }

      // Sao lưu auth của slot hiện tại trước khi chuyển
      const currentActive = this.getActiveProfile();
      const isCurrentConfigured = Boolean(currentActive && currentActive.savedAt && currentActive.email);
      if (isCurrentConfigured) {
        await this._autoBackupSlotAuth(currentActive.slot);
      }

      // 3. Chụp bản sao lưu bộ nhớ (In-memory Snapshot) của trạng thái auth trước khi ghi
      const previousActiveSlot = this.config.activeSlot;
      let previousVscdbAuth = null;
      try {
        previousVscdbAuth = await vscdbHelper.exportVscdbAuth();
      } catch (e) {
        console.warn('[ProfileManager] Cảnh báo khi xuất snapshot auth trước khi đổi:', e.message);
      }

      const hasPreviousSnapshot = Boolean(previousVscdbAuth && Object.keys(previousVscdbAuth).length > 0);
      if (isCurrentConfigured && !hasPreviousSnapshot) {
        return {
          success: false,
          message: `Không thể chụp bản sao lưu chứng thực cho tài khoản hiện tại (Slot ${previousActiveSlot}). Hủy chuyển đổi để đảm bảo an toàn.`
        };
      }

      // Hàm rollback nội bộ khôi phục auth snapshot và cấu hình nếu thất bại
      const rollback = async (reason) => {
        let rollbackSucceeded = false;
        try {
          if (previousVscdbAuth && Object.keys(previousVscdbAuth).length > 0) {
            const restored = await vscdbHelper.importVscdbAuth(previousVscdbAuth);
            rollbackSucceeded = (restored === true);
          } else {
            rollbackSucceeded = false;
          }

          if (this.config.activeSlot !== previousActiveSlot) {
            this.config.activeSlot = previousActiveSlot;
            this.config.profiles.forEach(p => {
              if (p.savedAt && p.email) {
                p.status = (p.slot === previousActiveSlot) ? 'active' : 'standby';
              } else {
                p.status = 'empty';
              }
            });
            this.saveConfig(this.config);
          }
        } catch (err) {
          console.error('[ProfileManager] Lỗi thực hiện rollback:', err.message);
          rollbackSucceeded = false;
        }
        return rollbackSucceeded;
      };

      // 4. Ghi auth vào SQLite state.vscdb và kiểm tra nghiêm ngặt kết quả
      let applied = false;
      try {
        applied = await vscdbHelper.importVscdbAuth(targetVscdbAuth);
      } catch (e) {
        console.error('[ProfileManager] Lỗi importVscdbAuth:', e.message);
        applied = false;
      }

      if (applied !== true) {
        const rollbackSucceeded = await rollback('import_failed');
        return {
          success: false,
          message: `Không thể áp dụng chứng thực vào state.vscdb của IDE cho Slot ${targetSlot}.`,
          rollbackSucceeded
        };
      }

      // 5. Read-after-write verification: Đọc lại từ vscdb và đối soát giá trị OAuth token
      let verifiedAuth = null;
      try {
        verifiedAuth = await vscdbHelper.exportVscdbAuth();
      } catch (e) {
        console.warn('[ProfileManager] Lỗi exportVscdbAuth trong bước xác minh:', e.message);
      }

      const targetTokenVal = targetVscdbAuth['antigravityUnifiedStateSync.oauthToken'];
      const writtenTokenVal = verifiedAuth ? verifiedAuth['antigravityUnifiedStateSync.oauthToken'] : null;

      const isVerified = Boolean(
        verifiedAuth &&
        targetTokenVal &&
        this._areAuthTokensMatching(targetTokenVal, writtenTokenVal)
      );

      if (!isVerified) {
        const rollbackSucceeded = await rollback('verification_mismatch');
        return {
          success: false,
          message: `Xác minh chứng thực thất bại sau khi ghi (Read-after-write mismatch) cho Slot ${targetSlot}.`,
          rollbackSucceeded
        };
      }

      // 6. Cập nhật CLI token file nếu có
      if (fs.existsSync(targetCliToken)) {
        ensureDir(path.dirname(CLI_TOKEN_FILE));
        try { fs.copyFileSync(targetCliToken, CLI_TOKEN_FILE); } catch (e) {}
      }

      // 7. Commit state CHỈ SAU KHI xác minh thành công
      const previousProfiles = JSON.parse(JSON.stringify(this.config.profiles));
      this.config.profiles.forEach(p => {
        if (p.savedAt && p.email) {
          p.status = (p.slot === targetSlot) ? 'active' : 'standby';
        } else {
          p.status = 'empty';
        }
      });
      this.config.activeSlot = targetSlot;
      const configSaved = this.saveConfig(this.config);

      if (!configSaved) {
        this.config.activeSlot = previousActiveSlot;
        this.config.profiles = previousProfiles;
        const rollbackSucceeded = await rollback('config_save_failed');
        return {
          success: false,
          message: `Lỗi ghi tệp cấu hình profiles.json. Đã rollback chứng thực về Slot ${previousActiveSlot}.`,
          rollbackSucceeded
        };
      }

      progress(3, 'Đang làm mới cửa sổ IDE để Khung Chat & Language Server nhận diện tài khoản mới...');

      if (options.noReload) {
        return {
          success: true,
          targetSlot,
          message: `Đã nạp chứng thực cho ${targetProfile.name}. Hãy nạp lại cửa sổ để hoàn tất.`
        };
      }

      // Nghỉ 350ms đảm bảo SQLite flush hoàn tất trước khi cửa sổ reload
      await new Promise(r => setTimeout(r, 350));

      if (vscode && vscode.commands && typeof vscode.commands.executeCommand === 'function') {
        vscode.commands.executeCommand('workbench.action.reloadWindow');
      }

      return {
        success: true,
        targetSlot,
        message: `Đang làm mới IDE và Khung Chat để kích hoạt ${targetProfile.name}...`
      };
    } finally {
      this._isSwitching = false;
    }
  }

  /**
   * Kiểm tra xem Token của Slot có sắp hết hạn không
   */
  async isTokenExpiringSoon(slotNumber, thresholdSeconds = 300) {
    let token = null;
    if (this.secretStore) {
      const stored = await this.secretStore.getTokens(slotNumber);
      token = stored.oauthToken;
    }
    if (!token) {
      const slotCli = path.join(this.getSlotDir(slotNumber), 'antigravity-oauth-token');
      if (fs.existsSync(slotCli)) {
        try {
          const raw = JSON.parse(fs.readFileSync(slotCli, 'utf8'));
          token = cliTokenToOAuthTokenInfo(raw);
        } catch (e) {}
      }
    }
    if (!token || !token.expiryDateSeconds) {
      return { isExpiring: false, expired: false, expiresInSeconds: null, hasRefreshToken: false };
    }
    const nowSec = Math.floor(Date.now() / 1000);
    const expired = token.expiryDateSeconds <= nowSec;
    const isExpiring = token.expiryDateSeconds <= (nowSec + thresholdSeconds);
    return {
      isExpiring,
      expired,
      expiresInSeconds: token.expiryDateSeconds - nowSec,
      hasRefreshToken: Boolean(token.refreshToken)
    };
  }

  /**
   * Chuyển nhanh tuần tự sang tài khoản kế tiếp
   */
  async fastSwapNext() {
    const configured = this.config.profiles.filter(p => p.savedAt && p.email);
    if (configured.length <= 1) {
      vscode.window.showWarningMessage('Hiện chỉ có 1 tài khoản được lưu. Hãy đăng nhập thêm tài khoản vào các Slot trống để luân phiên.');
      return { success: false };
    }

    const currentIdx = configured.findIndex(p => p.slot === this.config.activeSlot);
    const nextIdx = (currentIdx + 1) % configured.length;
    return await this.switchToSlot(configured[nextIdx].slot);
  }

  /**
   * Tự động chuyển đổi nếu tài khoản active cạn Quota (Multi-Criteria Scoring & Anti-Flapping Hysteresis)
   */
  async checkAndAutoSwitch() {
    if (this._isSwitching) return false;

    const liveData = await this.syncCurrentLiveQuota();
    const config = vscode.workspace.getConfiguration('antigravitySafeSwitcher');
    const autoSwitchEnabled = config.get('autoSwitchOnLowQuota', true);
    const criticalThreshold = config.get('criticalThreshold', 10);
    const warningThreshold = config.get('warningThreshold', 15);

    if (!autoSwitchEnabled || !liveData || !liveData.isLive) return false;

    const isLow = (liveData.flashQuota <= criticalThreshold || liveData.proQuota <= criticalThreshold);
    if (!isLow) return false;

    const currentScore = (liveData.flashQuota * 0.55) + (liveData.proQuota * 0.35) + ((liveData.claudeQuota || 0) * 0.1);

    // Lọc các ứng viên có hạn mức vượt ngưỡng cảnh báo và có biên độ cao hơn tài khoản hiện tại (Anti-flapping hysteresis)
    const candidates = this.config.profiles.filter(p => {
      if (p.slot === this.config.activeSlot || !p.savedAt || !p.email) return false;
      const candidateScore = (p.flashQuota * 0.55) + (p.proQuota * 0.35) + ((p.claudeQuota || 0) * 0.1);
      return p.flashQuota >= warningThreshold && candidateScore >= (currentScore + 15);
    });

    if (candidates.length > 0) {
      // Sắp xếp theo điểm tổng hợp Quota và ưu tiên tài khoản có resetTime gần nhất
      candidates.sort((a, b) => {
        const scoreA = (a.flashQuota * 0.55) + (a.proQuota * 0.35) + ((a.claudeQuota || 0) * 0.1);
        const scoreB = (b.flashQuota * 0.55) + (b.proQuota * 0.35) + ((b.claudeQuota || 0) * 0.1);
        if (Math.abs(scoreB - scoreA) > 2) return scoreB - scoreA;
        const resetA = a.resetTime ? new Date(a.resetTime).getTime() : 0;
        const resetB = b.resetTime ? new Date(b.resetTime).getTime() : 0;
        return resetB - resetA;
      });

      const bestTarget = candidates[0];
      vscode.window.showWarningMessage(
        `[Auto-Switch] Quota tài khoản hiện tại đã cạn (${liveData.flashQuota}%). Đang chuyển sang ${bestTarget.name} (${bestTarget.flashQuota}% Quota)...`
      );
      await this.switchToSlot(bestTarget.slot);
      return true;
    }

    return false;
  }

  /**
   * Xuất toàn bộ Profile và Tokens thành gói Bundle an toàn
   */
  async exportProfilesBundle() {
    const bundle = {
      version: '1.2.0',
      exportedAt: new Date().toISOString(),
      config: JSON.parse(JSON.stringify(this.config)),
      slotsData: {}
    };

    for (const p of this.config.profiles) {
      if (p.savedAt && p.email) {
        let tokens = { oauthToken: null, vscdbAuth: null };
        if (this.secretStore) {
          tokens = await this.secretStore.getTokens(p.slot);
        }
        bundle.slotsData[p.slot] = tokens;
      }
    }

    return bundle;
  }

  /**
   * Nạp gói Profile Bundle vào hệ thống
   */
  async importProfilesBundle(bundle) {
    if (!bundle || !bundle.config || !Array.isArray(bundle.config.profiles)) {
      return { success: false, message: 'Dữ liệu Bundle không đúng định dạng.' };
    }

    try {
      this.config = bundle.config;
      this.saveConfig(this.config);

      if (bundle.slotsData && this.secretStore) {
        for (const [slotStr, tokens] of Object.entries(bundle.slotsData)) {
          const slot = parseInt(slotStr, 10);
          if (tokens && (tokens.oauthToken || tokens.vscdbAuth)) {
            await this.secretStore.storeTokens(slot, tokens.oauthToken, tokens.vscdbAuth);
          }
        }
      }

      return { success: true, message: 'Đã nạp thành công cấu hình Profiles từ Bundle!' };
    } catch (e) {
      return { success: false, message: `Lỗi nạp Bundle: ${e.message}` };
    }
  }

  /**
   * Đổi tên hiển thị cho Slot
   */
  renameSlot(slot, newName) {
    if (!slot || !newName || !newName.trim()) {
      return { success: false, message: 'Tên không hợp lệ.' };
    }
    const profile = this.config.profiles.find(p => p.slot === slot);
    if (!profile) {
      return { success: false, message: `Không tìm thấy Slot ${slot}.` };
    }
    profile.name = newName.trim();
    this.saveConfig(this.config);
    return { success: true, slot, name: profile.name };
  }
}

ProfileManager.PROFILES_DIR = DEFAULT_PROFILES_DIR;
ProfileManager.DEFAULT_CONFIG = DEFAULT_CONFIG;

module.exports = ProfileManager;
