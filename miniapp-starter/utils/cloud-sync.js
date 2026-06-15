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
let _cloudUpdatedAt = 0      // updatedAt value we KNOW is on cloud (learned via
                             // fetch, or set when we write/pull). local > this
                             // ⇒ local edits not yet on cloud ("未同步").
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

// Returns { doc, error }:
//   - { doc: <obj>, error: null }  → user has a cloud doc
//   - { doc: null,  error: null }  → genuinely no doc (first-time user)
//   - { doc: null,  error: <msg> } → fetch failed (network / sdk unavailable)
//
// 区分这三种状态很重要:之前所有错误都返回 null,导致 hydrate / push 误以为
// "用户没文档" → 调 createInitialDoc 在已有文档的用户上又新建一条,产生
// duplicate(同 _openid 多条 doc)。fix:只在 error===null && doc===null 时才
// 当作"首次用户"建初始 doc;有 error 时永远不 create。
// 给一条 user_state doc 打「数据完整度」分:已完成作业数(一次性 done + 重复 occurrence
// done)优先,其次 task 数,再次 updatedAt。用来在「同一 _openid 有多条重复 doc」时
// 稳定挑「最全」的那条来读 —— 历史 bug 会留下重复 doc,随机读 res.data[0] 会读到旧的
// 那条,导致完成记录/改动看着像被回退。纯读取层选择,不删除任何 doc(非破坏性)。
function scoreDoc(doc) {
  const st = (doc && doc.state) || {}
  const tasks = Array.isArray(st.tasks) ? st.tasks : []
  let done = 0
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i]
    if (t && t.status === 'done') done++
    const occ = (t && t.occurrences) || {}
    for (const k in occ) { if (occ[k] && occ[k].status === 'done') done++ }
  }
  return { done: done, tasks: tasks.length, updatedAt: (doc && doc.updatedAt) || 0 }
}
function pickPrimaryDoc(docs) {
  if (!docs || !docs.length) return null
  if (docs.length === 1) return docs[0]
  console.warn('[cloud-sync] multiple user_state docs for this user:', docs.length, '— picking the most complete one')
  return docs.slice().sort((a, b) => {
    const sa = scoreDoc(a), sb = scoreDoc(b)
    if (sb.done !== sa.done) return sb.done - sa.done       // 完成数最多优先
    if (sb.tasks !== sa.tasks) return sb.tasks - sa.tasks   // task 最多
    return (sb.updatedAt || 0) - (sa.updatedAt || 0)        // 最新
  })[0]
}

