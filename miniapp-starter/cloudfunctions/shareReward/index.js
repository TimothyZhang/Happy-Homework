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
const REWARD_PER_SAVE = 3
const HISTORY_KEEP = 200          // 单方向最多保留多少条记录

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
  if (!sharerOpenid || !notebookId) {
    return { ok: false, reason: 'invalid_args' }
  }
  // 自己保存自己的分享不算
  if (sharerOpenid === callerOpenid) {
    return { ok: false, reason: 'self_save' }
  }

  await ensureCollection()
  const db = cloud.database()
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
      notebookName,
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
  const ids = rows.map((r) => r._id)

  // 批量删除：单条删一遍。WeChat cloud DB 的 batch 操作有限，循环最稳妥。
  for (const id of ids) {
    try {
      await db.collection(COLLECTION).doc(id).remove()
    } catch (e) {
      // 删除失败也别阻塞领取 —— 后面 claimed=true 兜底
      console.warn('[shareReward] remove failed', id, e && e.errMsg)
    }
  }

  return {
    ok: true,
    total,
    count: rows.length,
    notebooks: rows.map((r) => r.notebookName || '').filter(Boolean)
  }
}
