'use strict'

// 把 user_state collection 复制一份到 user_state_backup_v2,
// 让 v2→v3 schema 重构有可回滚的兜底。
//
// 两个 action:
//
// 1. backup_self (默认 / 客户端调用):
//    按 caller OPENID 备份"自己的"那一条。客户端在 hydrate 完成后检测到
//    本次跑了 v2→v3 migrate 就调一次。云函数侧通过 user_state doc 上的
//    backedUpAt 字段做 dedup,所以重调也只备份一次。
//
//      wx.cloud.callFunction({ name: 'backupUserState', data: { action: 'backup_self' } })
//
// 2. backup_all (管理员手动 invoke):
//    全量复制 user_state 整个 collection。在控制台 / tcb 调试面板里 invoke,
//    event 传 { action: 'backup_all', tag: '...' }。客户端不应该调这个 action。
//
// 备份记录约定:
//   - _openid 改名为 sourceOpenid(系统字段 admin 写入会被拦)
//   - _id 不复制,backup 集合自己生成
//   - 加 backupAt timestamp + backupTag 字符串
//   - 加 sourceId 字段保留原 doc id 方便回滚定位
//
// 回滚:目前没自动化。需要 restore 时手动从 user_state_backup_v2 复制回去。

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const SOURCE = 'user_state'
const TARGET = 'user_state_backup_v2'
const PAGE_SIZE = 100

async function ensureCollection(name) {
  const db = cloud.database()
  try {
    await db.createCollection(name)
  } catch (e) {
    // 已存在 (-502002 / -501001 等) 忽略;别的错误后续 .add 会显式报。
  }
}

function snapshotPayload(doc, backupAt, backupTag) {
  const payload = { ...doc }
  delete payload._id
  payload.sourceId = doc._id || ''
  payload.sourceOpenid = doc._openid || ''
  delete payload._openid
  payload.backupAt = backupAt
  payload.backupTag = backupTag
  return payload
}

async function backupSelf(callerOpenid) {
  if (!callerOpenid) {
    return { ok: false, reason: 'no_openid' }
  }
  await ensureCollection(TARGET)
  const db = cloud.database()
  const res = await db.collection(SOURCE)
    .where({ _openid: callerOpenid })
    .limit(1)
    .get()
  const doc = (res.data && res.data[0]) || null
  if (!doc) {
    // 用户还没有 user_state — 不是错误,只是没东西备份。
    return { ok: true, alreadyBackedUp: false, copied: 0, reason: 'no_doc' }
  }
  if (doc.backedUpAt) {
    // 已经备份过了 — dedup,不重复写。
    return { ok: true, alreadyBackedUp: true, backedUpAt: doc.backedUpAt }
  }

  const backupAt = Date.now()
  const isoStamp = new Date(backupAt).toISOString().replace(/[:.]/g, '-')
  const backupTag = `self-${isoStamp}`

  try {
    await db.collection(TARGET).add({
      data: snapshotPayload(doc, backupAt, backupTag)
    })
  } catch (e) {
    return { ok: false, reason: 'backup_write_failed', error: String(e && e.message) }
  }

  // 在原 doc 上写 backedUpAt 字段做 dedup。
  // 注意:cloud-sync push 不带 backedUpAt 字段(它不在 SYNC_FIELDS),
  // 所以后续客户端 push 整包 state 时不会覆盖这个 server-only 字段。
  try {
    await db.collection(SOURCE).doc(doc._id).update({
      data: { backedUpAt: backupAt, backupTag }
    })
  } catch (e) {
    // 标记失败 — 下次还会再 backup 一次,无害(只是 backup 集合多一份),
    // 不算 fatal,客户端那边也已经成功收到备份完成的信号。
    console.warn('[backup] mark backedUpAt failed', doc._id, e && e.message)
  }

  return {
    ok: true,
    alreadyBackedUp: false,
    copied: 1,
    backupAt,
    backupTag
  }
}

async function fetchAll() {
  const db = cloud.database()
  let all = []
  let skip = 0
  while (true) {
    const res = await db.collection(SOURCE).skip(skip).limit(PAGE_SIZE).get()
    if (!res.data || res.data.length === 0) break
    all = all.concat(res.data)
    if (res.data.length < PAGE_SIZE) break
    skip += PAGE_SIZE
  }
  return all
}

async function backupAll(eventTag) {
  await ensureCollection(TARGET)
  const db = cloud.database()
  const backupAt = Date.now()
  const isoStamp = new Date(backupAt).toISOString().replace(/[:.]/g, '-')
  const backupTag = (eventTag && typeof eventTag === 'string')
    ? eventTag.slice(0, 64)
    : `all-${isoStamp}`

  let allDocs
  try {
    allDocs = await fetchAll()
  } catch (e) {
    return { ok: false, reason: 'fetch_failed', error: String(e && e.message) }
  }

  let copied = 0
  let failed = 0
  const failures = []
  for (const doc of allDocs) {
    try {
      await db.collection(TARGET).add({
        data: snapshotPayload(doc, backupAt, backupTag)
      })
      copied++
    } catch (e) {
      failed++
      if (failures.length < 5) {
        failures.push({ sourceId: doc._id || '', error: String(e && e.message) })
      }
    }
  }
  return {
    ok: failed === 0,
    tag: backupTag,
    backupAt,
    total: allDocs.length,
    copied,
    failed,
    failures
  }
}

exports.main = async (event = {}) => {
  const ctx = cloud.getWXContext()
  const callerOpenid = ctx.OPENID

  const action = event.action || 'backup_self'

  if (action === 'backup_self') {
    return backupSelf(callerOpenid)
  }
  if (action === 'backup_all') {
    return backupAll(event.tag)
  }
  return { ok: false, reason: 'unknown_action', action }
}
