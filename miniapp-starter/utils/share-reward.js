// 分享奖励：包装 shareReward 云函数的三类调用，并把"我的 openid"缓存到 storage。
//
// 所有函数都会优雅降级：云函数没部署 / 网络失败 / 返回错误时返回 null/0，
// 不抛异常、不弹错误 toast —— 主分享流程可以照常工作。

const FN_NAME = 'shareReward'
const OPENID_STORAGE_KEY = 'share-reward-my-openid'

let _cachedOpenid = null
let _lastClaimAt = 0
let _cloudFnDisabled = false  // flipped on first hard failure (not deployed / unreachable)
const CLAIM_THROTTLE_MS = 30000  // don't hit the network more than every 30s

function ensureCloud() {
  return typeof wx !== 'undefined' && wx.cloud && typeof wx.cloud.callFunction === 'function'
}

// Permanent failures (function not deployed / no permission): flip the
// session-level disabled flag so we stop retrying. Timeouts are NOT permanent
// (cold-start can take several seconds) — those just fail silently and the
// next throttle window will retry.
function isPermanentFailure(e) {
  const msg = (e && (e.errMsg || e.message)) || String(e || '')
  return /function not found|资源不存在|FUNCTION_NOT_FOUND|-501|FUNCTIONS_EXECUTE_FAIL|permission/i.test(msg)
}

function isExpectedNoise(e) {
  const msg = (e && (e.errMsg || e.message)) || String(e || '')
  return isPermanentFailure(e) || /timeout/i.test(msg)
}

async function callFn(payload) {
  if (!ensureCloud()) return null
  if (_cloudFnDisabled) return null
  try {
    const res = await wx.cloud.callFunction({ name: FN_NAME, data: payload })
    return (res && res.result) || null
  } catch (e) {
    if (isPermanentFailure(e)) {
      _cloudFnDisabled = true  // skip future calls this session
    } else if (!isExpectedNoise(e)) {
      console.warn('[share-reward] callFunction failed', payload && payload.action, e && e.errMsg)
    }
    return null
  }
}

// Returns own openid, hitting cloud only on first miss. Cached in storage so
// subsequent app launches are offline-friendly.
async function getMyOpenid() {
  if (_cachedOpenid) return _cachedOpenid
  try {
    const cached = wx.getStorageSync(OPENID_STORAGE_KEY)
    if (cached) {
      _cachedOpenid = cached
      return cached
    }
  } catch (_) {}

  const r = await callFn({ action: 'whoami' })
  if (r && r.ok && r.openid) {
    _cachedOpenid = r.openid
    try { wx.setStorageSync(OPENID_STORAGE_KEY, r.openid) } catch (_) {}
    return r.openid
  }
  return null
}

// Best-effort: returns a fresh openid for embedding into a share payload, or
// null if cloud unavailable. The share path itself stays valid either way.
function getMyOpenidSync() {
  if (_cachedOpenid) return _cachedOpenid
  try {
    const cached = wx.getStorageSync(OPENID_STORAGE_KEY)
    if (cached) { _cachedOpenid = cached; return cached }
  } catch (_) {}
  return null
}

// Kicks off a background openid fetch; safe to call repeatedly.
function preloadOpenid() {
  if (_cachedOpenid) return Promise.resolve(_cachedOpenid)
  return getMyOpenid()
}

// Receiver calls this after successfully importing a shared notebook. Cloud
// function dedups (importer × notebook), so calling twice is harmless.
async function reportShareSave({ sharerOpenid, notebookId, notebookName }) {
  if (!sharerOpenid || !notebookId) return null
  return callFn({
    action: 'credit',
    sharerOpenid,
    notebookId,
    notebookName: notebookName || ''
  })
}

// Sharer pulls and consumes any pending reward records. Returns
// { total, count, notebooks } on success, or null if nothing to claim or the
// cloud call fails. Throttled to avoid hammering the cloud function on
// every onShow.
async function claimPendingRewards({ force } = {}) {
  const now = Date.now()
  if (!force && now - _lastClaimAt < CLAIM_THROTTLE_MS) return null
  _lastClaimAt = now
  const r = await callFn({ action: 'claim' })
  if (!r || !r.ok) return null
  if (!r.total) return null
  return r
}

module.exports = {
  getMyOpenid,
  getMyOpenidSync,
  preloadOpenid,
  reportShareSave,
  claimPendingRewards
}
