const store = require('../../utils/store')
const cloudSync = require('../../utils/cloud-sync')
const perf = require('../../utils/perf')
const i18n = require('../../utils/i18n')

const deriveAnimState = store.deriveAnimState

// Speaking lines are now resolved via i18n at runtime (see pickLine below).
// Keys map: hungry → [pet_speak_hungry_1, pet_speak_hungry_2], etc.
const SPEAKING_KEYS = {
  hungry:  ['pet_speak_hungry_1', 'pet_speak_hungry_2'],
  dirty:   ['pet_speak_dirty_1',  'pet_speak_dirty_2'],
  sick:    ['pet_speak_sick_1',   'pet_speak_sick_2'],
  sad:     ['pet_speak_sad_1',    'pet_speak_sad_2'],
  happy:   ['pet_speak_happy_1',  'pet_speak_happy_2', 'pet_speak_happy_3'],
  idle:    ['pet_speak_idle_1',   'pet_speak_idle_2',  'pet_speak_idle_3']
}

function pickLine(state) {
  const keys = SPEAKING_KEYS[state] || SPEAKING_KEYS.idle
  return i18n.t(keys[Math.floor(Math.random() * keys.length)])
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

// 每个物种侧身 rig 的关节 pivot(% 对应分层 SVG 的 200 视口,从各自侧身图量出)。
// 以 inline transform-origin 绑到各分层,让 眨眼/点头/摆尾/迈腿 都绕正确关节转。
const RIG_PIVOTS = {
  cat:     { tail: '30% 57%', legBack: '54% 69%', body: '52% 75%', legFront: '54% 70%', head: '65% 56%', eye: '79% 45%' },
  dog:     { tail: '31% 55%', legBack: '54% 69%', body: '52% 78%', legFront: '54% 70%', head: '59% 47%', eye: '80% 45%' },
  rabbit:  { tail: '31% 58%', legBack: '54% 71%', body: '54% 79%', legFront: '54% 72%', head: '61% 55%', eye: '80% 48%' },
  pig:     { tail: '24% 55%', legBack: '54% 70%', body: '52% 80%', legFront: '54% 71%', head: '59% 47%', eye: '80% 45%' },
  chicken: { tail: '26% 59%', legBack: '59% 79%', body: '50% 83%', legFront: '46% 79%', head: '59% 50%', eye: '75% 38%' },
  cow:     { tail: '24% 56%', legBack: '54% 69%', body: '52% 78%', legFront: '54% 70%', head: '60% 47%', eye: '80% 45%' },
  sheep:   { tail: '30% 57%', legBack: '54% 70%', body: '51% 79%', legFront: '54% 71%', head: '65% 49%', eye: '81% 48%' },
  alpaca:  { tail: '25% 62%', legBack: '52% 73%', body: '49% 80%', legFront: '52% 74%', head: '68% 58%', eye: '80% 26%' },
  parrot:  { tail: '29% 62%', legBack: '59% 84%', body: '52% 85%', legFront: '49% 84%', head: '58% 38%', eye: '77% 36%' }
}

// 地板可行走带(全屏 room 的百分比)。上沿(yMin)= 远处,下沿(yMax)= 近处。
// 带子落在房间地板的可见区(被下方控制卡盖住之前),侧面行走以横向为主。
// 场景宽 2 倍(.room = 200vw,可左右滑动看)。可行走带是 .room 的百分比 → 横向 5~95%
// 落在 10~190vw,宠物在整个 2 倍宽的房间里漫游。深度范围拉大(远 0.58 / 近 1.0)=
// 更强的近大远小透视感。
const FLOOR = { xMin: 5, xMax: 95, yMin: 40, yMax: 86 }
// 家具:宠物走过去「用」它时站的位置(脚底 scene%,跟 wxss .furni-* 的 left% 对齐)
// + 到点播的动作 + 对应属性 + 菜单图标。点家具 → 弹菜单(免费用一下 / 买对应道具)。
// 散落布局(非一排):电视靠墙+沙发在它前面成「客厅」;床靠墙;浴缸靠墙+马桶在前成
// 「卫生间」;餐桌、游乐场散在中前景。y = 宠物站到家具正前方(下方一点)。
// y = 宠物走过去站的位置:取家具正下方再往前一点(留出空隙,别贴着家具),
// 这样宠物不挡家具、家具也好点(配合 wxss 里家具 z 高于宠物)。
const FURNITURE = {
  tv:         { x: 10, y: 50, anim: 'happy',       stat: 'happiness',   emoji: '📺' },
  sofa:       { x: 17, y: 66, anim: 'happy',       stat: 'happiness',   emoji: '🛋️' },
  bed:        { x: 50, y: 52, anim: 'happy',       stat: 'health',      emoji: '🛏️' },
  playground: { x: 35, y: 72, anim: 'celebrating', stat: 'happiness',   emoji: '🎠' },
  table:      { x: 64, y: 68, anim: 'eating',      stat: 'fullness',    emoji: '🍽️' },
  bath:       { x: 78, y: 53, anim: 'celebrating', stat: 'cleanliness', emoji: '🛁' },
  toilet:     { x: 88, y: 69, anim: 'happy',       stat: 'cleanliness', emoji: '🚽' }
}
// 每个属性对应商店里的哪些道具(菜单里列出来给买)。
const STAT_ITEMS = {
  fullness:    [1, 2],
  cleanliness: [3, 4],
  happiness:   [5, 8],
  health:      [6, 7]
}

// 今天作业还没做完 → 宠物「待在原地、不玩」。今天没作业 = 不锁。
function todayHomeworkLocked(state) {
  const items = store.tasksForDate(state, store.todayStr()) || []
  if (!items.length) return false
  return items.some((it) => !(it.occurrence && it.occurrence.status === 'done'))
}
const DEPTH_FAR = 0.58      // 脚底在 yMin(最远)时的身体缩放
const DEPTH_NEAR = 1.0      // 脚底在 yMax(最近)时的身体缩放(放大 → 近大远小更明显)
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

// Map store.js species array → translated labels for display.
// Internal ids/emojis are unchanged; only .label is replaced.
function translateSpecies(speciesOptions) {
  return speciesOptions.map(function(s) {
    return { id: s.id, emoji: s.emoji, label: i18n.t('pet_species_' + s.id) }
  })
}

// Map store.js shopItems → translated name/effect/buyLabel for display.
// Internal ids/prices/stats are unchanged.
function translateShopItems(items) {
  return items.map(function(item) {
    return Object.assign({}, item, {
      name:     i18n.t('pet_item_name_' + item.id),
      effect:   i18n.t('pet_item_effect_' + item.id),
      buyLabel: i18n.t('pet_shop_buy_btn', { price: item.price })
    })
  })
}

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
    actorX: 25,
    actorY: 62,
    actorScale: 1,
    actorZ: 72,
    actorFace: 'right',
    actorMoving: false,
    moveDurMs: 0,
    cameraTx: 0,           // 相机:整间房的 translateX(px,负值=房间左移):平滑跟随宠物保持其大致居中
    spriteAnim: '',
    rigPivot: RIG_PIVOTS.cat,   // 当前物种 rig 各关节 pivot(refreshState 按 species 覆盖)
    showPetMenu: false,
    showDeskMenu: false,   // 点书桌弹出的学习菜单(单词挑战/听写/单词本)
    roomTheme: 'cozy',     // 房间背景主题:cozy 温馨小屋 / castle 城堡
    showRoomPicker: false, // 选房间背景的弹窗
    showShopPanel: false,  // 商店弹窗(经验一大坨隐藏后,商店挪到金币下按钮)
    showFurniMenu: false,  // 点家具弹的菜单(免费用一下 / 买对应属性道具)
    furniMenuKind: '',
    furniMenuTitle: '',
    furniMenuItems: [],
    furniFreeAvail: true,
    furniFreeName: '',
    furniFreeEffect: '',
    furniFreePrice: '',
    furniAnchorLeft: 0,
    furniAnchorTop: 0,
    reciteLeft: 0,         // 今天还能背几次(0 则菜单里不显示「背单词」)
    vocab: 0,              // 词汇量 = 已掌握单词数(浮窗展示)
    showBubble: false,
    bubbleText: '',
    // 摸摸它 / 点宠物时从身上飘出的爱心粒子(每个 {id,g,x,dur})。
    hearts: [],
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
    levelUpToLevel: 0,
    // i18n dict injected into template
    t: {},
    // computed i18n strings that need dynamic interpolation
    hudCoins: '',
    hudAgeDays: '',
    hudVocab: '',
    shopPanelCoins: '',
    manageRenameSub: '',
    manageSwitchSub: '',
    manageRoomSub: '',
    switchSheetSub: ''
  },

  onShow() {
    const stamp = perf.markPageShow('pet')
    const tb = typeof this.getTabBar === 'function' && this.getTabBar()
    if (tb) tb.setData({ selected: 1 })
    wx.setNavigationBarTitle({ title: i18n.t('pet_navtitle') })
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
    if (this._heartTimer) { clearTimeout(this._heartTimer); this._heartTimer = null }
    if (this.data.hearts && this.data.hearts.length) this.setData({ hearts: [] })
    this._stopFurniCdTick()
    this._stopSceneEngine()
  },

  onUnload() {
    if (this._levelAnimTimer) {
      clearTimeout(this._levelAnimTimer)
      this._levelAnimTimer = null
    }
    if (this._heartTimer) { clearTimeout(this._heartTimer); this._heartTimer = null }
    this._stopFurniCdTick()
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
    const coins = state.coins
    const ageDays = isSetup ? store.petAgeDays(pet) : 0
    const vocab = store.getWordStats(state).mastered
    const renameCost = store.PET_RENAME_COST
    const switchCost = store.PET_SWITCH_COST
    const roomTheme = pet.roomTheme || 'cozy'
    // 今天作业没做完 → 锁住:宠物待在原地不漫游,点它/点地/点家具只会说「做完作业再来玩」
    const hwLocked = isSetup ? todayHomeworkLocked(state) : false
    this._hwLocked = hwLocked
    this.setData({
      t: i18n.dict(),
      pet,
      hwLocked,
      coins,
      shopItems: translateShopItems(state.shopItems),
      speciesOptions: translateSpecies(store.PET_SPECIES),
      mode: isSetup ? 'view' : 'setup',
      animState: isSetup ? deriveAnimState(pet) : 'idle',
      rigPivot: RIG_PIVOTS[pet.species] || RIG_PIVOTS.cat,
      roomTheme,
      ageDays,
      vocab,
      reciteLeft: store.reciteRemaining(state),
      xp,
      xpNeeded,
      xpPercent,
      xpPerHour,
      xpPreviewWidth,
      canLevelUp,
      isMaxLevel,
      levelBadge: levelBadge(pet.level || 1),
      showBubble: false,
      bubbleText: '',
      // Computed interpolated strings
      hudCoins: i18n.t('pet_hud_coins', { n: coins }),
      hudAgeDays: i18n.t('pet_age_days', { n: ageDays }),
      hudVocab: i18n.t('pet_vocab', { n: vocab }),
      shopPanelCoins: i18n.t('pet_shop_panel_coins', { n: coins }),
      manageRenameSub: i18n.t('pet_manage_rename_sub', { cost: renameCost }),
      manageSwitchSub: i18n.t('pet_manage_switch_sub', { cost: switchCost }),
      manageRoomSub: roomTheme === 'castle'
        ? i18n.t('pet_manage_room_sub_castle')
        : i18n.t('pet_manage_room_sub_cozy'),
      switchSheetSub: i18n.t('pet_switch_sub', { cost: switchCost, coins })
    }, perfStamp ? () => perf.markPaint(perfStamp) : undefined)
    // Start/stop the 2.5D scene engine alongside refreshState. Idempotent —
    // _startSceneEngine is a no-op if already running. First setup drops the
    // pet at a sensible spot and measures the scene rect (for tap-to-walk).
    if (isSetup && hasAnimRig(pet)) {
      if (!this._actorReady) { this._initActor(); this._actorReady = true }
      if (hwLocked) this._stopSceneEngine()   // 锁住:待在原地不漫游
      else this._startSceneEngine()
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
      actorX: 25, actorY: y,
      actorScale: depthForY(y), actorZ: zForY(y),
      actorFace: 'right', actorMoving: false, moveDurMs: 0,
      cameraTx: this._cameraTx(25)
    })
  },

  // 相机 translateX:让宠物(xPct% 处)大致落在屏幕中央。房间宽 2W,平移夹在 [-W, 0]。
  // translateX = W/2 - 宠物px;通过 .room 的 transition(时长=moveDurMs、ease-in-out)平滑过渡。
  _cameraTx(xPct) {
    if (!this._winW) {
      let w = 375
      try { const i = (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()) || {}; w = i.windowWidth || i.screenWidth || 375 } catch (e) {}
      this._winW = w
    }
    const W = this._winW
    return Math.round(clampNum(W / 2 - xPct / 100 * 2 * W, -W, 0))
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
      if (this._hwLocked) return   // 作业没做完,待在原地不漫游
      if (this.data.showFurniMenu) { this._scheduleWander(800); return }   // 家具副窗开着,冻住漫游(别让相机滑走)
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
      moveDurMs: dur,
      cameraTx: this._cameraTx(tx)   // 相机用同样的时长(dur)平滑跟到目标,屏幕不会比宠物快
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
      wx.showToast({ title: i18n.t('pet_toast_pick_species'), icon: 'none' })
      return
    }
    const trimmed = (setupName || '').trim()
    if (!trimmed) {
      wx.showToast({ title: i18n.t('pet_toast_enter_name'), icon: 'none' })
      return
    }
    store.setupPet({ species: setupSpecies, name: trimmed })
    this.refreshState()
    wx.showToast({ title: i18n.t('pet_toast_hello', { name: trimmed }), icon: 'success' })
  },

  // === Pet interactions === //
  // Tap the pet to interact. A content pet gives a delightful one-shot
  // reaction — a quick `happy` bounce, or an occasional bigger `celebrate`
  // when it's already in a great mood. A pet that isn't feeling well
  // (sick / hungry / dirty / sad) only acknowledges the touch with its mood
  // line — it shouldn't bounce happily while it still needs care, so the tap
  // never contradicts the mood the stat bars and home mascot are showing.
  // The mood-appropriate speech bubble fires in every case.
  // 飘爱心:从宠物身上往上冒几颗爱心,纯视觉(不依赖动画引擎,任何心情都能飘)。
  _spawnHearts(n) {
    const count = n || 3
    const glyphs = ['❤️', '💗', '💛', '💖']
    const batch = []
    for (let i = 0; i < count; i++) {
      this._heartSeq = (this._heartSeq || 0) + 1
      batch.push({
        id: this._heartSeq,
        g: glyphs[Math.floor(Math.random() * glyphs.length)],
        x: 30 + Math.floor(Math.random() * 40),       // 起点横向 %,身体宽度内抖动
        dur: 1100 + Math.floor(Math.random() * 500)   // 飘升时长 ms
      })
    }
    this.setData({ hearts: (this.data.hearts || []).concat(batch) })
    // 所有爱心动画 ≤1.6s,统一在最后一次飘心后清空(隐形残留不影响观感)。
    if (this._heartTimer) clearTimeout(this._heartTimer)
    this._heartTimer = setTimeout(() => {
      this._heartTimer = null
      this.setData({ hearts: [] })
    }, 1900)
  },

  handleTapPet() {
    if (this.data.mode !== 'view') return
    if (this._hwLocked) { this._sayBusy(); return }   // 作业没做完 → 不互动,只说一句
    // 点宠物 = 直接摸摸它(挤一下 + 飘爱心 + 说句话)。学习菜单已挪到书桌,不再弹宠物菜单。
    this.menuTouchPet()
  },

  // 作业没做完时的「待机话」:站着不动,只冒一句「做完作业再来玩」。
  _sayBusy() {
    this.setData({ showBubble: true, bubbleText: i18n.t('pet_busy_homework') })
    if (this._bubbleTimer) clearTimeout(this._bubbleTimer)
    this._bubbleTimer = setTimeout(() => {
      this.setData({ showBubble: false })
      this._bubbleTimer = null
    }, 2400)
  },

  closePetMenu() {
    this.setData({ showPetMenu: false })
    if (this.data.mode === 'view' && hasAnimRig(this.data.pet)) this._startSceneEngine()
  },

  // === 书桌·学习菜单 === //
  openDeskMenu() {
    if (this.data.mode !== 'view') return
    this.setData({ showDeskMenu: true })
  },
  closeDeskMenu() {
    this.setData({ showDeskMenu: false })
  },

  // === 商店弹窗 === //
  openShopPanel() {
    this.setData({ showShopPanel: true })
  },
  closeShopPanel() {
    this.setData({ showShopPanel: false })
  },

  // === 房间背景主题 === //
  openRoomPicker() {
    this.setData({ showRoomPicker: true, showShopPanel: false })
  },
  closeRoomPicker() {
    this.setData({ showRoomPicker: false })
  },
  pickRoom(e) {
    const theme = store.setRoomTheme(e.currentTarget.dataset.theme)
    this.setData({
      roomTheme: theme,
      showRoomPicker: false,
      manageRoomSub: theme === 'castle'
        ? i18n.t('pet_manage_room_sub_castle')
        : i18n.t('pet_manage_room_sub_cozy')
    })
    wx.showToast({
      title: theme === 'castle'
        ? i18n.t('pet_toast_room_castle')
        : i18n.t('pet_toast_room_cozy'),
      icon: 'none'
    })
  },

  // 摸摸它:按心情互动(挤一下 + 飘爱心 + 说话气泡)。现在由点宠物直接触发。
  menuTouchPet() {
    this.setData({ showPetMenu: false })
    if (this.data.mode === 'view' && hasAnimRig(this.data.pet)) this._startSceneEngine()
    const mood = deriveAnimState(this.data.pet)
    const unwell = mood === 'sick' || mood === 'hungry' || mood === 'dirty' || mood === 'sad'
    if (!unwell && hasAnimRig(this.data.pet)) {
      const big = mood === 'happy' && Math.random() < 0.35
      this.queueAnim(big ? 'celebrating' : 'happy')
    }
    // 摸摸它一定冒一大把爱心(不管心情),这是「被宠爱」的核心反馈。
    this._spawnHearts(4)
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
    this.setData({ showDeskMenu: false })
    wx.navigateTo({ url: '/pkg-notebook/word-recite/index' })
  },

  // 菜单·听写单词:进背单词页的听写模式(TTS 读音 + 拼写)。
  menuStartDictation() {
    this.setData({ showDeskMenu: false })
    wx.navigateTo({ url: '/pkg-notebook/word-recite/index?mode=dictation' })
  },

  // 菜单·我的单词本:进单词库管理页(增减单词本/单词、设目标、设每次数量)。
  menuWordBooks() {
    this.setData({ showDeskMenu: false })
    wx.navigateTo({ url: '/pkg-notebook/word-books/index' })
  },

  // 点空地板 → 宠物走过去(四方向)。点宠物本身走的是 catchtap=handleTapPet
  // (停止冒泡),不会落到这里。实时量一次 scene 矩形(避免页面滚动后坐标错位),
  // 用 viewport 坐标 changedTouches.client* 对齐 boundingClientRect。
  handleSceneTap(e) {
    if (this.data.mode !== 'view' || !hasAnimRig(this.data.pet)) return
    if (this.data.showPetMenu) { this.closePetMenu(); return }
    if (this._hwLocked) { this._sayBusy(); return }   // 作业没做完 → 不走动
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

  // 点家具 → 宠物先走过去,到了再在家具正上方「原地」弹小副窗(跟书桌菜单同款)。
  openFurnitureMenu(e) {
    if (this.data.mode !== 'view' || !hasAnimRig(this.data.pet)) return
    if (this._hwLocked) { this._sayBusy(); return }   // 作业没做完 → 不去玩家具
    if (this._oneShotActive) return
    if (this.data.showPetMenu) { this.closePetMenu(); return }
    if (this.data.showFurniMenu) return
    const kind = e.currentTarget.dataset.kind
    const f = FURNITURE[kind]
    if (!f) return
    // 先冻住漫游 + 走到家具正前方,到点回调里再弹菜单
    if (this._wanderTimer) { clearTimeout(this._wanderTimer); this._wanderTimer = null }
    this._moveActorTo(f.x, f.y, () => this._showFurnitureMenu(kind))
  },

  // 到达家具后:量家具屏幕位置 → 副窗锚在它正上方(fixed 屏幕坐标,夹在视口内)。
  _showFurnitureMenu(kind) {
    const f = FURNITURE[kind]
    if (!f || this.data.mode !== 'view') return
    const ids = STAT_ITEMS[f.stat] || []
    const items = (this.data.shopItems || []).filter((it) => ids.indexOf(it.id) !== -1)
    const left = store.furnitureCooldownLeft(kind)
    const fe = store.furnitureEffect(kind)
    const win = this._win || (this._win = wx.getSystemInfoSync())
    const sw = win.windowWidth || 375
    const sh = win.windowHeight || 667
    const halfPx = 180 * sw / 750 + 12
    wx.createSelectorQuery().select('.furni-' + kind).boundingClientRect((rect) => {
      let ax = sw / 2, ay = sh * 0.46
      if (rect && rect.width) {
        ax = Math.min(Math.max(rect.left + rect.width / 2, halfPx), sw - halfPx)
        ay = rect.top
      }
      this.setData({
        showFurniMenu: true,
        furniMenuKind: kind,
        furniMenuTitle: f.emoji + ' ' + i18n.t('pet_furni_act_' + kind),
        furniMenuItems: items,
        furniFreeAvail: left <= 0,
        furniFreeName: i18n.t('pet_furni_freeitem_' + kind),
        furniFreeEffect: (left <= 0 && fe)
          ? (i18n.t('pet_stat_' + fe.stat) + ' +' + fe.amount)
          : ('⏳ ' + this._fmtCountdown(left)),
        furniFreePrice: i18n.t('pet_shop_buy_btn', { price: 0 }),
        furniAnchorLeft: Math.round(ax),
        furniAnchorTop: Math.round(ay)
      })
      // 冷却中 → 每秒刷新倒计时;到 0 自动变可用
      this._stopFurniCdTick()
      if (left > 0) this._startFurniCdTick(kind, fe)
    }).exec()
  },

  closeFurnitureMenu() {
    this._stopFurniCdTick()
    this.setData({ showFurniMenu: false })
    if (this._engineOn) this._scheduleWander(500 + Math.random() * 600)   // 恢复漫游
  },

  // 冷却倒计时(每秒刷新副窗里「免费」那行的效果文案)
  _fmtCountdown(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000))
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
    const p = (n) => (n < 10 ? '0' : '') + n
    return (h > 0 ? h + ':' : '') + p(m) + ':' + p(sec)
  },
  _startFurniCdTick(kind, fe) {
    this._stopFurniCdTick()
    this._furniCdTimer = setInterval(() => {
      if (!this.data.showFurniMenu || this.data.furniMenuKind !== kind) { this._stopFurniCdTick(); return }
      const left = store.furnitureCooldownLeft(kind)
      if (left <= 0) {
        this.setData({
          furniFreeAvail: true,
          furniFreeEffect: fe ? (i18n.t('pet_stat_' + fe.stat) + ' +' + fe.amount) : ''
        })
        this._stopFurniCdTick()
        return
      }
      this.setData({ furniFreeEffect: '⏳ ' + this._fmtCountdown(left) })
    }, 1000)
  },
  _stopFurniCdTick() {
    if (this._furniCdTimer) { clearInterval(this._furniCdTimer); this._furniCdTimer = null }
  },

  // 菜单·免费陪它用一下:走过去用家具,免费回一点属性(有冷却)。冷却中只走过去蹭一下。
  furnitureFreeUse() {
    const kind = this.data.furniMenuKind
    const f = FURNITURE[kind]
    if (!f) return
    this._stopFurniCdTick()
    this.setData({ showFurniMenu: false })
    if (this._wanderTimer) { clearTimeout(this._wanderTimer); this._wanderTimer = null }
    this._moveActorTo(f.x, f.y, () => {
      const r = store.useFurnitureItem(kind)
      let bubble = i18n.t('pet_furni_' + kind)
      if (r && r.ok) {
        this.refreshState()
        this.queueAnim(f.anim)
        this._spawnHearts(2)
        if (r.amount > 0) wx.showToast({ title: i18n.t('pet_stat_' + r.stat) + ' +' + r.amount, icon: 'none' })
      } else if (r && r.reason === 'cooldown') {
        this.queueAnim('happy')
        bubble = i18n.t('pet_furni_cooldown', { t: this._fmtCooldown(r.remainingMs) })
      } else {
        this.queueAnim('happy')
      }
      this.setData({ showBubble: true, bubbleText: bubble })
      if (this._bubbleTimer) clearTimeout(this._bubbleTimer)
      this._bubbleTimer = setTimeout(() => { this.setData({ showBubble: false }); this._bubbleTimer = null }, 2400)
    })
  },

  // 菜单里买道具:复用 handleBuyItem(它会刷新属性 + toast + 吃东西动画);副窗保持打开可继续买。
  buyFromFurniMenu(e) {
    this.handleBuyItem(e)
  },

  // 冷却剩余的本地化短文案:≥1h 显示「Xh / X 小时」,否则「Xmin / X 分钟」。
  _fmtCooldown(ms) {
    const m = Math.max(1, Math.ceil(ms / 60000))
    if (m >= 60) return i18n.t('pet_furni_cd_h', { n: Math.ceil(m / 60) })
    return i18n.t('pet_furni_cd_min', { n: m })
  },

  handleBuyItem(event) {
    const { id } = event.currentTarget.dataset
    const before = store.getStateWithComputed()
    const item = before.shopItems.find((shopItem) => shopItem.id === id)
    if (before.coins < item.price) {
      wx.showToast({ title: i18n.t('pet_toast_not_enough_coins'), icon: 'none' })
      return
    }

    store.buyItem(id)
    this.refreshState()
    wx.showToast({ title: i18n.t('pet_toast_bought', { name: i18n.t('pet_item_name_' + item.id) }), icon: 'success' })
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
        title: i18n.t('pet_toast_xp_needed', { n: Math.max(0, this.data.xpNeeded - this.data.xp) }),
        icon: 'none'
      })
      return
    }
    const result = store.levelUpPet()
    if (!result || !result.ok) {
      if (result && result.reason === 'insufficient-xp') {
        wx.showToast({ title: i18n.t('pet_toast_xp_needed', { n: result.need }), icon: 'none' })
      } else if (result && result.reason === 'max-level') {
        wx.showToast({ title: i18n.t('pet_toast_max_level'), icon: 'none' })
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
    this.setData({ showShopPanel: false })
    const currentName = (this.data.pet && this.data.pet.name) || ''
    wx.showModal({
      title: i18n.t('pet_rename_modal_title', { cost: this.data.renameCost }),
      editable: true,
      placeholderText: i18n.t('pet_rename_placeholder'),
      content: currentName,
      confirmText: i18n.t('pet_rename_confirm'),
      cancelText: i18n.t('pet_rename_cancel'),
      success: (res) => {
        if (!res.confirm) return
        const newName = (res.content || '').trim()
        if (!newName) {
          wx.showToast({ title: i18n.t('pet_toast_rename_empty'), icon: 'none' })
          return
        }
        if (newName === currentName) return  // 同名,不扣金币静默返回
        const r = store.renamePet(newName)
        if (r && r.ok) {
          this.refreshState()
          wx.showToast({ title: i18n.t('pet_toast_rename_success', { name: r.newName }), icon: 'none' })
        } else if (r && r.reason === 'name-too-long') {
          wx.showToast({ title: i18n.t('pet_toast_rename_too_long', { max: r.max }), icon: 'none' })
        } else if (r && r.reason === 'not-enough-coins') {
          wx.showToast({ title: i18n.t('pet_toast_rename_no_coins', { cost: r.cost }), icon: 'none' })
        } else if (r && r.reason === 'empty-name') {
          wx.showToast({ title: i18n.t('pet_toast_rename_empty'), icon: 'none' })
        } else if (r && r.reason === 'same-name') {
          // 静默 — UI 层已经早返回了,这里兜底
        } else if (r && r.reason === 'no-pet') {
          wx.showToast({ title: i18n.t('pet_toast_no_pet'), icon: 'none' })
        }
      }
    })
  },

  // === Switch species === //
  handleOpenSwitchPanel() {
    this.setData({ showSwitchPanel: true, showShopPanel: false })
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
      wx.showToast({ title: i18n.t('pet_toast_switch_no_coins', { cost: this.data.switchCost }), icon: 'none' })
      return
    }
    this.setData({ switching: true })
    wx.showModal({
      title: i18n.t('pet_switch_modal_title'),
      content: i18n.t('pet_switch_modal_content', { cost: this.data.switchCost, emoji: entry.emoji, label: i18n.t('pet_species_' + entry.id) }),
      confirmText: i18n.t('pet_switch_modal_confirm'),
      cancelText: i18n.t('pet_switch_modal_cancel'),
      success: (res) => {
        if (!res.confirm) {
          this.setData({ switching: false })
          return
        }
        const r = store.switchPetSpecies(id)
        this.setData({ switching: false, showSwitchPanel: false })
        this.refreshState()
        if (r && r.ok) {
          wx.showToast({ title: i18n.t('pet_toast_switch_success', { emoji: r.emoji, label: i18n.t('pet_species_' + id) }), icon: 'success' })
        } else if (r && r.reason === 'not-enough-coins') {
          wx.showToast({ title: i18n.t('pet_toast_switch_no_coins', { cost: this.data.switchCost }), icon: 'none' })
        }
      },
      fail: () => { this.setData({ switching: false }) }
    })
  }
})
