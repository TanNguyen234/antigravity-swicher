(function () {
  const vscode = acquireVsCodeApi();

  const accountsGrid = document.getElementById('accountsGrid');
  const activeSlotIndicator = document.getElementById('activeSlotIndicator');
  const activeSlotText = document.getElementById('activeSlotText');
  const valActiveAccount = document.getElementById('valActiveAccount');
  const valActivePlan = document.getElementById('valActivePlan');
  const valFiveHourQuota = document.getElementById('valFiveHourQuota');
  const valFiveHourReset = document.getElementById('valFiveHourReset');
  const valWeeklyQuota = document.getElementById('valWeeklyQuota');
  const valWeeklyReset = document.getElementById('valWeeklyReset');
  const valCredits = document.getElementById('valCredits');
  const valLastSyncSub = document.getElementById('valLastSyncSub');
  const lastSyncedText = document.getElementById('lastSyncedText');

  // Stepper Elements
  const switchingStepper = document.getElementById('switchingStepper');
  const stepperProgressBar = document.getElementById('stepperProgressBar');
  const stepperHeadline = document.getElementById('stepperHeadline');
  const stepperPercent = document.getElementById('stepperPercent');
  const stepperMessage = document.getElementById('stepperMessage');
  const stepItems = [
    document.getElementById('step1'),
    document.getElementById('step2'),
    document.getElementById('step3'),
    document.getElementById('step4')
  ];

  // Header & System Action Buttons
  document.getElementById('btnRefresh').addEventListener('click', () => {
    vscode.postMessage({ command: 'refresh' });
  });

  document.getElementById('btnOpenTab').addEventListener('click', () => {
    vscode.postMessage({ command: 'openTab' });
  });

  document.getElementById('btnSaveCurrent').addEventListener('click', () => {
    vscode.postMessage({ command: 'saveCurrent' });
  });

  document.getElementById('btnLogoutCurrent').addEventListener('click', () => {
    vscode.postMessage({ command: 'logoutCurrent' });
  });

  document.getElementById('btnBackup').addEventListener('click', () => {
    vscode.postMessage({ command: 'backup' });
  });

  const btnSimulateLow = document.getElementById('btnSimulateLow');
  if (btnSimulateLow) {
    btnSimulateLow.addEventListener('click', () => {
      vscode.postMessage({ command: 'simulateLow' });
    });
  }

  let switchingSlot = null;
  let switchingProgressMsg = '';
  let liveCountdownInterval = null;
  let currentActiveSlotNum = null;

  // HTML Escape Helper
  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Quota display helper: 0 is 0%, null/undefined is unknown '—'
  function formatQuotaDisplay(val) {
    if (typeof val === 'number' && Number.isFinite(val)) return `${Math.round(val)}%`;
    return '—';
  }

  function getBarClass(val, thresholds) {
    if (typeof val !== 'number' || !Number.isFinite(val)) return 'fill-neutral';
    const crit = (thresholds && typeof thresholds.critical === 'number') ? thresholds.critical : 10;
    const warn = (thresholds && typeof thresholds.warning === 'number') ? thresholds.warning : 15;
    if (val <= crit) return 'fill-rose';
    if (val <= warn) return 'fill-amber';
    return 'fill-emerald';
  }

  function getQuotaColor(val, thresholds) {
    if (typeof val !== 'number' || !Number.isFinite(val)) return 'var(--text-muted)';
    const crit = (thresholds && typeof thresholds.critical === 'number') ? thresholds.critical : 10;
    const warn = (thresholds && typeof thresholds.warning === 'number') ? thresholds.warning : 15;
    if (val <= crit) return 'var(--color-danger)';
    if (val <= warn) return 'var(--color-warning)';
    return 'inherit';
  }

  function formatSyncTime(isoStr) {
    if (!isoStr) return 'Chưa đồng bộ';
    try {
      const d = new Date(isoStr);
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch (e) {
      return isoStr;
    }
  }

  function formatTimeRemaining(resetTimeStr) {
    if (!resetTimeStr) return 'Không rõ';
    const diff = new Date(resetTimeStr).getTime() - Date.now();
    if (diff <= 0) return 'Đang đồng bộ';
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((diff % (1000 * 60)) / 1000);
    if (hours > 24) {
      const days = Math.floor(hours / 24);
      return `${days}d ${hours % 24}h`;
    }
    return `${hours}h ${minutes}m ${seconds.toString().padStart(2, '0')}s`;
  }

  // Visibility Optimization: Dừng interval khi tab/panel bị ẩn để tiết kiệm 100% CPU
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (liveCountdownInterval) {
        clearInterval(liveCountdownInterval);
        liveCountdownInterval = null;
      }
    } else {
      startLiveCountdown();
    }
  });

  // Lắng nghe dữ liệu từ extension host
  window.addEventListener('message', event => {
    const message = event.data;
    if (message && message.type === 'updateData') {
      renderDashboard(message.data);
    } else if (message && message.type === 'switchingProgress') {
      switchingSlot = message.slot;
      switchingProgressMsg = message.message || 'Đang xử lý...';
      updateSwitchingStepper(message.slot, message.step || 0, switchingProgressMsg);
    } else if (message && message.type === 'switchResult') {
      if (message.success) {
        completeSwitchingStepper(message.message);
      } else {
        failSwitchingStepper(message.message);
      }
      switchingSlot = null;
      switchingProgressMsg = '';
    }
  });

  function updateSwitchingStepper(slot, step, message) {
    if (!switchingStepper) return;
    switchingStepper.style.display = 'block';

    if (stepperHeadline) {
      stepperHeadline.textContent = `Đang chuyển đổi sang Slot ${slot}...`;
    }
    if (stepperMessage) {
      stepperMessage.textContent = message;
    }

    let percent = 15;
    if (step === 1) percent = 25;
    else if (step === 2) percent = 50;
    else if (step === 3) percent = 75;
    else if (step >= 4) percent = 92;

    if (stepperProgressBar) {
      stepperProgressBar.style.width = percent + '%';
      stepperProgressBar.style.background = 'linear-gradient(90deg, #d29922, #3fb950)';
    }
    if (stepperPercent) {
      stepperPercent.textContent = percent + '%';
    }

    stepItems.forEach((el, idx) => {
      if (!el) return;
      el.classList.remove('is-active', 'is-done');
      if (idx + 1 < step) {
        el.classList.add('is-done');
      } else if (idx + 1 === step) {
        el.classList.add('is-active');
      }
    });

    if (activeSlotText) {
      activeSlotText.textContent = `Đang chuyển sang Slot ${slot}...`;
    }
  }

  function completeSwitchingStepper(msg) {
    if (!switchingStepper) return;
    if (stepperProgressBar) {
      stepperProgressBar.style.width = '100%';
      stepperProgressBar.style.background = 'linear-gradient(90deg, #10b981, #34d399)';
    }
    if (stepperPercent) stepperPercent.textContent = '100%';
    if (stepperMessage) stepperMessage.textContent = msg || 'Hoàn tất chuyển đổi!';
    stepItems.forEach(el => el && el.classList.add('is-done'));

    setTimeout(() => {
      switchingStepper.style.display = 'none';
    }, 1400);
  }

  function failSwitchingStepper(errMsg) {
    if (!switchingStepper) return;
    if (stepperHeadline) stepperHeadline.textContent = 'Chuyển đổi không thành công';
    if (stepperProgressBar) {
      stepperProgressBar.style.width = '100%';
      stepperProgressBar.style.background = 'var(--color-danger)';
    }
    if (stepperPercent) stepperPercent.textContent = 'Lỗi';
    if (stepperMessage) stepperMessage.textContent = errMsg || 'Đã bảo toàn tài khoản ban đầu.';
    stepItems.forEach(el => el && el.classList.remove('is-active', 'is-done'));

    if (activeSlotText && currentActiveSlotNum) {
      activeSlotText.textContent = `Slot ${currentActiveSlotNum} Đang hoạt động`;
    }

    setTimeout(() => {
      switchingStepper.style.display = 'none';
      if (stepperProgressBar) {
        stepperProgressBar.style.background = 'linear-gradient(90deg, #d29922, #3fb950)';
      }
    }, 3000);
  }

  function startLiveCountdown() {
    if (liveCountdownInterval) clearInterval(liveCountdownInterval);
    liveCountdownInterval = setInterval(() => {
      if (document.hidden) return;

      document.querySelectorAll('[data-reset-time]').forEach(el => {
        const timeStr = el.getAttribute('data-reset-time');
        if (!timeStr) {
          el.textContent = 'Không rõ';
          el.style.color = 'var(--text-muted)';
          return;
        }
        const diff = new Date(timeStr).getTime() - Date.now();
        if (diff <= 0) {
          el.textContent = 'Đang đồng bộ';
          el.style.color = 'var(--text-muted)';
        } else {
          const hours = Math.floor(diff / (1000 * 60 * 60));
          const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
          const seconds = Math.floor((diff % (1000 * 60)) / 1000);
          if (hours > 24) {
            const days = Math.floor(hours / 24);
            el.textContent = `${days}d ${hours % 24}h`;
          } else {
            el.textContent = `${hours}h ${minutes}m ${seconds.toString().padStart(2, '0')}s`;
          }
          el.style.color = '';
        }
      });
    }, 1000);
  }

  function renderDashboard(data) {
    if (!data || !Array.isArray(data.profiles)) return;

    currentActiveSlotNum = data.activeSlot;
    const isAuth = Boolean(data.sessionAuthenticated);
    const activeProfile = data.profiles.find(p => p.slot === data.activeSlot) || data.profiles[0];

    // Platform Keycap (Cmd vs Ctrl)
    const keyModifier = document.getElementById('keyModifier');
    if (keyModifier) {
      const isMac = (data && data.platform === 'darwin') ||
                    (navigator.platform && navigator.platform.toUpperCase().indexOf('MAC') >= 0);
      keyModifier.textContent = isMac ? 'Cmd' : 'Ctrl';
    }

    // Dynamic Slot Count Titles
    const headlineSlotCount = document.getElementById('headlineSlotCount');
    const badgeSlotCount = document.getElementById('badgeSlotCount');
    const numSlots = data.profiles.length;
    if (headlineSlotCount) headlineSlotCount.textContent = `${numSlots} TÀI KHOẢN GOOGLE`;
    if (badgeSlotCount) badgeSlotCount.textContent = `${numSlots} Slots`;

    // Test Auto-Switch Visibility
    if (btnSimulateLow) {
      btnSimulateLow.style.display = data.isDevelopment ? 'inline-flex' : 'none';
    }

    // Active Slot Indicator Text: Phân biệt rõ phiên đăng nhập với cấu hình slot đã lưu
    const hasConfigured = data.profiles.some(p => p.savedAt && p.email);
    if (activeSlotText) {
      if (!isAuth || !hasConfigured) {
        activeSlotText.textContent = 'Chưa đăng nhập';
        if (activeSlotIndicator) {
          const dot = activeSlotIndicator.querySelector('.status-indicator-dot');
          if (dot) dot.style.background = '#8b949e';
        }
      } else {
        activeSlotText.textContent = `Slot ${data.activeSlot} Đang hoạt động`;
        if (activeSlotIndicator) {
          const dot = activeSlotIndicator.querySelector('.status-indicator-dot');
          if (dot) dot.style.background = 'var(--color-success)';
        }
      }
    }

    // Top 4-Metric Real Observed Stats Bar
    if (valActiveAccount) {
      if (isAuth && activeProfile && activeProfile.email) {
        valActiveAccount.textContent = activeProfile.name || activeProfile.email;
        valActiveAccount.title = activeProfile.email;
      } else {
        valActiveAccount.textContent = 'Chưa đăng nhập';
        valActiveAccount.title = '';
      }
    }
    if (valActivePlan) {
      if (isAuth && activeProfile && activeProfile.email) {
        valActivePlan.textContent = activeProfile.planName || activeProfile.tier || 'Google AI';
      } else {
        valActivePlan.textContent = 'Chưa kết nối phiên';
      }
    }
    if (valFiveHourQuota) {
      const q5h = activeProfile ? (activeProfile.fiveHourQuota ?? activeProfile.flashQuota ?? null) : null;
      valFiveHourQuota.textContent = formatQuotaDisplay(q5h);
    }
    if (valFiveHourReset) {
      const r5h = activeProfile ? (activeProfile.fiveHourResetTime ?? activeProfile.resetTime) : null;
      if (r5h) {
        valFiveHourReset.textContent = 'Hồi sau ' + formatTimeRemaining(r5h);
      } else {
        valFiveHourReset.textContent = 'Không rõ';
      }
    }
    if (valWeeklyQuota) {
      const qWk = activeProfile ? (activeProfile.weeklyQuota ?? activeProfile.proQuota ?? null) : null;
      valWeeklyQuota.textContent = formatQuotaDisplay(qWk);
    }
    if (valWeeklyReset) {
      if (activeProfile && activeProfile.weeklyResetTime) {
        valWeeklyReset.textContent = 'Hồi sau ' + formatTimeRemaining(activeProfile.weeklyResetTime);
      } else {
        valWeeklyReset.textContent = 'Không rõ';
      }
    }
    if (valCredits) {
      const cr = activeProfile ? activeProfile.promptCredits : null;
      valCredits.textContent = (typeof cr === 'number' && Number.isFinite(cr)) ? `${cr}` : 'N/A';
    }
    if (valLastSyncSub) {
      valLastSyncSub.textContent = data.lastSyncedAt ? `Cập nhật: ${formatSyncTime(data.lastSyncedAt)}` : 'Chưa đồng bộ';
    }
    if (lastSyncedText) {
      lastSyncedText.textContent = data.lastSyncedAt ? `Cập nhật: ${formatSyncTime(data.lastSyncedAt)}` : 'Live RPC';
    }

    // Render Account Profile Cards
    accountsGrid.innerHTML = '';
    const isSessionAuth = Boolean(data.sessionAuthenticated);
    data.profiles.forEach(p => {
      const isCurrent = isSessionAuth && (p.slot === data.activeSlot);
      const isConfigured = Boolean(p.savedAt && p.email);
      const card = document.createElement('div');
      const safeSlot = escapeHtml(p.slot);

      if (!isConfigured) {
        // Render thẻ SLOT TRỐNG
        card.className = 'account-card is-empty';
        card.innerHTML = `
          <div>
            <div class="card-top">
              <span class="slot-tag">SLOT #${safeSlot}</span>
              <span class="status-pill status-empty">Trống</span>
            </div>

            <div class="account-name-row">
              <div class="account-name" style="color: var(--text-muted);">[#${safeSlot}] Slot Trống</div>
            </div>

            <div class="empty-slot-placeholder">
              <div class="empty-icon">
                <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                  <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
                </svg>
              </div>
              <div class="empty-text-title">Chưa liên kết tài khoản</div>
              <div class="empty-text-desc">Đăng nhập tài khoản Google để luân phiên Quota tự động khi cạn dung lượng.</div>
            </div>
          </div>

          <div class="card-actions-bar">
            <button class="btn btn-sm btn-primary" data-action="login" data-slot="${safeSlot}" style="flex: 1;" title="Đăng nhập tài khoản Google mới vào Slot này">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"></path><polyline points="10 17 15 12 10 7"></polyline><line x1="15" y1="12" x2="3" y2="12"></line></svg>
              Đăng nhập mới
            </button>
            <button class="btn btn-sm btn-secondary" data-action="save" data-slot="${safeSlot}" title="Gán tài khoản đang dùng hiện tại vào Slot này">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path></svg>
              Gán phiên này
            </button>
            <button class="btn btn-sm btn-ghost" data-action="delete" data-slot="${safeSlot}" title="Làm sạch dữ liệu Slot này">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
            </button>
          </div>
        `;
      } else {
        // Render thẻ ĐÃ CÓ TÀI KHOẢN
        card.className = `account-card ${isCurrent ? 'is-active' : ''}`;
        const isExpiring = p.tokenExpiry && p.tokenExpiry.isExpiring;

        const safeName = escapeHtml(p.name);
        const safeEmail = escapeHtml(p.email);
        const rawPlan = p.planName ? `${p.planName}` : (p.tier || 'Google AI');
        const safePlan = escapeHtml(rawPlan);

        const q5h = p.fiveHourQuota ?? p.flashQuota ?? null;
        const q5hReset = p.fiveHourResetTime ?? p.resetTime;
        const qWk = p.weeklyQuota ?? p.proQuota ?? null;
        const qWkReset = p.weeklyResetTime;
        const qClaude = p.claudeQuota ?? null;

        const q5hWidth = (typeof q5h === 'number' && Number.isFinite(q5h)) ? Math.max(0, Math.min(100, q5h)) : 0;
        const qWkWidth = (typeof qWk === 'number' && Number.isFinite(qWk)) ? Math.max(0, Math.min(100, qWk)) : 0;
        const qClaudeWidth = (typeof qClaude === 'number' && Number.isFinite(qClaude)) ? Math.max(0, Math.min(100, qClaude)) : 0;

        const q5hDisp = formatQuotaDisplay(q5h);
        const qWkDisp = formatQuotaDisplay(qWk);
        const qClaudeDisp = formatQuotaDisplay(qClaude);

        const q5hColor = getQuotaColor(q5h, data.thresholds);
        const qWkColor = getQuotaColor(qWk, data.thresholds);
        const qClaudeColor = getQuotaColor(qClaude, data.thresholds);

        const q5hBarClass = getBarClass(q5h, data.thresholds);
        const qWkBarClass = getBarClass(qWk, data.thresholds);
        const qClaudeBarClass = getBarClass(qClaude, data.thresholds);

        card.innerHTML = `
          <div>
            <div class="card-top">
              <span class="slot-tag">SLOT #${safeSlot}</span>
              ${isCurrent 
                ? '<span class="status-pill status-active">Đang dùng</span>' 
                : '<span class="status-pill status-standby">Sẵn sàng</span>'
              }
            </div>

            <div class="account-name-row">
              <div class="account-name" title="${safeName}">[#${safeSlot}] ${safeName}</div>
              <button class="btn-icon-rename" data-action="rename" data-slot="${safeSlot}" title="Đổi tên gợi nhớ cho Slot ${safeSlot}">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
              </button>
            </div>

            <div class="account-email-row">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path><polyline points="22,6 12,13 2,6"></polyline></svg>
              <span class="account-email-text">${safeEmail}</span>
            </div>

            <div class="meta-badges-row">
              <span class="tier-badge">${safePlan}</span>
              ${(p.promptCredits !== undefined && p.promptCredits !== null) ? `<span class="credits-badge" title="Prompt Credits còn lại">⚡ ${escapeHtml(p.promptCredits)} Credits</span>` : ''}
              ${isExpiring ? '<span style="color: #f85149; font-size: 9.5px;" title="Token sắp hết hạn">⚠️ Token sắp hết hạn</span>' : ''}
            </div>

            <div class="quota-bars-container">
              <!-- Bucket 1: 5-Hour Rolling Limit (Gemini 5h) -->
              <div class="quota-item">
                <div class="quota-item-header">
                  <span class="quota-item-title">Gemini — 5h</span>
                  <span class="quota-val-text" style="color: ${q5hColor};">${q5hDisp}</span>
                </div>
                <div class="quota-track">
                  <div class="quota-fill ${q5hBarClass}" style="width: ${q5hWidth}%;"></div>
                </div>
                <div class="quota-sub-meta">
                  <span>Hạn mức 5h cuốn chiếu</span>
                  <span data-reset-time="${escapeHtml(q5hReset || '')}">${formatTimeRemaining(q5hReset)}</span>
                </div>
              </div>

              <!-- Bucket 2: Weekly Allocation (Gemini Weekly) -->
              <div class="quota-item">
                <div class="quota-item-header">
                  <span class="quota-item-title">Gemini — Weekly</span>
                  <span class="quota-val-text" style="color: ${qWkColor};">${qWkDisp}</span>
                </div>
                <div class="quota-track">
                  <div class="quota-fill ${qWkBarClass}" style="width: ${qWkWidth}%;"></div>
                </div>
                <div class="quota-sub-meta">
                  <span>Hạn mức Tuần cố định</span>
                  <span data-reset-time="${escapeHtml(qWkReset || '')}">${formatTimeRemaining(qWkReset)}</span>
                </div>
              </div>

              <!-- Bucket 3: Claude & Partner Models -->
              <div class="quota-item">
                <div class="quota-item-header">
                  <span class="quota-item-title">Partner Models</span>
                  <span class="quota-val-text" style="color: ${qClaudeColor};">${qClaudeDisp}</span>
                </div>
                <div class="quota-track">
                  <div class="quota-fill ${qClaudeBarClass}" style="width: ${qClaudeWidth}%;"></div>
                </div>
                <div class="quota-sub-meta">
                  <span>Mô hình đối tác</span>
                  <span>Đồng bộ theo phiên</span>
                </div>
              </div>
            </div>
          </div>

          <div class="card-actions-bar">
            ${isCurrent
              ? `
                <button class="btn btn-sm btn-disabled" disabled style="flex: 1;">✓ Đang hoạt động</button>
                <button class="btn btn-sm btn-warning" data-action="logout" data-slot="${safeSlot}" title="Đăng xuất phiên hiện tại">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line></svg>
                </button>
                <button class="btn btn-sm btn-danger-outline" data-action="delete" data-slot="${safeSlot}" title="Xóa tài khoản khỏi Slot">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                </button>
              `
              : `
                <button class="btn btn-sm btn-primary" data-action="switch" data-slot="${safeSlot}" style="flex: 1;" title="Chuyển ngay sang tài khoản này (Bảo toàn Tab code & Khung Chat)">
                  ⚡ Chuyển ngay
                </button>
                <button class="btn btn-sm btn-danger-outline" data-action="delete" data-slot="${safeSlot}" title="Xóa tài khoản khỏi Slot">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                </button>
              `
            }
          </div>
        `;
      }

      accountsGrid.appendChild(card);
    });

    startLiveCountdown();

    // Event Delegation: click trên bất kỳ nút nào trong accountsGrid
    accountsGrid.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const action = btn.getAttribute('data-action');
        const slot = parseInt(btn.getAttribute('data-slot'), 10);

        if (action === 'rename') {
          vscode.postMessage({ command: 'renameSlot', slot: slot });
        } else if (action === 'login') {
          btn.innerHTML = `<span class="spinner-dot"></span> Chờ đăng nhập...`;
          btn.classList.add('btn-disabled');
          vscode.postMessage({ command: 'loginNew', slot: slot });
        } else if (action === 'switch') {
          switchingSlot = slot;
          updateSwitchingStepper(slot, 1, 'Đang lưu tab code & chuẩn bị chuyển tài khoản...');
          vscode.postMessage({ command: 'switch', slot: slot });
        } else if (action === 'save') {
          vscode.postMessage({ command: 'bindSlot', slot: slot });
        } else if (action === 'logout') {
          vscode.postMessage({ command: 'logoutCurrent' });
        } else if (action === 'delete') {
          vscode.postMessage({ command: 'deleteSlot', slot: slot });
        }
      });
    });
  }

  // Khởi động gửi yêu cầu lấy dữ liệu lần đầu
  vscode.postMessage({ command: 'refresh' });
})();

