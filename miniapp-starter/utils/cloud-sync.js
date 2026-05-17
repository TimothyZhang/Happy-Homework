// Cross-device sync via WeChat 云开发 数据库.
//
// Single-device claim model: only ONE device may write at a time. The cloud
// doc holds the active sessionId; whoever's id matches owns it. Switching
// devices requires user confirmation (modal) and pulls cloud state down.
//
// Design notes:
// - Reads stay sync (local cache wins for UI). Cloud is consulted on launch
//   and on each onShow (debounced).
// - Writes push to cloud after a 200ms debounce. If push reports 0 rows
//   updated, this device has been kicked — surface a modal.
// - Last-write-wins by `updatedAt` (ms). Single-device claim makes this rare.
// - Never block the UI for a network round-trip. Failures are silent + retry
//   on next mutation.

const coinLedger = require('./coin-ledger')

const COLLECTION = 'user_state'
const HYDRATE_DEBOUNCE_MS = 30000  // page onShow re-check throttle
const PUSH_DEBOUNCE_MS = 200       // batch rapid setData ticks (drag, ticker)

const SESSION_STORAGE_KEY = 'cloud-sync-device-session-id'

let _store = null            // injected via init() to break the circular dep
let _readOnly = false
let _conflictAcknowledged = false  // user dismissed conflict modal this session
let _modalShowing = false          // dedup overlapping modal triggers
let _lastHydrateAt = 0
let _lastPushAt = 0          // ms — most recent successful actuallyPush
let _lastError = null        // last push/hydrate error message; null = healthy
let _pushTimer = null
let _pendingPushState = null
let _pushInflight = null     // promise of in-flight actuallyPush, for forceSync
let _hydrateInflight = null

function db() {
  if (!wx.cloud || !wx.cloud.database) return null
  return wx.cloud.database()
}