async function fetchCloudDoc() {
  const d = db()
  if (!d) { _lastError = 'wx.cloud unavailable'; return { doc: null, error: _lastError } }
  try {
    // _openid auto-injected by creator-only ACL → 正常只返回本用户的 doc。但历史 bug
    // 可能给同一 _openid 留了多条重复 doc。挑「数据最全」的那条读(pickPrimaryDoc),
    // 而不是随机 res.data[0],避免读到旧 doc 把完成记录/改动覆盖掉。
    const res = await d.collection(COLLECTION).get()
    _lastError = null
    const picked = pickPrimaryDoc((res && res.data) || [])
    if (picked) _cloudUpdatedAt = picked.updatedAt || 0   // 学到云端当前 updatedAt
    return { doc: picked, error: null }
  } catch (e) {
    const msg = (e && e.errMsg) || String(e)
    _lastError = msg
    console.warn('[cloud-sync] fetchCloudDoc failed', e)
    return { doc: null, error: msg }
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
    _cloudUpdatedAt = updatedAt || 0
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
    if (state) { _cloudUpdatedAt = updatedAt || 0; _lastPushAt = Date.now() }  // 推了新 state 上云
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
  _cloudUpdatedAt = remoteUpdatedAt || 0   // 拉了云端 → 本地=云端,已对齐
}

async function hydrate() {
  if (_hydrateInflight) return _hydrateInflight
  _hydrateInflight = (async () => {
    const localSessionId = getDeviceSessionId()
    const { doc, error: fetchError } = await fetchCloudDoc()

    if (fetchError) {
      // 网络/SDK 失败 —— 区别于"确实没有 doc"。绝不能在这里走 createInitialDoc
      // 分支,否则已有云端文档的用户每次网络抖一下就被多建一条 doc。
      // 本地缓存继续可用,下次 onShow 或显式 forceSync 时再重试。
      return { changed: false, error: fetchError }
    }

    if (!doc) {
      // First time on cloud for this user. Push current local state as the
      // starting point and claim the session。coins 在 SYNC_FIELDS 里,正常
      // 跟随 state 整包 push,不需要特殊 seed。
      const localState = _store.getStateForSync()
      const localUpdatedAt = _store.getUpdatedAt()
      await createInitialDoc(localSessionId, localState, localUpdatedAt)
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

    // Conflict: another sessionId holds the doc.
    // 数据安全第一条铁律:本机数据「不比云端旧」时,绝不能被云端覆盖。
    // 直接夺回 session 并把本机 state 推上云。修一个真实的数据丢失:
    // 之前这里只要 session 不匹配就进只读、静默不推 → 本机连着几天的新数据攒着
    // 没传上云,最后用户点「使用此设备」拉了云端旧快照、把本机新数据全覆盖丢了。
    const localUpdatedAt0 = _store.getUpdatedAt()
    if (localUpdatedAt0 >= (doc.updatedAt || 0)) {
      const localState = _store.getStateForSync()
      await claimSession(doc._id, localSessionId, localState, localUpdatedAt0)
      _readOnly = false
      _conflictAcknowledged = false
      return { changed: false }   // 本机更新 → 推上去,本机不变
    }

    // 只有云端「确实更新」(另一台设备写过更新的数据)才弹冲突框让用户定夺。
    if (_conflictAcknowledged) {
      _readOnly = true
      return { changed: false }
    }
    const choice = await showConflictModal(true)
    if (choice === 'takeover') {
      // 走到这里说明云端比本机新,夺回并拉云端是对的(本机本来就旧)。
      await claimSession(doc._id, localSessionId, null, doc.updatedAt)
      _readOnly = false
      _conflictAcknowledged = false
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
        const { doc, error: probeError } = await fetchCloudDoc()
        if (probeError) {
          // 探测失败:无法判断是"没文档"还是"被踢下线"。绝不调
          // createInitialDoc —— 否则网络一抖就给已有文档的用户多建一条。
          // 下次 saveState 触发 push 时会再走一遍流程,届时网络好了再处理。
          return
        }
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
      _cloudUpdatedAt = updatedAt || 0   // 这份 updatedAt 已落云端 → 本地与云端对齐
    } catch (e) {
      _lastError = (e && e.errMsg) || String(e)
      console.warn('[cloud-sync] push failed', e)
      // Retry on next saveState; nothing else to do here.
    }
  })()
  try { return await _pushInflight } finally { _pushInflight = null }
}

async function handleKickedOnPush(remoteDoc, attemptedState, attemptedUpdatedAt) {
  const localSessionId = getDeviceSessionId()
  // 本机这次要 push 的数据「不比云端旧」→ 直接夺回并推上去,绝不丢本机改动。
  // (同上铁律:本机更新就不能被云端旧数据盖。)
  if ((attemptedUpdatedAt || 0) >= (remoteDoc.updatedAt || 0)) {
    await claimSession(remoteDoc._id, localSessionId, attemptedState, attemptedUpdatedAt)
    _readOnly = false
    _conflictAcknowledged = false
    return
  }
  // 云端确实更新 → 让用户决定。
  if (_modalShowing) {
    _readOnly = true
    return
  }
  const choice = await showConflictModal(false)
  if (choice === 'takeover') {
    await claimSession(remoteDoc._id, localSessionId, null, remoteDoc.updatedAt)
    _readOnly = false
    _conflictAcknowledged = false
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
  const i18n = require('./i18n')   // lazy: cloud-sync 加载很早,避免任何初始化顺序问题
  if (!ts) return i18n.t('sync_never')
  const diff = Date.now() - ts
  if (diff < 30 * 1000) return i18n.t('sync_just_now')
  if (diff < 60 * 1000) return i18n.t('sync_sec_ago', { n: Math.floor(diff / 1000) })
  if (diff < 60 * 60 * 1000) return i18n.t('sync_min_ago', { n: Math.floor(diff / 60000) })
  if (diff < 24 * 60 * 60 * 1000) return i18n.t('sync_hr_ago', { n: Math.floor(diff / 3600000) })
  const d = new Date(ts)
  const pad = (n) => `${n}`.padStart(2, '0')
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// 本地是否有「还没成功推上云」的改动。local updatedAt 比已知云端 updatedAt 新 = 有。
// 注意:每次编辑后 200ms~1s 内本来就会短暂 unsynced(push 在途),这是正常的,
// 不该报警 —— 所以「需要提醒」(needsAttention)只在持续没同步上(>30s 没成功
// push / 推送报错 / 只读被踢)时才为真,避免每次打勾都闪 banner。
function hasUnsyncedLocal() {
  const localUpd = (_store && typeof _store.getUpdatedAt === 'function') ? _store.getUpdatedAt() : 0
  return localUpd > _cloudUpdatedAt
}

function getSyncStatus() {
  const unsynced = hasUnsyncedLocal()
  const lastSyncTs = Math.max(_lastPushAt, _lastHydrateAt)
  // 有改动、且距离上次成功同步已超过 30s(说明不是「在途」而是真卡住了)。
  const staleUnsynced = unsynced && lastSyncTs > 0 && (Date.now() - lastSyncTs > 30000)
  let status = 'healthy'
  if (_readOnly) status = 'readonly'
  else if (_lastError) status = 'error'
  else if (staleUnsynced) status = 'unsynced'
  else if (!_lastPushAt && !_lastHydrateAt) status = 'unknown'
  const needsAttention = status === 'readonly' || status === 'error' || status === 'unsynced'
  return {
    status,
    needsAttention,
    readOnly: _readOnly,
    unsynced,
    lastHydrateAt: _lastHydrateAt,
    lastPushAt: _lastPushAt,
    lastError: _lastError,
    lastSyncDisplay: formatRelativeTime(lastSyncTs),
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
  // 2. Bypass debounce.
  _lastHydrateAt = 0
  return hydrate()
}

// Used from the profile page's "切回此设备" button when stuck in read-only.
// Re-claim ownership and pull cloud state.
async function reclaim() {
  console.log('[cloud-sync] reclaim invoked')
  const localSessionId = getDeviceSessionId()
  const { doc, error: fetchError } = await fetchCloudDoc()
  if (fetchError) {
    // 拉云端文档失败,绝不能 createInitialDoc(会在已有用户上多建一条)。
    // 把 _lastError 留给 UI 提示用户重试。
    console.log('[cloud-sync] reclaim: fetch failed, abort', fetchError)
    return false
  }
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
  // 同铁律:本机数据「不比云端旧」→ 夺回并推本机(保住本机改动);否则才拉云端。
  const localUpdatedAt = _store.getUpdatedAt()
  if (localUpdatedAt >= (doc.updatedAt || 0)) {
    const localState = _store.getStateForSync()
    const okPush = await claimSession(doc._id, localSessionId, localState, localUpdatedAt)
    if (okPush) { _readOnly = false; _conflictAcknowledged = false; _lastError = null }
    else { _lastError = _lastError || 'claimSession failed' }
    console.log('[cloud-sync] reclaim: local newer, pushed up, ok=', okPush)
    return okPush
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
