// 单个单词本:增减单词/短语 + 拍照/选图 OCR 导入。
// OCR 复用已部署的 homeworkOCR 云函数拿 rawText,再在本地解析成「中英成对」。
const store = require('../../utils/store')
const i18n = require('../../utils/i18n')

// 把一段 OCR 文本解析成 [{cn,en}]。每行抓中文串 + 英文串(任意先后),成对即收。
function parsePairs(rawText) {
  const lines = (rawText || '').split(/\r?\n/)
  const pairs = []
  const seen = {}
  lines.forEach((raw) => {
    const line = (raw || '').trim()
    if (!line) return
    const cnMatch = line.match(/[一-鿿]+/g)
    const enMatch = line.match(/[a-zA-Z][a-zA-Z''\- ]*[a-zA-Z]|[a-zA-Z]/)
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
    editEn: '',
    t: {}
  },

  onLoad(q) {
    this._id = (q && q.id) || ''
    try { this.setData({ textMax: store.WORD_TEXT_MAX || 40 }) } catch (e) {}
    this._refresh()
  },

  onShow() {
    this.setData({ t: i18n.dict() })
    this._refreshLabels()
  },

  // Recompute all dynamic i18n labels from current data state.
  _refreshLabels() {
    const d = this.data
    const n = d.words ? d.words.length : 0
    const rc = d.refCount || 0
    this.setData({
      countLabel: i18n.t('wbook_count', { n }),
      publicOnLabel: i18n.t('wbook_public_on', { n: rc }),
      refCountLabel: i18n.t('wbook_ref_count', { n: rc }),
      ocrTitle: i18n.t('wbook_ocr_title', { n: d.ocrPairs ? d.ocrPairs.length : 0 }),
      ocrImportLabel: i18n.t('wbook_ocr_import_btn', { n: d.ocrPairs ? d.ocrPairs.length : 0 })
    })
  },

  _refresh() {
    const s = store.getStateWithComputed()
    const b = (s.wordBooks || []).find((x) => x.id === this._id)
    if (!b) { wx.navigateBack({ delta: 1 }); return }
    wx.setNavigationBarTitle({ title: b.name || i18n.t('wbook_navtitle_fallback') })
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
    }, () => { this._loadStats(); this._refreshLabels() })
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
          }, () => this._refreshLabels())
        }).catch(() => {})
    } else if (this.data.isPublic) {
      wx.cloud.callFunction({ name: 'homeworkOCR', data: { action: 'myBookStat', bookKey: this._id } })
        .then((res) => {
          const r = (res && res.result) || {}
          if (r.ok) this.setData({ refCount: r.refCount || 0 }, () => this._refreshLabels())
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
      wx.showToast({ title: i18n.t('wbook_toast_no_cloud_publish'), icon: 'none' }); this.setData({ isPublic: false }); return
    }
    const words = (this.data.words || []).map((w) => ({ cn: w.cn, en: w.en }))
    if (!words.length) { wx.showToast({ title: i18n.t('wbook_toast_empty_publish'), icon: 'none' }); this.setData({ isPublic: false }); return }
    this.setData({ publicBusy: true })
    wx.showLoading({ title: i18n.t('wbook_loading_publishing'), mask: true })
    const prof = store.getProfile() || {}
    wx.cloud.callFunction({ name: 'homeworkOCR', timeout: 20000, data: { action: 'publishBook', bookKey: this._id, name: this.data.name, words, ownerName: prof.nickname || '', ownerAvatar: prof.avatar || '' } })
      .then((res) => {
        const r = (res && res.result) || {}
        wx.hideLoading(); this.setData({ publicBusy: false })
        if (!r.ok) { this.setData({ isPublic: false }); wx.showToast({ title: r.error || i18n.t('wbook_toast_publish_fail'), icon: 'none' }); return }
        store.setWordBookPublic(this._id, true)
        this.setData({ isPublic: true }, () => this._refreshLabels())
        wx.showToast({ title: i18n.t('wbook_toast_published', { n: r.count || words.length }), icon: 'success' })
      })
      .catch(() => { wx.hideLoading(); this.setData({ publicBusy: false, isPublic: false }); wx.showToast({ title: i18n.t('wbook_toast_publish_fail_retry'), icon: 'none' }) })
  },

  _unpublishBook() {
    this.setData({ publicBusy: true })
    wx.showLoading({ title: i18n.t('wbook_loading_unpublishing'), mask: true })
    const done = () => { wx.hideLoading(); store.setWordBookPublic(this._id, false); this.setData({ publicBusy: false, isPublic: false, refCount: 0 }, () => this._refreshLabels()) }
    if (!wx.cloud || !wx.cloud.callFunction) { done(); return }
    wx.cloud.callFunction({ name: 'homeworkOCR', timeout: 20000, data: { action: 'unpublishBook', bookKey: this._id } })
      .then(() => { done(); wx.showToast({ title: i18n.t('wbook_toast_unpublished'), icon: 'none' }) })
      .catch(() => { done() })   // 撤销失败也按本地撤销,避免卡在公开态
  },

  // === 引用本:从源拉最新内容(保留 SRS)===
  updateRef() {
    if (this.data.refBusy) return
    const ref = this.data._ref
    if (!ref) { wx.showToast({ title: i18n.t('wbook_toast_no_source'), icon: 'none' }); return }
    if (!wx.cloud || !wx.cloud.callFunction) { wx.showToast({ title: i18n.t('wbook_toast_no_cloud_sync'), icon: 'none' }); return }
    this.setData({ refBusy: true })
    wx.showLoading({ title: i18n.t('wbook_loading_updating'), mask: true })
    wx.cloud.callFunction({ name: 'homeworkOCR', timeout: 20000, data: { action: 'getBook', id: ref } })
      .then((res) => {
        const r = (res && res.result) || {}
        wx.hideLoading(); this.setData({ refBusy: false })
        if (!r.ok || !r.book) {
          // 源被作者撤回 / 删除:这本仍可继续用,只是没法再同步新内容。说清楚、不报错脸。
          wx.showModal({ title: i18n.t('wbook_modal_source_gone_title'), content: i18n.t('wbook_modal_source_gone_content'), showCancel: false, confirmText: i18n.t('wbook_modal_source_gone_ok') })
          return
        }
        const n = store.syncReferencedBook(this._id, r.book.words || [])
        this._refresh()
        wx.showToast({ title: i18n.t('wbook_toast_updated', { n }), icon: 'success' })
      })
      .catch(() => { wx.hideLoading(); this.setData({ refBusy: false }); wx.showToast({ title: i18n.t('wbook_toast_update_fail'), icon: 'none' }) })
  },

  // === 复制成「我自己的」可编辑副本(占自定义单词本额度,从掌握度从头开始)===
  copyBook() {
    if (this.data.copyBusy) return
    if (store.getCustomBookCount() >= store.CUSTOM_WORD_BOOKS_MAX) {
      wx.showToast({ title: i18n.t('wbook_toast_book_full', { n: store.CUSTOM_WORD_BOOKS_MAX }), icon: 'none' }); return
    }
    const payload = store.serializeWordBookForShare(this._id)
    if (!payload || !payload.w.length) { wx.showToast({ title: i18n.t('wbook_toast_book_empty'), icon: 'none' }); return }
    this.setData({ copyBusy: true })
    const book = store.importSharedWordBook(payload)
    this.setData({ copyBusy: false })
    if (!book) { wx.showToast({ title: i18n.t('wbook_toast_copy_fail'), icon: 'none' }); return }
    wx.showToast({ title: i18n.t('wbook_toast_copy_ok'), icon: 'success' })
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
    if (!cn || !en) { wx.showToast({ title: i18n.t('wbook_toast_both_required'), icon: 'none' }); return }
    const ok = store.updateWord(this._id, this.data.editId, cn, en)
    if (!ok) { wx.showToast({ title: i18n.t('wbook_toast_save_fail'), icon: 'none' }); return }
    this.setData({ editing: false, editId: '', editCn: '', editEn: '' })
    this._refresh()
    wx.showToast({ title: i18n.t('wbook_toast_saved'), icon: 'success' })
  },

  onCn(e) { this.setData({ cnInput: e.detail.value }) },
  onEn(e) { this.setData({ enInput: e.detail.value }) },

  addWord() {
    const cn = (this.data.cnInput || '').trim()
    const en = (this.data.enInput || '').trim()
    if (!cn || !en) { wx.showToast({ title: i18n.t('wbook_toast_both_required'), icon: 'none' }); return }
    const w = store.addWord(this._id, cn, en)
    if (!w) { wx.showToast({ title: i18n.t('wbook_toast_add_fail'), icon: 'none' }); return }
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
      title: i18n.t('wbook_modal_rename_title'), editable: true, content: cur, placeholderText: i18n.t('wbook_modal_rename_placeholder'),
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
    const name = this.data.name || ''
    wx.showModal({
      title: i18n.t('wbook_modal_delete_title'),
      content: i18n.t('wbook_modal_delete_content', { name }),
      confirmText: i18n.t('wbook_modal_delete_confirm'), confirmColor: '#e15c5c',
      success: (r) => {
        if (!r.confirm) return
        // 自己的公开本被删:顺手把云端公开副本也撤掉,这样别人「引用」的本以后
        // 不再同步到新内容(但他们已引用的快照不受影响,仍可继续用)。best-effort。
        if (this.data.isPublic && !this.data.isRef && wx.cloud && wx.cloud.callFunction) {
          wx.cloud.callFunction({ name: 'homeworkOCR', data: { action: 'unpublishBook', bookKey: this._id } }).catch(() => {})
        }
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
      wx.showModal({ title: i18n.t('wbook_modal_ocr_unavail_title'), content: i18n.t('wbook_modal_ocr_unavail_content'), showCancel: false })
      return
    }
    this._ocrBusy = true
    wx.showLoading({ title: i18n.t('wbook_loading_uploading'), mask: true })
    try {
      const up = await wx.cloud.uploadFile({
        cloudPath: 'ocr-words/' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.jpg',
        filePath
      })
      wx.showLoading({ title: i18n.t('wbook_loading_recognizing'), mask: true })
      const callRes = await wx.cloud.callFunction({ name: 'homeworkOCR', timeout: 60000, data: { action: 'wordpairs', imageFileID: up.fileID } })
      const result = (callRes && callRes.result) || {}
      wx.hideLoading()
      this._ocrBusy = false
      if (!result.ok) throw new Error(result.error || result.message || i18n.t('wbook_modal_ocr_fail_title'))
      // 优先用云端单词表专用识别的成对结果;老云函数还没认 wordpairs 时只回 rawText,本地正则兜底。
      let pairs = normalizePairs(result.pairs)
      if (!pairs.length) pairs = parsePairs(result.rawText || '')
      if (!pairs.length) {
        wx.showModal({ title: i18n.t('wbook_modal_ocr_none_title'), content: i18n.t('wbook_modal_ocr_none_content'), showCancel: false })
        return
      }
      this.setData({ showOcr: true, ocrPairs: pairs }, () => this._refreshLabels())
    } catch (e) {
      wx.hideLoading()
      this._ocrBusy = false
      wx.showModal({ title: i18n.t('wbook_modal_ocr_fail_title'), content: (e && e.message) || i18n.t('wbook_modal_ocr_fail_content'), showCancel: false })
    }
  },

  removeOcrPair(e) {
    const i = e.currentTarget.dataset.i
    const arr = this.data.ocrPairs.slice()
    arr.splice(i, 1)
    this.setData({ ocrPairs: arr }, () => this._refreshLabels())
  },

  cancelOcr() { this.setData({ showOcr: false, ocrPairs: [] }) },

  noop() {},

  // 分享单词本:把本子打包进分享链接,同学点开走 word-book-import 一键导入。
  onShareAppMessage() {
    const payload = store.serializeWordBookForShare(this._id)
    if (!payload || !payload.w.length) {
      return { title: i18n.t('wbook_share_empty_title'), path: '/pages/pet/index' }
    }
    const encoded = encodeURIComponent(JSON.stringify(payload))
    return {
      title: i18n.t('wbook_share_title', { name: this.data.name || '' }),
      path: '/pkg-notebook/word-book-import/index?d=' + encoded
    }
  },

  importOcr() {
    const pairs = this.data.ocrPairs || []
    pairs.forEach((p) => store.addWord(this._id, p.cn, p.en))
    this.setData({ showOcr: false, ocrPairs: [] })
    this._refresh()
    wx.showToast({ title: i18n.t('wbook_toast_imported', { n: pairs.length }), icon: 'success' })
  }
})
