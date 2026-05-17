'use strict'

// 金币账本云函数 (v3: per-event 容错,单条不合法不再整批拒;单条 over-debit
// clip 到 0 不再 for-loop break)。
//
// 历史背景:state.coins 之前在 cloud-sync 的 SYNC_FIELDS 里随 state 一起
// 整包 push,客户端篡改 localStorage 就能直接覆盖云端余额。这个云函数把
// 余额改成由服务端持有 —— 客户端只能上报"事件"(完成作业/购买宠物/...),
// 由服务端按 kind 校验后写入 user_state.state.coins + coin_ledger 审计。
//
// 接口:
//   commit  → 批量提交事件,返回 { ok, appliedCount, newBalance,
//                                  appliedEventIds, droppedEventIds, clippedEventIds, lastReason }
//   balance → 仅查当前余额
//
// 事件 schema(client → server):
//   { eventId: string,   // client UUID,服务端 dedup
//     kind: string,       // 见下方 EVENT_RULES
//     delta: number,      // 带符号整数
//     ts: number,         // client 时间,仅用于审计
//     meta?: object }     // taskId / itemId 之类,审计用
//
// v3 容错语义:
// - 单条 schema 校验失败(legacy kind / 越界 delta / 缺字段)→ drop + drain,不入账。
//   保护客户端 pending 队列不被一条"老版本残留"事件堵死;过去 v2 的整批拒会
//   让所有后续 event 永远到不了 server(例:client 升级前 pet_level_up,server
//   只认 level_upgrade)。
// - 单条 balance 不够(balance + delta < 0)→ delta clip 到 -balance,balance 落到 0,
//   仍然写 ledger(标 clipped + requestedDelta) + drain。过去 v2 的 break 会让
//   该条以及之后所有 event 卡在队头(例:perfect_day_clawback 退 -65 但 server
//   只有 18,导致 for-loop break,后续 +10 task_reward 全卡)。
//
// 设计上的弱点(刻意保留):
// - 我们不真正反作弊"用户给自己刷分"。攻击者可以伪造 kind=task_reward 多个
//   事件,只要 delta 在合理范围内服务端就会接受。该云函数解决的是"防止
//   localStorage 篡改秒变 999999",而不是细粒度规则强制。
// - 真正想细致的话需要服务端持有 task / pet 状态,代价远超本次重构范围。

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const USER_COLLECTION = 'user_state'
const LEDGER_COLLECTION = 'coin_ledger'

// 单次 commit 最多处理多少事件,防止脚本一次塞十万条爆 DB。
const MAX_EVENTS_PER_CALL = 100

// 单次 commit 累计 delta 绝对值上限,防止边界外的"我刷 1e9 金币"。
const MAX_BATCH_ABS_DELTA = 100000

// 每个 kind 的允许 delta 范围(含端点)。这里取相对宽松的上限,目的是
// catastrophic protection 不是逐规则匹配 —— 客户端常规算出的奖励都落在
// 区间内,刻意越界的(比如直接造 task_reward delta=1e6)会被这里拦掉。
//
// 数值参考 store.js V1-VALUES-DESIGN:
//   task_reward    : 单次完成最高 = REWARD_TASK_FUTURE(15) + dailyBonus
//                    (最多 20×15 + 50 早完成 = 350) + weeklyBonus(100) ≈ 465
//   task_refund    : 上限对称
//   pet_purchase   : 道具最贵 50,留余量
//   level_upgrade  : LEVEL_COSTS_PLATEAU=2000,留 5x 余量给后续调表
//   pet_skin_switch: PET_SWITCH_COST=100,留余量
const EVENT_RULES = {
  task_reward:     { min: 1,       max: 500 },
  task_refund:     { min: -500,    max: -1 },
  pet_purchase:    { min: -200,    max: -1 },
  level_upgrade:   { min: -10000,  max: -1 },
  pet_skin_switch: { min: -1000,   max: -1 }
}

exports.main = async (event = {}) => {
  const ctx = cloud.getWXContext()
  const openid = ctx && ctx.OPENID
  if (!openid) {
    return { ok: false, reason: 'no_openid' }
  }

  const action = event.action
  if (action === 'balance') {
    return getBalance(openid)
  }
  if (action === 'commit') {
    return commitEvents(openid, event.events)
  }
  return { ok: false, reason: 'unknown_action' }
}

