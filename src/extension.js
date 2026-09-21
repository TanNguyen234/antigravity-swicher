const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const ProfileManager = require('./profileManager');
const ProfileSecretStorage = require('./secretStore');
const { restoreWorkspaceState, setStateStorageDir } = require('./workspaceState');
const { DashboardViewProvider, openDashboardPanel, hasActiveWebviews } = require('./dashboardProvider');

let statusBarItem;
let profileManager;
let secretStore;
let dashboardProvider;
let checkInterval;

/**
 * @param {vscode.ExtensionContext} context
 */
async function activate(context) {
  console.log('[SafeSwitcher] Antigravity Safe Account Manager & Dashboard đã kích hoạt thành công!');

  const storageDir = context.globalStorageUri ? context.globalStorageUri.fsPath : null;
  if (storageDir) {
    setStateStorageDir(storageDir);
  }

  // 1. Khởi tạo SecretStore và ProfileManager
  secretStore = new ProfileSecretStorage(context);
  profileManager = new ProfileManager(secretStore, storageDir);

  // 1b. Tự động di chuyển an toàn token từ file plaintext cũ sang SecretStorage (OS DPAPI / Keychain)
  for (let slot = 1; slot <= 3; slot++) {
    const slotDir = profileManager.getSlotDir(slot);
    await secretStore.migrateFromDisk(slot, slotDir);
  }

  // 1c. Đồng bộ quota thật từ Language Server
  await profileManager.syncCurrentLiveQuota();

  // 2. Tự động phục hồi lại workspace tabs & cursor nếu có pending state
  await restoreWorkspaceState(storageDir);

  // 3. Đăng ký Dashboard Webview View trên thanh Activity Bar
  dashboardProvider = new DashboardViewProvider(context.extensionUri, profileManager);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('antigravity-safe-switcher.dashboardView', dashboardProvider)
  );

  // 4. Tạo và cấu hình Status Bar Item ở góc dưới
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'antigravity-safe-switcher.switchProfile';
  context.subscriptions.push(statusBarItem);
  updateStatusBar();
  statusBarItem.show();

  // 5. Đăng ký các Commands
  // 5.1 Command: Chọn nhanh Profile từ menu QuickPick
  context.subscriptions.push(
    vscode.commands.registerCommand('antigravity-safe-switcher.switchProfile', async () => {
      await profileManager.syncCurrentLiveQuota();
      const profiles = profileManager.getAllProfiles();
      const active = profileManager.getActiveProfile();

      const items = profiles.map(p => {
        const isCurrent = (p.slot === active.slot);
        const isConfigured = Boolean(p.savedAt && p.email);

        const fH = typeof p.fiveHourQuota === 'number' ? `${p.fiveHourQuota}%` : (typeof p.flashQuota === 'number' ? `${p.flashQuota}%` : '—');
        const wK = typeof p.weeklyQuota === 'number' ? `${p.weeklyQuota}%` : (typeof p.proQuota === 'number' ? `${p.proQuota}%` : '—');
        const cL = typeof p.claudeQuota === 'number' ? `${p.claudeQuota}%` : '—';

        return {
          label: `${isCurrent ? '$(check) ' : ''}Slot ${p.slot}: ${p.name}`,
          description: isConfigured ? `${p.email} (${p.tier || 'Google AI'})` : '(Slot Trống - Chưa liên kết)',
          detail: isConfigured 
            ? `5h: ${fH} | Tuần: ${wK} | Claude/Đối tác: ${cL}` 
            : 'Click để đăng nhập hoặc gán tài khoản vào slot này',
          slot: p.slot,
          isConfigured: isConfigured
        };
      });

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Chọn Slot tài khoản Google (Tự động bảo toàn Tabs):'
      });

      if (selected) {
        if (!selected.isConfigured) {
          // Hỏi người dùng muốn đăng nhập mới hay gán phiên
          await profileManager.loginNewToSlot(selected.slot);
          updateStatusBar();
          if (dashboardProvider) dashboardProvider.updateDashboard();
        } else {
          const res = await profileManager.switchToSlot(selected.slot);
          if (!res || !res.success) {
            updateStatusBar();
            if (dashboardProvider) dashboardProvider.updateDashboard({ syncLive: false });
          }
          // Khi thành công, IDE sẽ reloadWindow. KHÔNG gọi syncCurrentLiveQuota trước reload.
        }
      }
    })
  );

  // 5.2 Command: Lưu phiên hiện tại vào 1 trong 3 Slot
  context.subscriptions.push(
    vscode.commands.registerCommand('antigravity-safe-switcher.saveCurrentProfile', async () => {
      const slotItems = [
        { label: 'Slot 1', slot: 1 },
        { label: 'Slot 2', slot: 2 },
        { label: 'Slot 3', slot: 3 }
      ];

      const chosenSlot = await vscode.window.showQuickPick(slotItems, {
        placeHolder: 'Chọn Slot để lưu phiên đăng nhập hiện tại:'
      });

      if (!chosenSlot) return;

      const profile = profileManager.getAllProfiles().find(p => p.slot === chosenSlot.slot);
      const customName = await vscode.window.showInputBox({
        prompt: 'Đặt tên gợi nhớ cho tài khoản này:',
        value: (profile && profile.name && !profile.name.includes('(Trống)')) ? profile.name : `Tài khoản ${chosenSlot.slot}`
      });

      const result = await profileManager.saveCurrentToSlot(chosenSlot.slot, customName);
      if (result.success) {
        vscode.window.showInformationMessage(result.message);
        updateStatusBar();
        if (dashboardProvider) dashboardProvider.updateDashboard();
      } else {
        vscode.window.showErrorMessage(result.message);
      }
    })
  );

  // 5.2b Command: Xóa tài khoản / Làm sạch Slot
  context.subscriptions.push(
    vscode.commands.registerCommand('antigravity-safe-switcher.deleteProfile', async () => {
      const profiles = profileManager.getAllProfiles();
      const items = profiles.map(p => ({
        label: `Slot ${p.slot}: ${p.name}`,
        description: p.email || '(Đang trống)',
        slot: p.slot
      }));

      const chosen = await vscode.window.showQuickPick(items, {
        placeHolder: 'Chọn Slot muốn xóa tài khoản để đưa về trạng thái trống:'
      });

      if (!chosen) return;

      const choice = await vscode.window.showWarningMessage(
        `Bạn có chắc chắn muốn XÓA tài khoản tại Slot ${chosen.slot} không?`,
        { modal: true },
        'Xóa tài khoản',
        'Hủy'
      );

      if (choice === 'Xóa tài khoản') {
        const res = await profileManager.deleteProfile(chosen.slot);
        if (res.success) {
          vscode.window.showInformationMessage(res.message);
          updateStatusBar();
          if (dashboardProvider) dashboardProvider.updateDashboard({ syncLive: false });
          if (res.reloadRequired) {
            setTimeout(() => {
              vscode.commands.executeCommand('workbench.action.reloadWindow');
            }, 350);
          }
        } else {
          vscode.window.showErrorMessage(res.message);
        }
      }
    })
  );

  // 5.3 Command: Xoay vòng tài khoản nhanh (Ctrl+Alt+S / Cmd+Alt+S)
  context.subscriptions.push(
    vscode.commands.registerCommand('antigravity-safe-switcher.fastSwap', async () => {
      const res = await profileManager.fastSwapNext();
      if (!res || !res.success) {
        updateStatusBar();
        if (dashboardProvider) dashboardProvider.updateDashboard({ syncLive: false });
      }
      // Khi thành công, IDE sẽ reloadWindow. KHÔNG gọi syncCurrentLiveQuota trước reload.
    })
  );

  // 5.4 Command: Mở Dashboard Sidebar
  context.subscriptions.push(
    vscode.commands.registerCommand('antigravity-safe-switcher.openDashboard', () => {
      vscode.commands.executeCommand('workbench.view.extension.antigravity-account-center');
    })
  );

  // 5.5 Command: Mở Dashboard trong một Tab riêng biệt
  context.subscriptions.push(
    vscode.commands.registerCommand('antigravity-safe-switcher.openDashboardTab', () => {
      openDashboardPanel(context.extensionUri, profileManager);
    })
  );

  // 5.6 Command: Backup Profiles ra thư mục an toàn
  context.subscriptions.push(
    vscode.commands.registerCommand('antigravity-safe-switcher.backupProfiles', async () => {
      try {
        const defaultBackupParent = path.dirname(profileManager.storageDir);
        const backupDir = path.join(defaultBackupParent, 'backups', `backup_${new Date().toISOString().replace(/[:.]/g, '-')}`);
        const profilesDir = profileManager.storageDir;
        
        fs.cpSync(profilesDir, backupDir, { recursive: true });
        vscode.window.showInformationMessage(`Đã sao lưu Profile thành công ra: ${backupDir}`);
      } catch (err) {
        vscode.window.showErrorMessage(`Lỗi sao lưu: ${err.message}`);
      }
    })
  );

  // 5.7 Command: Xuất Bundle di chuyển đa thiết bị
  context.subscriptions.push(
    vscode.commands.registerCommand('antigravity-safe-switcher.exportBundle', async () => {
      try {
        const bundle = await profileManager.exportProfilesBundle();
        const uri = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file(path.join(__dirname, '..', `antigravity_profiles_bundle_${Date.now()}.json`)),
          filters: { 'JSON Files': ['json'] },
          saveLabel: 'Xuất gói Profiles Bundle'
        });
        if (uri) {
          fs.writeFileSync(uri.fsPath, JSON.stringify(bundle, null, 2), 'utf8');
          vscode.window.showInformationMessage(`Đã xuất an toàn gói Profiles Bundle tới: ${uri.fsPath}`);
        }
      } catch (err) {
        vscode.window.showErrorMessage(`Lỗi xuất Bundle: ${err.message}`);
      }
    })
  );

  // 5.8 Command: Nhập Bundle từ máy khác
  context.subscriptions.push(
    vscode.commands.registerCommand('antigravity-safe-switcher.importBundle', async () => {
      try {
        const uris = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectMany: false,
          filters: { 'JSON Files': ['json'] },
          openLabel: 'Nạp gói Profiles Bundle'
        });
        if (uris && uris.length > 0) {
          const raw = fs.readFileSync(uris[0].fsPath, 'utf8');
          const bundle = JSON.parse(raw);
          const res = await profileManager.importProfilesBundle(bundle);
          if (res.success) {
            vscode.window.showInformationMessage(res.message);
            updateStatusBar();
            if (dashboardProvider) dashboardProvider.updateDashboard();
          } else {
            vscode.window.showErrorMessage(res.message);
          }
        }
      } catch (err) {
        vscode.window.showErrorMessage(`Lỗi nạp Bundle: ${err.message}`);
      }
    })
  );

  // 6. Định kỳ kiểm tra Quota thật từ Language Server (Adaptive Polling: 45s khi Dashboard mở, 180s khi đóng để siêu nhẹ máy)
  let lastSyncTime = 0;
  checkInterval = setInterval(async () => {
    const isDashboardActive = typeof hasActiveWebviews === 'function' && hasActiveWebviews();
    const intervalNeeded = isDashboardActive ? 45000 : 180000;

    if (Date.now() - lastSyncTime < intervalNeeded) {
      return;
    }
    lastSyncTime = Date.now();

    await profileManager.syncCurrentLiveQuota();
    updateStatusBar();
    if (dashboardProvider && isDashboardActive) {
      dashboardProvider.updateDashboard();
    }
    await profileManager.checkAndAutoSwitch();
  }, 15000);
}

