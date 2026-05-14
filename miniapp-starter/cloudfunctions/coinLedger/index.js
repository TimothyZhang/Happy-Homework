'use strict'

// 金币账本云函数 (v2: level_upgrade 上限从 -100000 收紧到 -10000)。
//
// 历史背景:state.coins 之前在 cloud-sync 的 SYNC_FIELDS 里随 state 一起
// 整包 push,客户端篡改 localStorage 就能直接覆盖云端余额。这个云函数把
// 余额改成由服务端持有 —— 客户端只能上报"事件"(完成作业/购买宠物/...),
// 由服务端按 kind 校验后写入 user_state.state.coins + coin_ledger 审计。
//
// 接口:
//   commit  → 批量提交事件,返回 { ok, appliedCount, newBalance, lastReason }
//   balance → 仅查当前余额
//
// 事件 schema(client → server):
//   { eventId: string,   // client UUID,服务端 dedup
//     kind: string,       // 见下方 EVENT_RULES
//     delta: number,      // 带符号整数
//     ts: number,         // client 时间,仅用于审计
//     meta?: object }     // taskId / itemId 之类,审计用
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

  // 先把全部事件 schema 校验过一遍 —— 任何一条不合规直接整批拒,简化语义。
  for (const ev of events) {
    const v = validateEvent(ev)
    if (!v.ok) return { ok: false, reason: 'bad_event', detail: v.reason, eventId: ev && ev.eventId }
  }

  // 批量累计 delta 也要在硬上限内
  const totalAbs = events.reduce((s, ev) => s + Math.abs(Number(ev.delta) || 0), 0)
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
  const eventIds = events.map((ev) => ev.eventId)
  const dupRes = await db.collection(LEDGER_COLLECTION)
    .where({ _openid: openid, eventId: db.command.in(eventIds) })
    .field({ eventId: true })
    .limit(MAX_EVENTS_PER_CALL)
    .get()
  const seenIds = new Set((dupRes.data || []).map((d) => d.eventId))

  const appliedEventIds = []
  let netDelta = 0
  let stopReason = ''
  let appliedCount = 0

  // 按顺序处理。先做余额校验(spend 不能让余额变负),通过后写 ledger。
  // 中途遇到余额不足:停止,前面已写的 ledger + balance update 仍然有效。
  // 已 seen 的 eventId:跳过,不计 appliedCount,但 newBalance 反映真实余额。
  for (const ev of events) {
    if (seenIds.has(ev.eventId)) {
      // 之前已经入账,余额已经包含它,跳过
      continue
    }
    const delta = Math.trunc(Number(ev.delta))
    if (balance + delta < 0) {
      // 余额不够,提前停。前面已写的事件保留。
      stopReason = 'insufficient_balance'
      break
    }
    try {
      await db.collection(LEDGER_COLLECTION).add({
        data: {
          _openid: openid,
          eventId: ev.eventId,
          kind: ev.kind,
          delta,
          balanceAfter: balance + delta,
          clientTs: Number(ev.ts) || 0,
          meta: ev.meta && typeof ev.meta === 'object' ? ev.meta : null,
          createdAt: Date.now()
        }
      })
    } catch (e) {
      // 写 ledger 失败:停。已成功的保留,balance 不增。
      stopReason = 'ledger_write_failed'
      break
    }
    balance += delta
    netDelta += delta
    appliedEventIds.push(ev.eventId)
    appliedCount += 1
  }

  if (netDelta !== 0) {
    // 一次性更新 user_state.state.coins。用 inc 保证和 cloud-sync 自然 push
    // 的字段不打架(其它字段 push 的是整对象,但 cloud-sync push 已经把
    // coins 从 SYNC_FIELDS 里剔除,所以 coins 字段只有我们写)。
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
      // 余额更新失败,ledger 条目已经写了 → roll back 这批 ledger,让 client
      // 下次重试时 server dedup 不会拦住事件、能重新走完整流程。如果 rollback
      // 自己也失败,残留 orphan ledger 条目只是审计噪声,balance 仍是对的。
      for (const eid of appliedEventIds) {
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
        rolledBackEventIds: appliedEventIds
      }
    }
  }

  return {
    ok: true,
    appliedCount,
    skippedCount: events.length - appliedCount,
    appliedEventIds,
    newBalance: balance,
    lastReason: stopReason
  }
}
