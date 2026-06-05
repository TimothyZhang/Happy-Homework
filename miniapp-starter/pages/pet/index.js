const store = require('../../utils/store')
const cloudSync = require('../../utils/cloud-sync')
const perf = require('../../utils/perf')

const deriveAnimState = store.deriveAnimState

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

// === 2.5D 场景宠物引擎 ===
// 宠物在一个伪 3D 房间(scene)里自动漫游 + 可点地板走到指定点。坐标用 scene
// 百分比,脚底为锚点(actorX/actorY);深度(actorY 越大越近)推出身体缩放
// (actorScale)和前后遮挡(actorZ)。行走方向取位移主轴 → 上/下/左/右四向,
// 左右用镜像翻转,上/下沿用正面图(朝镜头)。eating/celebrating/happy 是原地
// 一次性动作,会暂停漫游、播完恢复。
const ONESHOT_MS = { eating: 1800, celebrating: 2000, happy: 1200 }

// 地板可行走带(全屏 room 的百分比)。上沿(yMin)= 远处,下沿(yMax)= 近处。
// 带子落在房间地板的可见区(被下方控制卡盖住之前),侧面行走以横向为主。
const FLOOR = { xMin: 8, xMax: 92, yMin: 46, yMax: 76 }
const DEPTH_FAR = 0.72      // 脚底在 yMin(最远)时的身体缩放
const DEPTH_NEAR = 1.12     // 脚底在 yMax(最近)时的身体缩放
const WALK_SPEED_PCT_PER_S = 24   // 行走速度(room% / 秒)→ 每段 transition 时长
// 竖屏里纵向 1% 跨的像素远多于横向(屏高≈屏宽×2.2),给 dy 加权,
// 让纵向移动 duration 变长 → 纵向走得没那么快(横向不变)。
const VERTICAL_WEIGHT = 2.2
const WALK_MIN_MS = 600, WALK_MAX_MS = 3000
const IDLE_MIN_MS = 700, IDLE_MAX_MS = 2400

function clampNum(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }

// 深度缩放:actorY 在 [yMin,yMax] 线性映射到 [DEPTH_FAR,DEPTH_NEAR]。
function depthForY(y) {
  const t = clampNum((y - FLOOR.yMin) / (FLOOR.yMax - FLOOR.yMin), 0, 1)
  return Math.round((DEPTH_FAR + (DEPTH_NEAR - DEPTH_FAR) * t) * 1000) / 1000
}
// 近的盖远的:y 越大 z 越高。
function zForY(y) { return 10 + Math.round(y) }

// 侧面行走:朝向只看水平位移方向(left 镜像 / right 原图);纯竖直移动保持原朝向。
// 四个方向走起来看到的都是侧面,只是左右镜像 + 远近缩放不同。
function faceFromDelta(dx, prevFace) {
  if (dx < -2) return 'left'
  if (dx > 2) return 'right'
  return prevFace || 'right'
}

function hasAnimRig(pet) { return !!(pet && pet.species) }

