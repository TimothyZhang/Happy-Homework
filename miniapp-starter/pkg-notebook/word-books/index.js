// 单词库管理:增减单词本、选「近期目标」本、设每次背诵数量。
const store = require('../../utils/store')

Page({
  data: {
    books: [],
    sessionSize: 20,
    sizeMin: 3,
    sizeMax: 50,
    targetCount: 0
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
    this.setData({
      books,
      sessionSize: (s.wordConfig && s.wordConfig.sessionSize) || store.RECITE_DEFAULT_SIZE,
      targetCount: books.filter((b) => b.isTarget).length
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

  removeBook(e) {
    const id = e.currentTarget.dataset.id
    const name = e.currentTarget.dataset.name
    wx.showModal({
      title: '删除单词本',
      content: '确定删除「' + name + '」?里面的单词会一起删掉,无法恢复。',
      confirmText: '删除', confirmColor: '#e15c5c',
      success: (r) => { if (r.confirm) { store.removeWordBook(id); this._refresh() } }
    })
  },

  renameBook(e) {
    const id = e.currentTarget.dataset.id
    const name = e.currentTarget.dataset.name
    wx.showModal({
      title: '单词本改名', editable: true, content: name, placeholderText: '新名字',
      success: (r) => {
        if (!r.confirm) return
        const next = (r.content || '').trim()
        if (!next || next === name) return
        store.renameWordBook(id, next)
        this._refresh()
      }
    })
  },

  decSize() { store.setReciteSessionSize(this.data.sessionSize - 1); this._refresh() },
  incSize() { store.setReciteSessionSize(this.data.sessionSize + 1); this._refresh() }
})