async function getBalance(openid) {
  const db = cloud.database()
  const res = await db.collection(USER_COLLECTION)
    .where({ _openid: openid })
    .field({ state: true })
    .limit(1)
    .get()
  const doc = (res.data && res.data[0]) || null
  if (!doc) return { ok: false, reason: 'no_user_state' }
  const coins = (doc.state && typeof doc.state.coins === 'number') ? doc.state.coins : 0
  return { ok: true, balance: coins }
}

async function ensureCollection(name) {
  const db = cloud.database()
  try {
    await db.createCollection(name)
  } catch (e) {
    // 已存在或无权限,后续操作自然失败
  }
}

// 校验单个事件,返回 { ok, reason? }。不修改任何数据。
function validateEvent(ev) {
  if (!ev || typeof ev !== 'object') return { ok: false, reason: 'not_object' }
  if (typeof ev.eventId !== 'string' || ev.eventId.length === 0 || ev.eventId.length > 64) {
    return { ok: false, reason: 'bad_event_id' }
  }
  if (typeof ev.kind !== 'string' || !EVENT_RULES[ev.kind]) {
    return { ok: false, reason: 'bad_kind' }
  }
  const delta = Number(ev.delta)
  if (!Number.isFinite(delta) || !Number.isInteger(delta)) {
    return { ok: false, reason: 'bad_delta' }
  }
  const rule = EVENT_RULES[ev.kind]
  if (delta < rule.min || delta > rule.max) {
    return { ok: false, reason: 'delta_out_of_range' }
  }
  return { ok: true }
}

