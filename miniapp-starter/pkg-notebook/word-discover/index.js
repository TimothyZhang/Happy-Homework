// 发现单词本:搜索别人公开的单词本,只读 —— 只能「复制到我的」,改不了原作者的。
const store = require('../../utils/store')
const i18n = require('../../utils/i18n')

function decorate(b) {
  const words = b.words || []
  const wordCount = b.wordCount || words.length
  const refCount = b.refCount || 0
  return {
    id: b.id,
    name: b.name,
    wordCount,
    mine: !!b.mine,
    creatorName: b.creatorName || '',
    creatorAvatar: b.creatorAvatar || '',
    refCount,
    words,
    preview: words.slice(0, 4).map((w) => w.cn + ' ' + w.en).join('  ·  '),
    metaLabel: i18n.t('wdisc_meta', { wordCount, refCount })
  }
}

Page({
  data: { q: '', books: [], loading: false, searched: false, isAdmin: false, t: {} },

  onLoad() {
    this._search('')   // 进来先浏览最近公开的
    if (wx.cloud && wx.cloud.callFunction) {
      wx.cloud.callFunction({ name: 'adminPanel', data: { action: 'whoami' } })
        .then((res) => { const r = (res && res.result) || {}; this.setData({ isAdmin: !!r.isAdmin }) })
        .catch(() => {})
    }
  },

  onShow() {
    this.setData({ t: i18n.dict() })
    wx.setNavigationBarTitle({ title: i18n.t('wdisc_navtitle') })
  },

  onQ(e) { this.setData({ q: e.detail.value }) },
  doSearch() { this._search(this.data.q) },

  _search(q) {
    if (!wx.cloud || !wx.cloud.callFunction) {
      wx.showToast({ title: i18n.t('wdisc_toast_no_cloud'), icon: 'none' }); return
    }
    this.setData({ loading: true })
    wx.cloud.callFunction({ name: 'homeworkOCR', timeout: 20000, data: { action: 'searchBooks', q: (q || '').trim() } })
      .then((res) => {
        const r = (res && res.result) || {}
        const books = (r.ok && Array.isArray(r.books)) ? r.books.map(decorate) : []
        this.setData({ loading: false, searched: true, books })
        if (!r.ok) wx.showToast({ title: r.error || i18n.t('wdisc_toast_search_fail'), icon: 'none' })
      })
      .catch(() => { this.setData({ loading: false, searched: true, books: [] }); wx.showToast({ title: i18n.t('wdisc_toast_search_fail'), icon: 'none' }) })
  },

  // 添加(= 引用):保持和源关联、可同步更新、只读(改不到作者),不占自定义额度。
  // 想要独立可改的副本,去本子详情页点「复制」(那个才占自定义额度)。
  referenceBook(e) {
    const b = (this.data.books || []).find((x) => x.id === e.currentTarget.dataset.id)
    if (!b || !(b.words || []).length) { wx.showToast({ title: i18n.t('wdisc_toast_empty'), icon: 'none' }); return }
    const book = store.addReferencedBook(b.name, b.words, b.id, { name: b.creatorName, avatar: b.creatorAvatar })
    if (!book) { wx.showToast({ title: i18n.t('wdisc_toast_add_fail'), icon: 'none' }); return }
    // 被引用次数 +1(云端,粗略热度,失败不影响本地)
    if (wx.cloud && wx.cloud.callFunction) {
      wx.cloud.callFunction({ name: 'homeworkOCR', data: { action: 'incrementRef', id: b.id } }).catch(() => {})
    }
    wx.showToast({ title: i18n.t('wdisc_toast_added'), icon: 'success' })
    setTimeout(() => wx.navigateTo({ url: '/pkg-notebook/word-book/index?id=' + book.id }), 650)
  },

  // 管理员:给词库标星 / 取消(标星排搜索最前)。
  toggleFeatured(e) {
    if (!this.data.isAdmin) return
    const id = e.currentTarget.dataset.id
    const b = (this.data.books || []).find((x) => x.id === id)
    if (!b) return
    wx.cloud.callFunction({ name: 'homeworkOCR', data: { action: 'setFeatured', id, featured: !b.featured } })
      .then((res) => {
        const r = (res && res.result) || {}
        if (!r.ok) { wx.showToast({ title: r.error || i18n.t('wdisc_toast_op_fail'), icon: 'none' }); return }
        wx.showToast({ title: r.featured ? i18n.t('wdisc_toast_starred') : i18n.t('wdisc_toast_unstarred'), icon: 'none' })
        this._search(this.data.q)
      })
      .catch(() => wx.showToast({ title: i18n.t('wdisc_toast_op_fail'), icon: 'none' }))
  },

  noop() {}
})
