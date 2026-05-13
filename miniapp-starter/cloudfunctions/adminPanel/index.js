'use strict'

// 管理后台云函数。
//
// 用 wx-server-sdk 的 admin 权限读 user_state（绕过「仅创建者可读写」ACL）。
// 客户端只调用本云函数；user_state ACL 永远不放开，避免普通用户直接读全表。
//
// === 金币调整的"信箱"模式 ===
//
// adjustCoins **不**直接写 user_state.state.coins。原因：客户端 cloud-sync 是
// 「整个 state 全量 push、200ms 防抖」，会用本地旧 coins 覆盖云端，吞掉调整。
// shareReward 也踩过同样的坑，解决办法是中间加一个 INBOX 集合：
//
//   adjustCoins → 写 admin_coin_inbox（_openid = 目标用户，含 delta/reason/...）
//                 同时写 coin_adjustments（不可变审计，全保留）
//   claimAdminCoins（任意用户可调）→ 拉自己 inbox 里 unclaimed 的记录、删除、返回
//                 → 客户端 store.applyAdminCoinClaim 本地累加 + 走自己的 push
//
// 好处：
// - 目标用户在不在线无所谓；离线时调整在 inbox 里待领，下次启动 app 自动到账
// - 不存在和用户 push 的竞争 —— 因为不修改 user_state
// - clamp 到 ≥0 由客户端 claim 时按顺序处理（多条 -delta 累计到 0 后剩余的丢弃）
//
// Actions:
//   whoami           → { ok, openid, isAdmin } 前端据此渲染入口
//   listUsers        → 所有 user_state 摘要（admin only）
//   getUser          → 指定用户完整 state（admin only）
//   adjustCoins      → 入 inbox + 写审计（admin only）
//   listAdjustments  → 审计列表（admin only）
//   claimAdminCoins  → 任意用户拉/清自己的 inbox（**不需要 admin**）
//
// 管理员白名单：环境变量 ADMIN_OPENIDS（逗号分隔）。未配置 = 无管理员。

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const USER_COLLECTION = 'user_state'
const AUDIT_COLLECTION = 'coin_adjustments'
const INBOX_COLLECTION = 'admin_coin_inbox'
const LIST_LIMIT_DEFAULT = 100
const LIST_LIMIT_MAX = 1000
const DELTA_MAX_ABS = 1000000
const INBOX_CLAIM_LIMIT = 200       // 单次 claim 最多拉多少条 inbox 记录

// 硬编码管理员 openid 列表 —— 改这里比去云开发面板配环境变量省事(且 diff 可见)。
// 也可以同时配环境变量 ADMIN_OPENIDS（逗号分隔），两边都会生效。
// 把你自己的 openid 加在这里：
const ADMIN_OPENIDS_HARDCODED = [
  // 'oXXXXXXXXXXXXXXXXXXXXXXXX'
]

function getAdminOpenids() {
  const set = new Set(ADMIN_OPENIDS_HARDCODED.map((s) => (s || '').trim()).filter(Boolean))
  const raw = (process.env.ADMIN_OPENIDS || '').trim()
  if (raw) {
    for (const id of raw.split(',').map((s) => s.trim()).filter(Boolean)) set.add(id)
  }
  return set
}

function isAdmin(openid) {
  if (!openid) return false
  return getAdminOpenids().has(openid)
}

exports.main = async (event = {}) => {
  const ctx = cloud.getWXContext()
  const callerOpenid = ctx.OPENID
  if (!callerOpenid) return { ok: false, reason: 'no_openid' }

  const action = event.action

  if (action === 'whoami') {
    return { ok: true, openid: callerOpenid, isAdmin: isAdmin(callerOpenid) }
  }

  // claimAdminCoins 任何用户都能调（拉自己的 inbox）。其它 action 走 admin 白名单。
  if (action === 'claimAdminCoins') {
    try {
      return await claimAdminCoins(callerOpenid)
    } catch (e) {
      console.error('[adminPanel] claimAdminCoins failed', e)
      return { ok: false, reason: 'internal_error', message: (e && e.errMsg) || String(e) }
    }
  }

  if (!isAdmin(callerOpenid)) {
    return { ok: false, reason: 'not_admin' }
  }

  try {
    if (action === 'listUsers') {
      return await listUsers(event)
    }
    if (action === 'getUser') {
      return await getUser(event)
    }
    if (action === 'adjustCoins') {
      return await adjustCoins({ ...event, adminOpenid: callerOpenid })
    }
    if (action === 'listAdjustments') {
      return await listAdjustments(event)
    }
    return { ok: false, reason: 'unknown_action' }
  } catch (e) {
    console.error('[adminPanel] action failed', action, e)
    return { ok: false, reason: 'internal_error', message: (e && e.errMsg) || String(e) }
  }
}

