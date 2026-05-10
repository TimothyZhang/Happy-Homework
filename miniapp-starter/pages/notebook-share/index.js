const store = require('../../utils/store')
const shareReward = require('../../utils/share-reward')

function summarize(n) {
  if (!n) return ''
  if (n.mode === 'one-shot') {
    const due = n.endDate || n.startDate
    return `一次性 · 截止 ${due}`
  }
  const rec = n.recurrence || { type: 'daily' }
  let recLabel = '每日'
  if (rec.type === 'weekly') {
    const names = ['一', '二', '三', '四', '五', '六', '日']
    recLabel = '每周' + (rec.weekdays || []).slice().sort().map((w) => names[w - 1]).join('、')
  }
  const range = `${n.startDate} → ${n.endDate || '长期'}`
  return `重复 · ${recLabel} · ${range}`
}

Page({
  data: {
    payload: null,
    notebookSummary: '',
    sharerLabel: '',
    error: '',
    importing: false
  },

  onLoad(options) {
    const raw = options && options.d
    if (!raw) {
      this.setData({ error: '分享链接里没有作业本数据' })
      return
    }
    try {
      const payload = JSON.parse(decodeURIComponent(raw))
      if (!payload || !payload.n) throw new Error('payload invalid')
      // Normalize: WXML reads payload.t.length unconditionally, so ensure it
      // exists even on payloads that arrived without a tasks array.
      if (!Array.isArray(payload.t)) payload.t = []
      const from = (payload.from || '').trim() || '好友'
      this.setData({
        payload,
        notebookSummary: summarize(payload.n),
        sharerLabel: `${from}分享给你的作业本`
      })
      wx.setNavigationBarTitle({ title: payload.n.name || '导入作业本' })
    } catch (e) {
      this.setData({ error: '分享数据已损坏，无法读取' })
    }
  },

  handleImport() {
    if (this.data.importing) return
    if (!this.data.payload) return
    const payload = this.data.payload
    const name = (payload.n && payload.n.name) || ''
    const dupe = store.findNotebookByName(name)
    if (dupe) {
      this.showDuplicateActionSheet(dupe.id)
      return
    }
    this.runImport({ mode: 'new' })
  },

  // Three-way conflict resolver when the import name collides with an
  // existing notebook. Choices:
  //   合并 — append shared tasks to the existing notebook (no dedupe; all
  //          incoming tasks land as todo).
  //   重命名 — auto-suffix " 复制" until unique, then create as new.
  //   覆盖 — destructive: replaces metadata + tasks under the same id.
  //          Coin/streak history is keyed elsewhere and stays intact.
  showDuplicateActionSheet(targetId) {
    wx.showActionSheet({
      itemList: ['合并到现有作业本', '重命名后保存', '覆盖现有作业本'],
      success: (res) => {
        if (res.tapIndex === 0) {
          this.runImport({ mode: 'merge', targetNotebookId: targetId })
        } else if (res.tapIndex === 1) {
          this.runImport({ mode: 'rename' })
        } else if (res.tapIndex === 2) {
          // Second confirm — overwrite is destructive.
          wx.showModal({
            title: '覆盖作业本？',
            content: '现有作业本里的所有作业会被替换，进度记录保留。',
            confirmText: '覆盖',
            confirmColor: '#e54545',
            success: (r) => {
              if (r.confirm) {
                this.runImport({ mode: 'overwrite', targetNotebookId: targetId })
              }
            }
          })
        }
      }
    })
  },

  runImport(options) {
    if (this.data.importing) return
    this.setData({ importing: true })
    const payload = this.data.payload
    const newId = store.importSharedNotebook(payload, options)
    if (!newId) {
      this.setData({ importing: false, error: '保存失败，请稍后再试' })
      return
    }
    wx.showToast({ title: '已保存', icon: 'success' })
    // Best-effort credit the original sharer with +3 coins. Cloud function
    // dedups (importer × notebookId) so re-imports won't double-credit.
    // Failure is silent — main flow already succeeded.
    if (payload.sharer && payload.nbId) {
      shareReward.reportShareSave({
        sharerOpenid: payload.sharer,
        notebookId: payload.nbId,
        notebookName: (payload.n && payload.n.name) || ''
      }).catch(() => {})
    }
    setTimeout(() => {
      wx.redirectTo({ url: `/pages/notebook-detail/index?id=${newId}` })
    }, 600)
  },

  handleCancel() {
    if (getCurrentPages().length > 1) {
      wx.navigateBack()
    } else {
      wx.switchTab({ url: '/pages/home/index' })
    }
  },

  // Forward the same shared payload onward — re-encode rather than relying
  // on `currentRoute + options`, so we don't rebuild the URL by hand.
  onShareAppMessage() {
    const payload = this.data.payload
    if (!payload || !payload.n) {
      return { title: '作业本', path: '/pages/tasks/index' }
    }
    const total = (payload.t || []).length
    const title = total > 0 ? `${payload.n.name} · ${total} 项作业` : payload.n.name
    const encoded = encodeURIComponent(JSON.stringify(payload))
    return { title, path: `/pages/notebook-share/index?d=${encoded}` }
  }
})
