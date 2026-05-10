const store = require('../../utils/store')
const cloudSync = require('../../utils/cloud-sync')

// Animation state derived from current pet stats. Priority: critical health
// problems first, then mood, then "happy" only when everything is comfy.
function deriveAnimState(pet) {
  if (!pet || !pet.species) return 'idle'
  if (pet.health      < 30) return 'sick'
  if (pet.fullness    < 30) return 'hungry'
  if (pet.cleanliness < 30) return 'dirty'
  if (pet.happiness   < 30) return 'sad'
  if (pet.happiness >= 80
      && pet.fullness    >= 50
      && pet.cleanliness >= 50
      && pet.health      >= 50) return 'happy'
  return 'idle'
}

const SPEAKING_LINES = {
  hungry:  ['我饿了…要吃东西啦', '咕噜咕噜，肚子空空的'],
  dirty:   ['我想洗澡澡了～', '快帮我搓个泡泡浴'],
  sick:    ['不太舒服…想吃药', '我有点头晕…'],
  sad:     ['陪陪我嘛', '今天有点闷闷的'],
  happy:   ['好喜欢你呀！', '今天天气真好！', '嘻嘻嘻～'],
  idle:    ['今天过得怎么样呀？', '想我了吗？', '一起加油哦～']
}

function pickLine(state) {
  const arr = SPEAKING_LINES[state] || SPEAKING_LINES.idle
  return arr[Math.floor(Math.random() * arr.length)]
}

Page({
  data: {
    pet: {},
    coins: 0,
    shopItems: [],
    speciesOptions: store.PET_SPECIES,
    mode: 'view',          // 'setup' | 'view'
    setupSpecies: '',
    setupName: '',
    animState: 'idle',
    showBubble: false,
    bubbleText: '',
    ageDays: 0
  },

  onShow() {
    const tb = typeof this.getTabBar === 'function' && this.getTabBar()
    if (tb) tb.setData({ selected: 3 })
    this.refreshState()
    cloudSync.hydrateIfStale().then((r) => {
      if (r && r.changed) this.refreshState()
    }).catch(() => {})
  },

  onHide() {
    if (this._bubbleTimer) {
      clearTimeout(this._bubbleTimer)
      this._bubbleTimer = null
    }
  },

  refreshState() {
    const state = store.getStateWithComputed()
    const pet = state.pet || {}
    const isSetup = !!pet.species
    this.setData({
      pet,
      coins: state.coins,
      shopItems: state.shopItems,
      mode: isSetup ? 'view' : 'setup',
      animState: isSetup ? deriveAnimState(pet) : 'idle',
      ageDays: isSetup ? store.petAgeDays(pet) : 0,
      showBubble: false,
      bubbleText: ''
    })
  },

  // === Setup flow === //
  handlePickSpecies(e) {
    this.setData({ setupSpecies: e.currentTarget.dataset.id })
  },

  handleSetupName(e) {
    this.setData({ setupName: e.detail.value })
  },

  handleConfirmSetup() {
    const { setupSpecies, setupName } = this.data
    if (!setupSpecies) {
      wx.showToast({ title: '选一只想养的吧', icon: 'none' })
      return
    }
    const trimmed = (setupName || '').trim()
    if (!trimmed) {
      wx.showToast({ title: '给它起个名字吧', icon: 'none' })
      return
    }
    store.setupPet({ species: setupSpecies, name: trimmed })
    this.refreshState()
    wx.showToast({ title: `你好，${trimmed}！`, icon: 'success' })
  },

  // === Pet interactions === //
  handleTapPet() {
    if (this.data.mode !== 'view') return
    const baseState = deriveAnimState(this.data.pet)
    const line = pickLine(baseState)
    this.setData({ showBubble: true, bubbleText: line, animState: 'talking' })
    if (this._bubbleTimer) clearTimeout(this._bubbleTimer)
    this._bubbleTimer = setTimeout(() => {
      this.setData({ showBubble: false, animState: deriveAnimState(this.data.pet) })
      this._bubbleTimer = null
    }, 2200)
  },

  handleBuyItem(event) {
    const { id } = event.currentTarget.dataset
    const before = store.getStateWithComputed()
    const item = before.shopItems.find((shopItem) => shopItem.id === id)
    if (before.coins < item.price) {
      wx.showToast({ title: '金币不够', icon: 'none' })
      return
    }

    store.buyItem(id)
    this.refreshState()
    wx.showToast({ title: `${item.name} 已购买`, icon: 'success' })
  }
})
