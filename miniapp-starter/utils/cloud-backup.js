// 云端备份(客户端侧)。
// 每生成一份「新的」本地快照,也推一份上云(adminPanel.saveBackup)。设备丢了/重装,
// 登录后能从云端把历史快照捞回来恢复。纯 best-effort:没云能力 / 失败都静默。
//
// 关键:必须把本地 state 整个传上去 —— pre-sync 那份是「被云端覆盖前的本机数据」,
// 云端 user_state 里根本没有,不能让云函数去 copy user_state(会拿到覆盖后的新数据)。

function pushBackup(rec) {
  if (!rec || !rec.state) return
  if (typeof wx === 'undefined' || !wx.cloud || !wx.cloud.callFunction) return
  wx.cloud.callFunction({
    name: 'adminPanel',
    data: {
      action: 'saveBackup',
      backup: {
        updatedAt: rec.updatedAt,
        reason: rec.reason,
        taskCount: rec.taskCount,
        doneCount: rec.doneCount,
        clientAt: rec.at,
        state: rec.state
      }
    }
  }).catch((e) => console.warn('[cloud-backup] push failed', e && e.errMsg))
}

function listMine(limit) {
  if (typeof wx === 'undefined' || !wx.cloud || !wx.cloud.callFunction) return Promise.resolve([])
  return wx.cloud.callFunction({ name: 'adminPanel', data: { action: 'listMyBackups', limit: limit || 30 } })
    .then((res) => ((res && res.result && res.result.rows) || []))
    .catch(() => [])
}

// 取某份备份的完整内容(含 state),给恢复用。返回 backup 对象或 null。
function getMine(id) {
  if (!id || typeof wx === 'undefined' || !wx.cloud || !wx.cloud.callFunction) return Promise.resolve(null)
  return wx.cloud.callFunction({ name: 'adminPanel', data: { action: 'getMyBackup', id } })
    .then((res) => (res && res.result && res.result.ok ? res.result.backup : null))
    .catch(() => null)
}

module.exports = { pushBackup, listMine, getMine }
