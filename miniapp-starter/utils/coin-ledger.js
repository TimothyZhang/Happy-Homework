// coin-ledger 客户端 wrapper —— 把 store 里 pendingCoinEvents 队列 debounced
// 上送给 coinLedger 云函数,拿回 newBalance + appliedEventIds 后让 store 对齐。
//
// 设计参考 cloud-sync 和 share-reward:
//   - init(storeIface) 注入 store 的 getPendingCoinEvents / applyServerCoinResult
//   - scheduleFlush() 重置 debounce 计时器,FLUSH_DEBOUNCE_MS 后真正发请求
//   - flush() 同步 inflight 合并(并发触发只跑一次 round-trip)
//   - 云函数不可达 / not deployed 时静默降级 —— 主流程(完成作业、刷宠物)
//     仍然能用,pendingCoinEvents 留在本地等下次有网络/部署再重试
//
// 失败语义:
//   - 网络抖动 / 超时 → events 留队列,下次 scheduleFlush 再发
//   - 永久错误(函数不存在 / 权限) → flip _cloudFnDisabled 跳过 session 后续
//   - 服务端返 ok:false → 不 drain 队列,下次重试

const FN_NAME = 'coinLedger'
const FLUSH_DEBOUNCE_MS = 500   // 一个动作可能连续 emit 多个事件(如完成作业 = task_reward),合并
const MAX_BATCH = 50            // 单次最多上送多少事件(云函数硬上限 100,这里保守)

let _store = null
let _flushTimer = null
let _flushInflight = null
let _cloudFnDisabled = false

function ensureCloud() {
  return typeof wx !== 'undefined' && wx.cloud && typeof wx.cloud.callFunction === 'function'
}

function isPermanentFailure(e) {
  const msg = (e && (e.errMsg || e.message)) || String(e || '')
  return /function not found|资源不存在|FUNCTION_NOT_FOUND|-501|FUNCTIONS_EXECUTE_FAIL|permission/i.test(msg)
}

function init(storeIface) {
  _store = storeIface
}

function scheduleFlush() {
  if (!_store) return
  if (_cloudFnDisabled) return
  if (_flushTimer) clearTimeout(_flushTimer)
  _flushTimer = setTimeout(() => {
    _flushTimer = null
    // fire-and-forget;flush() 自己内部 catch
    flush().catch(() => {})
  }, FLUSH_DEBOUNCE_MS)
}

async function flush() {
  if (!_store) return null
  if (_cloudFnDisabled) return null
  if (!ensureCloud()) return null
  if (_flushInflight) return _flushInflight

  const events = _store.getPendingCoinEvents()
  if (!events || events.length === 0) return { ok: true, appliedCount: 0 }

  // 一次最多 MAX_BATCH,剩下的下次 flush 自然带上
  const batch = events.slice(0, MAX_BATCH)
  const batchIds = batch.map((ev) => ev.eventId)

  _flushInflight = (async () => {
    try {
      const res = await wx.cloud.callFunction({
        name: FN_NAME,
        data: { action: 'commit', events: batch }
      })
      const r = (res && res.result) || null
      if (!r || !r.ok) {
        // server 报错 / 校验失败,events 留在 queue 下次再试
        if (r && r.reason) console.warn('[coin-ledger] commit refused', r.reason, r.detail || '')
        return r
      }
      // server 返回了 appliedEventIds(已入账的)+ newBalance(账本最新余额)
      // 注意:appliedEventIds 可能短于 batch —— server 中途余额不足 / 校验失败,
      // 前缀部分仍然入账。我们用 server 给的列表 drain,而不是整批。
      _store.applyServerCoinResult({
        appliedEventIds: r.appliedEventIds || batchIds,  // 兼容老版未返 appliedEventIds 的情况
        newBalance: r.newBalance
      })
      // 如果还有事件没批到(batch 截断),下次自然会再 flush
      if (events.length > batch.length) {
        scheduleFlush()
      }
      return r
    } catch (e) {
      if (isPermanentFailure(e)) {
        _cloudFnDisabled = true
        console.warn('[coin-ledger] cloud function unavailable, disabling for session', e && e.errMsg)
      } else if (!/timeout/i.test((e && e.errMsg) || '')) {
        console.warn('[coin-ledger] flush failed', e && e.errMsg)
      }
      return null
    } finally {
      _flushInflight = null
    }
  })()
  return _flushInflight
}

module.exports = {
  init,
  scheduleFlush,
  flush
}
