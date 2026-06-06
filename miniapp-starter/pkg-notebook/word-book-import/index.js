// 接收分享的单词本:解码链接里的 payload,预览,一键导入成一个全新的本。
const store = require('../../utils/store')
const i18n = require('../../utils/i18n')

Page({
  data: {
    ok: true,
    name: '',
    pairs: [],
    count: 0,
    imported: false
  },

  onLoad(q) {
    this.setData({ t: i18n.dict() })
    wx.setNavigationBarTitle({ title: i18n.t('wbimport_navtitle') })
    try {
      const payload = JSON.parse(decodeURIComponent((q && q.d) || ''))
      if (!payload || payload.k !== 'wb' || !Array.isArray(payload.w)) throw new Error('bad')
      const pairs = payload.w
        .filter((p) => Array.isArray(p) && p[0] && p[1])
        .map((p) => ({ cn: String(p[0]).slice(0, 40), en: String(p[1]).slice(0, 40) }))
      this._payload = payload
      const bookName = payload.n || ''
      const pairCount = pairs.length
      this.setData({
        ok: true,
        name: bookName,
        count: pairCount,
        pairs: pairs.slice(0, 100),
        heroCount: i18n.t('wbimport_hero_count', { name: bookName, n: pairCount }),
        moreText: i18n.t('wbimport_more', { n: pairCount })
      })
    } catch (e) {
      this.setData({ ok: false })
    }
  },

  onShow() {
    this.setData({ t: i18n.dict() })
    wx.setNavigationBarTitle({ title: i18n.t('wbimport_navtitle') })
  },

  doImport() {
    if (this.data.imported) return
    const b = store.importSharedWordBook(this._payload)
    if (!b) { wx.showToast({ title: i18n.t('wbimport_toast_fail'), icon: 'none' }); return }
    this.setData({ imported: true })
    wx.showToast({ title: i18n.t('wbimport_toast_ok', { name: b.name }), icon: 'success' })
    setTimeout(() => {
      wx.redirectTo({ url: '/pkg-notebook/word-book/index?id=' + b.id, fail: () => wx.switchTab({ url: '/pages/pet/index' }) })
    }, 700)
  },

  goPet() { wx.switchTab({ url: '/pages/pet/index' }) }
})