async function commitEvents(openid, events) {
  if (!Array.isArray(events) || events.length === 0) {
    return { ok: false, reason: 'no_events' }
  }
  if (events.length > MAX_EVENTS_PER_CALL) {
    return { ok: false, reason: 'too_many_events' }
  }

  // 累计 abs delta 上限,防 DDoS。单条 event 的 schema / 余额校验放进主循环,
  // 任何一条不合规不再整批拒 —— 老版本 client 残留的 obsolete kind / over-debit
  // task_refund 会单条 drop 掉,后续 event 继续处理,不再 poison 整个队列。
  const totalAbs = events.reduce((s, ev) => s + Math.abs(Number(ev && ev.delta) || 0), 0)
  if (totalAbs > MAX_BATCH_ABS_DELTA) {
    return { ok: false, reason: 'batch_delta_too_large' }
  }

  const db = cloud.database()

  // 取当前余额。user_state 由 cloud-sync 在首次 launch 时建,理论上一定存在;
  // 不存在就拒,让 client 先 hydrate。
  const userRes = await db.collection(USER_COLLECTION)
    .where({ _openid: openid })
    .field({ state: true })
    .limit(1)
    .get()
  const userDoc = (userRes.data && userRes.data[0]) || null
  if (!userDoc) {
    return { ok: false, reason: 'no_user_state' }
  }
  let balance = (userDoc.state && typeof userDoc.state.coins === 'number') ? userDoc.state.coins : 0

  await ensureCollection(LEDGER_COLLECTION)

  // 服务端 dedup:同一 eventId 已经入账过的跳过(retry 安全)。
  const eventIds = events.map((ev) => ev && ev.eventId).filter((id) => typeof id === 'string' && id.length > 0)
  const dupRes = eventIds.length > 0
    ? await db.collection(LEDGER_COLLECTION)
        .where({ _openid: openid, eventId: db.command.in(eventIds) })
        .field({ eventId: true })
        .limit(MAX_EVENTS_PER_CALL)
        .get()
    : { data: [] }
  const seenIds = new Set((dupRes.data || []).map((d) => d.eventId))

  const appliedEventIds = []     // client 应当从 pending 排空的 eventId(实际入账 / 已 seen / 被丢弃)
  const writtenEventIds = []     // 真正写进 ledger 的子集,用于 rollback
  const droppedEventIds = []     // schema 校验失败被丢弃的 eventId(audit / 排查用)
  const clippedEventIds = []     // delta 被 clip 到 0 的 eventId(audit)
  let netDelta = 0
  let stopReason = ''
  let appliedCount = 0

  for (const ev of events) {
    const v = validateEvent(ev)
    if (!v.ok) {
      // legacy kind(如旧客户端的 pet_level_up)/ 越界 delta / 非法 eventId:
      // 直接 drain 让 client 把它从 pending 移除,不写 ledger 不动 balance。
      // 缺合法 eventId 的就只能 silently skip(没法 drain client)。
      if (ev && typeof ev.eventId === 'string' && ev.eventId.length > 0) {
        droppedEventIds.push(ev.eventId)
        appliedEventIds.push(ev.eventId)
      }
      console.warn('[coinLedger] dropping bad event', v.reason, ev && ev.eventId)
      continue
    }

    if (seenIds.has(ev.eventId)) {
      // 之前已入账。也加进 appliedEventIds 让 client 排空 —— 应对上次返回包
      // 丢了 / client 没 drain 成功的 retry。balance 已经包含它的效果,这里
      // 不重复写 ledger 不重复 inc。
      appliedEventIds.push(ev.eventId)
      continue
    }

    const requestedDelta = Math.trunc(Number(ev.delta))
    let effectiveDelta = requestedDelta
    let clipped = false
    if (balance + requestedDelta < 0) {
      // 服务端 balance 不允许负 —— clip 到 0(跟客户端 applyCoinDelta 的
      // max(0, ...) 一致)。这样单条还不起钱的 event 不会 poison 后续 event,
      // 该 event 仍然被 drain,只是 server 这边按 -balance 入账。
      effectiveDelta = -balance
      clipped = true
    }

    try {
      await db.collection(LEDGER_COLLECTION).add({
        data: {
          _openid: openid,
          eventId: ev.eventId,
          kind: ev.kind,
          delta: effectiveDelta,
          ...(clipped ? { requestedDelta, clipped: true } : {}),
          balanceAfter: balance + effectiveDelta,
          clientTs: Number(ev.ts) || 0,
          meta: ev.meta && typeof ev.meta === 'object' ? ev.meta : null,
          createdAt: Date.now()
        }
      })
    } catch (e) {
      // 写 ledger 失败:系统级问题(quota / 网络),break 让客户端下次整批重试。
      // 已经写过的 ledger 条目下面会按 writtenEventIds rollback。
      stopReason = 'ledger_write_failed'
      break
    }
    balance += effectiveDelta
    netDelta += effectiveDelta
    appliedEventIds.push(ev.eventId)
    writtenEventIds.push(ev.eventId)
    if (clipped) clippedEventIds.push(ev.eventId)
    appliedCount += 1
  }

  if (netDelta !== 0) {
    // 一次性更新 user_state.state.coins。用 inc 保证和 cloud-sync 自然 push
    // 的字段不打架(coins 不在 SYNC_FIELDS,所以 coins 字段只有我们写)。
    let incApplied = false
    try {
      const upd = await db.collection(USER_COLLECTION)
        .where({ _openid: openid })
        .update({ data: { state: { coins: db.command.inc(netDelta) } } })
      incApplied = !!(upd && upd.stats && upd.stats.updated > 0)
      if (!incApplied) {
        console.warn('[coinLedger] balance update affected 0 rows; user_state missing for', openid)
      }
    } catch (e) {
      console.warn('[coinLedger] balance update threw', e && e.errMsg)
    }
    if (!incApplied) {
      // 余额更新失败,只 rollback 真正写进 ledger 的那批 —— seen / dropped 的
      // 没写过 ledger,不需要 rollback。
      for (const eid of writtenEventIds) {
        try {
          await db.collection(LEDGER_COLLECTION)
            .where({ _openid: openid, eventId: eid })
            .remove()
        } catch (e) {
          console.warn('[coinLedger] ledger rollback failed for', eid, e && e.errMsg)
        }
      }
      return {
        ok: false,
        reason: 'balance_update_failed',
        rolledBackEventIds: writtenEventIds
      }
    }
  }

  return {
    ok: true,
    appliedCount,
    skippedCount: events.length - appliedCount,
    appliedEventIds,
    droppedEventIds,
    clippedEventIds,
    newBalance: balance,
    lastReason: stopReason
  }
}
