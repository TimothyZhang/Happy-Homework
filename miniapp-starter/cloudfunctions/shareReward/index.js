'use strict'

// 分享奖励云函数
//
// 四个 action：
//   whoami     — 返回调用者的 OPENID，用于客户端缓存自己的身份
//   credit     — 接收方导入分享的作业本时调用，往 INBOX 里写一条奖励记录
//   claim      — 分享方拉取并领取属于自己的奖励记录（读 + 删除 + 返回总额）
//   getProfile — 按 openid 查分享者公开 profile (nickname/avatar)，给接收页展示
//                "X 分享给你的作业本"。openid 不是机密(分享方主动写进 payload),
//                返回也只限 profile 两个字段,不暴露其它 user_state。
//
// 使用 INBOX 集合而不是直接改 user_state，是为了避免和现有 cloud-sync
// 的"单设备写"模型冲突 —— user_state 写入由分享方自己的设备控制，奖励
// 通过领取的方式合并进去。
//
// 集合 share_rewards_inbox 推荐 ACL：仅创建者可读写。
// 云函数用 admin 权限绕过 ACL，可以为任意 _openid 写记录、按 openid 查询删除。

const cloud = require('wx-server-sdk')
const crypto = require('crypto')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const COLLECTION = 'share_rewards_inbox'
const USER_COLLECTION = 'user_state'
const LEDGER_COLLECTION = 'coin_ledger'   // 和 coinLedger 云函数共用
const REWARD_PER_SAVE = 3
const HISTORY_KEEP = 200          // 单方向最多保留多少条记录
const NOTEBOOK_ID_MAX_LEN = 100
const NOTEBOOK_NAME_MAX_LEN = 60

// 接收方在 credit 时可能塞控制字符 / 零宽 / bidi 标记,污染分享方的奖励
// toast 文案和 admin 审计日志。统一从输入字段里剥掉。
// 用 RegExp(string) 构造,源里只出现 \u 转义 —— 字面量会让源文件含不可见
// 控制字符,git 直接当 binary 处理,diff 没法读。覆盖范围:
//   U+0000-U+001F  C0 控制字符 (含 tab/lf/cr)
//   U+007F         DEL
//   U+200B-U+200F  ZWSP / ZWNJ / ZWJ / LRM / RLM
//   U+202A-U+202E  bidi embed / override / PDF
//   U+2066-U+2069  bidi isolate (LRI / RLI / FSI / PDI)
//   U+FEFF         BOM / ZWNBSP
const BAD_CHARS_RE = new RegExp(
  '[\\u0000-\\u001F\\u007F\\u200B-\\u200F\\u202A-\\u202E\\u2066-\\u2069\\uFEFF]',
  'g'
)

function sanitizeShortString(input, maxLen) {
  return String(input || '').replace(BAD_CHARS_RE, '').slice(0, maxLen)
}

exports.main = async (event = {}) => {
  const ctx = cloud.getWXContext()
  const callerOpenid = ctx.OPENID

  if (!callerOpenid) {
    return { ok: false, reason: 'no_openid' }
  }

  const action = event.action

  if (action === 'whoami') {
    return { ok: true, openid: callerOpenid }
  }

  if (action === 'credit') {
    return creditShare({
      callerOpenid,
      sharerOpenid: event.sharerOpenid,
      notebookId: event.notebookId,
      notebookName: event.notebookName || ''
    })
  }

  if (action === 'claim') {
    return claimRewards(callerOpenid)
  }

  if (action === 'getProfile') {
    return getProfile(event.openid)
  }

  return { ok: false, reason: 'unknown_action' }
}

// 接收页用来展示"X 分享给你的作业本"。
// openid 来自 share payload.sharer —— 分享方主动写进 URL 的,接收人天然知道,
// 不算隐私。我们只回 nickname + avatar(分享方在 profile 页填的,等同于
// "公开身份"),不回 coins/tasks/notebooks 等其它 user_state。
async function getProfile(openid) {
  if (typeof openid !== 'string' || !openid || openid.length > 100) {
    return { ok: false, reason: 'invalid_args' }
  }
  const db = cloud.database()
  const res = await db.collection(USER_COLLECTION)
    .where({ _openid: openid })
    .field({ state: true })
    .limit(1)
    .get()
  const doc = (res.data && res.data[0]) || null
  if (!doc || !doc.state) {
    return { ok: true, profile: null }
  }
  const p = doc.state.profile || {}
  return {
    ok: true,
    profile: {
      nickname: sanitizeShortString(p.nickname, 40),
      avatar: typeof p.avatar === 'string' ? p.avatar.slice(0, 500) : ''
    }
  }
}

// 第一次部署后集合可能还不存在 —— 用 admin SDK 懒建，开发者不必另外去
// 控制台手工创建 share_rewards_inbox。建过之后这一步是 no-op。
async function ensureCollection() {
  const db = cloud.database()
  try {
    await db.createCollection(COLLECTION)
  } catch (e) {
    // -502002 / -501001 = collection already exists；忽略其它错误也没关系，
    // 后续的 .where().get() 会以更明确的方式失败。
  }
}

