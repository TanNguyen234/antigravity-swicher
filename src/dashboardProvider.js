const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

let activeWebviews = new Set();
let currentPanel = undefined;

function getHtmlContent(extensionUri, webview) {
  const htmlPath = path.join(extensionUri.fsPath, 'media', 'dashboard.html');
  const cssPath = path.join(extensionUri.fsPath, 'media', 'dashboard.css');
  const jsPath = path.join(extensionUri.fsPath, 'media', 'dashboard.js');

  const cssUri = webview.asWebviewUri(vscode.Uri.file(cssPath));
  const jsUri = webview.asWebviewUri(vscode.Uri.file(jsPath));

  let html = fs.readFileSync(htmlPath, 'utf8');
  html = html.replace('{{cssUri}}', cssUri.toString());
  html = html.replace('{{jsUri}}', jsUri.toString());

  return html;
}

async function broadcastUpdate(profileManager) {
  await profileManager.syncCurrentLiveQuota();

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

  const data = {
    activeSlot: profileManager.config.activeSlot,
    profiles: profilesWithExpiry,
    totalTokensToday: profileManager.config.totalTokensToday || 0,
    estimatedSavingsUSD: profileManager.config.estimatedSavingsUSD || 0,
    hourlyUsage: profileManager.config.hourlyUsage || []
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
          if (!res.success && res.message) {
            vscode.window.showWarningMessage(res.message);
          }
          await broadcastUpdate(profileManager);
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
              await broadcastUpdate(profileManager);
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

      case 'simulateLow':
        const active = profileManager.getActiveProfile();
        active.flashQuota = 8;
        active.proQuota = 5;
        await broadcastUpdate(profileManager);
        vscode.window.showInformationMessage(`[Test] Đã giả lập ${active.name} còn 8% quota.`);
        setTimeout(async () => {
          await profileManager.checkAndAutoSwitch();
        }, 800);
        break;
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

  updateDashboard() {
    broadcastUpdate(this._profileManager);
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
