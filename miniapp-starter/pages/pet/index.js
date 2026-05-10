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

// Tiny visual milestone for higher levels — pet name gets a star/crown badge
// once it reaches L3 / L5. Keeps the "level matters" feeling without rewriting
// any of the SVG assets. (See V1-VALUES-DESIGN.md §5.)
function levelBadge(level) {
  if (!level || level < 3) return ''
  if (level < 5) return '⭐'
  return '👑'
}

// === Parrot animation state machine (V1-PET-ANIMATION-SPEC §3) ===
// Per-state durations (ms). Match the WXSS keyframes — eating/celebrating/
// flying are "one-shot" recipes that play once and return to idle; idle/
// walking/sleeping are loopable recipes the auto-cycler picks between.
const ANIM_RECIPES = {
  idle:        { duration: 2800, oneShot: false },
  walking:     { duration: 9000, oneShot: false },
  sleeping:    { duration: 5000, oneShot: false },
  flying:      { duration: 3500, oneShot: true  },
  eating:      { duration: 1800, oneShot: true  },
  celebrating: { duration: 2000, oneShot: true  }
}
const FLY_MIN_GAP_MS = 25000
const FLY_MAX_GAP_MS = 40000

function isParrot(pet) { return !!(pet && pet.species === 'parrot') }

// What auto-cycle states are available given current pet vitals.
// Per spec §3: when health/cleanliness are low, calm states only.
function pickAutoState(pet) {
  if (!pet) return 'idle'
  const unwell = (pet.health || 0) < 30 || (pet.cleanliness || 0) < 30
  if (unwell) {
    return Math.random() < 0.65 ? 'idle' : 'sleeping'
  }
  const r = Math.random()
  if (r < 0.55) return 'idle'
  if (r < 0.90) return 'walking'
  return 'sleeping'
}

