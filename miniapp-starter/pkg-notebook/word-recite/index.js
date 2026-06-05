// 跟宠物一起背单词(遗忘曲线 SRS)。题目来自 store 的单词库,按掌握度组卷;
// 宠物在上方"说"中文,用自制大键盘拼英文。每答对一个给宠物 +1 知识,背完结算。
const store = require('../../utils/store')

// 自制键盘:布局对齐 iPhone 默认英文键盘。
const ROWS_ABC = [
  ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
  ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
  ['z', 'x', 'c', 'v', 'b', 'n', 'm']
]
const ROWS_NUM = [
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
  ['-', '/', ':', ';', '(', ')', '$', '&', '@', '"'],
  ['.', ',', '?', '!', "'"]
]
const INPUT_MAX = 24

function norm(s) { return (s || '').trim().toLowerCase().replace(/\s+/g, ' ') }

Page({
  data: {
    species: 'cat',
    petName: '宝贝',
    knowledge: 0,
    rowsAbc: ROWS_ABC,
    rowsNum: ROWS_NUM,
    kbMode: 'abc',
    shiftActive: false,
    statusBarH: 20,
    // 单次状态
    blocked: false,
    blockedReason: '',
    word: {},
    input: '',
    index: 0,
    total: 0,
    feedback: '',      // '' | 'right' | 'wrong'
    done: false,
    correctCount: 0,
    knowledgeGained: 0,
    canMore: false
  },

  onLoad() {
    let statusBarH = 20
    try { statusBarH = (wx.getSystemInfoSync().statusBarHeight) || 20 } catch (e) {}
    this.setData({ statusBarH })
    this._answered = false
    this._results = []
    this._startSession()
  },

  onUnload() { if (this._t) { clearTimeout(this._t); this._t = null } },

  _startSession() {
    const state = store.getStateWithComputed()
    const pet = (state && state.pet) || {}
    const base = { species: pet.species || 'cat', petName: pet.name || '宝贝', knowledge: pet.knowledge || 0 }
    if (store.reciteRemaining(state) <= 0) {
      this.setData(Object.assign({}, base, { blocked: true, blockedReason: '今天已经背完 3 次啦,明天再来陪它背~' }))
      return
    }
    const session = store.buildReciteSession(state)
    if (!session.length) {
      this.setData(Object.assign({}, base, { blocked: true, blockedReason: '目标单词本里暂时没有要背的词啦~' }))
      return
    }
    this._session = session
    this._results = []
    this._answered = false
    this.setData(Object.assign({}, base, {
      blocked: false, blockedReason: '',
      done: false, index: 0, total: session.length,
      word: session[0], input: '', feedback: '', correctCount: 0, knowledgeGained: 0,
      kbMode: 'abc', shiftActive: false
    }))
  },

  // === 自制键盘 ===
  kbInput(e) {
    if (this.data.feedback) return
    const k = e.currentTarget.dataset.k
    if (!k) return
    const ch = (this.data.kbMode === 'abc' && this.data.shiftActive) ? k.toUpperCase() : k
    const patch = { input: (this.data.input + ch).slice(0, INPUT_MAX), feedback: '' }
    if (this.data.shiftActive) patch.shiftActive = false
    this.setData(patch)
  },
  kbShift() { if (!this.data.feedback) this.setData({ shiftActive: !this.data.shiftActive }) },
  kbToggleMode() { this.setData({ kbMode: this.data.kbMode === 'abc' ? 'num' : 'abc', shiftActive: false }) },
  kbDelete() {
    if (this.data.feedback || !this.data.input) return
    this.setData({ input: this.data.input.slice(0, -1), feedback: '' })
  },
  kbSpace() {
    if (this.data.feedback) return
    if (!this.data.input || this.data.input.slice(-1) === ' ') return
    this.setData({ input: (this.data.input + ' ').slice(0, INPUT_MAX), feedback: '' })
  },

  kbSubmit() {
    if (this.data.feedback) return
    const ans = norm(this.data.input)
    if (!ans) return
    const correct = ans === norm(this.data.word.en)
    // 只认第一次提交(用于 SRS + 知识),之后不再改判。
    if (!this._answered) {
      this._answered = true
      this._results.push({
        bookId: this.data.word.bookId,
        wordId: this.data.word.wordId,
        firstTryCorrect: correct
      })
      if (correct) this.setData({ correctCount: this.data.correctCount + 1 })
    }
    if (this._t) clearTimeout(this._t)
    if (correct) {
      this.setData({ feedback: 'right' })
      this._t = setTimeout(() => this._next(), 1000)
    } else {
      this.setData({ feedback: 'wrong' })
      this._t = setTimeout(() => this._next(), 1900)  // 亮出正确答案一会儿再下一个
    }
  },

  skip() {
    if (this._t) clearTimeout(this._t)
    this._next()   // 没答过就跳:这个词不记结果,以后再背
  },

  _next() {
    const ni = this.data.index + 1
    if (ni >= this._session.length) { this._finish(); return }
    this._answered = false
    this.setData({ index: ni, word: this._session[ni], input: '', feedback: '' })
  },

  _finish() {
    const r = store.applyReciteSession(this._results)
    const state = store.getStateWithComputed()
    const remaining = store.reciteRemaining(state)
    this.setData({
      done: true,
      feedback: '',
      knowledgeGained: (r && r.knowledgeGained) || 0,
      knowledge: (state.pet && state.pet.knowledge) || 0,
      canMore: remaining > 0
    })
  },

  restart() {
    if (this._t) clearTimeout(this._t)
    this._startSession()
  },

  exit() {
    wx.navigateBack({ delta: 1, fail: () => wx.switchTab({ url: '/pages/pet/index' }) })
  }
})
