// 管理员金币调整信箱客户端封装。
//
// adminPanel 云函数把 admin 的金币调整写入 admin_coin_inbox（不改 user_state），
// 客户端定期拉取并清空属于自己的 pending 条目；本地累加到 coins 后由 cloud-sync
// 自然 push 回云端。整套机制和 share-reward.js 同构。
//
// 失败时全程静默 —— 主流程（首页渲染）不应被 inbox 拉取阻塞。

const FN_NAME = 'adminPanel'

let _cloudFnDisabled = false
let _lastClaimAt = 0
const CLAIM_THROTTLE_MS = 30000

function ensureCloud() {
  return typeof wx !== 'undefined' && wx.cloud && typeof wx.cloud.callFunction === 'function'
}

function isPermanentFailure(e) {
  const msg = (e && (e.errMsg || e.message)) || String(e || '')
  return /function not found|资源不存在|FUNCTION_NOT_FOUND|-501|FUNCTIONS_EXECUTE_FAIL|permission/i.test(msg)
}

async function callFn(payload) {
  if (!ensureCloud()) return null
  if (_cloudFnDisabled) return null
  try {
    const res = await wx.cloud.callFunction({ name: FN_NAME, data: payload })
    return (res && res.result) || null
  } catch (e) {
    if (isPermanentFailure(e)) {
      _cloudFnDisabled = true
    } else if (!/timeout/i.test((e && e.errMsg) || '')) {
      console.warn('[admin-inbox] callFunction failed', payload && payload.action, e && e.errMsg)
    }
    return null
  }
}

// 返回 { ok, total, count, items: [{delta, reason, adminOpenid, createdAt}] }
// 或 null。throttle 30s 避免每次 onShow 都打云函数；首次启动或显式 force=true 立即拉。
async function claimPendingAdminCoins({ force } = {}) {
  const now = Date.now()
  if (!force && now - _lastClaimAt < CLAIM_THROTTLE_MS) return null
  _lastClaimAt = now
  const r = await callFn({ action: 'claimAdminCoins' })
  if (!r || !r.ok) return null
  if (!r.count) return null
  return r
}

module.exports = {
  claimPendingAdminCoins
}
