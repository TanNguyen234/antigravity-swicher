let vscode;
try {
  vscode = require('vscode');
} catch (e) {
  vscode = null;
}
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let activeWebviews = new Set();
let currentPanel = undefined;

function getHtmlContent(extensionUri, webview) {
  const htmlPath = path.join(extensionUri.fsPath, 'media', 'dashboard.html');
  const cssPath = path.join(extensionUri.fsPath, 'media', 'dashboard.css');
  const jsPath = path.join(extensionUri.fsPath, 'media', 'dashboard.js');

  const cssUri = webview.asWebviewUri(vscode ? vscode.Uri.file(cssPath) : { toString: () => cssPath });
  const jsUri = webview.asWebviewUri(vscode ? vscode.Uri.file(jsPath) : { toString: () => jsPath });
  const nonce = crypto.randomBytes(16).toString('base64');
  const cspSource = webview.cspSource;

  let html = fs.readFileSync(htmlPath, 'utf8');
  html = html.replace(/\{\{cssUri\}\}/g, cssUri.toString());
  html = html.replace(/\{\{jsUri\}\}/g, jsUri.toString());
  html = html.replace(/\{\{nonce\}\}/g, nonce);
  html = html.replace(/\{\{cspSource\}\}/g, cspSource);

  return html;
}

async function broadcastUpdate(profileManager, options = {}) {
  const syncLive = options.syncLive !== false;
  if (syncLive) {
    await profileManager.syncCurrentLiveQuota();
  }

  const profiles = profileManager.getAllProfiles();
  const profilesWithExpiry = await Promise.all(profiles.map(async p => {
    let tokenExpiry = { isExpiring: false, expired: false };
    if (p.savedAt && p.email) {
      tokenExpiry = await profileManager.isTokenExpiringSoon(p.slot);
    }
    return {
      ...p,
      tokenExpiry
    };
  }));

  let criticalThreshold = 10;
  let warningThreshold = 15;
  let isDevelopment = false;
  try {
    if (vscode && vscode.workspace) {
      const cfg = vscode.workspace.getConfiguration('antigravitySafeSwitcher');
      criticalThreshold = cfg.get('criticalThreshold', 10);
      warningThreshold = cfg.get('warningThreshold', 15);
      isDevelopment = Boolean(cfg.get('enableDevTools', false));
    }
  } catch (e) {}

  if (process.env.VSCODE_DEBUG_MODE || process.env.NODE_ENV === 'development') {
    isDevelopment = true;
  }

  const cfg = profileManager.config || (typeof profileManager.getConfig === 'function' ? profileManager.getConfig() : {});
  const data = {
    activeSlot: cfg.activeSlot || 1,
    profiles: profilesWithExpiry,
    totalTokensToday: cfg.totalTokensToday || 0,
    estimatedSavingsUSD: cfg.estimatedSavingsUSD || 0,
    hourlyUsage: cfg.hourlyUsage || [],
    thresholds: {
      critical: criticalThreshold,
      warning: warningThreshold
    },
    platform: process.platform,
    isDevelopment: isDevelopment
  };

  activeWebviews.forEach(wv => {
    try {
      wv.postMessage({ type: 'updateData', data: data });
    } catch (e) {
      activeWebviews.delete(wv);
    }
  });
}

function broadcastSwitchingProgress(slot, step, message) {
  activeWebviews.forEach(wv => {
    try {
      wv.postMessage({
        type: 'switchingProgress',
        slot: slot,
        step: step,
        message: message
      });
    } catch (e) {
      activeWebviews.delete(wv);
    }
  });
}

function broadcastSwitchResult(slot, success, message) {
  activeWebviews.forEach(wv => {
    try {
      wv.postMessage({
        type: 'switchResult',
        slot: slot,
        success: success,
        message: message
      });
    } catch (e) {
      activeWebviews.delete(wv);
    }
  });
}

