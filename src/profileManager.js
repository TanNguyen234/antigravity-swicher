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
  lastSyncedAt: null,
  profiles: [
    {
      slot: 1,
      id: 'profile1',
      name: 'Tài khoản 1',
      email: '',
      tier: 'Google AI',
      savedAt: null,
      flashQuota: null,
      proQuota: null,
      claudeQuota: null,
      fiveHourQuota: null,
      weeklyQuota: null,
      quota: null,
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
      flashQuota: null,
      proQuota: null,
      claudeQuota: null,
      fiveHourQuota: null,
      weeklyQuota: null,
      quota: null,
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
      flashQuota: null,
      proQuota: null,
      claudeQuota: null,
      fiveHourQuota: null,
      weeklyQuota: null,
      quota: null,
      resetTime: null,
      status: 'empty'
    }
  ]
};

/**
 * Chuẩn hóa giá trị quota:
 * finite number < 0   -> 0
 * finite number > 100 -> 100
 * finite 0..100       -> Math.round(val)
 * NaN                 -> null
 * Infinity            -> null
 * string              -> null
 * null/undefined      -> null
 */
function normalizeQuota(val) {
  if (typeof val !== 'number' || !Number.isFinite(val)) {
    return null;
  }
  if (val < 0) return 0;
  if (val > 100) return 100;
  return Math.round(val);
}

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
    this.sessionAuthenticated = false; // Phân biệt phiên thực tế với slot cấu hình
    this.currentSessionEmail = null;
    this.lastSyncedAt = null;
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
      const hasConfiguredMetadata = Boolean(p.savedAt && p.email);

      // Slot active: giữ nếu có email thật
      if (p.slot === this.config.activeSlot && p.email) {
        p.flashQuota = normalizeQuota(p.flashQuota);
        p.proQuota = normalizeQuota(p.proQuota);
        p.claudeQuota = normalizeQuota(p.claudeQuota);
        p.fiveHourQuota = normalizeQuota(p.fiveHourQuota);
        p.weeklyQuota = normalizeQuota(p.weeklyQuota);
        p.quota = normalizeQuota(p.quota);
        return;
      }

      if (!hasConfiguredMetadata) {
        p.savedAt = null;
        p.email = '';
        p.name = `Slot ${p.slot} (Trống)`;
        p.tier = 'N/A';
        p.planName = '';
        p.promptCredits = null;
        p.flowCredits = null;
        p.flashQuota = null;
        p.proQuota = null;
        p.claudeQuota = null;
        p.fiveHourQuota = null;
        p.weeklyQuota = null;
        p.quota = null;
        p.resetTime = null;
        p.fiveHourResetTime = null;
        p.weeklyResetTime = null;
        p.status = 'empty';
      } else {
        p.flashQuota = normalizeQuota(p.flashQuota);
        p.proQuota = normalizeQuota(p.proQuota);
        p.claudeQuota = normalizeQuota(p.claudeQuota);
        p.fiveHourQuota = normalizeQuota(p.fiveHourQuota);
        p.weeklyQuota = normalizeQuota(p.weeklyQuota);
        p.quota = normalizeQuota(p.quota);
      }
    });

    delete this.config.totalTokensToday;
    delete this.config.estimatedSavingsUSD;
    delete this.config.telemetryHistory;
    delete this.config.hourlyUsage;
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
  async syncCurrentLiveQuota(expectedSlot = null, fetcher = liveQuotaFetcher) {
    const realData = await fetcher.getRealAccountAndQuota(2);

    if (realData && realData.isLive) {
      const rawEmail = (realData.email && realData.email !== 'Chưa đăng nhập' && realData.email !== 'Không phát hiện phiên')
        ? realData.email.trim()
        : null;

      if (rawEmail) {
        this.sessionAuthenticated = true;
        this.currentSessionEmail = rawEmail;
        this.lastSyncedAt = new Date().toISOString();
        this.config.lastSyncedAt = this.lastSyncedAt;
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

          // Tự động sao lưu token vào SecretStorage
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

        this.updateTelemetryMetrics(realData);
        this.saveConfig(this.config);
      } else {
        if (!this._isSwitching) {
          this.sessionAuthenticated = false;
          this.currentSessionEmail = null;
        }
      }
    } else {
      if (!this._isSwitching) {
        this.sessionAuthenticated = false;
        this.currentSessionEmail = null;
      }
    }
    return realData;
  }

  _applyRealDataToProfile(profile, realData) {
    if (!profile || !realData) return;
    profile.email = realData.email || '';

    // Tự động gán tên từ Google nếu slot hiện đang dùng tên mặc định hoặc placeholder
    if (
      realData.name &&
      (
        !profile.name ||
        profile.name.includes('(Trống)') ||
        /^Slot \d+/.test(profile.name)
      )
    ) {
      profile.name = realData.name;
    }

    profile.tier = realData.tier || profile.tier || 'Google AI';
    profile.planName = realData.planName || '';
    profile.promptCredits = (typeof realData.promptCredits === 'number' && Number.isFinite(realData.promptCredits)) ? realData.promptCredits : undefined;
    profile.flowCredits = (typeof realData.flowCredits === 'number' && Number.isFinite(realData.flowCredits)) ? realData.flowCredits : undefined;

    const fH = (realData.fiveHourQuota !== undefined) ? realData.fiveHourQuota : realData.flashQuota;
    const wK = (realData.weeklyQuota !== undefined) ? realData.weeklyQuota : realData.proQuota;
    profile.fiveHourQuota = normalizeQuota(fH);
    profile.weeklyQuota = normalizeQuota(wK);
    profile.flashQuota = profile.fiveHourQuota;
    profile.proQuota = profile.weeklyQuota;
    profile.claudeQuota = normalizeQuota(realData.claudeQuota);
    profile.quota = profile.fiveHourQuota;
    profile.fiveHourResetTime = realData.fiveHourResetTime || realData.resetTime || null;
    profile.weeklyResetTime = realData.weeklyResetTime || null;
    profile.resetTime = profile.fiveHourResetTime;
    profile.fiveHourDescription = realData.fiveHourDescription || '';
    profile.weeklyDescription = realData.weeklyDescription || '';
  }

  updateTelemetryMetrics(realData) {
    this.lastSyncedAt = new Date().toISOString();
    this.config.lastSyncedAt = this.lastSyncedAt;
  }

  async _autoBackupSlotAuth(slotNumber) {
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
    }

    // Lưu TRỰC TIẾP vào SecretStorage - TUYỆT ĐỐI KHÔNG ghi file plaintext oauth_token.json, vscdb_auth.json vào slotDir
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
  /**
   * Lưu phiên đăng nhập hiện tại của Antigravity vào một Slot cụ thể
   */
  async saveCurrentToSlot(slotNumber, customName = null) {
    const prevActiveSlot = this.config.activeSlot;
    const prevProfiles = JSON.parse(JSON.stringify(this.config.profiles));

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
      }

      // 2. Lấy snapshot vscdb
      const authData = await vscdbHelper.exportVscdbAuth();

      // 3. Lưu trữ an toàn CHỈ trong SecretStorage (TUYỆT ĐỐI KHÔNG ghi file plaintext trên đĩa)
      if (this.secretStore) {
        try {
          await this.secretStore.storeTokens(slotNumber, oauthToken, authData);
        } catch (secErr) {
          console.error(`[ProfileManager] Lỗi lưu token vào SecretStorage cho Slot ${slotNumber}:`, secErr);
          return { success: false, message: `Lỗi lưu trữ chứng thực bảo mật: ${secErr.message}` };
        }
      }

      // 4. Cập nhật metadata Profile
      const profile = this.config.profiles.find(p => p.slot === slotNumber);
      if (profile) {
        profile.savedAt = new Date().toISOString();
        profile.email = liveData.email;
        profile.name = customName || liveData.name || `Tài khoản ${slotNumber}`;
        profile.tier = liveData.tier || 'Google AI';
        this._applyRealDataToProfile(profile, liveData);
        profile.status = (slotNumber === this.config.activeSlot) ? 'active' : 'standby';
      }

      this.config.activeSlot = slotNumber;
      const saved = this.saveConfig(this.config);
      if (!saved) {
        // Rollback in-memory state nếu lưu file cấu hình thất bại
        this.config.activeSlot = prevActiveSlot;
        this.config.profiles = prevProfiles;
        return {
          success: false,
          message: 'Không thể lưu tệp cấu hình profiles.json sau khi ghi nhận tài khoản.'
        };
      }

      this.sessionAuthenticated = true;
      this.currentSessionEmail = liveData.email;
      this.lastSyncedAt = new Date().toISOString();

      return {
        success: true,
        message: `Đã lưu thành công tài khoản [${profile ? profile.name : slotNumber}] (${liveData.email}) vào Slot ${slotNumber}!`
      };
    } catch (err) {
      this.config.activeSlot = prevActiveSlot;
      this.config.profiles = prevProfiles;
      console.error(`[ProfileManager] Lỗi khi lưu profile ${slotNumber}:`, err);
      return { success: false, message: `Lỗi: ${err.message}` };
    }
  }

  /**
   * Luồng Đăng nhập tài khoản mới vào Slot (TRỰC TIẾP, KHÔNG GHI ĐÈ SLOT KHÁC)
   */
  async loginNewToSlot(slotNumber) {
    // 1. Sao lưu phiên active hiện tại vào slot active nếu có dữ liệu - BẮT BUỘC KIỂM TRA THÀNH CÔNG
    const currentActive = this.getActiveProfile();
    if (currentActive && currentActive.savedAt && currentActive.email) {
      const backupRes = await this.saveCurrentToSlot(currentActive.slot);
      if (!backupRes || !backupRes.success) {
        return {
          success: false,
          message: `Không thể sao lưu an toàn tài khoản hiện tại trước khi đăng nhập mới: ${backupRes?.message || 'Lỗi sao lưu'}`
        };
      }
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

      // Thông báo người dùng: nút xác nhận CHỈ invalidateCache để tăng tốc polling, KHÔNG độc lập bind slot
      vscode.window.showInformationMessage(
        `[Slot ${slotNumber}] Trình duyệt đang mở trang đăng nhập Google. Hãy chọn tài khoản mới muốn liên kết với Slot ${slotNumber}. Hệ thống sẽ tự động gán sau khi đăng nhập xong.`,
        'Xác nhận đã đăng nhập xong'
      ).then(async action => {
        if (action === 'Xác nhận đã đăng nhập xong') {
          liveQuotaFetcher.invalidateCache();
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
   * Phương thức nội bộ xóa auth trong state.vscdb
   */
  async _clearVscdbAuth() {
    return vscdbHelper.importVscdbAuth({});
  }

  /**
   * Đăng xuất phiên làm việc thật (Kiểm tra nghiêm ngặt kết quả các cơ chế đăng xuất)
   */
  async logoutCurrent() {
    const warnings = [];
    let lsLogoutSuccess = false;
    let internalLogoutSuccess = false;

    // 1. Internal OAuth clear (tùy chọn / best-effort)
    if (vscode.antigravityUnifiedStateSync?.OAuthPreferences?.setOAuthTokenInfo) {
      try {
        await vscode.antigravityUnifiedStateSync.OAuthPreferences.setOAuthTokenInfo(null);
        if (vscode.antigravityUnifiedStateSync.UserStatus?.clearUserStatus) {
          await vscode.antigravityUnifiedStateSync.UserStatus.clearUserStatus();
        }
        internalLogoutSuccess = true;
      } catch (e) {
        warnings.push(`Internal OAuth clear: ${e.message}`);
      }
    }

    // 2. Language Server logout (Bảo vệ: không gọi RPC logout thật khi đang chạy unit test)
    if (process.env.NODE_ENV !== 'test') {
      try {
        const lsRes = await liveQuotaFetcher.logoutLanguageServer();
        if (lsRes && lsRes.success) {
          lsLogoutSuccess = true;
        } else if (lsRes && lsRes.error) {
          warnings.push(`LS logout: ${lsRes.error}`);
        }
      } catch (e) {
        warnings.push(`LS logout: ${e.message}`);
      }
    } else {
      lsLogoutSuccess = true;
    }

    // 3. CLI token removal
    if (process.env.NODE_ENV !== 'test' && fs.existsSync(CLI_TOKEN_FILE)) {
      try {
        fs.unlinkSync(CLI_TOKEN_FILE);
      } catch (e) {
        warnings.push(`CLI token removal: ${e.message}`);
      }
    }

    // 4. VSCDB managed auth clear (bắt buộc phải thành công)
    const vscdbCleared = await this._clearVscdbAuth();
    if (!vscdbCleared) {
      return {
        success: false,
        message: 'Không thể xóa sạch dữ liệu chứng thực trong state.vscdb khi đăng xuất.',
        warnings: warnings.length > 0 ? warnings : undefined
      };
    }

    // Nếu tất cả các cơ chế đăng xuất phiên đều thất bại
    if (!lsLogoutSuccess && !internalLogoutSuccess && !vscdbCleared) {
      return {
        success: false,
        message: 'Tất cả các cơ chế đăng xuất đều thất bại.',
        warnings: warnings.length > 0 ? warnings : undefined
      };
    }

    // 5. Cập nhật trạng thái phiên (Giữ lại profile metadata để người dùng có thể switch back sau)
    this.sessionAuthenticated = false;
    this.currentSessionEmail = null;

    const saved = this.saveConfig(this.config);
    if (!saved) {
      return {
        success: false,
        message: 'Lỗi ghi tệp cấu hình profiles.json khi đăng xuất.',
        warnings: warnings.length > 0 ? warnings : undefined
      };
    }

    return {
      success: true,
      message: 'Đã đăng xuất phiên làm việc thành công.',
      warnings: warnings.length > 0 ? warnings : undefined
    };
  }

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

      // 2. Lấy tokens xác thực của targetSlot từ SecretStorage trước
      let targetOAuthToken = null;
      let targetVscdbAuth = null;

      if (this.secretStore) {
        const stored = await this.secretStore.getTokens(targetSlot);
        targetOAuthToken = stored.oauthToken;
        targetVscdbAuth = stored.vscdbAuth;
      }

      // Legacy disk fallback (chỉ dùng khi SecretStorage chưa có, và tự động migrate)
      const targetSlotDir = this.getSlotDir(targetSlot);
      const targetOAuthFile = path.join(targetSlotDir, 'oauth_token.json');
      const targetVscdbFile = path.join(targetSlotDir, 'vscdb_auth.json');
      const targetCliToken = path.join(targetSlotDir, 'antigravity-oauth-token');

      let loadedFromDisk = false;
      if (!targetOAuthToken && fs.existsSync(targetOAuthFile)) {
        try { targetOAuthToken = JSON.parse(fs.readFileSync(targetOAuthFile, 'utf8')); loadedFromDisk = true; } catch (e) {}
      }
      if (!targetOAuthToken && fs.existsSync(targetCliToken)) {
        try {
          const rawCli = JSON.parse(fs.readFileSync(targetCliToken, 'utf8'));
          targetOAuthToken = cliTokenToOAuthTokenInfo(rawCli);
          loadedFromDisk = true;
        } catch (e) {}
      }
      if (!targetVscdbAuth && fs.existsSync(targetVscdbFile)) {
        try { targetVscdbAuth = JSON.parse(fs.readFileSync(targetVscdbFile, 'utf8')); loadedFromDisk = true; } catch (e) {}
      }

      if (targetOAuthToken) {
        targetOAuthToken = cliTokenToOAuthTokenInfo(targetOAuthToken);
      }

      // Nếu nạp từ disk fallback thành công, di chuyển ngay vào SecretStorage và dọn file plaintext
      if (loadedFromDisk && this.secretStore) {
        await this.secretStore.migrateFromDisk(targetSlot, targetSlotDir);
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
   * Tự động chuyển đổi nếu tài khoản active cạn Quota (Single-RPC, Truthful Ranking & Future Reset Tie-Breaking)
   */
  async checkAndAutoSwitch(liveData = null) {
    if (this._isSwitching) return false;

    // Nếu không truyền liveData từ vòng lặp ngoài, mới tự fetch
    const currentLive = liveData || await this.syncCurrentLiveQuota();

    const config = vscode.workspace.getConfiguration('antigravitySafeSwitcher');
    const autoSwitchEnabled = config.get('autoSwitchOnLowQuota', true);
    const criticalThreshold = config.get('criticalThreshold', 10);
    const warningThreshold = config.get('warningThreshold', 15);

    if (!autoSwitchEnabled || !currentLive || !currentLive.isLive) return false;

    const q5h = currentLive.fiveHourQuota !== undefined ? currentLive.fiveHourQuota : currentLive.flashQuota;
    const qWk = currentLive.weeklyQuota !== undefined ? currentLive.weeklyQuota : currentLive.proQuota;

    // Chỉ trigger khi quota active THỰC SỰ ĐÃ BIẾT và <= criticalThreshold. Quota null/unknown KHÔNG trigger!
    const isLow = (Number.isFinite(q5h) && q5h <= criticalThreshold) ||
                  (Number.isFinite(qWk) && qWk <= criticalThreshold);

    if (!isLow) return false;

    // Tính điểm tài khoản hiện tại dựa trên các bucket đã biết
    let currentScore = 0;
    if (Number.isFinite(q5h) && Number.isFinite(qWk)) {
      currentScore = q5h * 0.6 + qWk * 0.4;
    } else if (Number.isFinite(q5h)) {
      currentScore = q5h;
    } else if (Number.isFinite(qWk)) {
      currentScore = qWk;
    } else {
      return false; // Không rõ hạn mức -> không auto-switch
    }

    // Lọc các ứng viên hợp lệ:
    // - khác slot hiện tại
    // - đã lưu tài khoản
    // - có quota đã biết và vượt ngưỡng cảnh báo
    const candidates = [];
    for (const p of this.config.profiles) {
      if (p.slot === this.config.activeSlot || !p.savedAt || !p.email) continue;

      const p5h = p.fiveHourQuota !== undefined ? p.fiveHourQuota : p.flashQuota;
      const pWk = p.weeklyQuota !== undefined ? p.weeklyQuota : p.proQuota;

      const has5h = Number.isFinite(p5h);
      const hasWk = Number.isFinite(pWk);
      if (!has5h && !hasWk) continue; // Bỏ qua nếu quota không rõ

      // Ứng viên phải có quota trên ngưỡng cảnh báo
      if (has5h && p5h < warningThreshold) continue;
      if (hasWk && pWk < warningThreshold) continue;

      let score = 0;
      if (has5h && hasWk) {
        score = p5h * 0.6 + pWk * 0.4;
      } else if (has5h) {
        score = p5h;
      } else {
        score = pWk;
      }

      // Hysteresis: phải có điểm cao hơn hiện tại ít nhất 15 điểm
      if (score >= currentScore + 15) {
        candidates.push({ profile: p, score, p5h, pWk });
      }
    }

    if (candidates.length === 0) return false;

    const nowMs = Date.now();
    const getResetScore = (resetTimeStr) => {
      if (!resetTimeStr) return Infinity; // Không rõ -> xếp sau
      const t = new Date(resetTimeStr).getTime();
      if (isNaN(t) || t <= nowMs) return Infinity - 1; // Hết hạn -> xếp sau tương lai hợp lệ
      return t; // Càng gần hiện tại thì t càng nhỏ (hồi sớm hơn)
    };

    candidates.sort((a, b) => {
      if (Math.abs(b.score - a.score) > 2) {
        return b.score - a.score; // Điểm cao hơn thắng
      }
      // Điểm xấp xỉ bằng nhau -> ưu tiên reset time hợp lệ trong tương lai gần nhất
      const resetA = getResetScore(a.profile.fiveHourResetTime || a.profile.resetTime);
      const resetB = getResetScore(b.profile.fiveHourResetTime || b.profile.resetTime);
      return resetA - resetB;
    });

    const bestTarget = candidates[0].profile;
    vscode.window.showWarningMessage(
      `[Auto-Switch] Quota tài khoản hiện tại đã cạn (${q5h !== null ? q5h + '%' : 'hết hạn'}). Đang chuyển sang ${bestTarget.name}...`
    );

    const result = await this.switchToSlot(bestTarget.slot);
    return result?.success === true;
  }

  /**
   * Xuất toàn bộ Profile thành gói Bundle an toàn (KHÔNG chứa secret/token nhạy cảm)
   */
  async exportProfilesBundle() {
    const sanitizedConfig = JSON.parse(JSON.stringify(this.config));
    if (sanitizedConfig.profiles && Array.isArray(sanitizedConfig.profiles)) {
      sanitizedConfig.profiles.forEach(p => {
        delete p.token;
        delete p.accessToken;
        delete p.refreshToken;
        delete p.oauthToken;
        delete p.vscdbAuth;
      });
    }

    return {
      version: '1.2.0',
      exportedAt: new Date().toISOString(),
      config: sanitizedConfig,
      containsSecrets: false
    };
  }

  /**
   * Nạp gói Profile Bundle vào hệ thống với kiểm tra schema tối thiểu an toàn
   */
  async importProfilesBundle(bundle) {
    if (!bundle || typeof bundle !== 'object') {
      return { success: false, message: 'Bundle không hợp lệ: dữ liệu trống hoặc không phải object.' };
    }

    // Chặn cấu hình quá lớn / bất thường (chống DoS / tràn bộ nhớ)
    const bundleStr = JSON.stringify(bundle);
    if (bundleStr.length > 1024 * 1024) {
      return { success: false, message: 'Bundle không hợp lệ: kích thước vượt quá giới hạn 1MB.' };
    }

    const cfg = bundle.config;
    if (!cfg || typeof cfg !== 'object') {
      return { success: false, message: 'Bundle không hợp lệ: thiếu thuộc tính config.' };
    }

    if (!Array.isArray(cfg.profiles) || cfg.profiles.length === 0 || cfg.profiles.length > 10) {
      return { success: false, message: 'Bundle không hợp lệ: danh sách profiles không hợp lệ.' };
    }

    const validStatuses = new Set(['active', 'standby', 'empty']);
    const seenSlots = new Set();

    for (const p of cfg.profiles) {
      if (!p || typeof p !== 'object') {
        return { success: false, message: 'Bundle không hợp lệ: profile item không phải object.' };
      }
      if (typeof p.slot !== 'number' || !Number.isInteger(p.slot) || p.slot <= 0) {
        return { success: false, message: `Bundle không hợp lệ: slot ${p.slot} không phải số nguyên dương.` };
      }
      if (seenSlots.has(p.slot)) {
        return { success: false, message: `Bundle không hợp lệ: trùng lặp slot ID ${p.slot}.` };
      }
      seenSlots.add(p.slot);

      if (p.email !== undefined && p.email !== null && typeof p.email !== 'string') {
        return { success: false, message: `Bundle không hợp lệ: email tại Slot ${p.slot} phải là chuỗi.` };
      }
      if (p.name !== undefined && p.name !== null && typeof p.name !== 'string') {
        return { success: false, message: `Bundle không hợp lệ: tên tại Slot ${p.slot} phải là chuỗi.` };
      }
      if (p.tier !== undefined && p.tier !== null && typeof p.tier !== 'string') {
        return { success: false, message: `Bundle không hợp lệ: tier tại Slot ${p.slot} phải là chuỗi.` };
      }
      if (p.savedAt !== undefined && p.savedAt !== null && typeof p.savedAt !== 'string') {
        return { success: false, message: `Bundle không hợp lệ: savedAt tại Slot ${p.slot} không hợp lệ.` };
      }
      if (p.status !== undefined && p.status !== null && !validStatuses.has(p.status)) {
        return { success: false, message: `Bundle không hợp lệ: status "${p.status}" không được hỗ trợ.` };
      }

      // Chuẩn hóa và xác thực quota 0..100 hoặc null
      const quotaFields = ['quota', 'flashQuota', 'proQuota', 'claudeQuota', 'fiveHourQuota', 'weeklyQuota'];
      for (const qf of quotaFields) {
        if (p[qf] !== undefined && p[qf] !== null) {
          if (typeof p[qf] !== 'number' || !Number.isFinite(p[qf]) || p[qf] < 0 || p[qf] > 100) {
            return { success: false, message: `Bundle không hợp lệ: giá trị quota ${qf} không nằm trong dải 0..100.` };
          }
          p[qf] = Math.round(p[qf]);
        } else {
          p[qf] = null;
        }
      }
    }

    if (typeof cfg.activeSlot !== 'number' || !seenSlots.has(cfg.activeSlot)) {
      return { success: false, message: `Bundle không hợp lệ: activeSlot (${cfg.activeSlot}) không tồn tại trong danh sách profiles.` };
    }

    // Khi đã vượt qua toàn bộ kiểm tra schema:
    try {
      this.config = cfg;
      this.saveConfig(this.config);

      // Nếu bundle cũ có chứa legacy slotsData (để tương thích ngược),
      // LƯU TRỰC TIẾP VÀO SecretStorage, TUYỆT ĐỐI KHÔNG ghi ra file plaintext trên đĩa!
      if (bundle.slotsData && typeof bundle.slotsData === 'object' && this.secretStore) {
        for (const [slotStr, tokens] of Object.entries(bundle.slotsData)) {
          const slot = parseInt(slotStr, 10);
          if (tokens && typeof tokens === 'object' && (tokens.oauthToken || tokens.vscdbAuth)) {
            await this.secretStore.storeTokens(slot, tokens.oauthToken || null, tokens.vscdbAuth || null);
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
ProfileManager.normalizeQuota = normalizeQuota;

module.exports = ProfileManager;
