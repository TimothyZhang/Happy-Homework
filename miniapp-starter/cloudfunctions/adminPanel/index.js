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
//   listCoinLedger   → 金币流水（coin_ledger 服务端账本，admin only）
//   claimAdminCoins  → 任意用户拉/清自己的 inbox（**不需要 admin**）
//
// 管理员白名单：环境变量 ADMIN_OPENIDS（逗号分隔）。未配置 = 无管理员。

const cloud = require('wx-server-sdk')
const crypto = require('crypto')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const USER_COLLECTION = 'user_state'
const AUDIT_COLLECTION = 'coin_adjustments'
const INBOX_COLLECTION = 'admin_coin_inbox'
const RATE_COLLECTION = 'admin_action_rate'
const LEDGER_COLLECTION = 'coin_ledger'    // 和 coinLedger 云函数共用
const LOGIN_COLLECTION = 'login_logs'      // 登录日志:每次冷启动记一条
const LIST_LIMIT_DEFAULT = 100
const LIST_LIMIT_MAX = 1000
const LOGIN_LIST_LIMIT_DEFAULT = 50
// 去重窗口:同一 openid+sessionId+envVersion 10 分钟内只记一条,挡反复切前台刷屏。
const LOGIN_DEDUP_MS = 10 * 60 * 1000
const DELTA_MAX_ABS = 1000000
const INBOX_CLAIM_LIMIT = 200       // 单次 claim 最多拉多少条 inbox 记录

// adjustCoins 限流。admin 是人工操作,30 次/分钟足够;主要是挡住 admin
// 账号一旦被盗后,攻击者脚本无限刷调整的场景。
const ADJUST_RATE_WINDOW_MS = 60 * 1000
const ADJUST_RATE_MAX_PER_WINDOW = 30

// 硬编码管理员 openid 列表 —— 改这里比去云开发面板配环境变量省事(且 diff 可见)。
// 也可以同时配环境变量 ADMIN_OPENIDS（逗号分隔），两边都会生效。
// 把你自己的 openid 加在这里：
const ADMIN_OPENIDS_HARDCODED = [
  'ouEU23X1jzDKNgAiWKpO9kQukUm8'  // Tim (蛋仔) — 注意第 17 位是大写 O 不是 0
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

  // submitFeedback 任何用户都能调（提交建议/反馈,落 feedback 集合）。
  if (action === 'submitFeedback') {
    try {
      return await submitFeedback({ ...event, openid: callerOpenid })
    } catch (e) {
      console.error('[adminPanel] submitFeedback failed', e)
      return { ok: false, reason: 'internal_error', message: (e && e.errMsg) || String(e) }
    }
  }

  // logLogin 任何用户都能调（记一条自己的登录日志,服务端权威时间 + 设备 + 版本）。
  if (action === 'logLogin') {
    try {
      return await logLogin({ ...event, openid: callerOpenid })
    } catch (e) {
      console.error('[adminPanel] logLogin failed', e)
      return { ok: false, reason: 'internal_error', message: (e && e.errMsg) || String(e) }
    }
  }

  // listMyLogins 任何用户都能调（看自己的登录记录,设置页用）。
  if (action === 'listMyLogins') {
    try {
      return await listMyLogins(callerOpenid, event)
    } catch (e) {
      console.error('[adminPanel] listMyLogins failed', e)
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
      const rateOk = await checkAdminRateLimit(callerOpenid, 'adjustCoins')
      if (!rateOk) {
        return { ok: false, reason: 'rate_limited', retryAfterMs: ADJUST_RATE_WINDOW_MS }
      }
      return await adjustCoins({ ...event, adminOpenid: callerOpenid })
    }
    if (action === 'listAdjustments') {
      return await listAdjustments(event)
    }
    if (action === 'listCoinLedger') {
      return await listCoinLedger(event)
    }
    if (action === 'listFeedback') {
      return await listFeedback(event)
    }
    if (action === 'listLogins') {
      return await listLogins(event)
    }
    return { ok: false, reason: 'unknown_action' }
  } catch (e) {
    console.error('[adminPanel] action failed', action, e)
    return { ok: false, reason: 'internal_error', message: (e && e.errMsg) || String(e) }
  }
}