Page({
  data: {
    pet: {},
    coins: 0,
    shopItems: [],
    speciesOptions: store.PET_SPECIES,
    switchCost: store.PET_SWITCH_COST,
    showSwitchPanel: false,
    switching: false,
    mode: 'view',          // 'setup' | 'view'
    setupSpecies: '',
    setupName: '',
    animState: 'idle',
    // Parrot-specific animation channel (V1-PET-ANIMATION-SPEC). Other species
    // ignore this and keep using `animState` for their CSS class.
    currentAnim: 'idle',
    showBubble: false,
    bubbleText: '',
    ageDays: 0,
    levelCost: 0,
    levelProgress: 0,    // 0–100 percent for the progress bar
    canLevelUp: false,
    levelBadge: ''
  },

  onShow() {
    const tb = typeof this.getTabBar === 'function' && this.getTabBar()
    if (tb) tb.setData({ selected: 3 })
    this.refreshState()
    // Consume celebration flag from home page (set in maybeShowReward).
    const app = getApp()
    if (app && app.globalData && app.globalData.petAnimQueue === 'celebrating') {
      app.globalData.petAnimQueue = null
      this.queueAnim('celebrating')
    }
    cloudSync.hydrateIfStale().then((r) => {
      if (r && r.changed) this.refreshState()
    }).catch(() => {})
  },

  onHide() {
    if (this._bubbleTimer) {
      clearTimeout(this._bubbleTimer)
      this._bubbleTimer = null
    }
    this._stopAnimEngine()
  },

  onUnload() {
    this._stopAnimEngine()
  },

  refreshState() {
    const state = store.getStateWithComputed()
    const pet = state.pet || {}
    const isSetup = !!pet.species
    const levelCost = isSetup ? store.getLevelCost(pet.level || 1) : 0
    const levelProgress = levelCost > 0
      ? Math.min(100, Math.floor(((state.coins || 0) / levelCost) * 100))
      : 0
    this.setData({
      pet,
      coins: state.coins,
      shopItems: state.shopItems,
      mode: isSetup ? 'view' : 'setup',
      animState: isSetup ? deriveAnimState(pet) : 'idle',
      ageDays: isSetup ? store.petAgeDays(pet) : 0,
      levelCost,
      levelProgress,
      canLevelUp: isSetup && (state.coins || 0) >= levelCost,
      levelBadge: levelBadge(pet.level || 1),
      showBubble: false,
      bubbleText: ''
    })
    // Start/stop the parrot animation engine alongside refreshState. Idempotent:
    // _startAnimEngine is a no-op if timers are already armed.
    if (isSetup && isParrot(pet)) {
      this._startAnimEngine()
    } else {
      this._stopAnimEngine()
    }
  },

  // === Parrot animation engine === //
  // The engine runs two independent timers:
  //   _cycleTimer — picks the next loopable state (idle/walking/sleeping)
  //                 from pickAutoState() each tick. Driven by the previous
  //                 state's duration so transitions feel paced, not random.
  //   _flyTimer   — separate cadence for the rare "short flight" event.
  //                 Skipped silently while the pet is unwell or while a
  //                 one-shot is playing.
  // queueAnim() (eating / celebrating) is the highest-priority lane: it
  // interrupts the auto cycle, plays once, and resumes idle.
  _startAnimEngine() {
    if (this._cycleTimer || this._flyTimer || this._oneShotTimer) return
    if (!this.data.currentAnim) this.setData({ currentAnim: 'idle' })
    this._scheduleNextAuto(ANIM_RECIPES.idle.duration)
    this._scheduleFlying()
  },

  _stopAnimEngine() {
    if (this._cycleTimer)   { clearTimeout(this._cycleTimer);   this._cycleTimer = null }
    if (this._flyTimer)     { clearTimeout(this._flyTimer);     this._flyTimer = null }
    if (this._oneShotTimer) { clearTimeout(this._oneShotTimer); this._oneShotTimer = null }
    this._oneShotActive = false
    this._queuedOneShot = null
  },

  _scheduleNextAuto(delay) {
    if (this._cycleTimer) clearTimeout(this._cycleTimer)
    this._cycleTimer = setTimeout(() => {
      this._cycleTimer = null
      if (!isParrot(this.data.pet)) return
      // Defer if a one-shot owns the stage — re-check shortly.
      if (this._oneShotActive) {
        this._scheduleNextAuto(500)
        return
      }
      const next = pickAutoState(this.data.pet)
      this.setData({ currentAnim: next })
      this._scheduleNextAuto(ANIM_RECIPES[next].duration)
    }, Math.max(0, delay))
  },

  _scheduleFlying() {
    if (this._flyTimer) clearTimeout(this._flyTimer)
    const wait = FLY_MIN_GAP_MS + Math.floor(Math.random() * (FLY_MAX_GAP_MS - FLY_MIN_GAP_MS))
    this._flyTimer = setTimeout(() => {
      this._flyTimer = null
      if (!isParrot(this.data.pet)) return
      const pet = this.data.pet
      const unwell = (pet.health || 0) < 30 || (pet.cleanliness || 0) < 30
      // Don't fly while sick/dirty (per spec §3) or during a user-triggered
      // one-shot. Just re-arm the next attempt.
      if (unwell || this._oneShotActive) {
        this._scheduleFlying()
        return
      }
      this._playOneShot('flying', () => this._scheduleFlying())
    }, wait)
  },

  // Public: external triggers (eating from shop, celebrating from home).
  // Highest priority — interrupts the auto cycle. Multiple back-to-back
  // calls queue (one slot — only the latest is kept).
  queueAnim(name) {
    if (!isParrot(this.data.pet)) return
    const recipe = ANIM_RECIPES[name]
    if (!recipe || !recipe.oneShot) return
    if (this._oneShotActive) {
      this._queuedOneShot = name
      return
    }
    this._playOneShot(name)
  },

  _playOneShot(name, after) {
    const recipe = ANIM_RECIPES[name]
    if (!recipe) return
    this._oneShotActive = true
    if (this._cycleTimer) { clearTimeout(this._cycleTimer); this._cycleTimer = null }
    this.setData({ currentAnim: name })
    if (this._oneShotTimer) clearTimeout(this._oneShotTimer)
    this._oneShotTimer = setTimeout(() => {
      this._oneShotTimer = null
      this._oneShotActive = false
      if (typeof after === 'function') after()
      if (this._queuedOneShot) {
        const next = this._queuedOneShot
        this._queuedOneShot = null
        this._playOneShot(next)
      } else {
        this.setData({ currentAnim: 'idle' })
        this._scheduleNextAuto(ANIM_RECIPES.idle.duration)
      }
    }, recipe.duration)
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
    // Only food items (those that raise fullness) trigger the eating
    // animation — bath / toy / vitamin items don't (per spec §4).
    if ((item.fullness || 0) > 0) this.queueAnim('eating')
  },

  handleLevelUp() {
    if (!this.data.canLevelUp) {
      wx.showToast({ title: '金币不够升级', icon: 'none' })
      return
    }
    const r = store.levelUpPet()
    this.refreshState()
    if (r && r.ok) {
      wx.showToast({ title: `升到 Lv.${r.level}！`, icon: 'success' })
    }
  },

  // === Switch species === //
  handleOpenSwitchPanel() {
    this.setData({ showSwitchPanel: true })
  },

  handleCloseSwitchPanel() {
    this.setData({ showSwitchPanel: false })
  },

  handlePickSwitchSpecies(e) {
    if (this.data.switching) return
    const id = e.currentTarget.dataset.id
    const entry = store.PET_SPECIES.find((s) => s.id === id)
    if (!entry) return
    if (this.data.pet.species === id) return  // current species — disabled
    if ((this.data.coins || 0) < this.data.switchCost) {
      wx.showToast({ title: `金币不足，需要 ${this.data.switchCost}`, icon: 'none' })
      return
    }
    this.setData({ switching: true })
    wx.showModal({
      title: '换宠物',
      content: `花 ${this.data.switchCost} 金币换成 ${entry.emoji} ${entry.label} 吗？属性、等级和名字都会保留。`,
      confirmText: '确认',
      cancelText: '取消',
      success: (res) => {
        if (!res.confirm) {
          this.setData({ switching: false })
          return
        }
        const r = store.switchPetSpecies(id)
        this.setData({ switching: false, showSwitchPanel: false })
        this.refreshState()
        if (r && r.ok) {
          wx.showToast({ title: `换成 ${r.emoji} ${r.label} 啦！`, icon: 'success' })
        } else if (r && r.reason === 'not-enough-coins') {
          wx.showToast({ title: `金币不足，需要 ${this.data.switchCost}`, icon: 'none' })
        }
      },
      fail: () => { this.setData({ switching: false }) }
    })
  }
})
