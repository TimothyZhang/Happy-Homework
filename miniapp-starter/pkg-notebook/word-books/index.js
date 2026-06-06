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
    masteredWords: 0,
    customCount: 0,
    customMax: 5
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
        isRef: !!b.ref,
        creatorName: b.creatorName || '',
        creatorAvatar: b.creatorAvatar || '',
        count: words.length,
        mastered: words.filter((w) => w.mastered).length,
        isTarget: targets.indexOf(b.id) !== -1
      }
    })
    const stats = store.getWordStats(s)
    this.setData({
      books,
      customCount: store.getCustomBookCount(),
      customMax: store.CUSTOM_WORD_BOOKS_MAX,
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
    if (store.getCustomBookCount() >= store.CUSTOM_WORD_BOOKS_MAX) {
      wx.showModal({
        title: '自定义单词本已满',
        content: '最多只能有 ' + store.CUSTOM_WORD_BOOKS_MAX + ' 个自己的单词本(引用别人的不算)。删掉一个再建,或去发现页「添加」别人的。',
        confirmText: '去发现', cancelText: '知道了',
        success: (r) => { if (r.confirm) this.goDiscover() }
      })
      return
    }
    wx.showModal({
      title: '新建单词本', editable: true, placeholderText: '给单词本起个名字',
      success: (r) => {
        if (!r.confirm) return
        const b = store.addWordBook(r.content)
        this._refresh()
        if (b) wx.navigateTo({ url: '/pkg-notebook/word-book/index?id=' + b.id })
        else wx.showToast({ title: '新建失败(已达自定义上限)', icon: 'none' })
      }
    })
  },

  decSize() { store.setReciteSessionSize(this.data.sessionSize - 1); this._refresh() },
  incSize() { store.setReciteSessionSize(this.data.sessionSize + 1); this._refresh() }
})
