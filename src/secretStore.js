const fs = require('fs');
const path = require('path');

class ProfileSecretStorage {
  /**
   * @param {any} context - VS Code ExtensionContext or null/mock for tests
   */
  constructor(context = null) {
    this._context = context;
    this._secrets = context ? context.secrets : null;
    // In-memory fallback if running outside of VS Code extension host (e.g. tests/scripts)
    this._memoryStore = new Map();
  }

  setContext(context) {
    this._context = context;
    this._secrets = context ? context.secrets : null;
  }

  _getKey(slot, type) {
    return `antigravity_slot_${slot}_${type}`;
  }

  /**
   * Lưu trữ an toàn token OAuth và auth snapshot vào SecretStorage (mã hóa cấp OS)
   */
  async storeTokens(slot, oauthToken, vscdbAuth = null) {
    const oauthKey = this._getKey(slot, 'oauth');
    const vscdbKey = this._getKey(slot, 'vscdb');

    const oauthStr = oauthToken ? JSON.stringify(oauthToken) : null;
    const vscdbStr = vscdbAuth ? JSON.stringify(vscdbAuth) : null;

    if (this._secrets) {
      if (oauthStr) {
        await this._secrets.store(oauthKey, oauthStr);
      } else {
        await this._secrets.delete(oauthKey);
      }

      if (vscdbStr) {
        await this._secrets.store(vscdbKey, vscdbStr);
      } else {
        await this._secrets.delete(vscdbKey);
      }
    } else {
      if (oauthStr) this._memoryStore.set(oauthKey, oauthStr);
      else this._memoryStore.delete(oauthKey);

      if (vscdbStr) this._memoryStore.set(vscdbKey, vscdbStr);
      else this._memoryStore.delete(vscdbKey);
    }
  }

  /**
   * Lấy token đã mã hóa của một Slot
   */
  async getTokens(slot) {
    const oauthKey = this._getKey(slot, 'oauth');
    const vscdbKey = this._getKey(slot, 'vscdb');

    let oauthRaw = null;
    let vscdbRaw = null;

    if (this._secrets) {
      oauthRaw = await this._secrets.get(oauthKey);
      vscdbRaw = await this._secrets.get(vscdbKey);
    } else {
      oauthRaw = this._memoryStore.get(oauthKey) || null;
      vscdbRaw = this._memoryStore.get(vscdbKey) || null;
    }

    let oauthToken = null;
    let vscdbAuth = null;

    try {
      if (oauthRaw) oauthToken = JSON.parse(oauthRaw);
    } catch (e) {
      console.warn(`[ProfileSecretStorage] Lỗi parse oauthToken cho Slot ${slot}:`, e.message);
    }

    try {
      if (vscdbRaw) vscdbAuth = JSON.parse(vscdbRaw);
    } catch (e) {
      console.warn(`[ProfileSecretStorage] Lỗi parse vscdbAuth cho Slot ${slot}:`, e.message);
    }

    return { oauthToken, vscdbAuth };
  }

  /**
   * Xóa sạch token khi giải phóng Slot
   */
  async clearSlotTokens(slot) {
    const oauthKey = this._getKey(slot, 'oauth');
    const vscdbKey = this._getKey(slot, 'vscdb');

    if (this._secrets) {
      await this._secrets.delete(oauthKey);
      await this._secrets.delete(vscdbKey);
    } else {
      this._memoryStore.delete(oauthKey);
      this._memoryStore.delete(vscdbKey);
    }
  }

  /**
   * Kiểm tra xem một slot đã có token lưu trữ hay chưa
   */
  async hasTokens(slot) {
    const tokens = await this.getTokens(slot);
    return Boolean(
      (tokens.oauthToken && tokens.oauthToken.accessToken) ||
      (tokens.vscdbAuth && Object.keys(tokens.vscdbAuth).length > 0)
    );
  }

  /**
   * Di chuyển an toàn từ file JSON cũ sang SecretStorage (Zero-Data-Loss)
   * Chỉ xóa file plaintext khi SecretStorage thực tế đã nhận diện và xác minh đọc lại thành công!
   */
  async migrateFromDisk(slot, slotDir) {
    if (!fs.existsSync(slotDir)) return false;

    const oauthFile = path.join(slotDir, 'oauth_token.json');
    const vscdbFile = path.join(slotDir, 'vscdb_auth.json');
    const cliFile = path.join(slotDir, 'antigravity-oauth-token');

    let oauth = null;
    let vscdb = null;

    if (fs.existsSync(oauthFile)) {
      try {
        oauth = JSON.parse(fs.readFileSync(oauthFile, 'utf8'));
      } catch (e) {
        console.warn(`[ProfileSecretStorage] Lỗi đọc ${oauthFile}:`, e.message);
      }
    }

    if (!oauth && fs.existsSync(cliFile)) {
      try {
        const raw = JSON.parse(fs.readFileSync(cliFile, 'utf8'));
        const t = raw.token || raw;
        oauth = {
          accessToken: t.access_token || t.accessToken || '',
          refreshToken: t.refresh_token || t.refreshToken || ''
        };
      } catch (e) {
        console.warn(`[ProfileSecretStorage] Lỗi đọc ${cliFile}:`, e.message);
      }
    }

    if (fs.existsSync(vscdbFile)) {
      try {
        vscdb = JSON.parse(fs.readFileSync(vscdbFile, 'utf8'));
      } catch (e) {
        console.warn(`[ProfileSecretStorage] Lỗi đọc ${vscdbFile}:`, e.message);
      }
    }

    if (oauth || vscdb) {
      try {
        await this.storeTokens(slot, oauth, vscdb);

        // CHỈ xóa file plaintext khi SecretStorage của VS Code thực sự hoạt động VÀ đã kiểm tra đọc lại thành công
        if (this._secrets) {
          const verify = await this.getTokens(slot);
          const oauthOk = !oauth || (verify.oauthToken && (verify.oauthToken.accessToken === oauth.accessToken || verify.oauthToken.accessToken));
          const vscdbOk = !vscdb || (verify.vscdbAuth && typeof verify.vscdbAuth === 'object');

          if (oauthOk && vscdbOk) {
            if (fs.existsSync(oauthFile)) fs.unlinkSync(oauthFile);
            if (fs.existsSync(vscdbFile)) fs.unlinkSync(vscdbFile);
            if (fs.existsSync(cliFile)) fs.unlinkSync(cliFile);
            console.log(`[ProfileSecretStorage] Đã di chuyển an toàn tệp của Slot ${slot} sang SecretStorage.`);
            return true;
          }
        }
        return true;
      } catch (e) {
        console.warn(`[ProfileSecretStorage] Lỗi di chuyển sang SecretStorage:`, e.message);
        return false;
      }
    }

    return false;
  }
}

module.exports = ProfileSecretStorage;
