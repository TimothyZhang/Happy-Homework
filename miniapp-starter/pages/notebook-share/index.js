const store = require('../../utils/store')

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
    this.setData({ importing: true })
    const newId = store.importSharedNotebook(this.data.payload)
    if (!newId) {
      this.setData({ importing: false, error: '保存失败，请稍后再试' })
      return
    }
    wx.showToast({ title: '已保存', icon: 'success' })
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
