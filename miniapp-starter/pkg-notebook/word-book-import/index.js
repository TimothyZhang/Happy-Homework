// 接收分享的单词本:解码链接里的 payload,预览,一键导入成一个全新的本。
const store = require('../../utils/store')

Page({
  data: {
    ok: true,
    name: '',
    pairs: [],
    count: 0,
    imported: false
  },

  onLoad(q) {
    try {
      const payload = JSON.parse(decodeURIComponent((q && q.d) || ''))
      if (!payload || payload.k !== 'wb' || !Array.isArray(payload.w)) throw new Error('bad')
      const pairs = payload.w
        .filter((p) => Array.isArray(p) && p[0] && p[1])
        .map((p) => ({ cn: String(p[0]).slice(0, 40), en: String(p[1]).slice(0, 40) }))
      this._payload = payload
      this.setData({ ok: true, name: payload.n || '分享单词本', count: pairs.length, pairs: pairs.slice(0, 100) })
    } catch (e) {
      this.setData({ ok: false })
    }
  },

  doImport() {
    if (this.data.imported) return
    const b = store.importSharedWordBook(this._payload)
    if (!b) { wx.showToast({ title: '导入失败', icon: 'none' }); return }
    this.setData({ imported: true })
    wx.showToast({ title: '已导入「' + b.name + '」', icon: 'success' })
    setTimeout(() => {
      wx.redirectTo({ url: '/pkg-notebook/word-book/index?id=' + b.id, fail: () => wx.switchTab({ url: '/pages/pet/index' }) })
    }, 700)
  },

  goPet() { wx.switchTab({ url: '/pages/pet/index' }) }
})
