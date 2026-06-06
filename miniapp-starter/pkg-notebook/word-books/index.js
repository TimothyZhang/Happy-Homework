// 单词库管理:增减单词本、选「近期目标」本、设每次背诵数量。
const store = require('../../utils/store')
const i18n = require('../../utils/i18n')

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
    customMax: 5,
    t: {}
  },

  onShow() {
    this.setData({ t: i18n.dict() })
    wx.setNavigationBarTitle({ title: i18n.t('wbooks_navtitle') })
    this._refresh()
  },

  _refresh() {
    const s = store.getStateWithComputed()
    const targets = (s.wordConfig && s.wordConfig.targetBookIds) || []
    const books = (s.wordBooks || []).map((b) => {
      const words = b.words || []
      const count = words.length
      const mastered = words.filter((w) => w.mastered).length
      const builtin = !!b.builtin
      const metaKey = builtin ? 'wbooks_meta_builtin' : 'wbooks_meta'
      return {
        id: b.id,
        name: b.name,
        builtin,
        isRef: !!b.ref,
        creatorName: b.creatorName || '',
        creatorAvatar: b.creatorAvatar || '',
        count,
        mastered,
        isTarget: targets.indexOf(b.id) !== -1,
        metaLabel: i18n.t(metaKey, { count, mastered })
      }
    })
    const stats = store.getWordStats(s)
    const customCount = store.getCustomBookCount()
    const customMax = store.CUSTOM_WORD_BOOKS_MAX
    const targetCount = books.filter((b) => b.isTarget).length
    const totalWords = stats.total
    const masteredWords = stats.mastered
    const sessionSize = (s.wordConfig && s.wordConfig.sessionSize) || store.RECITE_DEFAULT_SIZE
    const sizeMin = this.data.sizeMin
    this.setData({
      books,
      customCount,
      customMax,
      sessionSize,
      targetCount,
      totalWords,
      masteredWords,
      statLabel: i18n.t('wbooks_stat', { total: totalWords, mastered: masteredWords }),
      sectionSub: i18n.t('wbooks_section_sub', { n: targetCount }),
      sessionSizeSub: i18n.t('wbooks_sessionSize_sub', { min: sizeMin }),
      newLabel: i18n.t('wbooks_new', { count: customCount, max: customMax })
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
        title: i18n.t('wbooks_modal_full_title'),
        content: i18n.t('wbooks_modal_full_content', { max: store.CUSTOM_WORD_BOOKS_MAX }),
        confirmText: i18n.t('wbooks_modal_full_confirm'),
        cancelText: i18n.t('wbooks_modal_full_cancel'),
        success: (r) => { if (r.confirm) this.goDiscover() }
      })
      return
    }
    wx.showModal({
      title: i18n.t('wbooks_modal_new_title'),
      editable: true,
      placeholderText: i18n.t('wbooks_modal_new_placeholder'),
      success: (r) => {
        if (!r.confirm) return
        const b = store.addWordBook(r.content)
        this._refresh()
        if (b) wx.navigateTo({ url: '/pkg-notebook/word-book/index?id=' + b.id })
        else wx.showToast({ title: i18n.t('wbooks_toast_new_fail'), icon: 'none' })
      }
    })
  },

  decSize() { store.setReciteSessionSize(this.data.sessionSize - 1); this._refresh() },
  incSize() { store.setReciteSessionSize(this.data.sessionSize + 1); this._refresh() }
})
