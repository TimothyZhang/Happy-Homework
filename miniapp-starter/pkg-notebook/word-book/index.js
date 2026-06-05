// 单个单词本:增减单词/短语。中英文用系统输入法填(这里是录入,不是背诵测试)。
const store = require('../../utils/store')

Page({
  data: {
    bookId: '',
    name: '',
    builtin: false,
    words: [],
    cnInput: '',
    enInput: '',
    textMax: 40
  },

  onLoad(q) {
    this._id = (q && q.id) || ''
    try { this.setData({ textMax: store.WORD_TEXT_MAX || 40 }) } catch (e) {}
    this._refresh()
  },

  _refresh() {
    const s = store.getStateWithComputed()
    const b = (s.wordBooks || []).find((x) => x.id === this._id)
    if (!b) { wx.navigateBack({ delta: 1 }); return }
    wx.setNavigationBarTitle({ title: b.name || '单词本' })
    this.setData({
      bookId: b.id,
      name: b.name,
      builtin: !!b.builtin,
      words: (b.words || []).map((w) => ({
        id: w.id, cn: w.cn, en: w.en,
        state: w.mastered ? 'mastered' : (w.seen ? 'learning' : 'new'),
        everWrong: !!w.everWrong
      }))
    })
  },

  onCn(e) { this.setData({ cnInput: e.detail.value }) },
  onEn(e) { this.setData({ enInput: e.detail.value }) },

  addWord() {
    const cn = (this.data.cnInput || '').trim()
    const en = (this.data.enInput || '').trim()
    if (!cn || !en) { wx.showToast({ title: '中文和英文都要填', icon: 'none' }); return }
    const w = store.addWord(this._id, cn, en)
    if (!w) { wx.showToast({ title: '添加失败', icon: 'none' }); return }
    this.setData({ cnInput: '', enInput: '' })
    this._refresh()
  },

  removeWord(e) {
    const id = e.currentTarget.dataset.id
    store.removeWord(this._id, id)
    this._refresh()
  }
})
