// 跟宠物一起背单词。宠物在上方"说"中文,用户用自制大键盘拼英文。
// 不用系统输入法 —— 整套键盘是自己用 view 拼的。词表内置,进来随机取一组。
const store = require('../../utils/store')

// 中→英 词表(小学常见词,尽量短)。
const WORD_LIST = [
  { cn: '苹果', en: 'apple' },
  { cn: '香蕉', en: 'banana' },
  { cn: '猫',   en: 'cat' },
  { cn: '狗',   en: 'dog' },
  { cn: '书',   en: 'book' },
  { cn: '笔',   en: 'pen' },
  { cn: '水',   en: 'water' },
  { cn: '牛奶', en: 'milk' },
  { cn: '红色', en: 'red' },
  { cn: '蓝色', en: 'blue' },
  { cn: '绿色', en: 'green' },
  { cn: '鱼',   en: 'fish' },
  { cn: '鸟',   en: 'bird' },
  { cn: '树',   en: 'tree' },
  { cn: '花',   en: 'flower' },
  { cn: '太阳', en: 'sun' },
  { cn: '月亮', en: 'moon' },
  { cn: '手',   en: 'hand' },
  { cn: '脚',   en: 'foot' },
  { cn: '米饭', en: 'rice' },
  { cn: '蛋',   en: 'egg' },
  { cn: '门',   en: 'door' },
  { cn: '车',   en: 'car' },
  { cn: '家',   en: 'home' },
  { cn: '学校', en: 'school' },
  { cn: '老师', en: 'teacher' },
  { cn: '朋友', en: 'friend' },
  { cn: '快乐', en: 'happy' }
]
// 自制键盘:布局对齐 iPhone 默认英文键盘 —— 三行字母(第二行缩进,shift / delete
// 在第三行两端),底排 123 / 空格 / 确定;123 切到数字符号页。
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
const SESSION_N = 12   // 每组题量
const INPUT_MAX = 18

function shuffled(arr) {
  const a = arr.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const t = a[i]; a[i] = a[j]; a[j] = t
  }
  return a
}

Page({
  data: {
    species: 'cat',
    petName: '宝贝',
    rowsAbc: ROWS_ABC,
    rowsNum: ROWS_NUM,
    kbMode: 'abc',         // 'abc' | 'num'
    shiftActive: false,
    word: {},
    input: '',
    index: 0,
    total: 0,
    feedback: '',      // '' | 'right' | 'wrong'
    done: false,
    correctCount: 0,
    statusBarH: 20
  },

  onLoad() {
    let statusBarH = 20
    try { statusBarH = (wx.getSystemInfoSync().statusBarHeight) || 20 } catch (e) {}
    const state = store.getStateWithComputed()
    const pet = (state && state.pet) || {}
    this._queue = shuffled(WORD_LIST).slice(0, SESSION_N)
    this.setData({
      species: pet.species || 'cat',
      petName: pet.name || '宝贝',
      statusBarH,
      total: this._queue.length,
      index: 0,
      word: this._queue[0] || {},
      input: '',
      feedback: '',
      done: false,
      correctCount: 0
    })
  },

  onUnload() { if (this._t) { clearTimeout(this._t); this._t = null } },

  // 自制键盘:点字母 → 追加到答案。答对锁定后(等下一题)不再接收输入。
  kbInput(e) {
    if (this.data.feedback === 'right') return
    const k = e.currentTarget.dataset.k
    if (!k) return
    const ch = (this.data.kbMode === 'abc' && this.data.shiftActive) ? k.toUpperCase() : k
    const patch = { input: (this.data.input + ch).slice(0, INPUT_MAX), feedback: '' }
    if (this.data.shiftActive) patch.shiftActive = false   // 单击 shift 只大写一个字母(同 iPhone)
    this.setData(patch)
  },

  kbShift() {
    if (this.data.feedback === 'right') return
    this.setData({ shiftActive: !this.data.shiftActive })
  },

  kbToggleMode() {
    this.setData({ kbMode: this.data.kbMode === 'abc' ? 'num' : 'abc', shiftActive: false })
  },

  kbDelete() {
    if (this.data.feedback === 'right') return
    if (!this.data.input) return
    this.setData({ input: this.data.input.slice(0, -1), feedback: '' })
  },

  kbSpace() {
    if (this.data.feedback === 'right') return
    // 不让以空格开头,也不连续两个空格
    if (!this.data.input || this.data.input.slice(-1) === ' ') return
    this.setData({ input: (this.data.input + ' ').slice(0, INPUT_MAX), feedback: '' })
  },

  kbSubmit() {
    if (this.data.feedback === 'right') return
    const ans = (this.data.input || '').trim().toLowerCase()
    if (!ans) return
    const correct = ans === (this.data.word.en || '').toLowerCase()
    if (this._t) clearTimeout(this._t)
    if (correct) {
      this.setData({ feedback: 'right', correctCount: this.data.correctCount + 1 })
      this._t = setTimeout(() => this.next(), 1100)
    } else {
      // 答错:亮出正确答案一会儿,再清空让其重试。
      this.setData({ feedback: 'wrong' })
      this._t = setTimeout(() => this.setData({ feedback: '', input: '' }), 1800)
    }
  },

  skip() {
    if (this._t) clearTimeout(this._t)
    this.next()
  },

  next() {
    const ni = this.data.index + 1
    if (ni >= this._queue.length) {
      this.setData({ done: true, feedback: '' })
      return
    }
    this.setData({ index: ni, word: this._queue[ni], input: '', feedback: '' })
  },

  restart() {
    if (this._t) clearTimeout(this._t)
    this._queue = shuffled(WORD_LIST).slice(0, SESSION_N)
    this.setData({
      done: false, index: 0, total: this._queue.length,
      word: this._queue[0] || {}, input: '', feedback: '', correctCount: 0
    })
  },

  exit() {
    wx.navigateBack({ delta: 1, fail: () => wx.switchTab({ url: '/pages/pet/index' }) })
  }
})