async function creditShare({ callerOpenid, sharerOpenid, notebookId, notebookName }) {
  if (typeof sharerOpenid !== 'string' || typeof notebookId !== 'string') {
    return { ok: false, reason: 'invalid_args' }
  }
  if (!sharerOpenid || !notebookId || notebookId.length > NOTEBOOK_ID_MAX_LEN) {
    return { ok: false, reason: 'invalid_args' }
  }
  // 自己保存自己的分享不算
  if (sharerOpenid === callerOpenid) {
    return { ok: false, reason: 'self_save' }
  }

  const safeNotebookName = sanitizeShortString(notebookName, NOTEBOOK_NAME_MAX_LEN)

  // v3 拍平作业本后, notebooks 数组永远为空, 老的 "notebookId in sharerDoc.notebooks"
  // 归属校验失效。新模型:
  //   - 字段名 notebookId 在 v3 实际承载的是客户端生成的 shareId (nanoid)
  //   - server 没法从 user_state 反查 shareId 归属 —— 客户端没把 shareId 落盘
  //   - 弱归属证明: sharer.state.tasks 至少非空(证明 sharerOpenid 是真实用户),
  //     避免随机 openid 灌奖励
  //   - dedup 仍走 (callerOpenid, notebookId) 复合 key, 同一接收人对同一分享只入一次
  // TODO 上线前考虑加一个 server-side shareId 签发接口(分享前 client 调云函数申请 token,
  // server 落库 (sharerOpenid, shareId, taskHash),credit 时验 token)。
  const db = cloud.database()
  const userRes = await db.collection(USER_COLLECTION)
    .where({ _openid: sharerOpenid })
    .field({ state: true })
    .limit(1)
    .get()
  const sharerDoc = (userRes.data && userRes.data[0]) || null
  if (!sharerDoc) {
    return { ok: false, reason: 'sharer_not_found' }
  }
  const tasks = Array.isArray(sharerDoc.state && sharerDoc.state.tasks)
    ? sharerDoc.state.tasks
    : []
  const notebooks = Array.isArray(sharerDoc.state && sharerDoc.state.notebooks)
    ? sharerDoc.state.notebooks
    : []
  // v2 老 client 推上来的 notebookId 仍按老规则校验(精确归属);
  // v3 新 client 的 notebookId 字段实际是 shareId,退化为"sharer 是真实活跃用户"。
  const isV2NotebookOwned = notebooks.some((nb) => nb && nb.id === notebookId)
  if (!isV2NotebookOwned && tasks.length === 0) {
    return { ok: false, reason: 'sharer_not_active' }
  }

  await ensureCollection()
  // 同一个接收人对同一个 notebook 只计一次
  const dedupKey = `${callerOpenid}__${notebookId}`
  const existing = await db.collection(COLLECTION)
    .where({ dedupKey })
    .limit(1)
    .get()
  if (existing.data && existing.data.length > 0) {
    return { ok: false, reason: 'already_credited' }
  }

  await db.collection(COLLECTION).add({
    data: {
      _openid: sharerOpenid,             // 这条收件人是分享方
      importerOpenid: callerOpenid,
      notebookId,
      notebookName: safeNotebookName,
      amount: REWARD_PER_SAVE,
      dedupKey,
      claimed: false,
      createdAt: Date.now()
    }
  })

  return { ok: true, credited: REWARD_PER_SAVE }
}

async function claimRewards(callerOpenid) {
  await ensureCollection()
  const db = cloud.database()
  // 拉本人未领取的全部记录。INBOX ACL 是创建者可读，但云函数用 admin
  // 直接 by _openid 查更可靠。
  const res = await db.collection(COLLECTION)
    .where({ _openid: callerOpenid, claimed: false })
    .limit(HISTORY_KEEP)
    .get()

  const rows = res.data || []
  if (rows.length === 0) {
    return { ok: true, total: 0, count: 0 }
  }

  const total = rows.reduce((sum, r) => sum + (Number(r.amount) || 0), 0)

  // 写一条 ledger summary entry 做服务端审计。客户端 = truth 架构下,
  // server 不再 inc user_state.state.coins,余额完全由 client applyCoinDelta
  // 维护,但 server 这边仍然记一条 immutable 流水,跟当事人 user_state 上的
  // coinLogs 互为对账。dedup 用 inboxIds 哈希(防 client 重试时多记一条)。
  await ensureLedgerCollection()
  const inboxIds = rows.map((r) => r._id).slice().sort()
  const inboxHash = crypto.createHash('sha256').update(inboxIds.join(',')).digest('hex').slice(0, 16)
  const eventId = `share_claim:${inboxHash}`
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
          kind: 'share_reward_claim',
          delta: total,
          meta: {
            count: rows.length,
            inboxIds,
            notebookIds: rows.map((r) => r.notebookId).filter(Boolean)
          },
          clientTs: 0,
          createdAt: Date.now()
        }
      })
    } catch (e) {
      console.warn('[shareReward] ledger write failed', e && e.errMsg)
      // 不致命 —— audit 失败但奖励照发,client 自己 applyCoinDelta 入账。
    }
  }

  // 删除 inbox(best-effort)。已经记 ledger 了,删除失败下次重读时通过
  // ledger eventId dedup 会被识别为 alreadyApplied,不会重发奖励。
  for (const r of rows) {
    try {
      await db.collection(COLLECTION).doc(r._id).remove()
    } catch (e) {
      console.warn('[shareReward] remove failed', r._id, e && e.errMsg)
    }
  }

  if (alreadyApplied) {
    // 之前已发过,客户端这次又来要 —— 还回 total=0 不让重复入账。
    return {
      ok: true,
      total: 0,
      count: 0,
      notebooks: [],
      eventId,
      alreadyApplied: true
    }
  }

  return {
    ok: true,
    total,
    count: rows.length,
    notebooks: rows.map((r) => r.notebookName || '').filter(Boolean),
    eventId
  }
}

async function ensureLedgerCollection() {
  const db = cloud.database()
  try {
    await db.createCollection(LEDGER_COLLECTION)
  } catch (e) {
    // 已存在或权限问题,后续 add 自然失败
  }
}

