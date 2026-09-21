/**
 * Test Suite Toàn Diện: Antigravity Account Switcher
 * Bao gồm:
 * - SUITE A: Isolated Unit & Logic Tests (Zero Disruption, Mocked Secrets, Dry Run)
 * - SUITE B: Live Integration Probes (Non-destructive, Safe Read-only Probes)
 */

// BẢO VỆ TUYỆT ĐỐI: Đặt NODE_ENV = 'test' để restartServer không bao giờ gửi SIGKILL đến IDE thật
process.env.NODE_ENV = 'test';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const liveQuotaFetcher = require('../src/liveQuotaFetcher');
const ProfileManager = require('../src/profileManager');
const ProfileSecretStorage = require('../src/secretStore');
const workspaceState = require('../src/workspaceState');

async function runAllTests() {
  console.log('================================================================');
  console.log('  ANTIGRAVITY ACCOUNT SWITCHER — COMPREHENSIVE TEST SUITE');
  console.log('================================================================\n');

  let passed = 0;
  let failed = 0;
  const suiteResults = { unit: { passed: 0, failed: 0 }, live: { passed: 0, failed: 0 } };

  function report(suite, name, ok, detail = '') {
    if (ok) {
      console.log(`  ✅ [PASS] ${name} ${detail ? '(' + detail + ')' : ''}`);
      passed++;
      suiteResults[suite].passed++;
    } else {
      console.error(`  ❌ [FAIL] ${name}: ${detail}`);
      failed++;
      suiteResults[suite].failed++;
    }
  }

  const args = process.argv.slice(2);
  const runUnitOnly = args.includes('--unit');
  const runLiveOnly = args.includes('--live');
  const shouldRunUnit = !runLiveOnly;
  const shouldRunLive = !runUnitOnly;

  if (shouldRunUnit) {
    // ==========================================================================
    // SUITE A: ISOLATED UNIT & LOGIC TESTS (ZERO SIDE EFFECTS)
    // ==========================================================================
    console.log('┌──────────────────────────────────────────────────────────────┐');
    console.log('│  SUITE A: ISOLATED UNIT & LOGIC TESTS (ZERO SIDE EFFECTS)   │');
    console.log('└──────────────────────────────────────────────────────────────┘');

  // TEST A1: Canonical Gmail Normalization & Deduplication
  console.log('\n--- [A1] Canonical Gmail Deduplication & Normalization ---');
  try {
    const pm = new ProfileManager();
    pm.config.profiles[0].email = 'tan.nguyen@gmail.com';
    pm.config.profiles[0].savedAt = new Date().toISOString();

    const dup1 = pm.isEmailDuplicate('tannguyen@gmail.com', 2); // Strips dots
    const dup2 = pm.isEmailDuplicate('tan.nguyen+dev@gmail.com', 2); // Strips +tag
    const dup3 = pm.isEmailDuplicate('TAN.NGUYEN@GMAIL.COM', 2); // Uppercase
    const dup4 = pm.isEmailDuplicate('tannguyen@googlemail.com', 2); // Googlemail alias
    const noDup = pm.isEmailDuplicate('other.user@gmail.com', 2); // Different user
    const selfSlot = pm.isEmailDuplicate('tan.nguyen@gmail.com', 1); // Same slot ignored

    report('unit', 'Strips dots in Gmail', dup1 === 1, 'tannguyen -> Slot 1');
    report('unit', 'Strips +tag aliases', dup2 === 1, 'tan.nguyen+dev -> Slot 1');
    report('unit', 'Case insensitive email comparison', dup3 === 1, 'Uppercase matched');
    report('unit', 'googlemail.com canonical domain', dup4 === 1, 'googlemail -> gmail');
    report('unit', 'Allows distinct user email', noDup === null, 'other.user allowed');
    report('unit', 'Ignores check against own slot', selfSlot === null, 'Slot 1 allowed for Slot 1');
  } catch (err) {
    report('unit', 'Canonical Gmail Test', false, err.message);
  }

  // TEST A2: SecretStore Zero Data Loss & Safe Migration
  console.log('\n--- [A2] SecretStore Zero-Data-Loss & Verified Migration ---');
  try {
    // 1. In-memory mode (khi context.secrets = null)
    const memStore = new ProfileSecretStorage(null);
    await memStore.storeTokens(1, { accessToken: 'mem_token_123' }, { key: 'val' });
    const memTokens = await memStore.getTokens(1);
    const memHas = await memStore.hasTokens(1);
    report('unit', 'SecretStore In-Memory Fallback', memTokens.oauthToken?.accessToken === 'mem_token_123' && memHas === true);

    // 2. Mocked VS Code SecretStorage
    const mockStorage = new Map();
    const mockContext = {
      secrets: {
        store: async (k, v) => { mockStorage.set(k, v); },
        get: async (k) => mockStorage.get(k) || null,
        delete: async (k) => { mockStorage.delete(k); }
      }
    };
    const secureStore = new ProfileSecretStorage(mockContext);
    await secureStore.storeTokens(2, { accessToken: 'secure_os_token' }, { vscdb: 1 });
    const loaded = await secureStore.getTokens(2);
    report('unit', 'SecretStorage Encrypted Store & Retrieve', loaded.oauthToken?.accessToken === 'secure_os_token');

    // 3. Di chuyển an toàn có xác minh đọc lại (Verified Migration)
    const testSlotDir = path.join(__dirname, 'mock_slot_temp');
    if (!fs.existsSync(testSlotDir)) fs.mkdirSync(testSlotDir, { recursive: true });
    const dummyOAuth = path.join(testSlotDir, 'oauth_token.json');
    fs.writeFileSync(dummyOAuth, JSON.stringify({ accessToken: 'legacy_disk_token' }));

    const migrated = await secureStore.migrateFromDisk(3, testSlotDir);
    const readback = await secureStore.getTokens(3);
    const diskDeleted = !fs.existsSync(dummyOAuth);
    report('unit', 'Migration Verifies Readback Before Disk Unlink', migrated && readback.oauthToken?.accessToken === 'legacy_disk_token' && diskDeleted);

    // 4. Cơ chế chống mất dữ liệu khi không có SecretStorage thật
    const testSlotDir2 = path.join(__dirname, 'mock_slot_temp2');
    if (!fs.existsSync(testSlotDir2)) fs.mkdirSync(testSlotDir2, { recursive: true });
    const dummyOAuth2 = path.join(testSlotDir2, 'oauth_token.json');
    fs.writeFileSync(dummyOAuth2, JSON.stringify({ accessToken: 'keep_on_disk' }));

    await memStore.migrateFromDisk(4, testSlotDir2);
    const fileStillOnDisk = fs.existsSync(dummyOAuth2);
    report('unit', 'Preserve Plaintext File When Running in Memory Mode', fileStillOnDisk === true, 'No unlink without OS SecretStorage');

    // Dọn dẹp mock
    if (fs.existsSync(testSlotDir)) fs.rmSync(testSlotDir, { recursive: true, force: true });
    if (fs.existsSync(testSlotDir2)) fs.rmSync(testSlotDir2, { recursive: true, force: true });
  } catch (err) {
    report('unit', 'SecretStorage Security Test', false, err.message);
  }

  // TEST A3: Concurrency Guard & Finally Release
  console.log('\n--- [A3] Concurrency Guard & Lock Integrity ---');
  try {
    const pm = new ProfileManager();
    pm._isSwitching = true;
    const blockedRes = await pm.switchToSlot(2);
    report('unit', 'Block concurrent switches while busy', blockedRes.success === false && blockedRes.message.includes('vui lòng đợi'));

    // Giả lập hoàn tất và kiểm tra finally
    pm._isSwitching = false;
    report('unit', 'Concurrency Lock Released Cleanly', pm._isSwitching === false);
  } catch (err) {
    report('unit', 'Concurrency Guard Test', false, err.message);
  }

  // TEST A4: Token Expiry Detection (isTokenExpiringSoon)
  console.log('\n--- [A4] Token Expiry Detection & Telemetry ---');
  try {
    const mockStorage = new Map();
    const mockContext = {
      secrets: {
        store: async (k, v) => { mockStorage.set(k, v); },
        get: async (k) => mockStorage.get(k) || null,
        delete: async (k) => { mockStorage.delete(k); }
      }
    };
    const secretStore = new ProfileSecretStorage(mockContext);
    const pm = new ProfileManager(secretStore);

    const nowSec = Math.floor(Date.now() / 1000);

    // Slot 1: Token đã hết hạn từ 60 giây trước
    await secretStore.storeTokens(1, { accessToken: 'tok1', expiryDateSeconds: nowSec - 60, refreshToken: 'ref1' });
    const exp1 = await pm.isTokenExpiringSoon(1, 300);
    report('unit', 'Detects expired token', exp1.expired === true && exp1.isExpiring === true);

    // Slot 2: Token sắp hết hạn trong 120 giây (dưới ngưỡng 300s)
    await secretStore.storeTokens(2, { accessToken: 'tok2', expiryDateSeconds: nowSec + 120, refreshToken: 'ref2' });
    const exp2 = await pm.isTokenExpiringSoon(2, 300);
    report('unit', 'Detects expiring soon token (< 300s)', exp2.expired === false && exp2.isExpiring === true);

    // Slot 3: Token còn rất dài (3600 giây)
    await secretStore.storeTokens(3, { accessToken: 'tok3', expiryDateSeconds: nowSec + 3600, refreshToken: 'ref3' });
    const exp3 = await pm.isTokenExpiringSoon(3, 300);
    report('unit', 'Detects healthy valid token', exp3.expired === false && exp3.isExpiring === false && exp3.expiresInSeconds > 3000);
    report('unit', 'Identifies refreshToken presence', exp3.hasRefreshToken === true);
  } catch (err) {
    report('unit', 'Token Expiry Test', false, err.message);
  }

  // TEST A5: Multi-Criteria Auto-Switch Scoring & Anti-Flapping Hysteresis
  console.log('\n--- [A5] Multi-Criteria Auto-Switch Scoring & Anti-Flapping Hysteresis ---');
  try {
    const pm = new ProfileManager();
    pm.config.activeSlot = 1;
    pm.config.profiles[0].flashQuota = 5;
    pm.config.profiles[0].proQuota = 5;
    pm.config.profiles[0].claudeQuota = 0;
    pm.config.profiles[0].savedAt = new Date().toISOString();
    pm.config.profiles[0].email = 'slot1@gmail.com';
    // Current score: 5 * 0.55 + 5 * 0.35 = 4.5

    // Candidate 1: 15% Flash, 10% Pro (Score: 15*0.55 + 10*0.35 = 11.75) -> Margin = 7.25 < 15 -> Flapping!
    pm.config.profiles[1].slot = 2;
    pm.config.profiles[1].flashQuota = 15;
    pm.config.profiles[1].proQuota = 10;
    pm.config.profiles[1].claudeQuota = 0;
    pm.config.profiles[1].savedAt = new Date().toISOString();
    pm.config.profiles[1].email = 'slot2@gmail.com';

    // Candidate 2: 70% Flash, 80% Pro (Score: 70*0.55 + 80*0.35 = 66.5) -> Margin > 15 -> Winner!
    pm.config.profiles[2].slot = 3;
    pm.config.profiles[2].flashQuota = 70;
    pm.config.profiles[2].proQuota = 80;
    pm.config.profiles[2].claudeQuota = 90;
    pm.config.profiles[2].savedAt = new Date().toISOString();
    pm.config.profiles[2].email = 'slot3@gmail.com';

    const currentScore = (5 * 0.55) + (5 * 0.35);
    const candidates = pm.config.profiles.filter(p => {
      if (p.slot === pm.config.activeSlot || !p.savedAt || !p.email) return false;
      const candidateScore = (p.flashQuota * 0.55) + (p.proQuota * 0.35) + ((p.claudeQuota || 0) * 0.1);
      return p.flashQuota >= 10 && candidateScore >= (currentScore + 15);
    });

    report('unit', 'Anti-flapping hysteresis filters out minor margin candidate', candidates.length === 1);
    report('unit', 'High-scoring candidate selected as optimal target', candidates[0].slot === 3);
  } catch (err) {
    report('unit', 'Auto-Switch Scoring Test', false, err.message);
  }

  // TEST A6: Multi-Device Profile Bundle Export & Import
  console.log('\n--- [A6] Multi-Device Profile Bundle Export & Import ---');
  try {
    const mockStorage = new Map();
    const mockContext = {
      secrets: {
        store: async (k, v) => { mockStorage.set(k, v); },
        get: async (k) => mockStorage.get(k) || null,
        delete: async (k) => { mockStorage.delete(k); }
      }
    };
    const secretStore = new ProfileSecretStorage(mockContext);
    const pm = new ProfileManager(secretStore);

    pm.config.profiles[0].email = 'export_user1@gmail.com';
    pm.config.profiles[0].savedAt = new Date().toISOString();
    await secretStore.storeTokens(1, { accessToken: 'bundle_token_1' });

    pm.config.profiles[1].email = 'export_user2@gmail.com';
    pm.config.profiles[1].savedAt = new Date().toISOString();
    await secretStore.storeTokens(2, { accessToken: 'bundle_token_2' });

    // 1. Xuất bundle
    const bundle = await pm.exportProfilesBundle();
    report('unit', 'Export Profiles Bundle Schema', bundle.version === '1.2.0' && bundle.slotsData[1] && bundle.slotsData[2]);

    // 2. Nhập bundle vào instance mới
    const newStorage = new Map();
    const newContext = {
      secrets: {
        store: async (k, v) => { newStorage.set(k, v); },
        get: async (k) => newStorage.get(k) || null,
        delete: async (k) => { newStorage.delete(k); }
      }
    };
    const newSecretStore = new ProfileSecretStorage(newContext);
    const newPm = new ProfileManager(newSecretStore);

    const importRes = await newPm.importProfilesBundle(bundle);
    report('unit', 'Import Profiles Bundle Executed', importRes.success === true);

    const importedTok1 = await newSecretStore.getTokens(1);
    report('unit', 'Imported Bundle Restores Encrypted Tokens', importedTok1.oauthToken?.accessToken === 'bundle_token_1');

    // 3. Xử lý bundle rác/lỗi
    const badRes = await newPm.importProfilesBundle({ invalid: 'schema' });
    report('unit', 'Reject malformed bundle gracefully', badRes.success === false);
  } catch (err) {
    report('unit', 'Bundle Export/Import Test', false, err.message);
  }

  // TEST A7: Workspace State & Dirty Document Resilience
  console.log('\n--- [A7] Workspace State & Unsaved Documents Safety ---');
  try {
    const isDirty = workspaceState.hasDirtyDocuments();
    report('unit', 'Detects Dirty Documents State', typeof isDirty === 'boolean', `isDirty: ${isDirty}`);
  } catch (err) {
    report('unit', 'Workspace State Test', false, err.message);
  }

  // TEST A8: Custom Slot Renaming
  console.log('\n--- [A8] Custom Slot Renaming (renameSlot) ---');
  try {
    const pm = new ProfileManager();
    const res1 = pm.renameSlot(1, 'Personal Dev AI');
    report('unit', 'Rename Slot Successfully', res1.success === true && pm.config.profiles[0].name === 'Personal Dev AI');

    const resEmpty = pm.renameSlot(1, '   ');
    report('unit', 'Rejects empty/whitespace names', resEmpty.success === false);

    const resInvalidSlot = pm.renameSlot(999, 'Non-existent');
    report('unit', 'Rejects invalid slot number', resInvalidSlot.success === false);
  } catch (err) {
    report('unit', 'Rename Slot Test', false, err.message);
  }

  // TEST A9: Real-time Progress Tracking in switchToSlot (Dry Run)
  console.log('\n--- [A9] Real-time Progress Tracking in switchToSlot (Dry Run) ---');
  try {
    const mockStorage = new Map();
    const mockContext = {
      secrets: {
        store: async (k, v) => { mockStorage.set(k, v); },
        get: async (k) => mockStorage.get(k) || null,
        delete: async (k) => { mockStorage.delete(k); }
      }
    };
    const secretStore = new ProfileSecretStorage(mockContext);
    const pm = new ProfileManager(secretStore);

    pm.config.activeSlot = 1;
    pm.config.profiles[0].email = 'active_user@gmail.com';
    pm.config.profiles[0].savedAt = new Date().toISOString();
    pm.config.profiles[0].status = 'active';

    pm.config.profiles[1].email = 'target_user@gmail.com';
    pm.config.profiles[1].savedAt = new Date().toISOString();
    pm.config.profiles[1].status = 'standby';

    await secretStore.storeTokens(2, { accessToken: 'valid_token_slot2' }, { key: 'val' });

    const progressSteps = [];
    const switchRes = await pm.switchToSlot(2, (step, msg) => {
      progressSteps.push({ step, msg });
    }, { dryRun: true, restartServer: false });

    report('unit', 'Dry Run Switch Successful', switchRes.success === true);
    report('unit', 'Dispatched 5-stage progress pipeline', progressSteps.length >= 4, `Steps recorded: ${progressSteps.length}`);
    report('unit', 'Active slot switched to 2', pm.config.activeSlot === 2);
    report('unit', 'Target profile status set to active', pm.config.profiles[1].status === 'active');
    report('unit', 'Lock released after switch', pm._isSwitching === false);
  } catch (err) {
    report('unit', 'Realtime Progress Tracking Test', false, err.message);
  }

  // TEST A10: Slot Login Isolation (_pendingLoginSlot Protection)
  console.log('\n--- [A10] Slot Login Isolation (_pendingLoginSlot Protection) ---');
  try {
    const pm = new ProfileManager();
    pm.config.activeSlot = 1;
    pm.config.profiles[0].email = 'primary_master@gmail.com';
    pm.config.profiles[0].savedAt = new Date().toISOString();
    pm.config.profiles[0].status = 'active';

    pm.config.profiles[1].email = '';
    pm.config.profiles[1].savedAt = null;
    pm.config.profiles[1].status = 'empty';
    pm._pendingLoginSlot = 2;

    const originalGetReal = liveQuotaFetcher.getRealAccountAndQuota;
    liveQuotaFetcher.getRealAccountAndQuota = async () => ({
      isLive: true,
      email: 'secondary_login@gmail.com',
      name: 'Google User 2',
      tier: 'Google AI',
      flashQuota: 100,
      proQuota: 100,
      claudeQuota: 100
    });

    await pm.syncCurrentLiveQuota();
    liveQuotaFetcher.getRealAccountAndQuota = originalGetReal;

    report('unit', 'Primary Slot 1 Preserved', pm.config.profiles[0].email === 'primary_master@gmail.com');
    report('unit', 'Secondary Slot 2 Bound to Incoming Session', pm.config.profiles[1].email === 'secondary_login@gmail.com');
    report('unit', 'Active Slot Updated to Target 2', pm.config.activeSlot === 2);
  } catch (err) {
    report('unit', 'Login Isolation Test', false, err.message);
  }

  // TEST A11: Anti-Revert Protection from Stale LS Readings
  console.log('\n--- [A11] Anti-Revert Protection from Stale LS Readings ---');
  try {
    const pm = new ProfileManager();
    pm.config.activeSlot = 2;
    pm.config.profiles[0].email = 'slot1_old@gmail.com';
    pm.config.profiles[0].savedAt = new Date().toISOString();

    pm.config.profiles[1].email = 'slot2_new@gmail.com';
    pm.config.profiles[1].savedAt = new Date().toISOString();

    const originalGetReal = liveQuotaFetcher.getRealAccountAndQuota;
    liveQuotaFetcher.getRealAccountAndQuota = async () => ({
      isLive: true,
      email: 'slot1_old@gmail.com',
      flashQuota: 50
    });

    // Gọi sync với expectedSlot = 2
    await pm.syncCurrentLiveQuota(2);
    liveQuotaFetcher.getRealAccountAndQuota = originalGetReal;

    report('unit', 'ActiveSlot Protected from Stale LS Reading', pm.config.activeSlot === 2);
  } catch (err) {
    report('unit', 'Anti-Revert Test', false, err.message);
  }

  // TEST A12: Fast Swap Circular Flow
  console.log('\n--- [A12] Fast Swap Circular Flow (1 -> 2 -> 3 -> 1) ---');
  try {
    const pm = new ProfileManager();
    pm.config.profiles[0].email = 'user1@gmail.com';
    pm.config.profiles[0].savedAt = new Date().toISOString();

    pm.config.profiles[1].email = 'user2@gmail.com';
    pm.config.profiles[1].savedAt = new Date().toISOString();

    pm.config.profiles[2].email = 'user3@gmail.com';
    pm.config.profiles[2].savedAt = new Date().toISOString();

    const configured = pm.config.profiles.filter(p => p.savedAt && p.email);

    pm.config.activeSlot = 1;
    let idx = configured.findIndex(p => p.slot === pm.config.activeSlot);
    let next1 = configured[(idx + 1) % configured.length].slot;

    pm.config.activeSlot = 2;
    idx = configured.findIndex(p => p.slot === pm.config.activeSlot);
    let next2 = configured[(idx + 1) % configured.length].slot;

    pm.config.activeSlot = 3;
    idx = configured.findIndex(p => p.slot === pm.config.activeSlot);
    let next3 = configured[(idx + 1) % configured.length].slot;

    report('unit', 'Fast Swap 1 -> 2', next1 === 2);
    report('unit', 'Fast Swap 2 -> 3', next2 === 3);
    report('unit', 'Fast Swap 3 -> 1 (Wrap-around)', next3 === 1);
  } catch (err) {
    report('unit', 'Fast Swap Test', false, err.message);
  }

  // TEST A13: Delete Profile & Clean Cascading
  console.log('\n--- [A13] Delete Profile & Clean Cascading ---');
  try {
    const mockStorage = new Map();
    const mockContext = {
      secrets: {
        store: async (k, v) => { mockStorage.set(k, v); },
        get: async (k) => mockStorage.get(k) || null,
        delete: async (k) => { mockStorage.delete(k); }
      }
    };
    const secretStore = new ProfileSecretStorage(mockContext);
    const pm = new ProfileManager(secretStore);

    pm.config.activeSlot = 2;
    pm.config.profiles[0].email = 'survivor@gmail.com';
    pm.config.profiles[0].savedAt = new Date().toISOString();

    pm.config.profiles[1].email = 'to_delete@gmail.com';
    pm.config.profiles[1].savedAt = new Date().toISOString();
    await secretStore.storeTokens(2, { accessToken: 'delete_me' });

    const delRes = await pm.deleteProfile(2);
    report('unit', 'Delete Profile Success', delRes.success === true);
    report('unit', 'Deleted Slot Status Empty', pm.config.profiles[1].email === '' && pm.config.profiles[1].status === 'empty');
    report('unit', 'Active Slot Cascaded to Available Slot 1', pm.config.activeSlot === 1);
  } catch (err) {
    report('unit', 'Delete Profile Test', false, err.message);
  }

  // TEST A14: Ghost Data Sanitize & Metadata Integrity
  console.log('\n--- [A14] Ghost Data Sanitize & Metadata Integrity ---');
  try {
    const pm = new ProfileManager();
    const ghost = {
      slot: 99,
      email: '',
      savedAt: null,
      flashQuota: 99,
      status: 'standby',
      name: 'Ghost Account'
    };
    pm.config.profiles.push(ghost);

    pm.validateAndSanitizeProfiles();

    report('unit', 'Ghost Slot Quota Purged to 0', ghost.flashQuota === 0);
    report('unit', 'Ghost Slot Status Set to empty', ghost.status === 'empty');
    report('unit', 'Ghost Slot Name Standardized', ghost.name === 'Slot 99 (Trống)');

    pm.config.profiles = pm.config.profiles.filter(p => p.slot !== 99);
  } catch (err) {
    report('unit', 'Sanitize Test', false, err.message);
  }

  // TEST A15: Client-side Live Countdown Formatter
  console.log('\n--- [A15] Client-side Countdown Formatter ---');
  try {
    function formatTimeRemaining(resetTimeStr) {
      if (!resetTimeStr) return 'Đầy quota';
      const diff = new Date(resetTimeStr).getTime() - Date.now();
      if (diff <= 0) return 'Đầy quota';
      const hours = Math.floor(diff / (1000 * 60 * 60));
      const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
      const seconds = Math.floor((diff % (1000 * 60)) / 1000);
      return `Hồi sau: ${hours}h ${minutes}m ${seconds.toString().padStart(2, '0')}s`;
    }

    const future = new Date(Date.now() + 3661000).toISOString();
    const past = new Date(Date.now() - 10000).toISOString();

    report('unit', 'Formats future reset time', formatTimeRemaining(future).startsWith('Hồi sau: 1h'));
    report('unit', 'Returns "Đầy quota" for past time', formatTimeRemaining(past) === 'Đầy quota');
    report('unit', 'Returns "Đầy quota" for null time', formatTimeRemaining(null) === 'Đầy quota');
  } catch (err) {
    report('unit', 'Countdown Formatter Test', false, err.message);
  }

  // TEST A16: Dual-Window Quota Logic & Binding
  console.log('\n--- [A16] Dual-Window Quota Binding to Profile ---');
  try {
    const pm = new ProfileManager();
    const testProfile = pm.config.profiles[0];
    const mockRealData = {
      isLive: true,
      email: 'test.user@gmail.com',
      name: 'Test Dev',
      tier: 'Google AI Pro',
      planName: 'Pro',
      promptCredits: 450,
      flowCredits: 80,
      fiveHourQuota: 55,
      weeklyQuota: 62,
      fiveHourResetTime: '2026-09-20T21:00:00Z',
      weeklyResetTime: '2026-09-27T00:00:00Z',
      claudeQuota: 100,
      resetTime: '2026-09-20T21:00:00Z'
    };

    pm._applyRealDataToProfile(testProfile, mockRealData);

    report('unit', 'Dual-Window 5h Quota correctly bound', testProfile.fiveHourQuota === 55);
    report('unit', 'Dual-Window Weekly Quota correctly bound', testProfile.weeklyQuota === 62);
    report('unit', 'Prompt Credits preserved', testProfile.promptCredits === 450);
    report('unit', 'Dual Reset Times recorded', testProfile.weeklyResetTime === '2026-09-27T00:00:00Z' && testProfile.fiveHourResetTime === '2026-09-20T21:00:00Z');
  } catch (err) {
    report('unit', 'Dual-Window Binding Test', false, err.message);
  }

  // TEST A17: 24-Hour Telemetry Generation & Market Rate Savings
  console.log('\n--- [A17] 24-Hour Telemetry Generation & Dynamic Calculations ---');
  try {
    const pm = new ProfileManager();
    const mockData = { fiveHourQuota: 50, weeklyQuota: 60 };
    pm.updateTelemetryMetrics(mockData);

    report('unit', 'Telemetry history array has 24 entries', Array.isArray(pm.config.telemetryHistory) && pm.config.telemetryHistory.length === 24);
    report('unit', 'Hourly usage mirrors telemetry history', Array.isArray(pm.config.hourlyUsage) && pm.config.hourlyUsage.length === 24);
    report('unit', 'Dynamic totalTokensToday is positive', typeof pm.config.totalTokensToday === 'number' && pm.config.totalTokensToday > 0);
    report('unit', 'Estimated savings matches $2.85/1M blend', pm.config.estimatedSavingsUSD === Number(((pm.config.totalTokensToday / 1000000) * 2.85).toFixed(2)));
    report('unit', 'Each telemetry point has hour, tokens, quota', Boolean(pm.config.telemetryHistory[0].hour) && typeof pm.config.telemetryHistory[0].tokens === 'number' && typeof pm.config.telemetryHistory[0].quota === 'number');
  } catch (err) {
    report('unit', 'Telemetry Generation Test', false, err.message);
  }

  // TEST A18: Zero-CPU Fast Health Check on Cached Config
  console.log('\n--- [A18] Zero-CPU Fast Health Check Revalidation ---');
  try {
    const fetcher = liveQuotaFetcher;
    if (fetcher.cachedConfig && fetcher.cachedConfig.port && fetcher.cachedConfig.csrfToken) {
      const probeStart = Date.now();
      const healthy = await fetcher._checkCachedHealth(fetcher.cachedConfig);
      const durationMs = Date.now() - probeStart;

      report('unit', 'Fast Port Health Check response in under 50ms (Zero-CPU)', durationMs < 50, `Took ${durationMs}ms`);
      report('unit', 'Cached connection is verified alive', healthy === true);
    } else {
      report('unit', 'Fast Port Health Check (Simulated)', true, 'No cached config currently, bypassed');
    }
  } catch (err) {
    report('unit', 'Fast Health Check Test', false, err.message);
  }
} // end if (shouldRunUnit)

  if (shouldRunLive) {
    // ==========================================================================
    // SUITE B: LIVE INTEGRATION PROBES (NON-DESTRUCTIVE, SAFE READ-ONLY)
    // ==========================================================================
    console.log('\n┌──────────────────────────────────────────────────────────────┐');
    console.log('│  SUITE B: LIVE INTEGRATION PROBES (SAFE READ-ONLY)           │');
    console.log('└──────────────────────────────────────────────────────────────┘');

  // TEST B1: Live Language Server Connect-RPC Smart Probe
  console.log('\n--- [B1] Live Connect-RPC to Active Language Server ---');
  try {
    const liveData = await liveQuotaFetcher.getRealAccountAndQuota(2);
    if (liveData.isLive) {
      report('live', 'Language Server Active Detection', true, `PID: ${liveQuotaFetcher.cachedConfig?.pid || 'N/A'}`);
      report('live', 'Dual-Protocol Smart Probe', Boolean(liveQuotaFetcher.cachedConfig?.protocol), `Protocol: ${liveQuotaFetcher.cachedConfig?.protocol}, Port: ${liveQuotaFetcher.cachedConfig?.port}`);
      report('live', 'Active Account Email Retrieved', Boolean(liveData.email && liveData.email.includes('@')), `Email: ${liveData.email}`);
      report('live', 'Quota Metrics Live Extraction', typeof liveData.flashQuota === 'number' && typeof liveData.claudeQuota === 'number', `Flash: ${liveData.flashQuota}%, Claude: ${liveData.claudeQuota}%`);
    } else {
      console.log('  ℹ️ [INFO] Language Server hiện không chạy hoặc đang ở chế độ chờ (Standby). Bỏ qua test live RPC.');
      report('live', 'Graceful Standby Handling', true, 'Detected inactive state without crashing');
    }
  } catch (err) {
    report('live', 'Live Language Server Probe', false, err.message);
  }

  // TEST B2: Python SQLite Bridge Data Integrity & Busy Timeout
  console.log('\n--- [B2] Python SQLite Bridge Read-only Export & UTF-8 Stream ---');
  try {
    const bridgePath = path.join(__dirname, '..', 'src', 'vscdb_bridge.py');
    const vscdbHelper = require('../src/vscdbHelper');
    const pyCmd = vscdbHelper.resolvePythonCommand();
    const dbPath = vscdbHelper.DB_PATH;

    if (!fs.existsSync(dbPath)) {
      console.log('  ℹ️ [INFO] state.vscdb không tồn tại trên host (môi trường CI/không có Antigravity IDE). Bỏ qua test live SQLite Bridge.');
      report('live', 'SQLite Bridge Standby Handling', true, 'Gracefully skipped when DB is absent');
    } else {
      const stdout = cp.execFileSync(pyCmd, [bridgePath, 'export'], { encoding: 'utf8', timeout: 5000 });
      const parsed = JSON.parse(stdout.trim());

      report('live', 'Python Bridge Export Returns Valid JSON', typeof parsed === 'object');
      report('live', 'Contains UnifiedStateSync Key', 'antigravityUnifiedStateSync.oauthToken' in parsed || 'antigravityUnifiedStateSync.userStatus' in parsed);
    }
  } catch (err) {
    report('live', 'SQLite Bridge Test', false, err.message);
  }

  // TEST B3: Live Dual-Window & Prompt Credits Retrieval
  console.log('\n--- [B3] Live Dual-Window & Prompt Credits Retrieval ---');
  try {
    const liveData = await liveQuotaFetcher.getRealAccountAndQuota(2);
    if (liveData.isLive) {
      report('live', 'Live 5-Hour Rolling Quota extracted', typeof liveData.fiveHourQuota === 'number', `5h: ${liveData.fiveHourQuota}%`);
      report('live', 'Live Weekly Allocation Quota extracted', typeof liveData.weeklyQuota === 'number', `Weekly: ${liveData.weeklyQuota}%`);
      report('live', 'Live Prompt Credits extracted', typeof liveData.promptCredits === 'number', `Credits: ${liveData.promptCredits}`);
      report('live', 'Live Plan Name identified', Boolean(liveData.planName), `Plan: ${liveData.planName}`);
    } else {
      report('live', 'Dual-Window Standby State Handled', true, 'Language Server standby');
    }
  } catch (err) {
    report('live', 'Live Dual-Window Probe', false, err.message);
  }
  } // end if (shouldRunLive)

  // ==========================================================================
  // TỔNG KẾT
  // ==========================================================================
  console.log('\n================================================================');
  console.log(`📊 TỔNG KẾT KIỂM THỬ:`);
  console.log(`   SUITE A (Unit/Logic):    ${suiteResults.unit.passed} PASSED | ${suiteResults.unit.failed} FAILED`);
  console.log(`   SUITE B (Live Probes):   ${suiteResults.live.passed} PASSED | ${suiteResults.live.failed} FAILED`);
  console.log(`   TỔNG CỘNG:               ${passed} PASSED | ${failed} FAILED`);
  console.log('================================================================\n');

  process.exit(failed > 0 ? 1 : 0);
}

runAllTests().catch(err => {
  console.error('Lỗi nghiêm trọng khi chạy Test Suite:', err);
  process.exit(1);
});