Page({
  data: {
    pet: {},
    coins: 0,
    shopItems: [],
    speciesOptions: store.PET_SPECIES,
    switchCost: store.PET_SWITCH_COST,
    renameCost: store.PET_RENAME_COST,
    petNameMax: store.PET_NAME_MAX_LEN,
    showSwitchPanel: false,
    switching: false,
    mode: 'view',          // 'setup' | 'view'
    setupSpecies: '',
    setupName: '',
    // Vital "mood" state — drives the .anim-{state} class for filter overlays
    // (grayscale on sad, hue-rotate on sick, brightness drop on dirty) and the
    // small state-icon emojis (🍖 / 💨 / 🤒 / 💧 / 💖).
    animState: 'idle',
    // 2.5D 场景 actor:脚底锚点 (actorX,actorY) 为 room 百分比;actorScale 由
    // 深度推出;actorZ 控前后遮挡;actorFace(left/right)决定侧面朝向(left 镜像);
    // actorMoving 决定走/站姿;moveDurMs 是这一段位移的 transition 时长;spriteAnim
    // 是原地一次性动作名(eating/celebrating/happy)。
    actorX: 50,
    actorY: 62,
    actorScale: 1,
    actorZ: 72,
    actorFace: 'right',
    actorMoving: false,
    moveDurMs: 0,
    spriteAnim: '',
    showPetMenu: false,
    showBubble: false,
    bubbleText: '',
    ageDays: 0,
    // 升级:经验值满 → 用户手动点按钮触发升级动画。
    // xp = 当前已积累的 XP;xpNeeded = 升到下一级需要的 XP;xpPercent = 进度条百分比。
    // xpPerHour:当前实际速率,显示在 "经验值 · X 点/小时" 标签里。
    // xpPreviewWidth:下一小时即将获得的 XP 占 xpNeeded 的百分比;
    //   xp-bar 主蓝条右侧用浅蓝色画一段"由短变长"的动画,长度上限就是这个值,
    //   告诉用户"下一小时可以涨到这里"。canLevelUp 时不显示(用户该点升级了)。
    xp: 0,
    xpNeeded: 0,
    xpPercent: 0,
    xpPerHour: 0,
    xpPreviewWidth: 0,
    canLevelUp: false,
    isMaxLevel: false,
    levelMax: store.LEVEL_MAX,
    levelBadge: '',
    // 升级动画覆盖层:点击升级按钮 → 触发 LEVEL_UP_ANIM_MS 的全屏动画。
    showLevelUpAnim: false,
    levelUpToLevel: 0
  },

  onShow() {
    const stamp = perf.markPageShow('pet')
    const tb = typeof this.getTabBar === 'function' && this.getTabBar()
    if (tb) tb.setData({ selected: 1 })
    this.refreshState(stamp)
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
    if (this._levelAnimTimer) {
      clearTimeout(this._levelAnimTimer)
      this._levelAnimTimer = null
      this.setData({ showLevelUpAnim: false })
    }
    this._stopSceneEngine()
  },

  onUnload() {
    if (this._levelAnimTimer) {
      clearTimeout(this._levelAnimTimer)
      this._levelAnimTimer = null
    }
    this._stopSceneEngine()
  },

  refreshState(perfStamp) {
    const state = store.getStateWithComputed()
    const pet = state.pet || {}
    const isSetup = !!pet.species
    const isMaxLevel = isSetup && (pet.level || 1) >= store.LEVEL_MAX
    const xpNeeded = isSetup && !isMaxLevel ? store.getXpForLevel(pet.level || 1) : 0
    const xp = pet.xp | 0
    const xpPercent = isMaxLevel ? 100
      : xpNeeded > 0 ? Math.max(0, Math.min(100, Math.floor(xp * 100 / xpNeeded))) : 0
    const canLevelUp = !isMaxLevel && xp >= xpNeeded
    // 当前 mult 用 pet(已含 petWithDecay 的衰减结果,因为 state 来自 getStateWithComputed)。
    // 显示一位小数足够区分 "+6.5 / h" vs "+10 / h",避免 "+6 / h" 失真。
    const xpPerHourRaw = isSetup ? store.currentXpPerHour(pet) : 0
    const xpPerHour = Math.round(xpPerHourRaw * 10) / 10
    // 下一小时预览段宽度:把下一小时能涨的 XP 折算成进度条 % 长度,
    // clip 到 [0, 100 - xpPercent](不能超过条尾)。
    const xpPreviewWidth = !isSetup || isMaxLevel || xpNeeded <= 0
      ? 0
      : Math.max(0, Math.min(100 - xpPercent, xpPerHourRaw * 100 / xpNeeded))
    this.setData({
      pet,
      coins: state.coins,
      shopItems: state.shopItems,
      mode: isSetup ? 'view' : 'setup',
      animState: isSetup ? deriveAnimState(pet) : 'idle',
      ageDays: isSetup ? store.petAgeDays(pet) : 0,
      xp,
      xpNeeded,
      xpPercent,
      xpPerHour,
      xpPreviewWidth,
      canLevelUp,
      isMaxLevel,
      levelBadge: levelBadge(pet.level || 1),
      showBubble: false,
      bubbleText: ''
    }, perfStamp ? () => perf.markPaint(perfStamp) : undefined)
    // Start/stop the 2.5D scene engine alongside refreshState. Idempotent —
    // _startSceneEngine is a no-op if already running. First setup drops the
    // pet at a sensible spot and measures the scene rect (for tap-to-walk).
    if (isSetup && hasAnimRig(pet)) {
      if (!this._actorReady) { this._initActor(); this._actorReady = true }
      this._startSceneEngine()
    } else {
      this._stopSceneEngine()
    }
  },

  // === 2.5D scene engine === //
  // 自动漫游:挑一个地板上的随机目标点 → 走过去(setData 目标 + transition 时长,
  // CSS 负责平滑滑行)→ 到点歇一下 → 再挑下一个。生病/脏时多半原地歇着。
  // queueAnim(eating/celebrating/happy)是最高优先级的原地动作,暂停漫游。
  _initActor() {
    const y = (FLOOR.yMin + FLOOR.yMax) / 2
    this.setData({
      actorX: 50, actorY: y,
      actorScale: depthForY(y), actorZ: zForY(y),
      actorFace: 'right', actorMoving: false, moveDurMs: 0
    })
  },

  _startSceneEngine() {
    if (this._engineOn) return
    this._engineOn = true
    this._scheduleWander(500 + Math.random() * 700)
  },

  _stopSceneEngine() {
    this._engineOn = false
    if (this._wanderTimer)  { clearTimeout(this._wanderTimer);  this._wanderTimer = null }
    if (this._arriveTimer)  { clearTimeout(this._arriveTimer);  this._arriveTimer = null }
    if (this._oneShotTimer) { clearTimeout(this._oneShotTimer); this._oneShotTimer = null }
    this._oneShotActive = false
  },

  _scheduleWander(delay) {
    if (this._wanderTimer) clearTimeout(this._wanderTimer)
    this._wanderTimer = setTimeout(() => {
      this._wanderTimer = null
      if (!this._engineOn || !hasAnimRig(this.data.pet)) return
      if (this._oneShotActive) { this._scheduleWander(500); return }
      const pet = this.data.pet
      const unwell = (pet.health || 0) < 30 || (pet.cleanliness || 0) < 30
      // 不舒服 → 多半原地歇着,偶尔挪一小步。
      if (unwell && Math.random() < 0.7) {
        this._scheduleWander(IDLE_MIN_MS + Math.random() * (IDLE_MAX_MS - IDLE_MIN_MS))
        return
      }
      const tx = FLOOR.xMin + Math.random() * (FLOOR.xMax - FLOOR.xMin)
      const ty = FLOOR.yMin + Math.random() * (FLOOR.yMax - FLOOR.yMin)
      this._moveActorTo(tx, ty, () => {
        this._scheduleWander(IDLE_MIN_MS + Math.random() * (IDLE_MAX_MS - IDLE_MIN_MS))
      })
    }, Math.max(0, delay))
  },

  // 走到 (tx,ty)(scene %)。算方向 + 距离 → transition 时长,到点回调。
  _moveActorTo(tx, ty, after) {
    tx = clampNum(tx, FLOOR.xMin, FLOOR.xMax)
    ty = clampNum(ty, FLOOR.yMin, FLOOR.yMax)
    const dx = tx - this.data.actorX
    const dy = ty - this.data.actorY
    if (Math.abs(dx) < 1.5 && Math.abs(dy) < 1.5) { if (typeof after === 'function') after(); return }
    // dy 加权:纵向位移按竖屏比例放大,duration 变长 → 纵向速度慢下来。
    const dyW = dy * VERTICAL_WEIGHT
    const dist = Math.sqrt(dx * dx + dyW * dyW)
    const dur = Math.round(clampNum(dist / WALK_SPEED_PCT_PER_S * 1000, WALK_MIN_MS, WALK_MAX_MS))
    this.setData({
      actorX: Math.round(tx * 10) / 10,
      actorY: Math.round(ty * 10) / 10,
      actorScale: depthForY(ty),
      actorZ: zForY(ty),
      actorFace: faceFromDelta(dx, this.data.actorFace),
      actorMoving: true,
      moveDurMs: dur
    })
    if (this._arriveTimer) clearTimeout(this._arriveTimer)
    this._arriveTimer = setTimeout(() => {
      this._arriveTimer = null
      this.setData({ actorMoving: false, moveDurMs: 0 })
      if (typeof after === 'function') after()
    }, dur)
  },

  // Public: 原地一次性动作(eating from shop / celebrating from home+升级 /
  // happy from tap)。暂停漫游,停下脚步,播完恢复。
  queueAnim(name) {
    if (!hasAnimRig(this.data.pet)) return
    if (!ONESHOT_MS[name]) return
    this._playOneShot(name)
  },

  _playOneShot(name) {
    this._oneShotActive = true
    if (this._wanderTimer) { clearTimeout(this._wanderTimer); this._wanderTimer = null }
    if (this._arriveTimer) { clearTimeout(this._arriveTimer); this._arriveTimer = null }
    this.setData({ actorMoving: false, moveDurMs: 0, spriteAnim: name })
    if (this._oneShotTimer) clearTimeout(this._oneShotTimer)
    this._oneShotTimer = setTimeout(() => {
      this._oneShotTimer = null
      this._oneShotActive = false
      this.setData({ spriteAnim: '' })
      if (this._engineOn) this._scheduleWander(400 + Math.random() * 600)
    }, ONESHOT_MS[name])
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
  // Tap the pet to interact. A content pet gives a delightful one-shot
  // reaction — a quick `happy` bounce, or an occasional bigger `celebrate`
  // when it's already in a great mood. A pet that isn't feeling well
  // (sick / hungry / dirty / sad) only acknowledges the touch with its mood
  // line — it shouldn't bounce happily while it still needs care, so the tap
  // never contradicts the mood the stat bars and home mascot are showing.
  // The mood-appropriate speech bubble fires in every case.
  handleTapPet() {
    if (this.data.mode !== 'view') return
    this.setData({ showPetMenu: true })
  },

  closePetMenu() {
    this.setData({ showPetMenu: false })
  },

  // 菜单·摸摸它:旧的按心情互动(蹦跳 + 说话气泡)。
  menuTouchPet() {
    this.setData({ showPetMenu: false })
    const mood = deriveAnimState(this.data.pet)
    const unwell = mood === 'sick' || mood === 'hungry' || mood === 'dirty' || mood === 'sad'
    if (!unwell && hasAnimRig(this.data.pet)) {
      const big = mood === 'happy' && Math.random() < 0.35
      this.queueAnim(big ? 'celebrating' : 'happy')
    }
    const line = pickLine(mood)
    this.setData({ showBubble: true, bubbleText: line })
    if (this._bubbleTimer) clearTimeout(this._bubbleTimer)
    this._bubbleTimer = setTimeout(() => {
      this.setData({ showBubble: false })
      this._bubbleTimer = null
    }, 2200)
  },

  // 菜单·一起来背单词吧:进背单词页(独立 navigateTo 页,天然全屏 + 无 tabBar)。
  menuStartRecite() {
    this.setData({ showPetMenu: false })
    wx.navigateTo({ url: '/pkg-notebook/word-recite/index' })
  },

  // 点空地板 → 宠物走过去(四方向)。点宠物本身走的是 catchtap=handleTapPet
  // (停止冒泡),不会落到这里。实时量一次 scene 矩形(避免页面滚动后坐标错位),
  // 用 viewport 坐标 changedTouches.client* 对齐 boundingClientRect。
  handleSceneTap(e) {
    if (this.data.mode !== 'view' || !hasAnimRig(this.data.pet)) return
    if (this._oneShotActive) return
    const t = (e.changedTouches && e.changedTouches[0]) || (e.touches && e.touches[0])
    const cx = t && t.clientX != null ? t.clientX : (e.detail && e.detail.x)
    const cy = t && t.clientY != null ? t.clientY : (e.detail && e.detail.y)
    if (cx == null) return
    wx.createSelectorQuery().select('.room').boundingClientRect((rect) => {
      if (!rect || !rect.width) return
      const xPct = (cx - rect.left) / rect.width * 100
      const yPct = (cy - rect.top) / rect.height * 100
      if (this._wanderTimer) { clearTimeout(this._wanderTimer); this._wanderTimer = null }
      this._moveActorTo(xPct, yPct, () => {
        if (this._engineOn) this._scheduleWander(IDLE_MIN_MS + Math.random() * (IDLE_MAX_MS - IDLE_MIN_MS))
      })
    }).exec()
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

  handleOpenCoinHistory() {
    wx.navigateTo({ url: '/pkg-notebook/coin-history/index' })
  },

  // 升级:XP 满才能点。点击直接升 — 没有 modal,直接播全屏升级动画 + 庆祝姿势。
  // 不弹 wx.showModal 是因为升级仪式感在动画上,弹窗反而打断节奏。
  handleLevelUp() {
    if (this.data.isMaxLevel) return
    if (!this.data.canLevelUp) {
      wx.showToast({
        title: `还差 ${Math.max(0, this.data.xpNeeded - this.data.xp)} XP`,
        icon: 'none'
      })
      return
    }
    const result = store.levelUpPet()
    if (!result || !result.ok) {
      if (result && result.reason === 'insufficient-xp') {
        wx.showToast({ title: `还差 ${result.need} XP`, icon: 'none' })
      } else if (result && result.reason === 'max-level') {
        wx.showToast({ title: '已经满级啦', icon: 'none' })
      }
      return
    }
    // 先 refresh 拿到新 level / 剩余 XP,再点亮动画。
    this.refreshState()
    this.setData({
      showLevelUpAnim: true,
      levelUpToLevel: result.level
    })
    this.queueAnim('celebrating')
    if (this._levelAnimTimer) clearTimeout(this._levelAnimTimer)
    this._levelAnimTimer = setTimeout(() => {
      this.setData({ showLevelUpAnim: false })
      this._levelAnimTimer = null
    }, 2400)
  },

  // 用于 switch-mask / switch-sheet 的 catchtouchmove,阻止拖动穿透到背景页。
  noop() {},

  // === Rename pet === //
  // 弹 wx.showModal 收新名字(editable + placeholderText)。校验交给 store.renamePet,
  // 这里仅在 UI 层做提示:空 / 超长 / 重名 / 金币不足 都用 toast 反馈。
  handleOpenRename() {
    const currentName = (this.data.pet && this.data.pet.name) || ''
    wx.showModal({
      title: `改名（${this.data.renameCost} 金币）`,
      editable: true,
      placeholderText: '给宠物起个新名字',
      content: currentName,
      confirmText: '确定',
      cancelText: '取消',
      success: (res) => {
        if (!res.confirm) return
        const newName = (res.content || '').trim()
        if (!newName) {
          wx.showToast({ title: '名字不能为空', icon: 'none' })
          return
        }
        if (newName === currentName) return  // 同名,不扣金币静默返回
        const r = store.renamePet(newName)
        if (r && r.ok) {
          this.refreshState()
          wx.showToast({ title: `改名成功！现在叫 ${r.newName} 啦~`, icon: 'none' })
        } else if (r && r.reason === 'name-too-long') {
          wx.showToast({ title: `名字不能超过 ${r.max} 个字`, icon: 'none' })
        } else if (r && r.reason === 'not-enough-coins') {
          wx.showToast({ title: `金币不足，需要 ${r.cost}`, icon: 'none' })
        } else if (r && r.reason === 'empty-name') {
          wx.showToast({ title: '名字不能为空', icon: 'none' })
        } else if (r && r.reason === 'same-name') {
          // 静默 — UI 层已经早返回了,这里兜底
        } else if (r && r.reason === 'no-pet') {
          wx.showToast({ title: '还没有宠物', icon: 'none' })
        }
      }
    })
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