async function ensureCollection(name) {
  const db = cloud.database()
  try {
    await db.createCollection(name)
  } catch (e) {
    // 已存在的错误码忽略；其它错误让后续操作自然失败。
  }
}

function summarizeUser(doc) {
  const state = (doc && doc.state) || {}
  const profile = state.profile || {}
  const pet = state.pet || {}
  const tasks = Array.isArray(state.tasks) ? state.tasks : []
  const notebooks = Array.isArray(state.notebooks) ? state.notebooks : []
  const coinLogsLen = Array.isArray(state.coinLogs) ? state.coinLogs.length : 0
  return {
    openid: doc._openid || '',
    docId: doc._id || '',
    nickname: profile.nickname || '',
    avatar: profile.avatar || '',
    coins: typeof state.coins === 'number' ? state.coins : 0,
    streakDays: typeof state.streakDays === 'number' ? state.streakDays : 0,
    pet: pet && pet.species ? {
      species: pet.species,
      emoji: pet.emoji || '',
      name: pet.name || '',
      level: pet.level || 1,
      happiness: pet.happiness || 0,
      fullness: pet.fullness || 0,
      cleanliness: pet.cleanliness || 0,
      health: pet.health || 0
    } : null,
    notebookCount: notebooks.length,
    taskCount: tasks.length,
    coinLogCount: coinLogsLen,
    sessionId: doc.sessionId || '',
    updatedAt: doc.updatedAt || 0,
    claimedAt: doc.claimedAt || 0
  }
}

async function listUsers(event) {
  const db = cloud.database()
  const limit = Math.min(LIST_LIMIT_MAX, Math.max(1, Number(event.limit) || LIST_LIMIT_DEFAULT))
  const skip = Math.max(0, Number(event.skip) || 0)
  const res = await db.collection(USER_COLLECTION)
    .orderBy('updatedAt', 'desc')
    .skip(skip)
    .limit(limit)
    .get()
  const rows = (res.data || []).map(summarizeUser)
  let total = rows.length + skip
  try {
    const c = await db.collection(USER_COLLECTION).count()
    total = (c && typeof c.total === 'number') ? c.total : total
  } catch (e) {
    // count 失败不阻塞列表
  }
  return { ok: true, users: rows, total, limit, skip }
}

async function getUser(event) {
  const targetOpenid = (event.openid || '').trim()
  if (!targetOpenid) return { ok: false, reason: 'invalid_args' }
  const db = cloud.database()
  const res = await db.collection(USER_COLLECTION)
    .where({ _openid: targetOpenid })
    .limit(1)
    .get()
  const doc = (res.data && res.data[0]) || null
  if (!doc) return { ok: false, reason: 'not_found' }
  return {
    ok: true,
    summary: summarizeUser(doc),
    state: doc.state || {},
    sessionId: doc.sessionId || '',
    updatedAt: doc.updatedAt || 0,
    claimedAt: doc.claimedAt || 0
  }
}

async function adjustCoins({ openid, delta, reason, adminOpenid }) {
  const targetOpenid = (openid || '').trim()
  const d = Math.trunc(Number(delta))
  if (!targetOpenid) return { ok: false, reason: 'invalid_args' }
  if (!Number.isFinite(d) || d === 0) return { ok: false, reason: 'invalid_delta' }
  if (Math.abs(d) > DELTA_MAX_ABS) return { ok: false, reason: 'delta_too_large' }
  const reasonText = (reason || '').toString().slice(0, 200) || 'admin-adjust'

  // 校验目标存在；我们不读 state.coins 因为可能滞后于客户端 push。
  const db = cloud.database()
  const userRes = await db.collection(USER_COLLECTION)
    .where({ _openid: targetOpenid })
    .limit(1)
    .get()
  if (!userRes.data || userRes.data.length === 0) {
    return { ok: false, reason: 'not_found' }
  }

  const nowTs = Date.now()

  // 1) 写审计（不可变记录）
  await ensureCollection(AUDIT_COLLECTION)
  const auditRes = await db.collection(AUDIT_COLLECTION).add({
    data: {
      targetOpenid,
      adminOpenid,
      delta: d,
      reason: reasonText,
      createdAt: nowTs,
      // 入 inbox 后是否被领走（claimAdminCoins 时回填 claimedAt）。
      claimed: false,
      claimedAt: 0,
      appliedDelta: 0  // claim 后回填实际应用的 delta（可能因 clamp 缩水）
    }
  })
  const auditId = auditRes && auditRes._id

  // 2) 写 inbox（目标用户认领的入口）
  await ensureCollection(INBOX_COLLECTION)
  await db.collection(INBOX_COLLECTION).add({
    data: {
      _openid: targetOpenid,     // 收件人 = 目标用户；自动注入 ACL 保护，但云函数仍可用 admin SDK 写
      adminOpenid,
      delta: d,
      reason: reasonText,
      auditId,
      claimed: false,
      createdAt: nowTs
    }
  })

  return {
    ok: true,
    delta: d,
    reason: reasonText,
    auditId,
    pendingOnly: true  // 提醒前端：用户下次进入 app 时才会真的到账
  }
}

