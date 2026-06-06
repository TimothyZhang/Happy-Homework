// 单词库管理:增减单词本、选「近期目标」本、设每次背诵数量。
const store = require('../../utils/store')

Page({
  data: {
    books: [],
    sessionSize: 20,
    sizeMin: 3,
    sizeMax: 50,
    targetCount: 0,
    totalWords: 0,
    masteredWords: 0
  },

  onShow() { this._refresh() },

  _refresh() {
    const s = store.getStateWithComputed()
    const targets = (s.wordConfig && s.wordConfig.targetBookIds) || []
    const books = (s.wordBooks || []).map((b) => {
      const words = b.words || []
      return {
        id: b.id,
        name: b.name,
        builtin: !!b.builtin,
        count: words.length,
        mastered: words.filter((w) => w.mastered).length,
        isTarget: targets.indexOf(b.id) !== -1
      }
    })
    const stats = store.getWordStats(s)
    this.setData({
      books,
      sessionSize: (s.wordConfig && s.wordConfig.sessionSize) || store.RECITE_DEFAULT_SIZE,
      targetCount: books.filter((b) => b.isTarget).length,
      totalWords: stats.total,
      masteredWords: stats.mastered
    })
  },

  toggleTarget(e) {
    const id = e.currentTarget.dataset.id
    const s = store.getStateWithComputed()
    const t = ((s.wordConfig && s.wordConfig.targetBookIds) || []).slice()
    const i = t.indexOf(id)
    if (i === -1) t.push(id); else t.splice(i, 1)
    store.setReciteTargets(t)
    this._refresh()
  },

  openBook(e) {
    wx.navigateTo({ url: '/pkg-notebook/word-book/index?id=' + e.currentTarget.dataset.id })
  },

  goDiscover() {
    wx.navigateTo({ url: '/pkg-notebook/word-discover/index' })
  },

  newBook() {
    wx.showModal({
      title: '新建单词本', editable: true, placeholderText: '给单词本起个名字',
      success: (r) => {
        if (!r.confirm) return
        const b = store.addWordBook(r.content)
        this._refresh()
        if (b) wx.navigateTo({ url: '/pkg-notebook/word-book/index?id=' + b.id })
      }
    })
  },

  decSize() { store.setReciteSessionSize(this.data.sessionSize - 1); this._refresh() },
  incSize() { store.setReciteSessionSize(this.data.sessionSize + 1); this._refresh() }
})