function setupWebviewHandlers(webview, extensionUri, profileManager) {
  activeWebviews.add(webview);

  webview.onDidReceiveMessage(async data => {
    switch (data.command) {
      case 'refresh':
        await broadcastUpdate(profileManager);
        break;

      case 'openTab':
        openDashboardPanel(extensionUri, profileManager);
        break;

      case 'renameSlot':
        if (data.slot) {
          const profile = profileManager.getAllProfiles().find(p => p.slot === data.slot);
          const currentName = profile ? profile.name : `Tài khoản ${data.slot}`;
          const newName = await vscode.window.showInputBox({
            prompt: `Đổi tên gợi nhớ cho Slot ${data.slot}:`,
            value: currentName
          });
          if (newName && newName.trim()) {
            const renameRes = profileManager.renameSlot(data.slot, newName.trim());
            if (renameRes.success) {
              await broadcastUpdate(profileManager);
              vscode.window.showInformationMessage(`Đã đổi tên Slot ${data.slot} thành "${renameRes.name}"`);
            }
          }
        }
        break;

      case 'loginNew':
        if (data.slot) {
          profileManager.loginNewToSlot(data.slot).then(async res => {
            if (res && res.success) {
              vscode.window.showInformationMessage(res.message);
            } else if (res && res.message) {
              vscode.window.showErrorMessage(res.message);
            }
            await broadcastUpdate(profileManager);
          }).catch(err => {
            console.error('[Dashboard] Lỗi loginNew:', err);
          });
        }
        break;

      case 'switch':
        if (data.slot) {
          broadcastSwitchingProgress(data.slot, 0, 'Đang chuẩn bị chuyển đổi...');
          const res = await profileManager.switchToSlot(data.slot, (step, message) => {
            broadcastSwitchingProgress(data.slot, step, message);
          });
          broadcastSwitchResult(data.slot, res.success === true, res.message);
          if (!res.success) {
            if (res.message) {
              vscode.window.showWarningMessage(res.message);
            }
            await broadcastUpdate(profileManager, { syncLive: false });
          }
        }
        break;

      case 'bindSlot':
        if (data.slot) {
          const profile = profileManager.getAllProfiles().find(p => p.slot === data.slot);
          const defaultName = (profile && profile.name && !profile.name.includes('(Trống)'))
            ? profile.name
            : `Tài khoản ${data.slot}`;

          const customName = await vscode.window.showInputBox({
            prompt: `Đặt tên gợi nhớ cho Slot ${data.slot}:`,
            value: defaultName
          });

          if (customName !== undefined) {
            const res = await profileManager.saveCurrentToSlot(data.slot, customName);
            if (res.success) {
              vscode.window.showInformationMessage(res.message);
              await broadcastUpdate(profileManager);
            } else {
              vscode.window.showErrorMessage(res.message);
            }
          }
        }
        break;

      case 'deleteSlot':
        if (data.slot) {
          const profile = profileManager.getAllProfiles().find(p => p.slot === data.slot);
          const displayName = (profile && (profile.email || profile.name))
            ? (profile.email ? `${profile.name} (${profile.email})` : profile.name)
            : `Slot ${data.slot}`;

          const choice = await vscode.window.showWarningMessage(
            `Bạn có chắc chắn muốn XÓA tài khoản [${displayName}] và đưa Slot ${data.slot} về trạng thái trống không?`,
            { modal: true },
            'Xóa tài khoản',
            'Hủy'
          );

          if (choice === 'Xóa tài khoản') {
            const res = await profileManager.deleteProfile(data.slot);
            if (res.success) {
              vscode.window.showInformationMessage(res.message);
              await broadcastUpdate(profileManager, { syncLive: false });
              if (res.reloadRequired) {
                setTimeout(() => {
                  vscode.commands.executeCommand('workbench.action.reloadWindow');
                }, 350);
              }
            } else {
              vscode.window.showErrorMessage(res.message);
            }
          }
        }
        break;

      case 'saveCurrent':
        vscode.commands.executeCommand('antigravity-safe-switcher.saveCurrentProfile');
        break;

      case 'logoutCurrent': {
        const choice = await vscode.window.showWarningMessage(
          'Bạn có chắc chắn muốn ĐĂNG XUẤT phiên tài khoản hiện tại khỏi Antigravity không?',
          { modal: true },
          'Đăng xuất',
          'Hủy'
        );
        if (choice === 'Đăng xuất') {
          await profileManager.logoutCurrent();
          await broadcastUpdate(profileManager);
        }
        break;
      }

      case 'backup':
        vscode.commands.executeCommand('antigravity-safe-switcher.backupProfiles');
        break;

      case 'simulateLow': {
        let isDev = Boolean(process.env.VSCODE_DEBUG_MODE || process.env.NODE_ENV === 'development');
        try {
          const cfg = vscode.workspace.getConfiguration('antigravitySafeSwitcher');
          if (cfg.get('enableDevTools', false)) isDev = true;
        } catch (e) {}

        if (isDev) {
          const active = profileManager.getActiveProfile();
          active.flashQuota = 8;
          active.proQuota = 5;
          await broadcastUpdate(profileManager, { syncLive: false });
          vscode.window.showInformationMessage(`[Test] Đã giả lập ${active.name} còn 8% quota.`);
          setTimeout(async () => {
            await profileManager.checkAndAutoSwitch();
          }, 800);
        }
        break;
      }
    }
  });
}

function openDashboardPanel(extensionUri, profileManager) {
  if (currentPanel) {
    currentPanel.reveal(vscode.ViewColumn.One);
    broadcastUpdate(profileManager);
    return;
  }

  currentPanel = vscode.window.createWebviewPanel(
    'antigravityAccountDashboardPanel',
    'Antigravity Account Center',
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      localResourceRoots: [extensionUri],
      retainContextWhenHidden: true
    }
  );

  currentPanel.iconPath = vscode.Uri.file(path.join(extensionUri.fsPath, 'media', 'shield-icon.svg'));
  currentPanel.webview.html = getHtmlContent(extensionUri, currentPanel.webview);
  setupWebviewHandlers(currentPanel.webview, extensionUri, profileManager);

  currentPanel.onDidDispose(() => {
    activeWebviews.delete(currentPanel.webview);
    currentPanel = undefined;
  });

  setTimeout(() => {
    broadcastUpdate(profileManager);
  }, 200);
}

class DashboardViewProvider {
  constructor(extensionUri, profileManager) {
    this._extensionUri = extensionUri;
    this._profileManager = profileManager;
    this._view = undefined;
  }

  resolveWebviewView(webviewView, context, _token) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };

    webviewView.webview.html = getHtmlContent(this._extensionUri, webviewView.webview);
    setupWebviewHandlers(webviewView.webview, this._extensionUri, this._profileManager);

    webviewView.onDidDispose(() => {
      activeWebviews.delete(webviewView.webview);
    });

    setTimeout(() => {
      broadcastUpdate(this._profileManager);
    }, 200);
  }

  updateDashboard(options = {}) {
    broadcastUpdate(this._profileManager, options);
  }
}

function hasActiveWebviews() {
  return activeWebviews.size > 0;
}

module.exports = {
  DashboardViewProvider,
  openDashboardPanel,
  hasActiveWebviews,
  broadcastUpdate
};
