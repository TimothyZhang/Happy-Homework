// 单个单词本:增减单词/短语 + 拍照/选图 OCR 导入。
// OCR 复用已部署的 homeworkOCR 云函数拿 rawText,再在本地解析成「中英成对」。
const store = require('../../utils/store')

// 把一段 OCR 文本解析成 [{cn,en}]。每行抓中文串 + 英文串(任意先后),成对即收。
function parsePairs(rawText) {
  const lines = (rawText || '').split(/\r?\n/)
  const pairs = []
  const seen = {}
  lines.forEach((raw) => {
    const line = (raw || '').trim()
    if (!line) return
    const cnMatch = line.match(/[一-鿿]+/g)
    const enMatch = line.match(/[a-zA-Z][a-zA-Z'’\- ]*[a-zA-Z]|[a-zA-Z]/)
    if (!cnMatch || !enMatch) return
    const cn = cnMatch.join('').slice(0, 40)
    const en = enMatch[0].trim().replace(/\s+/g, ' ').slice(0, 40)
    if (!cn || !en) return
    const key = cn + '|' + en.toLowerCase()
    if (seen[key]) return
    seen[key] = 1
    pairs.push({ cn, en })
  })
  return pairs
}

// 规范化云端单词表识别返回的 [{en,cn}]:去空、去重、限长。
function normalizePairs(rawPairs) {
  const pairs = []
  const seen = {}
  ;(Array.isArray(rawPairs) ? rawPairs : []).forEach((p) => {
    // 去掉词条前面的编号(预览就清干净,跟导入后一致)
    const cn = store.stripWordNum(String((p && p.cn) || '')).slice(0, 40)
    const en = store.stripWordNum(String((p && p.en) || '')).replace(/\s+/g, ' ').slice(0, 40)
    if (!cn || !en) return
    const key = cn + '|' + en.toLowerCase()
    if (seen[key]) return
    seen[key] = 1
    pairs.push({ cn, en })
  })
  return pairs
}

Page({
  data: {
    bookId: '',
    name: '',
    builtin: false,
    words: [],
    cnInput: '',
    enInput: '',
    textMax: 40,
    showOcr: false,
    ocrPairs: [],
    isPublic: false,
    publicBusy: false,
    isRef: false,
    refBusy: false,
    copyBusy: false,
    refCount: 0,
    creatorName: '',
    creatorAvatar: '',
    editing: false,
    editId: '',
    editCn: '',
    editEn: ''
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
      isPublic: !!b.public,
      isRef: !!b.ref,
      _ref: b.ref || '',
      creatorName: b.creatorName || '',
      creatorAvatar: b.creatorAvatar || '',
      words: (b.words || []).map((w) => ({
        id: w.id, cn: w.cn, en: w.en,
        state: w.mastered ? 'mastered' : (w.seen ? 'learning' : 'new'),
        everWrong: !!w.everWrong
      }))
    }, () => this._loadStats())
  },

  // 拉「被引用次数」:引用本看源公开库的热度;自己的公开本看自己被引用多少次。
  _loadStats() {
    if (!wx.cloud || !wx.cloud.callFunction) return
    if (this.data.isRef) {
      const ref = this.data._ref
      if (!ref) return
      wx.cloud.callFunction({ name: 'homeworkOCR', data: { action: 'getBook', id: ref } })
        .then((res) => {
          const bk = (res && res.result && res.result.book) || null
          if (!bk) return
          this.setData({
            refCount: bk.refCount || 0,
            creatorName: bk.creatorName || this.data.creatorName,
            creatorAvatar: bk.creatorAvatar || this.data.creatorAvatar
          })
        }).catch(() => {})
    } else if (this.data.isPublic) {
      wx.cloud.callFunction({ name: 'homeworkOCR', data: { action: 'myBookStat', bookKey: this._id } })
        .then((res) => {
          const r = (res && res.result) || {}
          if (r.ok) this.setData({ refCount: r.refCount || 0 })
        }).catch(() => {})
    }
  },

  // === 公开到单词库 / 撤销(调云函数;别人只能搜+复制,改不了你的)===
  togglePublic(e) {
    if (this.data.publicBusy) return
    if (e.detail.value) this._publishBook()
    else this._unpublishBook()
  },

  _publishBook() {
    if (!wx.cloud || !wx.cloud.callFunction) {
      wx.showToast({ title: '当前环境用不了公开', icon: 'none' }); this.setData({ isPublic: false }); return
    }
    const words = (this.data.words || []).map((w) => ({ cn: w.cn, en: w.en }))
    if (!words.length) { wx.showToast({ title: '空单词本不能公开', icon: 'none' }); this.setData({ isPublic: false }); return }
    this.setData({ publicBusy: true })
    wx.showLoading({ title: '发布中…', mask: true })
    const prof = store.getProfile() || {}
    wx.cloud.callFunction({ name: 'homeworkOCR', timeout: 20000, data: { action: 'publishBook', bookKey: this._id, name: this.data.name, words, ownerName: prof.nickname || '', ownerAvatar: prof.avatar || '' } })
      .then((res) => {
        const r = (res && res.result) || {}
        wx.hideLoading(); this.setData({ publicBusy: false })
        if (!r.ok) { this.setData({ isPublic: false }); wx.showToast({ title: r.error || '发布失败', icon: 'none' }); return }
        store.setWordBookPublic(this._id, true)
        this.setData({ isPublic: true })
        wx.showToast({ title: '已公开 ' + (r.count || words.length) + ' 词', icon: 'success' })
      })
      .catch(() => { wx.hideLoading(); this.setData({ publicBusy: false, isPublic: false }); wx.showToast({ title: '发布失败,稍后再试', icon: 'none' }) })
  },

  _unpublishBook() {
    this.setData({ publicBusy: true })
    wx.showLoading({ title: '撤销中…', mask: true })
    const done = () => { wx.hideLoading(); store.setWordBookPublic(this._id, false); this.setData({ publicBusy: false, isPublic: false, refCount: 0 }) }
    if (!wx.cloud || !wx.cloud.callFunction) { done(); return }
    wx.cloud.callFunction({ name: 'homeworkOCR', timeout: 20000, data: { action: 'unpublishBook', bookKey: this._id } })
      .then(() => { done(); wx.showToast({ title: '已撤销公开', icon: 'none' }) })
      .catch(() => { done() })   // 撤销失败也按本地撤销,避免卡在公开态
  },

  // === 引用本:从源拉最新内容(保留 SRS)===
  updateRef() {
    if (this.data.refBusy) return
    const ref = this.data._ref
    if (!ref) { wx.showToast({ title: '这个本没有来源', icon: 'none' }); return }
    if (!wx.cloud || !wx.cloud.callFunction) { wx.showToast({ title: '当前环境用不了同步', icon: 'none' }); return }
    this.setData({ refBusy: true })
    wx.showLoading({ title: '更新中…', mask: true })
    wx.cloud.callFunction({ name: 'homeworkOCR', timeout: 20000, data: { action: 'getBook', id: ref } })
      .then((res) => {
        const r = (res && res.result) || {}
        wx.hideLoading(); this.setData({ refBusy: false })
        if (!r.ok || !r.book) { wx.showToast({ title: r.error || '更新失败', icon: 'none' }); return }
        const n = store.syncReferencedBook(this._id, r.book.words || [])
        this._refresh()
        wx.showToast({ title: '已更新 · ' + n + ' 词', icon: 'success' })
      })
      .catch(() => { wx.hideLoading(); this.setData({ refBusy: false }); wx.showToast({ title: '更新失败,稍后再试', icon: 'none' }) })
  },

  // === 复制成「我自己的」可编辑副本(占自定义单词本额度,从掌握度从头开始)===
  copyBook() {
    if (this.data.copyBusy) return
    if (store.getCustomBookCount() >= store.CUSTOM_WORD_BOOKS_MAX) {
      wx.showToast({ title: '自定义单词本已满(上限 ' + store.CUSTOM_WORD_BOOKS_MAX + ' 个)', icon: 'none' }); return
    }
    const payload = store.serializeWordBookForShare(this._id)
    if (!payload || !payload.w.length) { wx.showToast({ title: '这个单词本是空的', icon: 'none' }); return }
    this.setData({ copyBusy: true })
    const book = store.importSharedWordBook(payload)
    this.setData({ copyBusy: false })
    if (!book) { wx.showToast({ title: '复制失败(可能已达自定义上限)', icon: 'none' }); return }
    wx.showToast({ title: '已复制为可编辑的本', icon: 'success' })
    setTimeout(() => wx.redirectTo({ url: '/pkg-notebook/word-book/index?id=' + book.id }), 650)
  },

  // === 修改单词 ===
  editWord(e) {
    const id = e.currentTarget.dataset.id
    const w = (this.data.words || []).find((x) => x.id === id)
    if (!w) return
    this.setData({ editing: true, editId: id, editCn: w.cn, editEn: w.en })
  },
  onEditCn(e) { this.setData({ editCn: e.detail.value }) },
  onEditEn(e) { this.setData({ editEn: e.detail.value }) },
  cancelEdit() { this.setData({ editing: false, editId: '', editCn: '', editEn: '' }) },
  saveEdit() {
    const cn = (this.data.editCn || '').trim()
    const en = (this.data.editEn || '').trim()
    if (!cn || !en) { wx.showToast({ title: '中文和英文都要填', icon: 'none' }); return }
    const ok = store.updateWord(this._id, this.data.editId, cn, en)
    if (!ok) { wx.showToast({ title: '保存失败', icon: 'none' }); return }
    this.setData({ editing: false, editId: '', editCn: '', editEn: '' })
    this._refresh()
    wx.showToast({ title: '已保存', icon: 'success' })
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
    store.removeWord(this._id, e.currentTarget.dataset.id)
    this._refresh()
  },

  // 单词本本身的改名 / 删除(从本子里面操作,基础词本也能删)
  renameBook() {
    const cur = this.data.name || ''
    wx.showModal({
      title: '单词本改名', editable: true, content: cur, placeholderText: '新名字',
      success: (r) => {
        if (!r.confirm) return
        const next = (r.content || '').trim()
        if (!next || next === cur) return
        store.renameWordBook(this._id, next)
        this._refresh()
      }
    })
  },

  deleteBook() {
    const name = this.data.name || '这个单词本'
    wx.showModal({
      title: '删除单词本',
      content: '确定删除「' + name + '」?里面的单词会一起删掉,无法恢复。',
      confirmText: '删除', confirmColor: '#e15c5c',
      success: (r) => {
        if (!r.confirm) return
        store.removeWordBook(this._id)
        wx.navigateBack({ delta: 1, fail: () => wx.switchTab && wx.navigateBack() })
      }
    })
  },

  // === 拍照 / 选图 OCR 导入 ===
  ocrImport() {
    if (this._ocrBusy) return
    wx.chooseMedia({
      count: 1, mediaType: ['image'], sourceType: ['album', 'camera'], sizeType: ['compressed'],
      success: (res) => {
        const fp = res.tempFiles && res.tempFiles[0] && res.tempFiles[0].tempFilePath
        if (fp) this._runOcr(fp)
      }
    })
  },

  async _runOcr(filePath) {
    if (!wx.cloud || !wx.cloud.callFunction) {
      wx.showModal({ title: '识别不可用', content: '当前环境用不了云识别,先手动加词吧~', showCancel: false })
      return
    }
    this._ocrBusy = true
    wx.showLoading({ title: '上传图片…', mask: true })
    try {
      const up = await wx.cloud.uploadFile({
        cloudPath: 'ocr-words/' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.jpg',
        filePath
      })
      wx.showLoading({ title: '识别中…', mask: true })
      const callRes = await wx.cloud.callFunction({ name: 'homeworkOCR', timeout: 60000, data: { action: 'wordpairs', imageFileID: up.fileID } })
      const result = (callRes && callRes.result) || {}
      wx.hideLoading()
      this._ocrBusy = false
      if (!result.ok) throw new Error(result.error || result.message || '识别失败')
      // 优先用云端单词表专用识别的成对结果;老云函数还没认 wordpairs 时只回 rawText,本地正则兜底。
      let pairs = normalizePairs(result.pairs)
      if (!pairs.length) pairs = parsePairs(result.rawText || '')
      if (!pairs.length) {
        wx.showModal({ title: '没识别到单词', content: '试着拍清楚点,保证图里有「中文 英文」成对的词。', showCancel: false })
        return
      }
      this.setData({ showOcr: true, ocrPairs: pairs })
    } catch (e) {
      wx.hideLoading()
      this._ocrBusy = false
      wx.showModal({ title: '识别失败', content: (e && e.message) || '再试一次,或换张清楚点的图。', showCancel: false })
    }
  },

  removeOcrPair(e) {
    const i = e.currentTarget.dataset.i
    const arr = this.data.ocrPairs.slice()
    arr.splice(i, 1)
    this.setData({ ocrPairs: arr })
  },

  cancelOcr() { this.setData({ showOcr: false, ocrPairs: [] }) },

  noop() {},

  // 分享单词本:把本子打包进分享链接,同学点开走 word-book-import 一键导入。
  onShareAppMessage() {
    const payload = store.serializeWordBookForShare(this._id)
    if (!payload || !payload.w.length) {
      return { title: '一起来单词挑战', path: '/pages/pet/index' }
    }
    const encoded = encodeURIComponent(JSON.stringify(payload))
    return {
      title: '「' + (this.data.name || '单词本') + '」单词本 · 来场单词挑战',
      path: '/pkg-notebook/word-book-import/index?d=' + encoded
    }
  },

  importOcr() {
    const pairs = this.data.ocrPairs || []
    pairs.forEach((p) => store.addWord(this._id, p.cn, p.en))
    this.setData({ showOcr: false, ocrPairs: [] })
    this._refresh()
    wx.showToast({ title: '已导入 ' + pairs.length + ' 个', icon: 'success' })
  }
})