// 每个 admin × action 一条文档。每次调用查一次,跨过 window 重置 count,
// 没跨过且 count 满了就拒。
//   { _openid: adminOpenid, action: 'adjustCoins', count, windowStart }
async function checkAdminRateLimit(adminOpenid, action) {
  await ensureCollection(RATE_COLLECTION)
  const db = cloud.database()
  const now = Date.now()
  const res = await db.collection(RATE_COLLECTION)
    .where({ _openid: adminOpenid, action })
    .limit(1)
    .get()
  const doc = (res.data && res.data[0]) || null
  if (!doc) {
    await db.collection(RATE_COLLECTION).add({
      data: { _openid: adminOpenid, action, count: 1, windowStart: now }
    })
    return true
  }
  if (now - (doc.windowStart || 0) > ADJUST_RATE_WINDOW_MS) {
    await db.collection(RATE_COLLECTION).doc(doc._id).update({
      data: { count: 1, windowStart: now }
    })
    return true
  }
  if ((doc.count || 0) >= ADJUST_RATE_MAX_PER_WINDOW) {
    return false
  }
  await db.collection(RATE_COLLECTION).doc(doc._id).update({
    data: { count: db.command.inc(1) }
  })
  return true
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

// 任意用户都能调（不走 admin 白名单）：拉自己 inbox 里所有 unclaimed 记录、
// 写 coin_ledger 服务端审计、删除 inbox、标记 audit、返 items 给 client。
//
// 客户端 = truth 架构下,server 不再 inc user_state.state.coins、不再 clamp。
// 每条 item 把 raw delta 推给 client,client 自己 applyCoinDelta 入账(允许
// 把余额拍负)。server 这边只留 immutable 审计。
async function claimAdminCoins(callerOpenid) {
  if (!callerOpenid) return { ok: false, reason: 'no_openid' }
  await ensureCollection(INBOX_COLLECTION)
  const db = cloud.database()

  // 拉 inbox。WeChat 云开发的 ACL「仅创建者可读写」对 _openid 做匹配；这里
  // 云函数 admin SDK 不依赖 ACL，直接 by _openid 过滤更稳。
  const res = await db.collection(INBOX_COLLECTION)
    .where({ _openid: callerOpenid, claimed: false })
    .orderBy('createdAt', 'asc')
    .limit(INBOX_CLAIM_LIMIT)
    .get()

  const rows = res.data || []
  if (rows.length === 0) {
    return { ok: true, total: 0, count: 0, items: [] }
  }

  const clientItems = []
  let totalDelta = 0
  let addedTotal = 0
  let deductedTotal = 0
  for (const r of rows) {
    const delta = Math.trunc(Number(r.delta) || 0)
    totalDelta += delta
    if (delta > 0) addedTotal += delta
    else if (delta < 0) deductedTotal += delta
    clientItems.push({
      delta,
      reason: r.reason || '',
      adminOpenid: r.adminOpenid || '',
      auditId: r.auditId || '',
      createdAt: r.createdAt || 0
    })
  }

  // ledger summary 做服务端审计。dedup 用 inboxIds 哈希 —— client 重试时
  // 第二次过来看到 alreadyApplied,会拿到 total=0 不重复入账。
  await ensureCollection(LEDGER_COLLECTION)
  const inboxIds = rows.map((r) => r._id).slice().sort()
  const inboxHash = crypto.createHash('sha256').update(inboxIds.join(',')).digest('hex').slice(0, 16)
  const eventId = `admin_claim:${inboxHash}`
  const existingLedger = await db.collection(LEDGER_COLLECTION)
    .where({ _openid: callerOpenid, eventId })
    .limit(1)
    .get()
  const alreadyApplied = !!(existingLedger.data && existingLedger.data.length > 0)
  if (!alreadyApplied) {
    try {
      await db.collection(LEDGER_COLLECTION).add({
        data: {
          _openid: callerOpenid,
          eventId,
          kind: 'admin_coin_claim',
          delta: totalDelta,
          meta: {
            count: rows.length,
            inboxIds,
            items: clientItems.map((it) => ({ delta: it.delta, auditId: it.auditId }))
          },
          clientTs: 0,
          createdAt: Date.now()
        }
      })
    } catch (e) {
      console.warn('[adminPanel] ledger write failed', e && e.errMsg)
      // 不致命 —— audit 失败但奖励照发,client 自己入账。
    }
  }

  // 删除 inbox + 标记 audit (best-effort)。
  for (const r of rows) {
    try {
      await db.collection(INBOX_COLLECTION).doc(r._id).remove()
    } catch (e) {
      console.warn('[adminPanel] inbox remove failed', r._id, e && e.errMsg)
    }
  }
  await ensureCollection(AUDIT_COLLECTION)
  for (const it of clientItems) {
    if (!it.auditId) continue
    try {
      await db.collection(AUDIT_COLLECTION).doc(it.auditId).update({
        data: {
          claimed: true,
          claimedAt: Date.now(),
          appliedDelta: it.delta
        }
      })
    } catch (e) {
      console.warn('[adminPanel] audit mark-claimed failed', it.auditId, e && e.errMsg)
    }
  }

  if (alreadyApplied) {
    // 重试场景:之前 ledger 已经记过这批,这次不让 client 二次入账。
    return {
      ok: true,
      total: 0,
      totalApplied: 0,
      addedTotal: 0,
      deductedTotal: 0,
      count: 0,
      items: [],
      eventId,
      alreadyApplied: true
    }
  }

  return {
    ok: true,
    total: totalDelta,
    totalApplied: totalDelta,
    addedTotal,
    deductedTotal,
    count: rows.length,
    items: clientItems,
    eventId
  }
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

// 查询 coin_ledger(服务端权威金币账本)。
// 不传 targetOpenid 时返回全局倒序流水(便于巡检),传了就只看那个用户。
// 可选 kind 过滤(task_reward / pet_purchase / admin_coin_claim / ...)。
async function listCoinLedger(event) {
  await ensureCollection(LEDGER_COLLECTION)
  const db = cloud.database()
  const limit = Math.min(LIST_LIMIT_MAX, Math.max(1, Number(event.limit) || LIST_LIMIT_DEFAULT))
  const skip = Math.max(0, Number(event.skip) || 0)
  const target = (event.targetOpenid || '').trim()
  const kind = (event.kind || '').trim()
  const filter = {}
  if (target) filter._openid = target
  if (kind) filter.kind = kind
  let q = db.collection(LEDGER_COLLECTION)
  if (Object.keys(filter).length) q = q.where(filter)
  const res = await q.orderBy('createdAt', 'desc').skip(skip).limit(limit).get()
  const rows = res.data || []
  let total = rows.length + skip
  try {
    let cq = db.collection(LEDGER_COLLECTION)
    if (Object.keys(filter).length) cq = cq.where(filter)
    const c = await cq.count()
    if (c && typeof c.total === 'number') total = c.total
  } catch (e) {
    // count 失败不阻塞列表
  }
  return { ok: true, rows, total, limit, skip }
}

const FEEDBACK_COLLECTION = 'feedback'
// 剥掉控制字符 / 零宽 / bidi 标记（字面量会让源文件含不可见字符，git 当 binary）。
const FEEDBACK_BAD_CHARS_RE = new RegExp(
  '[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]',
  'g'
)
function cleanFeedbackStr(s, max) {
  return String(s == null ? '' : s).replace(FEEDBACK_BAD_CHARS_RE, '').trim().slice(0, max)
}

// 任何用户提交建议/反馈。落 feedback 集合,管理员用 listFeedback 看。
async function submitFeedback({ openid, text, contact, version }) {
  const body = cleanFeedbackStr(text, 1000)
  if (!body) return { ok: false, reason: 'empty' }
  await ensureCollection(FEEDBACK_COLLECTION)
  const db = cloud.database()
  // 轻量防刷:同一用户 30 秒内最多 5 条。
  try {
    const since = Date.now() - 30000
    const recent = await db.collection(FEEDBACK_COLLECTION)
      .where({ _openid: openid, createdAt: db.command.gt(since) }).count()
    if (recent && recent.total >= 5) return { ok: false, reason: 'too_frequent' }
  } catch (e) { /* count 失败不挡提交 */ }
  // 顺手带上昵称,管理员看着方便(best-effort)。
  let nickname = ''
  try {
    const u = await db.collection(USER_COLLECTION).where({ _openid: openid }).field({ state: true }).limit(1).get()
    const p = u.data && u.data[0] && u.data[0].state && u.data[0].state.profile
    if (p && p.nickname) nickname = cleanFeedbackStr(p.nickname, 40)
  } catch (e) { /* ignore */ }
  await db.collection(FEEDBACK_COLLECTION).add({
    data: {
      _openid: openid,
      text: body,
      contact: cleanFeedbackStr(contact, 100),
      version: cleanFeedbackStr(version, 40),
      nickname,
      createdAt: Date.now()
    }
  })
  return { ok: true }
}

// 管理员看反馈列表(按时间倒序)。
async function listFeedback(event) {
  await ensureCollection(FEEDBACK_COLLECTION)
  const db = cloud.database()
  const limit = Math.min(LIST_LIMIT_MAX, Math.max(1, Number(event.limit) || LIST_LIMIT_DEFAULT))
  const skip = Math.max(0, Number(event.skip) || 0)
  const res = await db.collection(FEEDBACK_COLLECTION).orderBy('createdAt', 'desc').skip(skip).limit(limit).get()
  const rows = res.data || []
  let total = rows.length + skip
  try {
    const c = await db.collection(FEEDBACK_COLLECTION).count()
    if (c && typeof c.total === 'number') total = c.total
  } catch (e) { /* count 失败不阻塞 */ }
  return { ok: true, rows, total, limit, skip }
}

// === 登录日志 ===
// 每次客户端冷启动调一次 logLogin,记下「服务端时间 + 设备 + 版本(体验/正式/开发)
// + cloud-sync 设备会话 id」。这串信息正好对得上「多版本 = 多 session 抢同步」那个
// 丢数据根因 —— 在设置/admin 里翻登录记录,就能看出哪台设备、哪个版本、什么时候上来过。

// 记一条登录。同一 openid+sessionId+envVersion 10 分钟内去重(切前台不重复刷)。
async function logLogin({ openid, device, version }) {
  if (!openid) return { ok: false, reason: 'no_openid' }
  await ensureCollection(LOGIN_COLLECTION)
  const db = cloud.database()
  const now = Date.now()
  const dev = device || {}
  const ver = version || {}
  const sessionId = cleanFeedbackStr(dev.sessionId, 64)
  const envVersion = cleanFeedbackStr(ver.envVersion, 20)
  try {
    if (sessionId) {
      const since = now - LOGIN_DEDUP_MS
      const dup = await db.collection(LOGIN_COLLECTION)
        .where({ _openid: openid, sessionId, envVersion, at: db.command.gt(since) })
        .count()
      if (dup && dup.total > 0) return { ok: true, deduped: true }
    }
  } catch (e) { /* count 失败就照常记 */ }
  let nickname = ''
  try {
    const u = await db.collection(USER_COLLECTION).where({ _openid: openid }).field({ state: true }).limit(1).get()
    const p = u.data && u.data[0] && u.data[0].state && u.data[0].state.profile
    if (p && p.nickname) nickname = cleanFeedbackStr(p.nickname, 40)
  } catch (e) { /* ignore */ }
  await db.collection(LOGIN_COLLECTION).add({
    data: {
      _openid: openid,
      at: now,                                       // 服务端权威时间
      clientAt: Number(dev.clientAt) || 0,
      envVersion,                                    // develop / trial / release
      buildVersion: cleanFeedbackStr(ver.buildVersion, 40),
      sdkVersion: cleanFeedbackStr(dev.sdkVersion, 24),
      brand: cleanFeedbackStr(dev.brand, 40),
      model: cleanFeedbackStr(dev.model, 80),
      system: cleanFeedbackStr(dev.system, 48),
      platform: cleanFeedbackStr(dev.platform, 24),
      sessionId,
      scene: Number(dev.scene) || 0,
      nickname
    }
  })
  return { ok: true }
}

// 看自己的登录记录(设置页)。靠 _openid 过滤,任何用户可调。
async function listMyLogins(openid, event) {
  if (!openid) return { ok: false, reason: 'no_openid' }
  await ensureCollection(LOGIN_COLLECTION)
  const db = cloud.database()
  const limit = Math.min(200, Math.max(1, Number(event.limit) || LOGIN_LIST_LIMIT_DEFAULT))
  const res = await db.collection(LOGIN_COLLECTION)
    .where({ _openid: openid })
    .orderBy('at', 'desc')
    .limit(limit)
    .get()
  return { ok: true, rows: res.data || [] }
}

// 管理员看登录记录:不传 targetOpenid → 全局倒序(巡检多设备/多版本);传了只看那人。
async function listLogins(event) {
  await ensureCollection(LOGIN_COLLECTION)
  const db = cloud.database()
  const limit = Math.min(LIST_LIMIT_MAX, Math.max(1, Number(event.limit) || LOGIN_LIST_LIMIT_DEFAULT))
  const skip = Math.max(0, Number(event.skip) || 0)
  const target = (event.targetOpenid || '').trim()
  let q = db.collection(LOGIN_COLLECTION)
  if (target) q = q.where({ _openid: target })
  const res = await q.orderBy('at', 'desc').skip(skip).limit(limit).get()
  const rows = res.data || []
  let total = rows.length + skip
  try {
    let cq = db.collection(LOGIN_COLLECTION)
    if (target) cq = cq.where({ _openid: target })
    const c = await cq.count()
    if (c && typeof c.total === 'number') total = c.total
  } catch (e) { /* count 失败不阻塞 */ }
  return { ok: true, rows, total, limit, skip }
}