function genUuid() {
  // RFC4122-ish v4. Good enough for a device session id.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

function getDeviceSessionId() {
  let id = ''
  try { id = wx.getStorageSync(SESSION_STORAGE_KEY) } catch (_) {}
  if (!id) {
    id = genUuid()
    try { wx.setStorageSync(SESSION_STORAGE_KEY, id) } catch (_) {}
  }
  return id
}

function init(store) {
  _store = store
}

function isReadOnly() { return _readOnly }

async function fetchCloudDoc() {
  const d = db()
  if (!d) { _lastError = 'wx.cloud unavailable'; return null }
  try {
    // _openid is auto-injected by collection ACL "creator-only", so .get()
    // returns at most one doc — this user's.
    const res = await d.collection(COLLECTION).get()
    _lastError = null
    return (res.data && res.data[0]) || null
  } catch (e) {
    _lastError = (e && e.errMsg) || String(e)
    console.warn('[cloud-sync] fetchCloudDoc failed', e)
    return null
  }
}

async function createInitialDoc(localSessionId, state, updatedAt) {
  const d = db()
  if (!d) { _lastError = 'wx.cloud unavailable'; return false }
  try {
    await d.collection(COLLECTION).add({
      data: {
        state,
        sessionId: localSessionId,
        claimedAt: Date.now(),
        updatedAt
      }
    })
    _lastError = null
    _lastPushAt = Date.now()
    return true
  } catch (e) {
    _lastError = (e && e.errMsg) || String(e)
    console.warn('[cloud-sync] createInitialDoc failed', e)
    return false
  }
}

async function claimSession(docId, localSessionId, state, updatedAt) {
  const d = db()
  if (!d) { _lastError = 'wx.cloud unavailable'; return false }
  try {
    await d.collection(COLLECTION).doc(docId).update({
      data: {
        sessionId: localSessionId,
        claimedAt: Date.now(),
        // Don't bump updatedAt unless we're actually writing newer state.
        ...(state ? { state, updatedAt } : {})
      }
    })
    return true
  } catch (e) {
    _lastError = (e && e.errMsg) || String(e)
    console.warn('[cloud-sync] claimSession failed', e)
    return false
  }
}

function showConflictModal(initial) {
  // initial=true → first hydrate detects another device owns it
  // initial=false → mid-session push got rejected (kicked)
  return new Promise((resolve) => {
    if (_modalShowing) { resolve('cancel'); return }
    _modalShowing = true
    // confirmText/cancelText capped at 4 chars — exceeding the limit makes
    // wx.showModal silently no-op on iOS.
    wx.showModal({
      title: initial ? '数据正在另一台设备上使用' : '已在其他设备登录',
      content: initial
        ? '切换到此设备会让对方退出，并以云端最新数据为准。是否切换？'
        : '此设备已被踢下线。切换回来会以云端最新数据覆盖本机未保存的改动。',
      // confirmText must be ≤4 chars — wx.showModal silently fails to render
      // when exceeded, which would auto-resolve to 'cancel' and trap the user
      // in read-only mode with no visible prompt.
      confirmText: '用此设备',
      cancelText: '只读浏览',
      success: (r) => resolve(r.confirm ? 'takeover' : 'cancel'),
      fail: (err) => {
        console.warn('[cloud-sync] showConflictModal failed', err)
        resolve('cancel')
      },
      complete: () => { _modalShowing = false }
    })
  })
}

// Pull cloud state into local cache. Called from take-over and from "cloud
// is newer than local" branches. Bypasses pushState (would re-push back).
function applyRemoteState(remote, remoteUpdatedAt) {
  if (!_store || !remote) return
  _store.applyHydratedState(remote, remoteUpdatedAt)
}

async function hydrate() {
  if (_hydrateInflight) return _hydrateInflight
  _hydrateInflight = (async () => {
    const localSessionId = getDeviceSessionId()
    const doc = await fetchCloudDoc()

    if (!doc) {
      // First time on cloud for this user. Push current local state as the
      // starting point and claim the session.
      // Seed coins from local default into the cloud doc — coins 不在
      // SYNC_FIELDS, 后续 push 不带它, 服务端账本由 coinLedger / shareReward.claim
      // / adminPanel.claimAdminCoins 独占。只在首次建文档时 seed 一次, 让
      // 新用户的 defaultState.coins (100) 真的反映到云端起点。
      const localState = _store.getStateForSync()
      const localUpdatedAt = _store.getUpdatedAt()
      const seedCoins = typeof _store.getLocalCoins === 'function' ? _store.getLocalCoins() : undefined
      const initialState = (typeof seedCoins === 'number')
        ? { ...localState, coins: seedCoins }
        : localState
      await createInitialDoc(localSessionId, initialState, localUpdatedAt)
      return { changed: false }
    }

    if (doc.sessionId === localSessionId) {
      // We own it. If cloud is newer (e.g. we lost local cache), pull down.
      if (_readOnly) {
        _readOnly = false
        _conflictAcknowledged = false
      }
      const localUpdatedAt = _store.getUpdatedAt()
      if ((doc.updatedAt || 0) > localUpdatedAt) {
        applyRemoteState(doc.state, doc.updatedAt)
        return { changed: true }
      }
      return { changed: false }
    }

    // Conflict: another device holds the session.
    if (_conflictAcknowledged) {
      // User already chose read-only this session — don't nag.
      _readOnly = true
      return { changed: false }
    }

    const choice = await showConflictModal(true)
    if (choice === 'takeover') {
      await claimSession(doc._id, localSessionId, null, doc.updatedAt)
      _readOnly = false
      _conflictAcknowledged = false
      // Always pull cloud state on takeover — that's what "switch to this
      // device" means semantically.
      applyRemoteState(doc.state, doc.updatedAt)
      return { changed: true }
    }
    _readOnly = true
    _conflictAcknowledged = true
    return { changed: false }
  })()
  let hydrateResult
  try {
    hydrateResult = await _hydrateInflight
  } finally {
    _hydrateInflight = null
    // Stamp on completion (not start) so the debounce doesn't blackhole
    // pages that opened during a slow hydrate.
    _lastHydrateAt = Date.now()
  }
  // Lazy backup: 如果 hydrate 触发了 v2→v3 migrate (老用户首次跑新版本),
  // 调一次 backupUserState (backup_self) 给云端留一份升级前快照。云函数侧
  // 通过 doc.backedUpAt 字段 dedup,所以重复调也只备份一次。失败不阻塞用户。
  try {
    if (_store && typeof _store.consumeV2V3MigrationFlag === 'function' &&
        _store.consumeV2V3MigrationFlag() &&
        typeof wx !== 'undefined' && wx.cloud && typeof wx.cloud.callFunction === 'function') {
      wx.cloud.callFunction({
        name: 'backupUserState',
        data: { action: 'backup_self' }
      }).then((res) => {
        const r = (res && res.result) || {}
        if (r.ok) {
          if (!r.alreadyBackedUp) {
            console.log('[backup] v2 snapshot saved before upgrade', r)
          }
        } else {
          console.warn('[backup] backup_self failed', r)
        }
      }).catch((e) => {
        console.warn('[backup] backup_self call errored', e && e.errMsg)
      })
    }
  } catch (e) {
    // 静默 — backup 永远不能让用户卡住。
  }
  return hydrateResult
}

async function hydrateIfStale() {
  // If a hydrate is currently running (e.g. launch hydrate), wait for it
  // — that's the result the page wants. The debounce only kicks in for
  // *fresh* calls.
  if (_hydrateInflight) return _hydrateInflight
  if (Date.now() - _lastHydrateAt < HYDRATE_DEBOUNCE_MS) {
    return { changed: false }
  }
  return hydrate()
}

// Public: queue a state push. Coalesced via PUSH_DEBOUNCE_MS so a burst of
// setData (drag, ticker) results in one network round-trip.
function pushState(state, updatedAt) {
  if (_readOnly) return
  _pendingPushState = { state, updatedAt }
  if (_pushTimer) clearTimeout(_pushTimer)
  _pushTimer = setTimeout(() => {
    _pushTimer = null
    const pending = _pendingPushState
    _pendingPushState = null
    if (pending) actuallyPush(pending.state, pending.updatedAt)
  }, PUSH_DEBOUNCE_MS)
}

async function actuallyPush(state, updatedAt) {
  if (_pushInflight) return _pushInflight
  _pushInflight = (async () => {
    const d = db()
    if (!d) { _lastError = 'wx.cloud unavailable'; return }
    const localSessionId = getDeviceSessionId()
    try {
      const res = await d.collection(COLLECTION)
        .where({ sessionId: localSessionId })
        .update({ data: { state, updatedAt } })
      const updated = (res && res.stats && res.stats.updated) || 0
      if (updated === 0) {
        // Either no doc yet (race with init) or we've been kicked. Probe to
        // distinguish.
        const doc = await fetchCloudDoc()
        if (!doc) {
          // No cloud doc — create it with our state.
          await createInitialDoc(localSessionId, state, updatedAt)
          return
        }
        if (doc.sessionId !== localSessionId) {
          await handleKickedOnPush(doc, state, updatedAt)
        }
        return
      }
      _lastError = null
      _lastPushAt = Date.now()
    } catch (e) {
      _lastError = (e && e.errMsg) || String(e)
      console.warn('[cloud-sync] push failed', e)
      // Retry on next saveState; nothing else to do here.
    }
  })()
  try { return await _pushInflight } finally { _pushInflight = null }
}

async function handleKickedOnPush(remoteDoc, attemptedState, attemptedUpdatedAt) {
  if (_modalShowing) {
    // Already prompting; just stay read-only.
    _readOnly = true
    return
  }
  const choice = await showConflictModal(false)
  if (choice === 'takeover') {
    const localSessionId = getDeviceSessionId()
    await claimSession(remoteDoc._id, localSessionId, null, remoteDoc.updatedAt)
    _readOnly = false
    _conflictAcknowledged = false
    // Take over = adopt cloud state. The local edit that triggered this push
    // is intentionally lost — user accepted the "cloud wins" framing.
    applyRemoteState(remoteDoc.state, remoteDoc.updatedAt)
  } else {
    _readOnly = true
    _conflictAcknowledged = true
  }
}

// === Public manual-sync API ===
//
// Used by the profile page's sync card. The auto sync (launch hydrate +
// onShow hydrateIfStale + saveState pushState) covers 99% of cases; these
// are the fallback when the user wants to verify or recover.

function formatRelativeTime(ts) {
  if (!ts) return '从未'
  const diff = Date.now() - ts
  if (diff < 30 * 1000) return '刚刚'
  if (diff < 60 * 1000) return `${Math.floor(diff / 1000)} 秒前`
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} 分钟前`
  if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)} 小时前`
  const d = new Date(ts)
  const pad = (n) => `${n}`.padStart(2, '0')
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function getSyncStatus() {
  let status = 'healthy'
  if (_readOnly) status = 'readonly'
  else if (_lastError) status = 'error'
  else if (!_lastPushAt && !_lastHydrateAt) status = 'unknown'
  return {
    status,
    readOnly: _readOnly,
    lastHydrateAt: _lastHydrateAt,
    lastPushAt: _lastPushAt,
    lastError: _lastError,
    lastSyncDisplay: formatRelativeTime(Math.max(_lastPushAt, _lastHydrateAt)),
    inflight: !!_hydrateInflight || !!_pushInflight || !!_pushTimer
  }
}

// Flush any pending debounced push, then force a hydrate (bypass 30s
// debounce). Returns the hydrate result.
async function forceSync() {
  // 1. Flush any pending debounced push so cloud has our latest before we
  //    hydrate (otherwise hydrate might treat cloud as newer and overwrite).
  if (_pushTimer) {
    clearTimeout(_pushTimer)
    _pushTimer = null
    if (_pendingPushState && !_readOnly) {
      const p = _pendingPushState
      _pendingPushState = null
      await actuallyPush(p.state, p.updatedAt)
    }
  }
  // 2. Flush coin events 同步进 server 账本,这样紧接着 hydrate 拿到的
  //    state.coins 就是把 pending 算上后的最终值,UI 不会闪。
  if (!_readOnly) {
    try { await coinLedger.flush() } catch (e) { /* 失败下次重试 */ }
  }
  // 3. Bypass debounce.
  _lastHydrateAt = 0
  return hydrate()
}

// Used from the profile page's "切回此设备" button when stuck in read-only.
// Re-claim ownership and pull cloud state.
async function reclaim() {
  console.log('[cloud-sync] reclaim invoked')
  const localSessionId = getDeviceSessionId()
  const doc = await fetchCloudDoc()
  if (!doc) {
    console.log('[cloud-sync] reclaim: no cloud doc, seeding')
    const state = _store.getStateForSync()
    const updatedAt = _store.getUpdatedAt()
    const ok = await createInitialDoc(localSessionId, state, updatedAt)
    if (ok) {
      _readOnly = false
      _conflictAcknowledged = false
    }
    return ok
  }
  const ok = await claimSession(doc._id, localSessionId, null, doc.updatedAt)
  if (ok) {
    _readOnly = false
    _conflictAcknowledged = false
    _lastError = null
    applyRemoteState(doc.state, doc.updatedAt)
  } else {
    // claimSession swallows the error — surface it via _lastError so the UI
    // can show a useful toast instead of a bare "切回失败".
    _lastError = _lastError || 'claimSession failed'
  }
  console.log('[cloud-sync] reclaim done, ok=', ok, 'err=', _lastError)
  return ok
}

module.exports = {
  init,
  hydrate,
  hydrateIfStale,
  pushState,
  isReadOnly,
  // manual sync
  getSyncStatus,
  forceSync,
  reclaim
}