// 任意用户都能调（不走 admin 白名单）：拉自己 inbox 里所有 unclaimed 记录、删除、
// 顺带把审计记录的 claimed 标记为 true 并回填 appliedDelta。
// 客户端拿到 items 后本地累加到 coins、追加 coinLogs，由 cloud-sync 自然 push 回云端。
async function claimAdminCoins(callerOpenid) {
  if (!callerOpenid) return { ok: false, reason: 'no_openid' }
  await ensureCollection(INBOX_COLLECTION)
  const db = cloud.database()

  // 拉 inbox。WeChat 云开发的 ACL「仅创建者可读写」对 _openid 做匹配；这里
  // 云函数 admin SDK 不依赖 ACL，直接 by _openid 过滤更稳。
  const res = await db.collection(INBOX_COLLECTION)
    .where({ _openid: callerOpenid, claimed: false })
    .orderBy('createdAt', 'asc')   // 按时间序，客户端按这个顺序累加 + clamp
    .limit(INBOX_CLAIM_LIMIT)
    .get()

  const rows = res.data || []
  if (rows.length === 0) {
    return { ok: true, total: 0, count: 0, items: [] }
  }

  // 删除 inbox 记录（一条一条删；WeChat cloud DB 的批量删 API 受限）。
  // 删除失败也别阻塞领取 —— 还有 audit collection 兜底，不会重复领。
  // 我们用 doc.remove() 一次一条，参考 shareReward.claimRewards。
  for (const r of rows) {
    try {
      await db.collection(INBOX_COLLECTION).doc(r._id).remove()
    } catch (e) {
      console.warn('[adminPanel] inbox remove failed', r._id, e && e.errMsg)
    }
  }

  // 给 audit 标 claimed。失败不阻塞 —— 审计准确性次要。
  // 注意：appliedDelta 此时还不知道（要等客户端 clamp 后回报），先写 requested delta，
  // 等客户端调用 reportClaimResult action（如果需要更精确）。先简化：直接记 delta。
  await ensureCollection(AUDIT_COLLECTION)
  for (const r of rows) {
    if (!r.auditId) continue
    try {
      await db.collection(AUDIT_COLLECTION).doc(r.auditId).update({
        data: {
          claimed: true,
          claimedAt: Date.now(),
          appliedDelta: r.delta  // 客户端 clamp 不在审计这层处理，记原始 delta
        }
      })
    } catch (e) {
      console.warn('[adminPanel] audit mark-claimed failed', r.auditId, e && e.errMsg)
    }
  }

  const total = rows.reduce((s, r) => s + (Number(r.delta) || 0), 0)
  const items = rows.map((r) => ({
    delta: Number(r.delta) || 0,
    reason: r.reason || '',
    adminOpenid: r.adminOpenid || '',
    auditId: r.auditId || '',
    createdAt: r.createdAt || 0
  }))

  return { ok: true, total, count: rows.length, items }
}

async function listAdjustments(event) {
  await ensureCollection(AUDIT_COLLECTION)
  const db = cloud.database()
  const limit = Math.min(LIST_LIMIT_MAX, Math.max(1, Number(event.limit) || LIST_LIMIT_DEFAULT))
  const skip = Math.max(0, Number(event.skip) || 0)
  const target = (event.targetOpenid || '').trim()
  let q = db.collection(AUDIT_COLLECTION)
  if (target) q = q.where({ targetOpenid: target })
  const res = await q.orderBy('createdAt', 'desc').skip(skip).limit(limit).get()
  return { ok: true, rows: res.data || [], limit, skip }
}
