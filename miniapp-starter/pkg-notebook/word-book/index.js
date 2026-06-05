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
    ocrPairs: []
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
    store.removeWord(this._id, e.currentTarget.dataset.id)
    this._refresh()
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
      const callRes = await wx.cloud.callFunction({ name: 'homeworkOCR', timeout: 60000, data: { imageFileID: up.fileID } })
      const result = (callRes && callRes.result) || {}
      wx.hideLoading()
      this._ocrBusy = false
      if (!result.ok) throw new Error(result.message || '识别失败')
      const pairs = parsePairs(result.rawText || '')
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
      return { title: '一起来背单词', path: '/pages/pet/index' }
    }
    const encoded = encodeURIComponent(JSON.stringify(payload))
    return {
      title: '「' + (this.data.name || '单词本') + '」单词本 · 一起来背单词',
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
