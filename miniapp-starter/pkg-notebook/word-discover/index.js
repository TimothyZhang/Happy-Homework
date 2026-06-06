// 发现单词本:搜索别人公开的单词本,只读 —— 只能「复制到我的」,改不了原作者的。
const store = require('../../utils/store')

function decorate(b) {
  const words = b.words || []
  return {
    id: b.id,
    name: b.name,
    wordCount: b.wordCount || words.length,
    mine: !!b.mine,
    creatorName: b.creatorName || '',
    creatorAvatar: b.creatorAvatar || '',
    refCount: b.refCount || 0,
    words,
    preview: words.slice(0, 4).map((w) => w.cn + ' ' + w.en).join('  ·  ')
  }
}

Page({
  data: { q: '', books: [], loading: false, searched: false, isAdmin: false },

  onLoad() {
    this._search('')   // 进来先浏览最近公开的
    if (wx.cloud && wx.cloud.callFunction) {
      wx.cloud.callFunction({ name: 'adminPanel', data: { action: 'whoami' } })
        .then((res) => { const r = (res && res.result) || {}; this.setData({ isAdmin: !!r.isAdmin }) })
        .catch(() => {})
    }
  },

  onQ(e) { this.setData({ q: e.detail.value }) },
  doSearch() { this._search(this.data.q) },

  _search(q) {
    if (!wx.cloud || !wx.cloud.callFunction) {
      wx.showToast({ title: '当前环境用不了云搜索', icon: 'none' }); return
    }
    this.setData({ loading: true })
    wx.cloud.callFunction({ name: 'homeworkOCR', timeout: 20000, data: { action: 'searchBooks', q: (q || '').trim() } })
      .then((res) => {
        const r = (res && res.result) || {}
        const books = (r.ok && Array.isArray(r.books)) ? r.books.map(decorate) : []
        this.setData({ loading: false, searched: true, books })
        if (!r.ok) wx.showToast({ title: r.error || '搜索失败', icon: 'none' })
      })
      .catch(() => { this.setData({ loading: false, searched: true, books: [] }); wx.showToast({ title: '搜索失败,稍后再试', icon: 'none' }) })
  },

  // 添加(= 引用):保持和源关联、可同步更新、只读(改不到作者),不占自定义额度。
  // 想要独立可改的副本,去本子详情页点「复制」(那个才占自定义额度)。
  referenceBook(e) {
    const b = (this.data.books || []).find((x) => x.id === e.currentTarget.dataset.id)
    if (!b || !(b.words || []).length) { wx.showToast({ title: '这个单词本是空的', icon: 'none' }); return }
    const book = store.addReferencedBook(b.name, b.words, b.id, { name: b.creatorName, avatar: b.creatorAvatar })
    if (!book) { wx.showToast({ title: '添加失败(可能已达单词本上限)', icon: 'none' }); return }
    // 被引用次数 +1(云端,粗略热度,失败不影响本地)
    if (wx.cloud && wx.cloud.callFunction) {
      wx.cloud.callFunction({ name: 'homeworkOCR', data: { action: 'incrementRef', id: b.id } }).catch(() => {})
    }
    wx.showToast({ title: '已添加到我的', icon: 'success' })
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
        if (!r.ok) { wx.showToast({ title: r.error || '操作失败', icon: 'none' }); return }
        wx.showToast({ title: r.featured ? '已标星' : '已取消', icon: 'none' })
        this._search(this.data.q)
      })
      .catch(() => wx.showToast({ title: '操作失败', icon: 'none' }))
  },

  noop() {}
})