function updateStatusBar() {
  if (!statusBarItem || !profileManager) return;

  const active = profileManager.getActiveProfile();
  const isConfigured = Boolean(active && active.savedAt && active.email);

  if (!isConfigured) {
    statusBarItem.text = `$(account) Antigravity [Chưa đăng nhập]`;
    statusBarItem.tooltip = `Antigravity chưa có tài khoản đăng nhập hoặc đã đăng xuất.\nClick để kết nối tài khoản.`;
    statusBarItem.color = '#8b949e';
    statusBarItem.backgroundColor = undefined;
    return;
  }

  const fiveH = typeof active.fiveHourQuota === 'number'
    ? `${active.fiveHourQuota}%`
    : (typeof active.flashQuota === 'number' ? `${active.flashQuota}%` : '—');
  const weekly = typeof active.weeklyQuota === 'number'
    ? `${active.weeklyQuota}%`
    : (typeof active.proQuota === 'number' ? `${active.proQuota}%` : '—');
  const claude = typeof active.claudeQuota === 'number' ? `${active.claudeQuota}%` : '—';
  const credits = (active.promptCredits !== undefined && active.promptCredits !== null) ? active.promptCredits : '—';

  statusBarItem.text = `$(account) ${active.name.split(' ')[0]} [5h: ${fiveH} | Wk: ${weekly}]`;
  statusBarItem.tooltip = `${active.name} (${active.email})\nGói: ${active.tier || 'Google AI'} (${active.planName || 'Pro'})\nHạn mức 5 Giờ: ${fiveH}\nHạn mức Tuần: ${weekly}\nClaude / Đối tác: ${claude}\nCredits: ${credits} Prompt Credits\nClick để chuyển đổi tài khoản (Tự động bảo toàn Tab)`;

  let critThreshold = 10;
  let warnThreshold = 15;
  try {
    const cfg = vscode.workspace.getConfiguration('antigravitySafeSwitcher');
    critThreshold = cfg.get('criticalThreshold', 10);
    warnThreshold = cfg.get('warningThreshold', 15);
  } catch (e) {}

  const mainQuota = typeof active.fiveHourQuota === 'number'
    ? active.fiveHourQuota
    : (typeof active.flashQuota === 'number' ? active.flashQuota : null);

  if (mainQuota === null) {
    statusBarItem.color = '#8b949e';
    statusBarItem.backgroundColor = undefined;
  } else if (mainQuota <= critThreshold) {
    statusBarItem.color = '#f85149';
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
  } else if (mainQuota <= warnThreshold) {
    statusBarItem.color = '#d29922';
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  } else {
    statusBarItem.color = '#3fb950';
    statusBarItem.backgroundColor = undefined;
  }
}

function deactivate() {
  if (checkInterval) {
    clearInterval(checkInterval);
  }
}

module.exports = {
  activate,
  deactivate
};
