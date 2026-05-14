'use strict'

// 分享奖励云函数
//
// 三个 action：
//   whoami — 返回调用者的 OPENID，用于客户端缓存自己的身份
//   credit — 接收方导入分享的作业本时调用，往 INBOX 里写一条奖励记录
//   claim  — 分享方拉取并领取属于自己的奖励记录（读 + 删除 + 返回总额）
//
// 使用 INBOX 集合而不是直接改 user_state，是为了避免和现有 cloud-sync
// 的"单设备写"模型冲突 —— user_state 写入由分享方自己的设备控制，奖励
// 通过领取的方式合并进去。
//
// 集合 share_rewards_inbox 推荐 ACL：仅创建者可读写。
// 云函数用 admin 权限绕过 ACL，可以为任意 _openid 写记录、按 openid 查询删除。

const cloud = require('wx-server-sdk')
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

  return { ok: false, reason: 'unknown_action' }
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

  // 校验 notebookId 真的归属于 sharer。没有这一步,任意用户都可以调
  // credit(sharerOpenid: <任意>, notebookId: <任意字符串>) 给目标 openid
  // 灌金币 —— per-(caller,notebook) dedup 只要换字符串就绕过。
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
  const notebooks = Array.isArray(sharerDoc.state && sharerDoc.state.notebooks)
    ? sharerDoc.state.notebooks
    : []
  if (!notebooks.some((nb) => nb && nb.id === notebookId)) {
    return { ok: false, reason: 'notebook_not_owned' }
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
    // 没领的也回一个 newBalance,让 client 在 claim 之后能用同一个值对齐
    // (state.coins 是服务端账本,client 没法本地推断)。
    const cur = await readServerBalance(callerOpenid)
    return { ok: true, total: 0, count: 0, newBalance: cur }
  }

  const total = rows.reduce((sum, r) => sum + (Number(r.amount) || 0), 0)

  // 1) 写一条 ledger summary entry,做审计。先写 ledger 再改余额:这样
  //    余额改失败的话,审计上能看到"应入账但没成功"。
  const eventId = `share_claim_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
  try {
    await ensureLedgerCollection()
    await db.collection(LEDGER_COLLECTION).add({
      data: {
        _openid: callerOpenid,
        eventId,
        kind: 'share_reward_claim',
        delta: total,
        balanceAfter: null,    // 写完余额后没必要回填,审计够用
        meta: {
          count: rows.length,
          notebookIds: rows.map((r) => r.notebookId).filter(Boolean)
        },
        clientTs: 0,
        createdAt: Date.now()
      }
    })
  } catch (e) {
    console.warn('[shareReward] ledger write failed', e && e.errMsg)
    return { ok: false, reason: 'ledger_write_failed' }
  }

  // 2) 原子 inc 余额。如果 user_state 不存在(0 rows updated),拒绝并把
  //    ledger 这条标记为 voided —— 但 WeChat cloud 没法事务回滚,这里
  //    只能 best-effort,记一条 warn,client 下次会再试。
  let newBalance = null
  try {
    const upd = await db.collection(USER_COLLECTION)
      .where({ _openid: callerOpenid })
      .update({ data: { state: { coins: db.command.inc(total) } } })
    if (!upd || !upd.stats || upd.stats.updated === 0) {
      console.warn('[shareReward] balance update affected 0 rows; user_state missing?')
      return { ok: false, reason: 'no_user_state', eventId }
    }
    newBalance = await readServerBalance(callerOpenid)
  } catch (e) {
    console.warn('[shareReward] balance update failed', e && e.errMsg)
    return { ok: false, reason: 'balance_update_failed', eventId }
  }

  // 3) 删除 inbox(best-effort)。已经入账了,删除失败下次仍可能重领 ——
  //    但 ledger eventId 已经记录,人工对账时能发现。
  for (const r of rows) {
    try {
      await db.collection(COLLECTION).doc(r._id).remove()
    } catch (e) {
      console.warn('[shareReward] remove failed', r._id, e && e.errMsg)
    }
  }

  return {
    ok: true,
    total,
    count: rows.length,
    notebooks: rows.map((r) => r.notebookName || '').filter(Boolean),
    newBalance
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

async function readServerBalance(openid) {
  const db = cloud.database()
  const res = await db.collection(USER_COLLECTION)
    .where({ _openid: openid })
    .field({ state: true })
    .limit(1)
    .get()
  const doc = (res.data && res.data[0]) || null
  if (!doc || !doc.state) return 0
  return typeof doc.state.coins === 'number' ? doc.state.coins : 0
}
