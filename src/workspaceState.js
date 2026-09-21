let vscode;
try {
  vscode = require('vscode');
} catch (e) {
  vscode = null;
}
const fs = require('fs');
const path = require('path');

let customStateDir = null;

function setStateStorageDir(dir) {
  customStateDir = dir;
}

function getStateFilePath(storageDir = null) {
  const dir = storageDir || customStateDir;
  if (dir) {
    if (!fs.existsSync(dir)) {
      try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    }
    return path.join(dir, 'pending_workspace_state.json');
  }
  return path.join(__dirname, '..', 'pending_workspace_state.json');
}

/**
 * Kiểm tra xem có tài liệu nào đang soạn thảo chưa được lưu không
 */
function hasDirtyDocuments() {
  if (vscode && vscode.workspace && Array.isArray(vscode.workspace.textDocuments)) {
    return vscode.workspace.textDocuments.some(doc => doc.isDirty);
  }
  return false;
}

/**
 * Ghi nhớ toàn bộ workspace: các file tab đang mở, view column và vị trí con trỏ chuột
 */
async function saveWorkspaceState(storageDir = null) {
  try {
    const targetFile = getStateFilePath(storageDir);
    // Tự động lưu các file đang chỉnh sửa nếu người dùng bật cấu hình
    if (hasDirtyDocuments()) {
      try {
        await vscode.workspace.saveAll(false);
      } catch (e) {
        console.warn('[SafeSwitcher] Cảnh báo lưu file trước khi reload:', e.message);
      }
    }

    const state = {
      timestamp: Date.now(),
      openEditors: [],
      activeEditorUri: null,
      activePosition: null
    };

    if (vscode && vscode.window && vscode.window.tabGroups && vscode.window.tabGroups.all) {
      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
          if (tab.input && tab.input.uri) {
            state.openEditors.push({
              uri: tab.input.uri.toString(),
              viewColumn: group.viewColumn || 1,
              isActive: vscode.window.tabGroups.activeTabGroup === group && group.activeTab === tab
            });
          }
        }
      }
    }

    const activeEditor = vscode && vscode.window && vscode.window.activeTextEditor;
    if (activeEditor) {
      state.activeEditorUri = activeEditor.document.uri.toString();
      state.activePosition = {
        line: activeEditor.selection.active.line,
        character: activeEditor.selection.active.character
      };
    }

    fs.writeFileSync(targetFile, JSON.stringify(state, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('[SafeSwitcher] Lỗi khi lưu workspace state:', err);
    return false;
  }
}

/**
 * Khôi phục lại toàn bộ tabs và vị trí con trỏ chuột sau khi reload window
 */
async function restoreWorkspaceState(storageDir = null) {
  try {
    const targetFile = getStateFilePath(storageDir);
    let resolvedFile = null;

    if (fs.existsSync(targetFile)) {
      resolvedFile = targetFile;
    } else {
      const fallbackFile = path.join(__dirname, '..', 'pending_workspace_state.json');
      if (fs.existsSync(fallbackFile)) {
        resolvedFile = fallbackFile;
      }
    }

    if (!resolvedFile) {
      return;
    }

    const raw = fs.readFileSync(resolvedFile, 'utf8');
    try { fs.unlinkSync(resolvedFile); } catch (e) {} // Xóa file ngay sau khi đọc để tránh lặp lại

    const state = JSON.parse(raw);
    // Nếu trạng thái quá 5 phút thì bỏ qua (tránh restore trạng thái cũ)
    if (Date.now() - state.timestamp > 5 * 60 * 1000) {
      return;
    }

    if (state.openEditors && state.openEditors.length > 0) {
      for (const item of state.openEditors) {
        try {
          const docUri = vscode.Uri.parse(item.uri);
          const doc = await vscode.workspace.openTextDocument(docUri);
          const editor = await vscode.window.showTextDocument(doc, {
            viewColumn: item.viewColumn || 1,
            preview: false,
            preserveFocus: !item.isActive
          });

          // Phục hồi vị trí con trỏ nếu là active editor
          if (item.isActive && state.activePosition) {
            const pos = new vscode.Position(state.activePosition.line, state.activePosition.character);
            editor.selection = new vscode.Selection(pos, pos);
            editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
          }
        } catch (e) {
          console.warn('[SafeSwitcher] Không thể mở lại file:', item.uri, e.message);
        }
      }
    }
  } catch (err) {
    console.error('[SafeSwitcher] Lỗi khi khôi phục workspace state:', err);
  }
}

module.exports = {
  hasDirtyDocuments,
  saveWorkspaceState,
  restoreWorkspaceState,
  setStateStorageDir,
  getStateFilePath
};

