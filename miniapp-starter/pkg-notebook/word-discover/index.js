// 发现单词本:搜索别人公开的单词本,只读 —— 只能「复制到我的」,改不了原作者的。
const store = require('../../utils/store')

function decorate(b) {
  const words = b.words || []
  return {
    id: b.id,
    name: b.name,
    wordCount: b.wordCount || words.length,
    mine: !!b.mine,
    words,
    preview: words.slice(0, 4).map((w) => w.cn + ' ' + w.en).join('  ·  ')
  }
}

Page({
  data: { q: '', books: [], loading: false, searched: false },

  onLoad() { this._search('') },   // 进来先浏览最近公开的

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

  // 引用:保持和源关联,可同步更新,只读(改不到作者)。
  referenceBook(e) {
    const b = (this.data.books || []).find((x) => x.id === e.currentTarget.dataset.id)
    if (!b || !(b.words || []).length) { wx.showToast({ title: '这个单词本是空的', icon: 'none' }); return }
    const book = store.addReferencedBook(b.name, b.words, b.id)
    if (!book) { wx.showToast({ title: '添加失败(可能已达单词本上限)', icon: 'none' }); return }
    wx.showToast({ title: '已引用到我的', icon: 'success' })
    setTimeout(() => wx.navigateTo({ url: '/pkg-notebook/word-book/index?id=' + book.id }), 650)
  },

  // 复制:做一个独立副本,跟源没关系,自己能改。
  copyBook(e) {
    const b = (this.data.books || []).find((x) => x.id === e.currentTarget.dataset.id)
    if (!b || !(b.words || []).length) { wx.showToast({ title: '这个单词本是空的', icon: 'none' }); return }
    const payload = { k: 'wb', n: b.name, w: b.words.map((w) => [w.cn, w.en]) }
    const book = store.importSharedWordBook(payload)
    if (!book) { wx.showToast({ title: '复制失败(可能已达单词本上限)', icon: 'none' }); return }
    wx.showToast({ title: '已复制到我的', icon: 'success' })
    setTimeout(() => wx.navigateTo({ url: '/pkg-notebook/word-book/index?id=' + book.id }), 650)
  },

  noop() {}
})
