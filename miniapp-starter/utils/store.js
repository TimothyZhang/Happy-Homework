const cloudSync = require('./cloud-sync')
const i18n = require('./i18n')

const STORAGE_KEY = 'homework-pet-v1'
const SCHEMA_VERSION = 3

// v3: 作业本(notebook)概念彻底拍平 —— mode / startDate / endDate / recurrence
// 全部下沉到 task 自身,task 增加 organization 字段(校内/校外/其他)。
// state.notebooks[] 在 v3 之后永远是 []。SYNC_FIELDS 仍保留 'notebooks' 一段
// 时间,让老 client 拿到云端空数组而不是 undefined,迁移更平滑。
// organization 改为用户可在「我」Tab 自定义的列表。store 维护一份 state.organizations,
// 默认 ['校内', '校外', '其他'](与历史行为一致)。task.organization 存的是字符串,
// 不再做枚举校验 — 用户删除某个标签后,仍持有该标签的旧 task 显示不变,只是新的
// task-edit 下拉里不再出现该选项。
const DEFAULT_ORGANIZATIONS = ['校内', '校外', '其他']
const DEFAULT_ORGANIZATION = '校内'
const ORGANIZATION_MAX_LEN = 8
const ORGANIZATION_MAX_COUNT = 16

// 规整一份任意来源的 organizations 数组:strip 非字符串、trim、过滤空串、cap 长度、
// 去重(保序)、cap 总数。结果为空时回退默认列表 —— 永远保证至少一个标签可选。
function sanitizeOrganizationList(raw) {
  if (!Array.isArray(raw)) return DEFAULT_ORGANIZATIONS.slice()
  const seen = new Set()
  const out = []
  for (const v of raw) {
    if (typeof v !== 'string') continue
    const s = v.trim()
    if (!s || s.length > ORGANIZATION_MAX_LEN) continue
    if (seen.has(s)) continue
    seen.add(s)
    out.push(s)
    if (out.length >= ORGANIZATION_MAX_COUNT) break
  }
  return out.length > 0 ? out : DEFAULT_ORGANIZATIONS.slice()
}

// Subset of state fields synced to cloud. Everything else is local-only:
// transient UI state (editTaskId, editNotebookId), OCR jobs (ephemeral and
// large), and app-wide config that's the same for everyone (shopItems,
// schemaVersion).
// NOTE: `profile` carries both nickname AND avatar (a cloud:// fileID), so
// the avatar is synced through the existing entry — no separate field needed.
//
// 架构:客户端 = truth。所有 coin / bonus / perfectDays / completionsByDay
// 都是本地决定 + push 上云作 mirror。云端不再有"权威账本"概念,server
// 上 shareReward.claim / adminPanel.claimAdminCoins 只把 inbox items 推回给
// client,client 自己走 applyCoinDelta 入账。
const SYNC_FIELDS = [
  // schemaVersion 必须 sync — 否则 hydrate 拿到的 remote state 没这字段,
  // migrate 把 v2 数据(有 notebooks + 无 schemaVersion)误判为 v1,走 fallback
  // 把所有 task 塞进 nb_mig_today,首页"已完成"列表炸开。
  'schemaVersion',
  'notebooks', 'tasks',
  'coins',
  'streakDays', 'perfectDays', 'bonusByDay', 'completionsByDay',
  // coinLogs 是完整流水审计。append-only,cap 至 COIN_LOG_KEEP 条。
  'coinLogs',
  'pet', 'lastReward',
  'profile',
  // 用户自定义的「组织」标签列表(在我 Tab 编辑)。
  'organizations',
  // 单词库 / 背单词 SRS:单词本、配置(每次数量 + 目标本)、每日背诵次数。
  'wordBooks', 'wordConfig', 'reciteByDay'
]

// === Date helpers (local timezone, YYYY-MM-DD) === //

function pad2(n) { return `${n}`.padStart(2, '0') }

function dateToStr(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

function strToDate(str) {
  const [y, m, d] = str.split('-').map(Number)
  return new Date(y, m - 1, d)
}

function todayStr() {
  return dateToStr(new Date())
}

function addDays(str, n) {
  const d = strToDate(str)
  d.setDate(d.getDate() + n)
  return dateToStr(d)
}

// 1=Mon ... 7=Sun
function weekdayOf(str) {
  const w = strToDate(str).getDay() // 0=Sun..6=Sat
  return w === 0 ? 7 : w
}

function compareDateStr(a, b) {
  if (a === b) return 0
  return a < b ? -1 : 1
}

function getCurrentTime() {
  const date = new Date()
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

// 把 task.recurrence 渲染成用户友好的中文标签。
//   daily                                  → "每天"
//   weekly + weekdays=[1..7] 全选          → "每天"
//   weekly + weekdays=[1]                  → "每周一"
//   weekly + weekdays=[2,3,4]              → "每周二三四"
//   weekly + weekdays 空                   → "每周?"(fallback,实际数据不该出现)
// 非 recurring task 返回 ''。
const WEEKDAY_CHARS = { 1: '一', 2: '二', 3: '三', 4: '四', 5: '五', 6: '六', 7: '日' }
const WEEKDAY_ABBR_EN = { 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat', 7: 'Sun' }
function formatRecurrenceLabel(task) {
  if (!task || task.mode !== 'recurring') return ''
  const rec = task.recurrence || { type: 'daily' }
  if (rec.type === 'daily') return i18n.t('rec_daily')
  if (rec.type === 'weekly') {
    const wds = Array.isArray(rec.weekdays)
      ? rec.weekdays.filter((w) => Number.isInteger(w) && w >= 1 && w <= 7).slice().sort()
      : []
    if (wds.length === 0) return i18n.t('rec_weekly_unknown')
    if (wds.length === 7) return i18n.t('rec_daily')
    const zh = i18n.getLang() === 'zh'
    const map = zh ? WEEKDAY_CHARS : WEEKDAY_ABBR_EN
    return i18n.t('rec_weekly_prefix') + wds.map((d) => map[d]).join(zh ? '' : '/')
  }
  return i18n.t('rec_repeat')
}

// === Reward constants — kept in sync with V1-VALUES-DESIGN.md. === //

// Per-task reward depends on whether the task's occurrence date is in the
// past (overdue catch-up), today, or the future (worked ahead). Doing a
// task early is worth +5 vs today, doing one late is −5 vs today.
const REWARD_TASK_OVERDUE = 5
const REWARD_TASK_TODAY = 10
const REWARD_TASK_FUTURE = 15
const REWARD_WEEKLY_STREAK = 100  // every 7 consecutive perfect days

// 开心度来源:仅商店道具(item.happiness)。完成作业不再 +happiness。
// 历史字段 happinessPaid / happinessLastDecayAt 仍可能出现在旧数据里,
// 读取时容错忽略,新写入路径不再设置。

// Anti-farm cap: only the first N task completions on any given calendar day
// pay coins (both the per-task reward AND the daily-perfect base-per-task
// multiplier). The N+1-th finish onward still completes the task — it just
// doesn't earn coins. Counter is keyed on the wall-clock day of the finish,
// not the task's occurrence date.
const DAILY_COMPLETION_CAP = 20

// coinLogs 单 array 保留多少条 —— 超过就 slice 最近的。云端单文档 16MB
// 上限,本地 wx storage 默认 10MB,长期重度调整(admin 自己 / 测试号)会
// 不知不觉撑爆。200 条够人工审查近期账单,更早的进审计 collection 兜底。
const COIN_LOG_KEEP = 200

// Returns { amount, kind } for a single task completion. `taskDay` is the
// task's occurrence date (YYYY-MM-DD); `today` is the wall-clock day of
// the finish. `kind` is one of 'overdue' | 'today' | 'future' so the UI
// can decorate the toast (esp. the +5 future bonus).
function perTaskReward(taskDay, today) {
  const cmp = compareDateStr(taskDay, today)
  if (cmp < 0) return { amount: REWARD_TASK_OVERDUE, kind: 'overdue' }
  if (cmp > 0) return { amount: REWARD_TASK_FUTURE,  kind: 'future' }
  return { amount: REWARD_TASK_TODAY, kind: 'today' }
}

// Daily-perfect bonus has a flat "early-bird" extra keyed on the last task's
// completion hour — homework's an evening task, so earlier finishes pay more.
// <19:00 → +50, 19:00–20:00 → +30, 20:00–21:00 → +20, ≥21:00 → 0. Each tier
// matches hour < hourEnd, so anything before the first hourEnd also gets +50
// (afternoon, morning, or past-midnight all fall into that bucket).
const EARLY_BIRD_TIERS = [
  { hourEnd: 19, bonus: 50, label: '19 点前完成 +50', window: '21:00 前一整天 / 当晚 19:00 前' },
  { hourEnd: 20, bonus: 30, label: '20 点前完成 +30', window: '19:00–20:00' },
  { hourEnd: 21, bonus: 20, label: '21 点前完成 +20', window: '20:00–21:00' }
]

// Returns the flat early-bird bonus for a given Date (or now). Pure.
function earlyBirdBonus(date) {
  const d = date || new Date()
  const h = d.getHours()
  for (const tier of EARLY_BIRD_TIERS) {
    if (h < tier.hourEnd) return tier.bonus
  }
  return 0
}

// Projects how many additional coins the user would earn if they finished
// every pending item in `items` and the last finish lands before `cutoffHour`
// (a tier deadline: 19/20/21). Used by the pet-tips strip to render lines
// like "19:00 前完成所有作业，可获得 X 金币".
//
// Math mirrors finishTask:
//   - per-task: tier.amount (5/10/15) for each pending, subject to the day's
//     20-cap (already-spent slots from state.completionsByDay[today] are
//     consumed first).
//   - daily-perfect (today only — the projection deliberately ignores the
//     side-effect of overdue/future items completing their own day's perfect
//     bonus, which would be hard to read in a one-line tip): if today has at
//     least one item and today isn't already a perfect day, add
//     sum(rewardPaid for today's items after projection) + early-bird at
//     cutoff.
//   - per-task amounts for capped pending tasks are 0, and they contribute 0
//     to the daily-perfect sum too — so the cap propagates cleanly here.
//
// `state` reads: completionsByDay[today], perfectDays.
// `items` shape: array of { occurrenceDate, occurrence: { status, rewardPaid } }
// — i.e. the raw output of tasksForDate (pre-decoration).
function projectedReward(state, items, cutoffHour) {
  if (!Array.isArray(items) || items.length === 0) return 0
  const today = todayStr()
  const completionsToday =
    (state && state.completionsByDay && state.completionsByDay[today]) || 0
  let capRemaining = Math.max(0, DAILY_COMPLETION_CAP - completionsToday)

  let perTaskTotal = 0
  let todayRewardPaidSum = 0
  let todayHasItems = false

  for (const item of items) {
    const isToday = item.occurrenceDate === today
    if (isToday) todayHasItems = true
    const occ = item.occurrence || {}

    if (occ.status === 'done') {
      if (isToday) todayRewardPaidSum += (occ.rewardPaid || 0)
      continue
    }

    const tier = perTaskReward(item.occurrenceDate, today)
    const pay = capRemaining > 0 ? tier.amount : 0
    if (pay > 0) capRemaining--
    perTaskTotal += pay
    if (isToday) todayRewardPaidSum += pay
  }

  let dailyBonus = 0
  const alreadyPerfect =
    Array.isArray(state && state.perfectDays) && state.perfectDays.includes(today)
  if (todayHasItems && !alreadyPerfect) {
    const cutoffDate = new Date()
    cutoffDate.setHours(cutoffHour - 1, 59, 0, 0)
    dailyBonus = todayRewardPaidSum + earlyBirdBonus(cutoffDate)
  }

  return perTaskTotal + dailyBonus
}

// 当日已经入账的金币 —— sum(rewardPaid for today's items) + bonusByDay[day]
// 里的 dailyBonus(已含 baseBonus + early-bird) + weeklyBonus。家用 page 在
// 显示"今天作业全部完成"时,用这个数告诉小朋友今天挣到了多少金币。
// 注意 bonusByDay 只在 perfectDays 包含 day 时才有 entry,未完美的天数走
// 纯 rewardPaid 求和。
function coinsEarnedOn(state, day) {
  if (!state || !day) return 0
  const items = tasksForDate(state, day)
  let taskTotal = 0
  for (const it of items) {
    const occ = it.occurrence || {}
    if (occ.status === 'done') taskTotal += (occ.rewardPaid || 0)
  }
  const b = state.bonusByDay && state.bonusByDay[day]
  const bonusTotal = b ? ((b.dailyBonus || 0) + (b.weeklyBonus || 0)) : 0
  return taskTotal + bonusTotal
}

// === Pet helpers === //

const PET_SPECIES = [
  { id: 'cat',     emoji: '🐱', label: '猫' },
  { id: 'dog',     emoji: '🐶', label: '狗' },
  { id: 'chicken', emoji: '🐤', label: '鸡' },
  { id: 'parrot',  emoji: '🦜', label: '鹦鹉' },
  { id: 'pig',     emoji: '🐷', label: '猪' },
  { id: 'cow',     emoji: '🐮', label: '牛' },
  { id: 'rabbit',  emoji: '🐰', label: '兔子' },
  { id: 'sheep',   emoji: '🐑', label: '羊' },
  { id: 'alpaca',  emoji: '🦙', label: '羊驼' }
]

const PET_SWITCH_COST = 100
const PET_RENAME_COST = 10
const PET_NAME_MAX_LEN = 8

function petAgeDays(pet) {
  if (!pet || !pet.bornAt) return 0
  return Math.max(0, Math.floor((Date.now() - pet.bornAt) / 86400000))
}

// Stat decay per real-world hour. Tuned so each stat goes 100 → 50 in roughly
// 12–20 hours, i.e. by the next day every attribute is asking to be topped up.
// Fullness is fastest (most-frequent feeding); health is slowest (occasional
// medicine). See V1-VALUES-DESIGN.md §3 for the rationale.
const PET_DECAY_PER_HOUR = { fullness: 4, cleanliness: 3, happiness: 3, health: 2.5, effort: 3 }
// 努力:背单词攒起来、随时间衰减的进度条(0-100)。每答对一词 +EFFORT_PER_WORD,封顶 100。
// 计入 attrMultiplier(五项均值之一 → 努力越高 XP 越快;commit 7ccb2ec),但不影响 mood。
const EFFORT_PER_WORD = 5

// 房间家具:点一下宠物走过去「用」它,免费回一点对应属性,但每件有冷却(防刷)。
// 商店仍有价值:家具=免费但慢(有冷却、量小),商店=花金币但即时、量大。
// 冷却存在 pet.furniAt[kind](随 pet 同步;petWithDecay 用 {...pet} 保留)。
const FURNI_COOLDOWN_MS = 3 * 3600 * 1000   // 每件家具 3 小时冷却
const FURNI_EFFECTS = {
  tv:         { stat: 'happiness',   amount: 18 },
  sofa:       { stat: 'happiness',   amount: 20 },
  playground: { stat: 'happiness',   amount: 22 },
  bed:        { stat: 'health',      amount: 18 },
  table:      { stat: 'fullness',    amount: 22 },
  bath:       { stat: 'cleanliness', amount: 22 },
  toilet:     { stat: 'cleanliness', amount: 12 }
}

// 升级:XP 满 → 用户手动点按钮升级。levelUpPet() 检查 pet.xp >= getXpForLevel(level),
// 扣掉 cost,level +=1,溢出的 XP 留作下一级的进度。XP 不进金币 ledger
// (云端账本只管金币),靠 pet 字段随 SYNC_FIELDS 同步。
//
// XP 来源:**纯挂机** —— 速率 = XP_PER_HOUR_FULL × attrMultiplier(pet)。
// 完成作业只发金币不发 XP。维持属性 = XP 跑得快;摆烂 = XP 不动。
//
// 曲线:cost(level) = level × XP_PER_LEVEL_BASE + XP_PER_LEVEL_OFFSET
//                  = level × 33 + 87
//   Lv.1→2   = 120   (满速 0.5 天)
//   Lv.10→11 = 417   (~1.74 天)
//   Lv.50→51 = 1737  (~7.24 天)
//   Lv.90→91 = 3057  (~12.74 天)
//   Lv.99→100= 3354  (~13.97 天 ≈ 14) ✓
// 累计 sum(1..99) = 171963 XP ≈ 716 天满速 ≈ 2 年。
//
// XP_PER_HOUR_FULL = 10 → 满速 240 XP/天。半喂(mult=0.65)~156/天 ≈ 21 天/Lv.99→100。
const LEVEL_MAX = 100
const XP_PER_LEVEL_BASE = 33
const XP_PER_LEVEL_OFFSET = 87
const XP_PER_HOUR_FULL = 10

// 升到 level+1 需要的 XP。已满级返 0(UI 用 0 判定 MAX)。
function getXpForLevel(level) {
  const lvl = Math.max(1, level | 0)
  if (lvl >= LEVEL_MAX) return 0
  return lvl * XP_PER_LEVEL_BASE + XP_PER_LEVEL_OFFSET
}

// 五项属性(四项照料 + 努力)平均值 / 100 = XP 倍率。努力越高升级越快;努力随时间
// 衰减,所以要持续背单词才能维持满速。pet 不存在或没 species 返 0(没宠物不发 XP)。
function attrMultiplier(pet) {
  if (!pet || !pet.species) return 0
  const avg = ((pet.fullness | 0) + (pet.cleanliness | 0) +
               (pet.happiness | 0) + (pet.health | 0) + (pet.effort | 0)) / 5
  if (avg <= 0) return 0
  if (avg >= 100) return 1
  return avg / 100
}

// UI 提示用:当前这一刻每小时发多少 XP(mult 实时变化时跟着变)。
function currentXpPerHour(pet) {
  return XP_PER_HOUR_FULL * attrMultiplier(pet)
}

// Pure: returns pet with stats reduced by elapsed-time decay (rounded to ints
// so the UI doesn't show "76.342") **AND** xp incremented by挂机时间 ×
// attrMultiplier 的近似积分(trapezoidal:窗口起 + 终 mult 的平均)。
// 不持久化 lastDecayAt — commitPetDecay 才写。
function petWithDecay(pet) {
  if (!pet || !pet.species) return pet
  const now = Date.now()
  const last = pet.lastDecayAt || pet.bornAt || now
  const hours = Math.max(0, (now - last) / 3600000)
  if (hours <= 0) return pet
  const drop = (cur, rate) =>
    Math.max(0, Math.round((cur == null ? 100 : cur) - hours * rate))
  const decayed = {
    ...pet,
    happiness:   drop(pet.happiness,   PET_DECAY_PER_HOUR.happiness),
    fullness:    drop(pet.fullness,    PET_DECAY_PER_HOUR.fullness),
    cleanliness: drop(pet.cleanliness, PET_DECAY_PER_HOUR.cleanliness),
    health:      drop(pet.health,      PET_DECAY_PER_HOUR.health),
    // 努力默认 0(不是 100),不能用 drop(它把 null 当 100);从 0 起、有努力才衰减。
    effort:      Math.max(0, Math.round((pet.effort || 0) - hours * PET_DECAY_PER_HOUR.effort))
  }
  // Trapezoidal XP 积分:用窗口起 + 终的 mult 平均 × 时间 × 满速。
  // 起点用 pre-decay pet(尚未掉点),终点用 post-decay decayed。
  // 例:fullness 100→36 衰减 16h,mult_start=1.0、mult_end≈0.6 → avg≈0.8,
  // xp = 16 × 10 × 0.8 = 128。比单点取值更公平。
  const multStart = attrMultiplier(pet)
  const multEnd = attrMultiplier(decayed)
  const avgMult = (multStart + multEnd) / 2
  const xpGained = Math.floor(hours * XP_PER_HOUR_FULL * avgMult)
  if (xpGained > 0) decayed.xp = (pet.xp | 0) + xpGained
  return decayed
}

// "Catch-up" helper: call inside an updateState updater BEFORE applying any
// user-triggered change so the persisted stat numbers + xp reflect "now"
// before being bumped. Stamps lastDecayAt so the next window starts here.
function commitPetDecay(pet) {
  if (!pet || !pet.species) return pet
  const decayed = petWithDecay(pet)
  return { ...decayed, lastDecayAt: Date.now() }
}

// Animation state derived from current pet stats. Priority: critical health
// problems first, then mood, then "happy" only when everything is comfy.
// Shared by pet/index.js (full stage) and home/index.js (mascot) so the
// mood shown alongside tasks never diverges from the one on the pet page.
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

// === 背单词 / 单词库 SRS === //
// 宠物的「知识」属性靠背单词积累(每答对一个 +1,背完结算);知识不能用金币/道具买。
// 掌握度走遗忘曲线:连对 4 次(间隔递增)= 完全掌握,之后不再出现;答错回退两格 +
// 标记错过,需要重新连对。组卷:目标单词本里「到期旧词 + 新词」,保证至少 3 个新词,
// 凑够设定数量(默认 20)。每天最多背 RECITE_DAILY_MAX 次。
const RECITE_DAY_MS = 86400000
const RECITE_INTERVAL_DAYS = [0, 1, 2, 4, 7]   // 下标 = 答对后的连对数(0..4);到 4 即掌握
const RECITE_MASTER_STREAK = 4
const RECITE_WRONG_BACK = 2                     // 答错回退几格
const RECITE_WRONG_DELAY_MS = Math.round(0.25 * 86400000)  // 答错后约 6 小时再来
const RECITE_DEFAULT_SIZE = 20
const RECITE_MIN_NEW = 3
const RECITE_DAILY_MAX = 3
const RECITE_SESSION_MIN = 3
const RECITE_SESSION_MAX = 50

const DEFAULT_RECITE_WORDS = [
  ['苹果', 'apple'], ['香蕉', 'banana'], ['猫', 'cat'], ['狗', 'dog'], ['书', 'book'],
  ['笔', 'pen'], ['水', 'water'], ['牛奶', 'milk'], ['红色', 'red'], ['蓝色', 'blue'],
  ['绿色', 'green'], ['鱼', 'fish'], ['鸟', 'bird'], ['树', 'tree'], ['花', 'flower'],
  ['太阳', 'sun'], ['月亮', 'moon'], ['手', 'hand'], ['脚', 'foot'], ['米饭', 'rice'],
  ['蛋', 'egg'], ['门', 'door'], ['车', 'car'], ['家', 'home'], ['学校', 'school'],
  ['老师', 'teacher'], ['朋友', 'friend'], ['快乐', 'happy']
]

function freshWord(cn, en, id) {
  return { id, cn, en, streak: 0, everWrong: false, mastered: false, dueAt: 0, seen: false, lastAt: 0 }
}

function seedDefaultWordBook() {
  return {
    id: 'wb_default',
    name: '基础词',
    builtin: true,
    public: false,
    createdAt: 0,
    words: DEFAULT_RECITE_WORDS.map(([cn, en], i) => freshWord(cn, en, 'w_def_' + i))
  }
}

function defaultWordConfig() {
  return { sessionSize: RECITE_DEFAULT_SIZE, targetBookIds: ['wb_default'] }
}

function reciteShuffle(arr) {
  const a = arr.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const t = a[i]; a[i] = a[j]; a[j] = t
  }
  return a
}

function reciteIntervalMs(streak) {
  const s = Math.max(0, Math.min(RECITE_MASTER_STREAK, streak))
  return (RECITE_INTERVAL_DAYS[s] || 0) * RECITE_DAY_MS
}

function reciteCountToday(state) {
  const m = (state && state.reciteByDay) || {}
  return m[todayStr()] || 0
}
function reciteRemaining(state) {
  return Math.max(0, RECITE_DAILY_MAX - reciteCountToday(state))
}

// 组卷:目标本里未掌握的「到期旧词 + 新词」,保证 ≥ RECITE_MIN_NEW 新词,凑够 size。
// 返回 [{ bookId, wordId, cn, en, isNew }]。
function buildReciteSession(state) {
  const books = (state && state.wordBooks) || []
  const cfg = (state && state.wordConfig) || {}
  const size = Math.max(RECITE_SESSION_MIN, Math.min(RECITE_SESSION_MAX, cfg.sessionSize || RECITE_DEFAULT_SIZE))
  const targetIds = Array.isArray(cfg.targetBookIds) && cfg.targetBookIds.length
    ? cfg.targetBookIds : books.map((b) => b.id)
  const now = Date.now()
  const due = []
  const fresh = []
  books.forEach((book) => {
    if (targetIds.indexOf(book.id) === -1) return
    ;(book.words || []).forEach((w) => {
      if (w.mastered) return
      const item = { bookId: book.id, wordId: w.id, cn: w.cn, en: w.en, isNew: !w.seen, _due: w.dueAt || 0 }
      if (!w.seen) fresh.push(item)
      else if ((w.dueAt || 0) <= now) due.push(item)
    })
  })
  due.sort((a, b) => (a._due || 0) - (b._due || 0))   // 最早到期(最该复习)的优先
  const freshShuf = reciteShuffle(fresh)
  const picked = []
  const minNew = Math.min(RECITE_MIN_NEW, freshShuf.length)
  for (let i = 0; i < minNew; i++) picked.push(freshShuf[i])
  let di = 0
  while (picked.length < size && di < due.length) picked.push(due[di++])
  let fi = minNew
  while (picked.length < size && fi < freshShuf.length) picked.push(freshShuf[fi++])
  return reciteShuffle(picked).map((it) => ({ bookId: it.bookId, wordId: it.wordId, cn: it.cn, en: it.en, isNew: it.isNew }))
}

// 结算一组背诵:results = [{ bookId, wordId, firstTryCorrect }]。更新每个词的 SRS 状态
// + 给宠物加知识(每个 firstTryCorrect +1)+ 记一次每日次数。返回获得的知识点。
function applyReciteSession(results) {
  let knowledgeGained = 0
  updateState((state) => {
    const now = Date.now()
    const books = state.wordBooks || []
    ;(results || []).forEach((r) => {
      const book = books.find((b) => b.id === r.bookId)
      if (!book) return
      const w = (book.words || []).find((x) => x.id === r.wordId)
      if (!w) return
      w.seen = true
      w.lastAt = now
      if (r.firstTryCorrect) {
        w.streak = Math.min(RECITE_MASTER_STREAK, (w.streak || 0) + 1)
        w.dueAt = now + reciteIntervalMs(w.streak)
        if (w.streak >= RECITE_MASTER_STREAK) w.mastered = true
        knowledgeGained += 1
      } else {
        w.streak = Math.max(0, (w.streak || 0) - RECITE_WRONG_BACK)
        w.everWrong = true
        w.mastered = false
        w.dueAt = now + RECITE_WRONG_DELAY_MS
      }
    })
    if (state.pet && state.pet.species) {
      // 先把到此刻的衰减 + 挂机 XP 结算掉并盖时间戳,再在干净基线上加 经验 / 努力。
      const pet = commitPetDecay(state.pet)
      pet.knowledge = (pet.knowledge || 0) + knowledgeGained                 // 旧"知识"累计值,保留(不再展示)
      pet.xp = (pet.xp || 0) + knowledgeGained                               // 每答对一词 +1 经验
      pet.effort = Math.min(100, (pet.effort || 0) + knowledgeGained * EFFORT_PER_WORD)  // +努力(封顶 100)
      state.pet = pet
    }
    const today = todayStr()
    if (!state.reciteByDay || typeof state.reciteByDay !== 'object') state.reciteByDay = {}
    state.reciteByDay[today] = (state.reciteByDay[today] || 0) + 1
    const cutoff = addDays(today, -7)
    Object.keys(state.reciteByDay).forEach((k) => { if (k < cutoff) delete state.reciteByDay[k] })
    return state
  })
  // 每答对一个词同时 +1 知识 +1 经验,所以 xpGained === knowledgeGained,
  // 分开回传是为了结算页能各显示一行。
  return { knowledgeGained, xpGained: knowledgeGained }
}

// === 单词库管理(增减单词本/单词、目标本、每次数量) === //
const WORD_BOOK_NAME_MAX = 16
const WORD_TEXT_MAX = 40
const WORD_BOOKS_MAX = 40
const WORD_PER_BOOK_MAX = 800
const CUSTOM_WORD_BOOKS_MAX = 5   // 自定义单词本(非内置、非引用)上限;引用本不计、不限

// 自定义单词本数量 = 非 builtin、非 ref 的本(用于 5 个上限判断)。
function customBookCount(books) {
  return (books || []).filter((b) => !b.builtin && !b.ref).length
}
function getCustomBookCount() {
  return customBookCount(loadState().wordBooks)
}
// 把新建/导入/复制/引用的本默认设为近期目标(加进 targetBookIds)。
function _markBookAsTarget(state, bookId) {
  if (!state.wordConfig) state.wordConfig = defaultWordConfig()
  if (!Array.isArray(state.wordConfig.targetBookIds)) state.wordConfig.targetBookIds = []
  if (state.wordConfig.targetBookIds.indexOf(bookId) === -1) state.wordConfig.targetBookIds.push(bookId)
}

function uidBook() { return 'wb_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7) }
function uidWord() { return 'w_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7) }

function addWordBook(name) {
  let book = null
  updateState((state) => {
    if (!Array.isArray(state.wordBooks)) state.wordBooks = []
    if (customBookCount(state.wordBooks) >= CUSTOM_WORD_BOOKS_MAX) return state   // 自定义上限 5
    const nm = (name || '').trim().slice(0, WORD_BOOK_NAME_MAX) || '新单词本'
    book = { id: uidBook(), name: nm, builtin: false, public: false, createdAt: Date.now(), words: [] }
    state.wordBooks.push(book)
    _markBookAsTarget(state, book.id)   // 默认设为近期目标
    return state
  })
  return book
}

function removeWordBook(bookId) {
  updateState((state) => {
    state.wordBooks = (state.wordBooks || []).filter((b) => b.id !== bookId)
    if (state.wordConfig && Array.isArray(state.wordConfig.targetBookIds)) {
      state.wordConfig.targetBookIds = state.wordConfig.targetBookIds.filter((id) => id !== bookId)
    }
    return state
  })
}

function renameWordBook(bookId, name) {
  updateState((state) => {
    const b = (state.wordBooks || []).find((x) => x.id === bookId)
    if (b && !b.ref) b.name = (name || '').trim().slice(0, WORD_BOOK_NAME_MAX) || b.name   // 引用本不可改名
    return state
  })
}

// 跨所有单词本统计:去重后的总词数 + 已掌握词数。同一个词(en+cn 相同)在多本里
// 出现只算一个;任一本里掌握了就算这个词已掌握。
function getWordStats(state) {
  const books = (state && state.wordBooks) || []
  const seen = {}
  books.forEach((b) => {
    (b.words || []).forEach((w) => {
      const key = String(w.en || '').trim().toLowerCase() + '|' + String(w.cn || '').trim()
      if (key === '|') return
      if (!(key in seen)) seen[key] = false
      if (w.mastered) seen[key] = true
    })
  })
  const keys = Object.keys(seen)
  return { total: keys.length, mastered: keys.filter((k) => seen[k]).length }
}

// 给单词本加一个词。返回新词(失败返 null)。不同本可重复 —— 不去重。
// 去掉词条前面的编号/序号(导入残留):"1." "1、" "1)" "(1)" "①" 等。
// 保守:必须带分隔符(点/顿号/括号/冒号),所以不会误伤 "2.5D"(数字后跟数字不删)
// 或 "100 meters"(纯数字+空格不删)。幂等,可重复跑。
function stripWordNum(s) {
  return String(s == null ? '' : s)
    .replace(/^[\s　]*[(（]\s*\d{1,3}\s*[)）][\s.、:：]*/, '')   // (1) （1）
    .replace(/^[\s　]*\d{1,3}\s*[.、．。:：)]\s*(?!\d)/, '')     // 1. 1、 1) 1: 12.
    .replace(/^[\s　]*[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]\s*/, '')   // ①②③
    .trim()
}

function addWord(bookId, cn, en) {
  let word = null
  updateState((state) => {
    const b = (state.wordBooks || []).find((x) => x.id === bookId)
    if (!b) return state
    if (!Array.isArray(b.words)) b.words = []
    if (b.words.length >= WORD_PER_BOOK_MAX) return state
    const c = stripWordNum(cn).slice(0, WORD_TEXT_MAX)
    const e = stripWordNum(en).slice(0, WORD_TEXT_MAX)
    if (!c || !e) return state
    word = freshWord(c, e, uidWord())
    b.words.push(word)
    return state
  })
  return word
}

function removeWord(bookId, wordId) {
  updateState((state) => {
    const b = (state.wordBooks || []).find((x) => x.id === bookId)
    if (b && Array.isArray(b.words)) b.words = b.words.filter((w) => w.id !== wordId)
    return state
  })
}

// 修改一个单词的中文 / 英文(去编号 + 限长)。保留 SRS 掌握状态(只是改写法)。
function updateWord(bookId, wordId, cn, en) {
  let ok = false
  updateState((state) => {
    const b = (state.wordBooks || []).find((x) => x.id === bookId)
    if (!b) return state
    const w = (b.words || []).find((x) => x.id === wordId)
    if (!w) return state
    const c = stripWordNum(cn).slice(0, WORD_TEXT_MAX)
    const e = stripWordNum(en).slice(0, WORD_TEXT_MAX)
    if (!c || !e) return state
    w.cn = c
    w.en = e
    ok = true
    return state
  })
  return ok
}

// 设置近期目标单词本(一个或多个)。只保留存在的 id。
function setReciteTargets(bookIds) {
  updateState((state) => {
    if (!state.wordConfig) state.wordConfig = defaultWordConfig()
    const valid = (state.wordBooks || []).map((b) => b.id)
    state.wordConfig.targetBookIds = (Array.isArray(bookIds) ? bookIds : []).filter((id) => valid.indexOf(id) !== -1)
    return state
  })
}

function setReciteSessionSize(n) {
  updateState((state) => {
    if (!state.wordConfig) state.wordConfig = defaultWordConfig()
    const v = Math.max(RECITE_SESSION_MIN, Math.min(RECITE_SESSION_MAX, Math.round(n) || RECITE_DEFAULT_SIZE))
    state.wordConfig.sessionSize = v
    return state
  })
}

// 分享:把单词本打包成紧凑 payload(只带 名字 + 中英对,不带掌握度),编码进
// 分享链接;接收方走 importSharedWordBook 建一个全新的本(掌握度从头开始)。
function serializeWordBookForShare(bookId) {
  const state = loadState()
  const b = (state.wordBooks || []).find((x) => x.id === bookId)
  if (!b) return null
  const w = (b.words || []).map((x) => [x.cn, x.en]).filter((p) => p[0] && p[1])
  return { k: 'wb', n: (b.name || '单词本').slice(0, WORD_BOOK_NAME_MAX), w }
}

function importSharedWordBook(payload) {
  if (!payload || payload.k !== 'wb' || !Array.isArray(payload.w)) return null
  let book = null
  updateState((state) => {
    if (!Array.isArray(state.wordBooks)) state.wordBooks = []
    if (customBookCount(state.wordBooks) >= CUSTOM_WORD_BOOKS_MAX) return state   // 复制=自定义,占 5 个名额
    const name = (payload.n || '分享单词本').toString().trim().slice(0, WORD_BOOK_NAME_MAX) || '分享单词本'
    const seen = {}
    const words = []
    payload.w.forEach((p) => {
      if (!Array.isArray(p)) return
      const cn = (p[0] || '').toString().trim().slice(0, WORD_TEXT_MAX)
      const en = (p[1] || '').toString().trim().slice(0, WORD_TEXT_MAX)
      if (!cn || !en) return
      const key = cn + '|' + en.toLowerCase()
      if (seen[key]) return
      seen[key] = 1
      if (words.length < WORD_PER_BOOK_MAX) words.push(freshWord(cn, en, uidWord()))
    })
    book = { id: uidBook(), name, builtin: false, public: false, createdAt: Date.now(), words }
    state.wordBooks.push(book)
    _markBookAsTarget(state, book.id)   // 默认设为近期目标
    return state
  })
  return book
}

// 「引用」一个公开本:本地建一个带 ref(公开本 id)的本,内容是快照,可后续同步。
// 跟「复制」的区别:ref 让它能从源更新,且页面里只读(不让改作者的内容)。
function addReferencedBook(name, wordPairs, ref, creator) {
  let book = null
  updateState((state) => {
    if (!Array.isArray(state.wordBooks)) state.wordBooks = []
    if (state.wordBooks.length >= WORD_BOOKS_MAX) return state   // 引用本不占自定义 5 名额,仅总量安全上限
    const nm = (name || '引用单词本').toString().trim().slice(0, WORD_BOOK_NAME_MAX) || '引用单词本'
    const seen = {}
    const words = []
    ;(Array.isArray(wordPairs) ? wordPairs : []).forEach((p) => {
      const cn = String((p && p.cn) || '').trim().slice(0, WORD_TEXT_MAX)
      const en = String((p && p.en) || '').trim().slice(0, WORD_TEXT_MAX)
      if (!cn || !en) return
      const key = cn + '|' + en.toLowerCase()
      if (seen[key]) return
      seen[key] = 1
      if (words.length < WORD_PER_BOOK_MAX) words.push(freshWord(cn, en, uidWord()))
    })
    book = { id: uidBook(), name: nm, builtin: false, public: false, ref: String(ref || ''), refAt: Date.now(), createdAt: Date.now(),
      creatorName: (creator && creator.name) || '', creatorAvatar: (creator && creator.avatar) || '', words }
    state.wordBooks.push(book)
    _markBookAsTarget(state, book.id)   // 引用本默认设为近期目标
    return state
  })
  return book
}

// 同步引用本到源的最新内容:按 key(cn|en)保留旧词的 SRS 状态,加新词、去掉删掉的。
function syncReferencedBook(bookId, wordPairs) {
  let result = 0
  // 源返回空(被撤回 / 清空 / 网络异常拿到空数组)时不要把引用方本地的词清掉 ——
  // 「之前引用的不受影响」。空更新直接当 no-op,返回当前词数。
  if (!Array.isArray(wordPairs) || wordPairs.length === 0) {
    const cur = (loadState().wordBooks || []).find((x) => x.id === bookId)
    return (cur && (cur.words || []).length) || 0
  }
  updateState((state) => {
    const b = (state.wordBooks || []).find((x) => x.id === bookId)
    if (!b) return state
    const oldByKey = {}
    ;(b.words || []).forEach((w) => { oldByKey[(w.cn || '') + '|' + (w.en || '').toLowerCase()] = w })
    const seen = {}
    const next = []
    ;(Array.isArray(wordPairs) ? wordPairs : []).forEach((p) => {
      const cn = String((p && p.cn) || '').trim().slice(0, WORD_TEXT_MAX)
      const en = String((p && p.en) || '').trim().slice(0, WORD_TEXT_MAX)
      if (!cn || !en) return
      const key = cn + '|' + en.toLowerCase()
      if (seen[key] || next.length >= WORD_PER_BOOK_MAX) return
      seen[key] = 1
      next.push(oldByKey[key] || freshWord(cn, en, uidWord()))
    })
    result = next.length
    b.words = next
    b.refAt = Date.now()
    return state
  })
  return result
}

// 设置单词本是否公开(本地标记;真正发布/撤销到云库由页面调云函数完成)。
function setWordBookPublic(bookId, isPublic) {
  updateState((state) => {
    const b = (state.wordBooks || []).find((x) => x.id === bookId)
    if (b) b.public = !!isPublic
    return state
  })
}

const defaultState = {
  schemaVersion: SCHEMA_VERSION,
  // ms timestamp of last sync-relevant local mutation. 0 = never written, so
  // anything from cloud will win on first hydrate.
  updatedAt: 0,
  // 余额本地真值。每次 applyCoinDelta 直接改本地,saveState 整包 push 上云。
  // 新用户从 100 起步。
  coins: 100,
  // 完整流水审计。append-only,cap 至 COIN_LOG_KEEP 条。push 上云作 mirror。
  // revokePerfectDay 据此判定"对应 perfect 入账是否真发生过"(看 bonusByDay
  // 上的 ledgerEventId 是否能在 coinLogs 中找到)。
  coinLogs: [],
  streakDays: 0,
  // YYYY-MM-DD strings for days where every task got completed. Used to
  // compute consecutive-perfect-day streak. Pruned to ~14 days of history.
  perfectDays: [],
  // Per-day bonus paid on first all-done. Keyed by YYYY-MM-DD; value is
  // { dailyBonus, weeklyBonus, prevStreakDays }. Read by revertTask to claw
  // back the exact bonus that was credited (and restore prior streak).
  bonusByDay: {},
  // Per-day completion count for the 20-cap. Keyed by YYYY-MM-DD of the
  // wall-clock day the finish happened on (not the task's occurrence date),
  // so a 22:00 finish of yesterday's task counts toward today's quota.
  // Pruned to ~14 days alongside perfectDays.
  completionsByDay: {},
  editTaskId: null,
  editNotebookId: null,
  ocrCurrentJob: null,
  ocrJobs: [],
  // Empty pet object → triggers first-time setup flow on the pet tab.
  pet: {},
  // Each item lifts one primary stat back to a comfy zone. 开心度道具走
  // happiness 字段 — buyItem 会一并应用,跟其他三项一致。
  shopItems: [
    { id: 1, emoji: '🥕', name: '营养胡萝卜', effect: '饱腹+30',  price: 16, happiness: 0,  fullness: 30, cleanliness: 0,  health: 0  },
    { id: 2, emoji: '🍱', name: '丰盛便当',   effect: '饱腹+50',  price: 28, happiness: 0,  fullness: 50, cleanliness: 0,  health: 0  },
    { id: 3, emoji: '🧼', name: '香皂',       effect: '清洁+30',  price: 18, happiness: 0,  fullness: 0,  cleanliness: 30, health: 0  },
    { id: 4, emoji: '🛁', name: '泡泡浴',     effect: '清洁+60',  price: 32, happiness: 0,  fullness: 0,  cleanliness: 60, health: 0  },
    { id: 5, emoji: '🎾', name: '玩具球',     effect: '开心+30',  price: 20, happiness: 30, fullness: 0,  cleanliness: 0,  health: 0  },
    { id: 6, emoji: '💊', name: '维生素',     effect: '健康+25',  price: 20, happiness: 0,  fullness: 0,  cleanliness: 0,  health: 25 },
    { id: 7, emoji: '🏃', name: '健身房一次', effect: '健康+55',  price: 35, happiness: 0,  fullness: 0,  cleanliness: 0,  health: 55 },
    { id: 8, emoji: '🎁', name: '礼物盒',     effect: '开心+50',  price: 36, happiness: 50, fullness: 0,  cleanliness: 0,  health: 0  }
  ],
  // v3 起永远为空数组 —— 老字段保留只为 SYNC_FIELDS 兼容/老 client hydrate 不崩。
  notebooks: [],
  tasks: [],
  profile: { nickname: '', avatar: '' },
  // 用户自定义的组织标签列表(我 Tab 可编辑)。task.organization 存的是字符串,
  // 删除某个标签不会改动已有 task —— 仅影响 task-edit 下拉。
  organizations: DEFAULT_ORGANIZATIONS.slice(),
  // 单词库:多个单词本(每词带遗忘曲线 SRS 状态)+ 配置(每次数量 + 目标本)+
  // 每日背诵次数。新用户内置一个「基础词」本。
  wordBooks: [seedDefaultWordBook()],
  wordConfig: defaultWordConfig(),
  reciteByDay: {}
}

// === Storage / migration === //

// v2→v3 一次性标记 — 当本次 loadState/migrate 实际触发了 v2→v3 平移时置 true,
// cloud-sync hydrate 完成后会读取并调用 backupUserState (backup_self) 给云端
// 留下一份升级前快照,然后 consumeV2V3MigrationFlag() 清掉。
let _v2v3MigrationApplied = false

function consumeV2V3MigrationFlag() {
  const was = _v2v3MigrationApplied
  _v2v3MigrationApplied = false
  return was
}

function clone(data) { return JSON.parse(JSON.stringify(data)) }

function migrateState(raw) {
  if (!raw || typeof raw !== 'object') return clone(defaultState)

  // v1 → v2: 把老 tasks 都塞进一个"今天"的 one-shot notebook。
  //
  // 判定:真 v1 数据(无 schemaVersion **且** 没有 notebooks 数组结构)。
  // 注意:云端 user_state 因为历史原因 schemaVersion 不在 SYNC_FIELDS,
  // hydrate 拿到的 remote state 没有 schemaVersion 字段,但仍有 v2 schema 的
  // notebooks/tasks(带 notebookId)。这种情况必须走下面的 v2→v3 平移,绝不能
  // 命中本分支 — 一旦命中,所有 task 会被丢进 nb_mig_today,丢失原 notebook
  // 关联,平移后所有 task 都变成 today 的 one-shot → 首页"已完成"列表炸开。
  // (该 bug 在 1.0.0.26051701 体验版上确认过, see commitId 84e8795)
  if ((!raw.schemaVersion || raw.schemaVersion < 2) &&
      (!Array.isArray(raw.notebooks) || raw.notebooks.length === 0)) {
    const today = todayStr()
    const oldTasks = Array.isArray(raw.tasks) ? raw.tasks : []
    const notebooks = []
    const tasks = []
    if (oldTasks.length) {
      const nbId = 'nb_mig_today'
      notebooks.push({
        id: nbId, name: today, mode: 'one-shot',
        startDate: today, endDate: today, recurrence: null,
        createdAt: Date.now(), order: 0
      })
      for (const old of oldTasks) {
        tasks.push({
          id: `tk_mig_${old.id || tasks.length + 1}`,
          notebookId: nbId,
          subject: old.subject || '其他',
          content: old.content || '',
          estimatedMinutes: Number(old.estimatedMinutes || 0),
          order: tasks.length,
          createdAt: old.createdAt || Date.now(),
          status: old.status || 'todo',
          startedAt: old.actualStartedAt || null,
          currentSegmentStartedAt: old.currentSegmentStartedAt || null,
          accumulatedMs: old.accumulatedMs || old.elapsedMs || 0,
          completedAt: old.actualEndedAt || null,
          actualMinutes: null
        })
      }
    }
    raw = { ...raw, schemaVersion: 2, notebooks, tasks }
  }

  // v2 → v3: 拍平 notebook,把 mode / startDate / endDate / recurrence 平移到
  // task 上,加默认 organization。orphan task(notebookId 找不到本)按
  // one-shot/今日 兜底。perfectDays / coinLogs / bonusByDay / completionsByDay
  // / pet 字段 全部不动 —— 它们本来就是 task 粒度或全局粒度。
  //
  // 判定放宽:不再要求 schemaVersion === 2,只要"还不是 v3 + 有 v2 形态的
  // notebooks/tasks"就走平移。这是为了兼容云端 schemaVersion 字段丢失的场景
  // (SYNC_FIELDS 历史漏了 schemaVersion,hydrate 拿到 schemaVersion=undefined
  // 但 notebooks/tasks 仍是 v2 schema 的真实数据)。
  if (raw.schemaVersion !== SCHEMA_VERSION &&
      Array.isArray(raw.notebooks) && raw.notebooks.length > 0 &&
      Array.isArray(raw.tasks)) {
    const today = todayStr()
    const nbById = {}
    for (const nb of raw.notebooks) nbById[nb.id] = nb
    const nbSubjectById = {}
    for (const nb of raw.notebooks) nbSubjectById[nb.id] = nb.subject || ''
    raw.tasks = raw.tasks.map((t, i) => {
      const nb = nbById[t.notebookId]
      const mode = nb ? (nb.mode === 'recurring' ? 'recurring' : 'one-shot') : 'one-shot'
      const startDate = nb ? (nb.startDate || today) : today
      const endDate = nb
        ? (nb.endDate === undefined
            ? (mode === 'recurring' ? null : startDate)
            : nb.endDate)
        : today
      const recurrence = mode === 'recurring'
        ? (nb && nb.recurrence ? nb.recurrence : { type: 'daily', weekdays: [] })
        : null
      return {
        order: i,
        subject: t.subject || nbSubjectById[t.notebookId] || '其他',
        organization: DEFAULT_ORGANIZATION,
        ...t,
        mode,
        startDate,
        endDate,
        recurrence
        // notebookId 保留在 task 上不删 —— 老 client(v2)hydrate 时还能用,
        // 新 client 完全忽略。下次 schemaVersion bump 时再删。
      }
    })
    raw.notebooks = []  // 拍平,字段保留(SYNC_FIELDS 还在引用)
    raw.schemaVersion = 3
    _v2v3MigrationApplied = true  // 触发 lazy backup,cloud-sync 会读取这个 flag
  }

  if (raw.schemaVersion === SCHEMA_VERSION && Array.isArray(raw.tasks)) {
    // already v3 — backfill 缺失字段
    if (!Array.isArray(raw.notebooks)) raw.notebooks = []

    // hydrate 兜底:server 可能还在推 v2 schema(老 client 推上去的),
    // task 不带 mode/startDate,但 notebooks 数组里还有调度信息。这里反查
    // 把 mode/startDate/endDate/recurrence 从对应 notebook 平移到 task 上。
    // 真正完成迁移后 raw.notebooks 会被清空,这段就走空 — 完全 idempotent。
    const nbById = {}
    for (const nb of raw.notebooks) nbById[nb.id] = nb
    const today = todayStr()

    raw.tasks = raw.tasks.map((t, i) => {
      const out = { ...t }
      if (typeof out.order !== 'number') out.order = i
      // 反查 notebook 平移 — 仅在 task 缺 mode 时触发(避免覆盖 v3 写好的字段)。
      if (!out.mode && out.notebookId) {
        const nb = nbById[out.notebookId]
        if (nb) {
          out.mode = nb.mode === 'recurring' ? 'recurring' : 'one-shot'
          if (!out.startDate) out.startDate = nb.startDate || today
          if (out.endDate === undefined) {
            out.endDate = nb.endDate === undefined
              ? (out.mode === 'recurring' ? null : (nb.startDate || today))
              : nb.endDate
          }
          if (out.mode === 'recurring' && !out.recurrence) {
            out.recurrence = nb.recurrence || { type: 'daily', weekdays: [] }
          }
          if (!out.subject) out.subject = nb.subject || '其他'
        }
      }
      if (!out.subject) out.subject = '其他'
      // organization 现在是自由字符串(用户在我 Tab 自定义标签列表)。
      // 这里只兜底缺失/非法值,不再做枚举校验 — 历史 task 的任意 string 都保留。
      if (typeof out.organization !== 'string' || !out.organization.trim()) {
        out.organization = DEFAULT_ORGANIZATION
      }
      out.mode = out.mode === 'recurring' ? 'recurring' : 'one-shot'
      if (!out.startDate) out.startDate = today
      if (out.endDate === undefined) out.endDate = out.mode === 'one-shot' ? out.startDate : null
      out.recurrence = out.mode === 'recurring'
        ? (out.recurrence || { type: 'daily', weekdays: [] })
        : null
      // excludedDates: 这天的 recurring occurrence 被 detach 出独立 task,
      // 原 recurring 不再在该日期触发。仅 recurring task 用得到。
      if (!Array.isArray(out.excludedDates)) out.excludedDates = []
      return out
    })
    // 反查跑完就把 notebooks 清空,避免下次 hydrate 又被 server 推的老数据污染。
    if (raw.notebooks.length > 0) raw.notebooks = []
    raw.editNotebookId = raw.editNotebookId || null
    raw.profile = raw.profile && typeof raw.profile === 'object'
      ? { nickname: raw.profile.nickname || '', avatar: raw.profile.avatar || '' }
      : { nickname: '', avatar: '' }
    // 标签列表:trim/去重/卡长度卡总数,空数组回退默认。老用户(无 organizations 字段)
    // 自然落到默认 ['校内', '校外', '其他'] —— 跟历史 ORGANIZATIONS 常量一致。
    raw.organizations = sanitizeOrganizationList(raw.organizations)
    // shopItems is config (same for everyone), not user state — always
    // refresh from defaultState so item updates ship to existing users
    // without a manual cache wipe.
    raw.shopItems = clone(defaultState).shopItems
    if (!Array.isArray(raw.perfectDays)) raw.perfectDays = []
    if (!raw.bonusByDay || typeof raw.bonusByDay !== 'object') raw.bonusByDay = {}
    if (!raw.completionsByDay || typeof raw.completionsByDay !== 'object') raw.completionsByDay = {}
    if (typeof raw.streakDays !== 'number') raw.streakDays = 0
    if (typeof raw.coins !== 'number') raw.coins = 0
    // 老 schema 残留的 pendingCoinEvents 字段 — 新架构不再异步上报事件,
    // 直接 strip 掉。这些未发出的事件已经在本地 applyCoinDelta 时反映到
    // state.coins,丢了 server-side 的"待入账"列表无伤大雅。
    if ('pendingCoinEvents' in raw) delete raw.pendingCoinEvents
    if (!Array.isArray(raw.coinLogs)) raw.coinLogs = []
    // Pet schema upgrade: legacy data had {name, emoji, level, growth,
    // happiness, fullness} but no species / cleanliness / health / age. If
    // we see a name without a species, treat it as already-set-up (infer
    // species from the emoji), otherwise leave empty so setup runs.
    raw.pet = raw.pet && typeof raw.pet === 'object' ? raw.pet : {}
    if (raw.pet.name && !raw.pet.species) {
      const inferred = PET_SPECIES.find((s) => s.emoji === raw.pet.emoji)
      raw.pet.species = inferred ? inferred.id : 'cat'
    }
    if (raw.pet.species) {
      const sp = PET_SPECIES.find((s) => s.id === raw.pet.species)
      if (sp && !raw.pet.emoji) raw.pet.emoji = sp.emoji
      if (!raw.pet.bornAt)        raw.pet.bornAt        = Date.now()
      if (!raw.pet.lastDecayAt)   raw.pet.lastDecayAt   = Date.now()
      if (raw.pet.level == null)            raw.pet.level            = 1
      if (raw.pet.happiness == null)        raw.pet.happiness        = 80
      if (raw.pet.fullness == null)         raw.pet.fullness         = 80
      if (raw.pet.cleanliness == null)      raw.pet.cleanliness      = 90
      if (raw.pet.health == null)           raw.pet.health           = 95
      // xp: 新引入字段(经验值升级模型)。老用户从 0 开始攒,不影响 level。
      if (raw.pet.xp == null)               raw.pet.xp               = 0
      // knowledge: 旧"知识"累计值(已不展示,保留兼容)。老用户从 0 起。
      if (raw.pet.knowledge == null)        raw.pet.knowledge        = 0
      // effort 努力:0-100 进度条,背单词攒、随时间衰减。老用户从 0 起。
      if (raw.pet.effort == null)           raw.pet.effort           = 0
      raw.pet.effort = Math.max(0, Math.min(100, raw.pet.effort | 0))
      // 老 exp/growth/freeze 模型已废弃 — strip 历史字段。
      // 注意:xp 是新字段,不在 strip 列表里。
      if ('exp' in raw.pet)                   delete raw.pet.exp
      if ('happinessLastDecayAt' in raw.pet)  delete raw.pet.happinessLastDecayAt
      if ('growth' in raw.pet)                delete raw.pet.growth
      if ('nextLevelGrowth' in raw.pet)       delete raw.pet.nextLevelGrowth
      if (raw.pet.lastLeveledAt === undefined) raw.pet.lastLeveledAt = null
    }
    // 单词库:确保字段存在;每词补齐 SRS 字段。
    // 只在"从来没有 wordBooks 字段"(首次用单词功能)时种默认「基础词」本;
    // 用户主动删光(包括删掉「基础词」)→ 保持空,不再硬塞回来。
    if (!Array.isArray(raw.wordBooks)) raw.wordBooks = [seedDefaultWordBook()]
    raw.wordBooks.forEach((book) => {
      if (typeof book.public !== 'boolean') book.public = false
      if (!Array.isArray(book.words)) book.words = []
      book.words.forEach((w) => {
        if (typeof w.streak !== 'number') w.streak = 0
        if (typeof w.everWrong !== 'boolean') w.everWrong = false
        if (typeof w.mastered !== 'boolean') w.mastered = false
        if (typeof w.dueAt !== 'number') w.dueAt = 0
        if (typeof w.seen !== 'boolean') w.seen = false
        // 清掉历史导入残留在词条前的编号(幂等)。
        if (w.en) w.en = stripWordNum(w.en)
        if (w.cn) w.cn = stripWordNum(w.cn)
      })
    })
    if (!raw.wordConfig || typeof raw.wordConfig !== 'object') raw.wordConfig = defaultWordConfig()
    if (typeof raw.wordConfig.sessionSize !== 'number') raw.wordConfig.sessionSize = RECITE_DEFAULT_SIZE
    if (!Array.isArray(raw.wordConfig.targetBookIds) || raw.wordConfig.targetBookIds.length === 0) {
      raw.wordConfig.targetBookIds = raw.wordBooks.map((b) => b.id)
    }
    if (!raw.reciteByDay || typeof raw.reciteByDay !== 'object') raw.reciteByDay = {}
    // Pre-cloud-sync data: stamp current time so this device's data wins on
    // first cloud sync (over a fresh empty cloud doc with updatedAt=0).
    if (typeof raw.updatedAt !== 'number') raw.updatedAt = Date.now()
    return raw
  }

  // schemaVersion 奇怪 / tasks 不是数组 — 兜底重置。极少能命中(只有损坏数据)。
  return clone(defaultState)
}

// In-memory cache. The first read pays the storage + migrate cost; every
// subsequent tab onShow returns this reference instantly. Mutations go
// through updateState, which deep-clones before patching, so callers can't
// corrupt the cache by holding onto references.
let _stateCache = null

function loadState() {
  if (_stateCache) return _stateCache
  const t0 = Date.now()
  try {
    const raw = wx.getStorageSync(STORAGE_KEY)
    if (raw && typeof raw === 'object') {
      _stateCache = migrateState(raw)
      console.log(`[perf] loadState (first call): ${Date.now() - t0}ms`)
      return _stateCache
    }
  } catch (error) {
    console.warn('loadState failed', error)
  }
  _stateCache = clone(defaultState)
  console.log(`[perf] loadState (first call, fresh): ${Date.now() - t0}ms`)
  return _stateCache
}

function saveState(state) {
  _stateCache = state
  wx.setStorageSync(STORAGE_KEY, state)
  // 每天至少留一份本地快照(12h 节流,纯内存判断不额外读存储)。首次保存时
  // _lastAutoBackupMs=0 会先备一份,等于每次启动也留底。
  const nowMs = Date.now()
  if (nowMs - _lastAutoBackupMs > 12 * 60 * 60 * 1000) {
    _lastAutoBackupMs = nowMs   // 先占位防重入(backupLocalState 不回调 saveState)
    try { backupLocalState('daily') } catch (e) { console.warn('daily backup failed', e) }
  }
  // Push synced subset to cloud (debounced inside cloud-sync). coins 现在
  // 在 SYNC_FIELDS 里,随 state 一起整包推。
  cloudSync.pushState(pickSyncFields(state), state.updatedAt)
}

function pickSyncFields(state) {
  const out = {}
  for (const k of SYNC_FIELDS) out[k] = state[k]
  return out
}

// Called by cloud-sync after a hydrate determines remote is newer (or after
// the user "switches to this device"). Overlays the synced subset onto local
// cache + storage WITHOUT triggering a push back.
//
// 客户端 = truth 架构下,hydrate 只在"另一台设备写过 / 本机 storage 被清"
// 时才会接到云端比本地新的 state — 那种情况就用云端的 snapshot 覆盖本地。
function applyHydratedState(remoteSyncedFields, remoteUpdatedAt) {
  // 覆盖前先备份当前本地 state —— 这是本地数据「唯一」被云端整包覆盖的入口。
  // 万一拉下来的是旧快照盖了本机新数据,用户可在「我」Tab → 数据备份里恢复。
  try { backupLocalState('pre-sync') } catch (e) { console.warn('pre-sync backup failed', e) }
  const cur = loadState()
  const next = {
    ...cur,
    ...remoteSyncedFields,
    updatedAt: remoteUpdatedAt || Date.now()
  }
  _stateCache = next
  wx.setStorageSync(STORAGE_KEY, next)
}

function getStateForSync() {
  return pickSyncFields(loadState())
}

function getUpdatedAt() {
  return loadState().updatedAt || 0
}

// === Local backup safety net === //
//
// 同步前先备份。applyHydratedState 是本地数据「唯一」会被云端整包覆盖的地方,
// 覆盖前先把当前本地 state 存一份滚动快照 —— 万一云端拉下来的是旧快照把本机新
// 数据盖了(2026-06 那次丢数据就是这样),还能从备份里捞回来(我 Tab → 数据备份)。
// 另外 saveState 里每 12h 至少再留一份('daily'),防本地存储损坏等其它丢数据路径。
const BACKUP_STORAGE_KEY = STORAGE_KEY + '_synced_backups'
const BACKUP_KEEP = 15
let _lastAutoBackupMs = 0

function countDoneInState(state) {
  const tasks = Array.isArray(state && state.tasks) ? state.tasks : []
  let done = 0
  for (const t of tasks) {
    if (t && t.status === 'done') done++
    const occ = (t && t.occurrences) || {}
    for (const k in occ) { if (occ[k] && occ[k].status === 'done') done++ }
  }
  return done
}

function readBackups() {
  try {
    const arr = wx.getStorageSync(BACKUP_STORAGE_KEY)
    return Array.isArray(arr) ? arr : []
  } catch (_) { return [] }
}

function writeBackups(arr) {
  try { wx.setStorageSync(BACKUP_STORAGE_KEY, arr) } catch (e) { console.warn('writeBackups failed', e) }
}

// Snapshot current local synced fields into the rolling backup list (newest
// first). Dedup: if the newest existing backup is identical (same updatedAt +
// taskCount + doneCount) we just refresh its timestamp instead of growing the
// list. Returns the stored record.
function backupLocalState(reason) {
  const state = loadState()
  const list = readBackups()
  const top = list[0]
  const snapUpd = state.updatedAt || 0
  const snapTaskCount = Array.isArray(state.tasks) ? state.tasks.length : 0
  const snapDone = countDoneInState(state)
  if (top && top.updatedAt === snapUpd && top.taskCount === snapTaskCount && top.doneCount === snapDone) {
    // 与最新快照完全一致(updatedAt 每次保存都会变,相等 = 状态没动)→ 不增长、
    // 也不动它的 `at`(否则之前返回的 at 句柄会失效)。只更新节流时间戳。
    _lastAutoBackupMs = Date.now()
    return top
  }
  // `at` 既是显示时间也是恢复主键 —— 用严格递增保证唯一(快速连续调用同毫秒时 +1)。
  let at = Date.now()
  if (top && at <= top.at) at = top.at + 1
  const rec = {
    at,
    reason: reason || 'manual',
    updatedAt: snapUpd,
    taskCount: snapTaskCount,
    doneCount: snapDone,
    state: clone(pickSyncFields(state))
  }
  list.unshift(rec)
  // 超额裁剪时,优先淘汰最老的「非关键」备份(daily/manual),尽量保住
  // pre-sync / pre-restore —— 那两类是「数据被覆盖前的最后一份」,最值钱,
  // 不能被频繁开 app 产生的 daily 快照挤掉。
  while (list.length > BACKUP_KEEP) {
    let idx = -1
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].reason === 'daily' || list[i].reason === 'manual') { idx = i; break }
    }
    if (idx === -1) idx = list.length - 1   // 全是关键备份 → 只能删最老的
    list.splice(idx, 1)
  }
  writeBackups(list)
  _lastAutoBackupMs = at
  return rec
}

// Lightweight metadata for the settings UI (omit the heavy `state` blob).
function listBackups() {
  return readBackups().map((r) => ({
    at: r.at,
    reason: r.reason,
    updatedAt: r.updatedAt || 0,
    taskCount: r.taskCount || 0,
    doneCount: r.doneCount || 0
  }))
}

// Restore a backup by its `at` timestamp. Backs up the CURRENT state first
// (reason 'pre-restore') so an accidental restore is itself reversible, then
// overlays the snapshot, bumps updatedAt to now so it wins last-write-wins and
// pushes up to cloud. Returns true on success.
function restoreBackup(at) {
  const list = readBackups()
  const rec = list.find((r) => r.at === at)
  if (!rec || !rec.state) return false
  backupLocalState('pre-restore')
  const cur = loadState()
  const next = Object.assign({}, cur, rec.state, { updatedAt: Date.now() })
  saveState(next)
  return true
}

// === Task scheduling === //

// v3: 调度字段下沉到 task 后,直接读 task.mode / startDate / endDate / recurrence。
// excludedDates 里的日期(被 detach 出独立 task 的实例)从 recurring 里跳过。
function isTaskActiveOn(task, dateStr) {
  if (!task) return false
  if (task.startDate && compareDateStr(dateStr, task.startDate) < 0) return false
  if (task.mode === 'one-shot') {
    return dateStr === (task.endDate || task.startDate)
  }
  // recurring
  if (task.endDate && compareDateStr(dateStr, task.endDate) > 0) return false
  if (Array.isArray(task.excludedDates) && task.excludedDates.indexOf(dateStr) >= 0) return false
  const rec = task.recurrence || { type: 'daily' }
  if (rec.type === 'daily') return true
  if (rec.type === 'weekly') {
    const wds = Array.isArray(rec.weekdays) ? rec.weekdays : []
    return wds.includes(weekdayOf(dateStr))
  }
  return false
}

// One-shot tasks store status at top level. Recurring tasks store per-occurrence
// state under occurrences[YYYY-MM-DD].
function defaultOccurrence() {
  return {
    status: 'todo',
    startedAt: null,
    currentSegmentStartedAt: null,
    accumulatedMs: 0,
    completedAt: null,
    actualMinutes: null,
    // Set by finishTask so revertTask refunds exactly what was paid (which
    // varies by overdue/today/future and by the 20-cap status). null means
    // unfinished or paid before this field existed (legacy → treat as 0).
    rewardPaid: null,
    rewardKind: null,
    // 时间记录:开始/暂停/继续/完成 事件序列 [{ t:'start'|'pause'|'resume'|'done', at: ms }]
    events: []
  }
}

function isRecurringTask(task) {
  return !!(task && task.mode === 'recurring')
}

function getTaskState(task, dateStr) {
  if (!task) return defaultOccurrence()
  if (task.mode !== 'recurring') {
    return {
      status: task.status || 'todo',
      startedAt: task.startedAt || null,
      currentSegmentStartedAt: task.currentSegmentStartedAt || null,
      accumulatedMs: task.accumulatedMs || 0,
      completedAt: task.completedAt || null,
      actualMinutes: task.actualMinutes || null,
      rewardPaid: task.rewardPaid != null ? task.rewardPaid : null,
      rewardKind: task.rewardKind || null,
      events: Array.isArray(task.events) ? task.events : []
    }
  }
  const occ = (task.occurrences || {})[dateStr]
  return occ ? { ...defaultOccurrence(), ...occ } : defaultOccurrence()
}

// 某天还没做完的「下一项作业」(排除指定 id),按用户拖动顺序(order)取第一个。
// 给「完成后直接做下一项」用。返回 {taskId, date, content} 或 null。
function nextPendingTaskOnDate(excludeTaskId, dateStr) {
  const state = getStateWithComputed()
  const day = dateStr || todayStr()
  const items = tasksForDate(state, day) || []
  const pending = items
    .filter((it) => it.task && it.task.id !== excludeTaskId &&
      !(it.occurrence && it.occurrence.status === 'done'))
    .sort((a, b) => (a.task.order || 0) - (b.task.order || 0))
  if (!pending.length) return null
  const it = pending[0]
  return { taskId: it.task.id, date: it.occurrenceDate || day, content: it.task.content || '' }
}

// 往事件序列追加一条(开始/暂停/继续/完成),封顶 200 条防无限增长。
function appendEvent(events, type, at) {
  const arr = Array.isArray(events) ? events.slice() : []
  arr.push({ t: type, at: at })
  return arr.length > 200 ? arr.slice(-200) : arr
}

// 给 UI 用:某项作业(某天 occurrence)的时间记录,已格式化。行 = { t, label, time }。
// label/time 走 i18n(惰性 require 防循环依赖)。同一天只显示时分秒,跨天前面带月-日。
function getTaskTimelineRows(taskId, dateStr) {
  const i18n = require('./i18n')
  const state = loadState()
  const task = (state.tasks || []).find((t) => t.id === taskId)
  if (!task) return []
  const occ = getTaskState(task, dateStr || todayStr())
  const events = Array.isArray(occ.events) ? occ.events : []
  const pad = (n) => (n < 10 ? '0' + n : '' + n)
  const now = new Date()
  return events.map((ev) => {
    const d = new Date(ev.at)
    const hms = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
    const sameDay = d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
    return {
      t: ev.t,
      label: i18n.t('tfocus_ev_' + ev.t),
      time: sameDay ? hms : ((d.getMonth() + 1) + '-' + d.getDate() + ' ' + hms)
    }
  })
}

// 给 timelog 进度条用:把事件序列拆成「作业(work)/休息(break)」交替的区段。
// start/resume → 进入 work;pause → 进入 break;done → 结束。进行中(没 done)的
// 最后一段补到 now。返回 { segments:[{type:'work'|'break', ms}], workMs, breakMs }。
function getTaskWorkBreakSegments(taskId, dateStr, now) {
  const empty = { segments: [], workMs: 0, breakMs: 0 }
  const cur = loadState()
  const task = (cur.tasks || []).find((t) => t.id === taskId)
  if (!task) return empty
  const occ = getTaskState(task, dateStr || todayStr())
  const events = (Array.isArray(occ.events) ? occ.events : []).slice().sort((a, b) => a.at - b.at)
  const segs = []
  let prevAt = null, mode = null   // mode: 'work' | 'break' | null(结束)
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]
    if (prevAt != null && mode != null && ev.at > prevAt) {
      segs.push({ type: mode, ms: ev.at - prevAt })
    }
    if (ev.t === 'start' || ev.t === 'resume') mode = 'work'
    else if (ev.t === 'pause') mode = 'break'
    else if (ev.t === 'done') mode = null
    prevAt = ev.at
  }
  const tnow = now || Date.now()
  if (mode != null && prevAt != null && tnow > prevAt) {
    segs.push({ type: mode, ms: tnow - prevAt })   // 进行中:最后一段补到现在
  }
  let workMs = 0, breakMs = 0
  segs.forEach((s) => { if (s.type === 'work') workMs += s.ms; else breakMs += s.ms })
  return { segments: segs, workMs: workMs, breakMs: breakMs }
}

function applyTaskState(task, dateStr, patch) {
  if (task.mode !== 'recurring') {
    return { ...task, ...patch }
  }
  const occurrences = { ...(task.occurrences || {}) }
  occurrences[dateStr] = { ...defaultOccurrence(), ...occurrences[dateStr], ...patch }
  return { ...task, occurrences }
}

// 手动修正「已完成作业」记录的实际用时(分钟)。一次性作业写在 task 上;
// 重复作业写在该天 occurrence 上(dateStr)。只允许改已完成(status==='done')的记录;
// 不重算奖励(奖励在完成那刻已结算),仅修正用时统计(影响后续工时预估)。
function setActualMinutes(taskId, dateStr, minutes) {
  const m = Math.min(1440, Math.max(1, Math.round(Number(minutes) || 0)))
  let ok = false
  updateState((state) => {
    const task = (state.tasks || []).find((t) => t.id === taskId)
    if (!task) return state
    const rec = task.mode === 'recurring'
      ? (task.occurrences && task.occurrences[dateStr])
      : task
    if (!rec || rec.status !== 'done') return state
    state.tasks = state.tasks.map((t) =>
      t.id === taskId ? applyTaskState(t, dateStr, { actualMinutes: m }) : t
    )
    ok = true
    return state
  })
  return ok
}

// Tasks visible on a given date.
// For today and past days: scheduled-that-day + actually-finished-that-day
//   (so a task scheduled last week but cleared today still shows on today's
//   list, and yesterday's view shows whatever was finished yesterday).
// For future days: only scheduled-that-day.
// Today additionally includes:
//   - still-open overdue one-shot tasks
//   - every past undone occurrence of every recurring task (one row per
//     missed date, surfaced together so the user can clear the backlog)
// Each returned item carries `occurrenceDate` — the date its action should
// target (so finishing a "missed Monday" row writes occurrence[Monday]).
//
// v3: 不再依赖 notebook;调度字段从 task 自身读。`cache` 参数保留兼容老 caller,
// 实际不再使用 —— 没有可重用的索引。
function tasksForDate(state, dateStr, cache) {  // eslint-disable-line no-unused-vars
  const today = todayStr()
  const isFuture = compareDateStr(dateStr, today) > 0
  const isToday = dateStr === today
  const isPast = compareDateStr(dateStr, today) < 0

  // 同一个 occurrence(task,occurrenceDate)在一次 tasksForDate 里只能塞一次 ——
  // 一次性 task 在历史视图既走 onSchedule 又走 completedOnDate 时会撞,
  // 用这个 set 兜底去重。
  const seen = new Set()
  const items = []
  const pushItem = (it) => {
    const k = `${it.task.id}__${it.occurrenceDate}`
    if (seen.has(k)) return
    seen.add(k)
    items.push(it)
  }

  for (const task of state.tasks) {
    let onSchedule = false
    let isOverdue = false
    let completedOnDate = false
    let isMakeup = false

    // occurrenceDate 的语义是"这个 row 归属哪一天"。一次性 task 一律归
    // effectiveDueDate(task),这样 finishTask 拿到的 day 就是 task 自己的 due,
    // perTaskReward / perfectDays 都按 task 级日期走。recurring task 则归
    // 当前 dateStr(每天独立 occurrence)。
    let oneShotDue = null

    if (task.mode !== 'recurring') {
      oneShotDue = effectiveDueDate(task)
      const status = task.status || 'todo'
      const completedDay = (status === 'done' && task.completedAt)
        ? dateToStr(new Date(task.completedAt)) : null

      // 一次性 task 显示策略,按 completedDay 和 oneShotDue 关系分三档:
      //
      //   1) 未 done                → 按归属日(oneShotDue)单显;过期未做的
      //                              在 today 视图额外标 isOverdue(红色)
      //   2) done + completedDay > oneShotDue (漏做后来补)
      //                              → 归属日 + 完成日双显,归属日红、完成日黄
      //   3) done + completedDay <= oneShotDue (准时 / 提前完成)
      //                              → 仅 dueDate(oneShotDue)单显(白底)
      //
      // 跨两天作业本 5.16 提前完成的 case 走 3:5.17 (dueDate) 显示,5.16 不再
      // 重复。Tim 的语义是"一次性 task 永远展示在它的 dueDate 那天",哪天做
      // 的不影响"挂在哪天"。
      if (status === 'done' && completedDay) {
        const cmp = oneShotDue ? compareDateStr(completedDay, oneShotDue) : 0
        if (cmp > 0) {
          // 漏做:双显
          if (!isFuture && dateStr === oneShotDue) {
            onSchedule = true
            if (isPast) isOverdue = true
          }
          if (!isFuture && dateStr === completedDay) {
            completedOnDate = true
            isMakeup = true
          }
        } else {
          // 准时 / 提前:仅在 dueDate 那天显示(包括 future dueDate)
          if (oneShotDue && dateStr === oneShotDue) {
            onSchedule = true
          }
        }
      } else {
        // 未 done:归属日显示
        onSchedule = !!oneShotDue && oneShotDue === dateStr
        // Overdue: still-open one-shot whose own due date already passed. Today only.
        if (!onSchedule && isToday && oneShotDue &&
            compareDateStr(oneShotDue, today) < 0) {
          isOverdue = true
        }
      }
    } else {
      onSchedule = isTaskActiveOn(task, dateStr)
      // 历史视图:recurring 在本日 active,occurrence 已 done 但 completedAt
      // 不在本日 → 同上,红底但仍在已完成区。
      if (isPast && onSchedule) {
        const occ = (task.occurrences || {})[dateStr]
        if (occ && occ.status === 'done' && occ.completedAt) {
          const completedDay = dateToStr(new Date(occ.completedAt))
          if (completedDay !== dateStr) {
            isOverdue = true
          }
        }
      }
    }

    if (!onSchedule && !isOverdue && !completedOnDate) continue
    const occ = getTaskState(task, dateStr)
    pushItem({
      task,
      occurrence: occ,
      occurrenceDate: task.mode === 'recurring' ? dateStr : (oneShotDue || dateStr),
      isOverdue,
      isMakeup
    })
  }

  // Today view: surface past recurring occurrences that are either still
  // not done (red) OR were finished today (so a freshly-cleared backlog
  // item still appears, this time in the done section, marked as makeup).
  if (isToday) {
    for (const task of state.tasks) {
      if (task.mode !== 'recurring' || !task.startDate) continue
      const activeDates = []
      let d = task.startDate
      while (compareDateStr(d, today) < 0) {
        if (isTaskActiveOn(task, d)) activeDates.push(d)
        d = addDays(d, 1)
      }
      const occMap = task.occurrences || {}
      for (const ad of activeDates) {
        const raw = occMap[ad]
        const status = raw && raw.status ? raw.status : 'todo'
        if (status !== 'done') {
          pushItem({
            task,
            occurrence: { ...defaultOccurrence(), ...(raw || {}) },
            occurrenceDate: ad,
            isOverdue: true,
            isMakeup: false
          })
        } else if (raw && raw.completedAt &&
                   dateToStr(new Date(raw.completedAt)) === today) {
          pushItem({
            task,
            occurrence: { ...defaultOccurrence(), ...raw },
            occurrenceDate: ad,
            isOverdue: false,
            isMakeup: true
          })
        }
      }
    }
  }

  return items
}

// Calendar-specific aggregator: returns per-date counts for a single month
// without invoking tasksForDate per day. Iterates state.tasks ONCE and
// buckets contributions into the right cell. The result mirrors the
// counts that buildMonthGrid would compute by calling tasksForDate for
// each day.
//   counts[dateStr] = { total, done, hasOverdue }
// Only dates that have at least one task contribution are populated;
// callers should treat missing entries as { total: 0, done: 0, hasOverdue: false }.
function dateCountsForMonth(state, year, monthIdx0) {
  const today = todayStr()
  const monthPrefix = `${year}-${pad2(monthIdx0 + 1)}`
  const lastDay = new Date(year, monthIdx0 + 1, 0).getDate()
  const monthFirst = `${monthPrefix}-01`
  const monthLast = `${monthPrefix}-${pad2(lastDay)}`
  const todayInMonth = compareDateStr(today, monthFirst) >= 0 &&
                       compareDateStr(today, monthLast) <= 0

  const counts = {}
  const ensure = (d) => counts[d] || (counts[d] = { total: 0, done: 0, hasOverdue: false })

  for (const t of state.tasks) {
    if (t.mode !== 'recurring') {
      // 一次性 task: 按自己的 effectiveDueDate 决定显示日。
      const due = effectiveDueDate(t)
      if (!due) continue
      const dueInMonth = compareDateStr(due, monthFirst) >= 0 &&
                        compareDateStr(due, monthLast) <= 0
      const dueIsPast = compareDateStr(due, today) < 0
      const status = t.status || 'todo'
      const isDone = status === 'done'

      if (dueInMonth) {
        const c = ensure(due)
        c.total++
        if (isDone) c.done++
      }

      if (isDone && t.completedAt) {
        const cdate = dateToStr(new Date(t.completedAt))
        if (cdate !== due &&
            compareDateStr(cdate, today) <= 0 &&
            compareDateStr(cdate, monthFirst) >= 0 &&
            compareDateStr(cdate, monthLast) <= 0) {
          const c = ensure(cdate)
          c.total++
          c.done++
        }
      }

      if (todayInMonth && dueIsPast && !isDone) {
        const c = ensure(today)
        c.total++
        c.hasOverdue = true
      }
    } else {
      // recurring: 用 task 自身 startDate / endDate / recurrence。
      if (!t.startDate) continue

      const walkStart = compareDateStr(t.startDate, monthFirst) >= 0 ? t.startDate : monthFirst
      const walkEnd = t.endDate && compareDateStr(t.endDate, monthLast) < 0 ? t.endDate : monthLast
      const monthActive = []
      if (compareDateStr(walkStart, walkEnd) <= 0) {
        let d = walkStart
        while (compareDateStr(d, walkEnd) <= 0) {
          if (isTaskActiveOn(t, d)) monthActive.push(d)
          d = addDays(d, 1)
        }
      }

      let backlogActive = null
      if (todayInMonth) {
        backlogActive = []
        let d = t.startDate
        while (compareDateStr(d, today) < 0) {
          if (isTaskActiveOn(t, d)) backlogActive.push(d)
          d = addDays(d, 1)
        }
      }

      const occMap = t.occurrences || {}

      for (let i = 0; i < monthActive.length; i++) {
        const ad = monthActive[i]
        const occ = occMap[ad]
        const c = ensure(ad)
        c.total++
        if (occ && occ.status === 'done') c.done++
      }

      if (backlogActive) {
        const todayCell = ensure(today)
        for (let i = 0; i < backlogActive.length; i++) {
          const ad = backlogActive[i]
          const occ = occMap[ad]
          const status = (occ && occ.status) ? occ.status : 'todo'
          if (status !== 'done') {
            todayCell.total++
            todayCell.hasOverdue = true
          } else if (occ && occ.completedAt &&
                     dateToStr(new Date(occ.completedAt)) === today) {
            todayCell.total++
            todayCell.done++
          }
        }
      }
    }
  }

  return counts
}

// === Compute helpers === //

// Returns the current state. Shallow-copied so callers can't mutate the
// cache by reassigning top-level keys, but `notebooks`/`tasks` arrays are
// aliased — readers must not mutate them in place.
function getStateWithComputed() {
  const state = loadState()
  return { ...state, pet: petWithDecay(state.pet) }
}

// Throttle the read-only toast — updateState gets called many times per
// drag/tick, we don't want a toast cascade.
let _lastReadOnlyToastAt = 0
function maybeToastReadOnly() {
  const now = Date.now()
  if (now - _lastReadOnlyToastAt < 4000) return
  _lastReadOnlyToastAt = now
  wx.showToast({ title: i18n.t('store_readonly_toast'), icon: 'none', duration: 1800 })
}

function updateState(updater) {
  if (cloudSync.isReadOnly()) {
    maybeToastReadOnly()
    return { ...loadState() }
  }
  const state = loadState()
  const next = updater(clone(state))
  next.updatedAt = Date.now()
  saveState(next)
  return { ...next }
}

// === Client-truth coin model === //
//
// 客户端 = truth。每次 coin 变更走 applyCoinDelta:直接改 state.coins +
// append 一条 coinLogs 审计条目。saveState 整包 push 上云(coinLogs 在
// SYNC_FIELDS 里)。没有"待上报队列",没有"服务端账本",也没有 server
// 返 newBalance 这件事。
//
// 服务端的 shareReward / adminPanel 云函数只把 inbox items 推回给 client,
// client 自己 applyCoinDelta 入账。

function genEventId() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

// In-updater coin mutation. Caller must be inside `updateState((state) => {...})`.
// kind: 'task_reward' | 'task_refund' | 'pet_purchase' | 'pet_skin_switch'
//       | 'share_reward' | 'admin_adjust'
// delta: signed integer.
// meta:  optional debug context for the ledger entry (taskId, itemId, etc.).
// 返回写入的 eventId(no-op 时返 null) —— finishTask 用来 stamp 到
// bonusByDay[day].ledgerEventId,后续 revokePerfectDay 凭它判定那次入账
// 真的发生过、可以放心退款。
function applyCoinDelta(state, kind, delta, meta) {
  if (!delta) return null
  const d = Math.trunc(Number(delta) || 0)
  if (!d) return null
  const before = state.coins || 0
  // task_refund(完美日撤销 / task_revert)允许把余额拍负,用户欠的钱后续
  // task_reward 先补债再正向累计。spending 路径(buyItem / levelUpPet /
  // switchPetSpecies / renamePet)在 caller 端各自 guard state.coins < cost,
  // 不会从这里走出负值。
  state.coins = before + d
  const after = state.coins
  const eventId = genEventId()
  const ts = Date.now()
  if (!Array.isArray(state.coinLogs)) state.coinLogs = []
  state.coinLogs.push({
    eventId, kind, delta: d, balanceBefore: before, balanceAfter: after,
    ts, meta: meta || null
  })
  // Prune 防 cloud doc 撑爆。
  if (state.coinLogs.length > COIN_LOG_KEEP) {
    state.coinLogs = state.coinLogs.slice(state.coinLogs.length - COIN_LOG_KEEP)
  }
  return eventId
}

// XP 累计走 commitPetDecay(挂机积分),消费走 levelUpPet(扣 pet.xp 直写)。
// 不再需要 applyPetXpDelta 这种通用 helper。

// === Notebook CRUD === //

function genId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

// v3: notebook 概念已删除。addNotebook / updateNotebook / deleteNotebook /
// duplicateNotebook / setEditNotebookId / clearEditNotebookId / getNotebookById /
// findNotebookByName 全部移除 —— 调用方应直接管理 task。

// Finished-task history lookup. Walks both one-shot tasks (top-level
// status/actualMinutes) and recurring per-occurrence completions. Returns
// `{ actualMinutes, completedAt, subject, content }` rows so callers can
// time-weight or filter further. Pass an optional subject to require an
// exact subject match in addition to the name match.
function findFinishedTasksByName(name, subject) {
  const target = (name || '').trim()
  if (!target) return []
  const state = loadState()
  const out = []
  for (const t of state.tasks) {
    if ((t.content || '').trim() !== target) continue
    if (subject && t.subject !== subject) continue
    if (t.status === 'done' && t.completedAt && t.actualMinutes) {
      out.push({
        content: t.content,
        subject: t.subject,
        actualMinutes: t.actualMinutes,
        completedAt: t.completedAt
      })
    }
    const occs = t.occurrences || {}
    for (const d in occs) {
      const occ = occs[d]
      if (occ && occ.status === 'done' && occ.completedAt && occ.actualMinutes) {
        out.push({
          content: t.content,
          subject: t.subject,
          actualMinutes: occ.actualMinutes,
          completedAt: occ.completedAt
        })
      }
    }
  }
  return out
}

// Walk all done tasks (one-shot top-level + per-occurrence) with the same
// trimmed content and tally subjects. Returns the most-frequent subject
// when it strictly beats every other subject. A tie at the top — even by
// 1 — falls back to null so the user is asked to pick instead of being
// overridden by a noisy guess.
//   {subject, confidence}  — confidence = the winning subject's count
//   null                   — no history, or a tie at the top
function inferSubjectByName(name) {
  const target = (name || '').trim()
  if (!target) return null
  const state = loadState()
  const counts = {}
  function bump(s) {
    if (!s) return
    counts[s] = (counts[s] || 0) + 1
  }
  for (const t of state.tasks) {
    if ((t.content || '').trim() !== target) continue
    if (t.status === 'done' && t.completedAt) bump(t.subject)
    const occs = t.occurrences || {}
    for (const d in occs) {
      const occ = occs[d]
      if (occ && occ.status === 'done' && occ.completedAt) bump(t.subject)
    }
  }
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1])
  if (ranked.length === 0) return null
  if (ranked.length === 1) return { subject: ranked[0][0], confidence: ranked[0][1] }
  if (ranked[0][1] > ranked[1][1]) {
    return { subject: ranked[0][0], confidence: ranked[0][1] }
  }
  return null
}

// Time-weighted estimate: exponential decay with TAU = 7 days. Recent
// finishes weigh dramatically more than older ones. Requires ≥2 samples;
// otherwise returns null so the caller leaves the field empty. Result is
// rounded to the nearest 5 minutes (with a 5-minute floor) so the UI
// doesn't show "17.4 分钟".
const ESTIMATE_TAU_MS = 7 * 86400 * 1000
function estimateTaskMinutes(taskName, subject) {
  const samples = findFinishedTasksByName(taskName, subject)
  if (samples.length < 2) return null
  const now = Date.now()
  let totalW = 0
  let weightedSum = 0
  for (const s of samples) {
    const dt = Math.max(0, now - s.completedAt)
    const w = Math.exp(-dt / ESTIMATE_TAU_MS)
    totalW += w
    weightedSum += w * s.actualMinutes
  }
  if (totalW <= 0) return null
  const raw = weightedSum / totalW
  const rounded = Math.round(raw / 5) * 5
  return Math.max(5, rounded)
}

// === Task CRUD === //

// 标准化 organization:trim + 长度卡 — 任意非空字符串都保留(不再做枚举校验,
// 因为用户在我 Tab 自定义标签)。空/非法回退默认。截断 ORGANIZATION_MAX_LEN 避免
// share import 灌脏数据撑爆 chip 渲染。
function normalizeOrganization(v) {
  if (typeof v !== 'string') return DEFAULT_ORGANIZATION
  const s = v.trim()
  if (!s) return DEFAULT_ORGANIZATION
  return s.length > ORGANIZATION_MAX_LEN ? s.slice(0, ORGANIZATION_MAX_LEN) : s
}

// v3: 标准化 mode + 配套字段(startDate/endDate/recurrence)。
function normalizeScheduling(payload) {
  const today = todayStr()
  const mode = payload.mode === 'recurring' ? 'recurring' : 'one-shot'
  const startDate = payload.startDate || today
  const endDate = payload.endDate === undefined
    ? (mode === 'recurring' ? null : startDate)
    : payload.endDate
  const recurrence = mode === 'recurring'
    ? (payload.recurrence && payload.recurrence.type
        ? { type: payload.recurrence.type === 'weekly' ? 'weekly' : 'daily',
            weekdays: Array.isArray(payload.recurrence.weekdays)
              ? payload.recurrence.weekdays.filter((w) => Number.isInteger(w) && w >= 1 && w <= 7)
              : [] }
        : { type: 'daily', weekdays: [] })
    : null
  return { mode, startDate, endDate, recurrence }
}

// 一次性 task 落到哪天:优先 task.dueDate,缺失时退化到 task.endDate / startDate;
// 超出 task 范围(用户后来把 endDate 往前缩了)就钳到边界。
// recurring task 没有"截止日"概念 — 返回 null。
function effectiveDueDate(task) {
  if (!task || task.mode === 'recurring') return null
  const fallback = task.endDate || task.startDate
  let due = task.dueDate || fallback
  if (!due) return null
  if (task.startDate && due < task.startDate) due = task.startDate
  if (task.endDate && due > task.endDate) due = task.endDate
  return due
}

// v3 addTask: payload 直接带全字段(mode / startDate / endDate / recurrence /
// organization / subject / content / estimatedMinutes / dueDate)。
// 旧 caller(OCR 导入等)不传 mode/dates → 兜底 one-shot/today,行为兼容。
function addTask(payload) {
  let newTaskId = null
  updateState((state) => {
    const { mode, startDate, endDate, recurrence } = normalizeScheduling(payload || {})
    const maxOrder = state.tasks.reduce((m, t) => Math.max(m, t.order || 0), -1)
    const base = {
      id: genId('tk'),
      subject: payload.subject || '其他',
      organization: normalizeOrganization(payload.organization),
      content: payload.content || '',
      estimatedMinutes: Number(payload.estimatedMinutes || 0),
      // dueDate 仅对 one-shot 有意义:落到该日期(默认 = endDate)。
      dueDate: payload.dueDate || null,
      mode,
      startDate,
      endDate,
      recurrence,
      order: maxOrder + 1,
      createdAt: Date.now()
    }
    if (mode === 'recurring') {
      base.occurrences = {}
    } else {
      Object.assign(base, defaultOccurrence())
    }
    state.tasks.push(base)
    newTaskId = base.id
    reconcilePerfectDays(state)
    return state
  })
  return newTaskId
}

// v3 updateTask:可改 content / subject / organization / estimatedMinutes /
// dueDate,以及调度字段 mode / startDate / endDate / recurrence。
// 跨 mode 切换会清掉对应的状态字段(one-shot↔recurring 不保留进度)。
function updateTask(taskId, updates) {
  return updateState((state) => {
    state.tasks = state.tasks.map((t) => {
      if (t.id !== taskId) return t
      const next = { ...t }
      if ('content' in updates) next.content = updates.content
      if ('subject' in updates) next.subject = updates.subject
      if ('organization' in updates) next.organization = normalizeOrganization(updates.organization)
      if ('estimatedMinutes' in updates) next.estimatedMinutes = Number(updates.estimatedMinutes || 0)
      if ('dueDate' in updates) next.dueDate = updates.dueDate || null
      if ('startDate' in updates) next.startDate = updates.startDate || t.startDate
      if ('endDate' in updates) next.endDate = updates.endDate === undefined ? t.endDate : updates.endDate
      if ('recurrence' in updates) next.recurrence = updates.recurrence
      if ('mode' in updates && updates.mode !== t.mode) {
        const sched = normalizeScheduling({ ...next, mode: updates.mode })
        next.mode = sched.mode
        next.startDate = sched.startDate
        next.endDate = sched.endDate
        next.recurrence = sched.recurrence
        // 跨 mode 重置进度。one-shot ↔ recurring 不保留 status / occurrences。
        if (next.mode === 'recurring') {
          delete next.status
          delete next.startedAt
          delete next.currentSegmentStartedAt
          delete next.accumulatedMs
          delete next.completedAt
          delete next.actualMinutes
          delete next.rewardPaid
          delete next.rewardKind
          next.occurrences = {}
        } else {
          delete next.occurrences
          Object.assign(next, defaultOccurrence())
        }
      } else if ('mode' in updates && updates.mode === 'recurring') {
        // 同 mode 但更新 recurrence/dates
        const sched = normalizeScheduling({ ...next, mode: 'recurring' })
        next.recurrence = sched.recurrence
      }
      return next
    })
    reconcilePerfectDays(state)
    return state
  })
}

function deleteTask(taskId) {
  return updateState((state) => {
    state.tasks = state.tasks.filter((t) => t.id !== taskId)
    return state
  })
}

// v3 detach: 把 recurring task 的某个 date 实例拆成独立 one-shot task。
// - 新 task 继承 content / subject / organization / estimatedMinutes
// - occurrence[date] 的 status / accumulatedMs / completedAt / rewardPaid 等
//   完整搬到新 task 顶层(已 done 的实例 detach 后还是 done,不重发奖励)
// - 原 task.excludedDates 加入 date(isTaskActiveOn 跳过该日期)
// - 原 task.occurrences[date] 删除(防止统计/UI 残影)
// 返回新 task id;入参 task 不是 recurring 或者已被 excluded 则返回 null。
function detachOccurrence(taskId, date) {
  if (!taskId || !date) return null
  let newId = null
  updateState((state) => {
    const src = state.tasks.find((t) => t.id === taskId)
    if (!src || src.mode !== 'recurring') return state
    const excluded = Array.isArray(src.excludedDates) ? src.excludedDates : []
    if (excluded.indexOf(date) >= 0) return state
    const occ = (src.occurrences || {})[date] || defaultOccurrence()
    const maxOrder = state.tasks.reduce((m, t) => Math.max(m, t.order || 0), -1)
    const detached = {
      id: genId('tk'),
      subject: src.subject || '其他',
      organization: normalizeOrganization(src.organization),
      content: src.content || '',
      estimatedMinutes: Number(src.estimatedMinutes) || 0,
      dueDate: null,
      mode: 'one-shot',
      startDate: date,
      endDate: date,
      recurrence: null,
      excludedDates: [],
      order: maxOrder + 1,
      createdAt: Date.now(),
      // occurrence 顶层化
      status: occ.status || 'todo',
      startedAt: occ.startedAt || null,
      currentSegmentStartedAt: occ.currentSegmentStartedAt || null,
      accumulatedMs: occ.accumulatedMs || 0,
      completedAt: occ.completedAt || null,
      actualMinutes: occ.actualMinutes || null,
      rewardPaid: occ.rewardPaid != null ? occ.rewardPaid : null,
      rewardKind: occ.rewardKind || null,
      // 标记从哪里 detach 出来的,方便审计 / 后续"重新合并回 recurring"功能。
      detachedFrom: src.id,
      detachedDate: date
    }
    state.tasks.push(detached)
    // 原 recurring task 加 excludedDates,清掉 occurrences[date]。
    state.tasks = state.tasks.map((t) => {
      if (t.id !== taskId) return t
      const nextExcluded = excluded.indexOf(date) >= 0 ? excluded.slice() : excluded.concat([date])
      const nextOccurrences = { ...(t.occurrences || {}) }
      delete nextOccurrences[date]
      return { ...t, excludedDates: nextExcluded, occurrences: nextOccurrences }
    })
    newId = detached.id
    return state
  })
  return newId
}

// v3 exclude: 把 recurring task 的某个 date 实例标记为"删除此次",
// 不新建任何 task。原 occurrence 数据丢弃(包括已 done 的 reward 不撤销 ——
// 走单独的 revertTask 路径)。
function excludeOccurrence(taskId, date) {
  if (!taskId || !date) return false
  let ok = false
  updateState((state) => {
    const src = state.tasks.find((t) => t.id === taskId)
    if (!src || src.mode !== 'recurring') return state
    const excluded = Array.isArray(src.excludedDates) ? src.excludedDates : []
    state.tasks = state.tasks.map((t) => {
      if (t.id !== taskId) return t
      const nextExcluded = excluded.indexOf(date) >= 0 ? excluded.slice() : excluded.concat([date])
      const nextOccurrences = { ...(t.occurrences || {}) }
      delete nextOccurrences[date]
      return { ...t, excludedDates: nextExcluded, occurrences: nextOccurrences }
    })
    ok = true
    // 删除 occurrence 后, 这天如果原本是 perfect day, 现在 task 数变少了
    // 也可能仍然 perfect(全 done) — reconcile 一遍保证账本一致。
    reconcilePerfectDays(state)
    return state
  })
  return ok
}

// v3: reorderTasksInNotebook 已删除(notebook 概念消失)。pages 直接用 reorderTasks
// 改全局 order。

// Rewrite the global `order` field for the listed tasks (in given sequence),
// leaving all other tasks' orders untouched. Used by the home page when the
// user drags across rows.
function reorderTasks(orderedIds) {
  return updateState((state) => {
    const idToOrder = new Map()
    orderedIds.forEach((id, i) => idToOrder.set(id, i))
    state.tasks = state.tasks.map((t) => {
      if (!idToOrder.has(t.id)) return t
      return { ...t, order: idToOrder.get(t.id) }
    })
    return state
  })
}

// Reorder rows in the home today list — each row is identified by
// (taskId, occurrenceDate). For one-shot tasks, the rowOrder lands on
// task.order. For recurring tasks, the rowOrder lands on
// occurrence[date].order so two virtual rows of the same recurring task
// can be ordered independently.
function reorderRows(rows) {
  return updateState((state) => {
    const assignments = new Map()  // taskId → array of {date, order}
    rows.forEach((r, i) => {
      if (!r || !r.taskId) return
      const list = assignments.get(r.taskId) || []
      list.push({ date: r.occurrenceDate || '', order: i })
      assignments.set(r.taskId, list)
    })
    state.tasks = state.tasks.map((t) => {
      const list = assignments.get(t.id)
      if (!list) return t
      if (t.mode !== 'recurring') {
        // Use the LAST assignment (one-shot has only one logical row)
        return { ...t, order: list[list.length - 1].order }
      }
      // Recurring: each match writes to its occurrence
      const occurrences = { ...(t.occurrences || {}) }
      for (const a of list) {
        if (!a.date) continue
        occurrences[a.date] = { ...defaultOccurrence(), ...occurrences[a.date], order: a.order }
      }
      return { ...t, occurrences }
    })
    return state
  })
}

// Read the effective row order for a (task, date) pair — recurring per-
// occurrence override beats the task-level default.
function getRowOrder(task, dateStr) {
  if (!task || task.mode !== 'recurring') return (task && task.order) || 0
  const occ = (task.occurrences || {})[dateStr]
  if (occ && typeof occ.order === 'number') return occ.order
  return task.order || 0
}

function setEditTaskId(taskId) {
  return updateState((state) => { state.editTaskId = taskId; return state })
}

function clearEditTaskId() {
  return updateState((state) => { state.editTaskId = null; return state })
}

// === Task control (per-date) === //

function pauseInPlace(occ, now) {
  if (occ.status !== 'doing') return occ
  const segMs = occ.currentSegmentStartedAt ? Math.max(0, now - occ.currentSegmentStartedAt) : 0
  return {
    ...occ,
    status: 'paused',
    accumulatedMs: (occ.accumulatedMs || 0) + segMs,
    currentSegmentStartedAt: null,
    events: appendEvent(occ.events, 'pause', now)
  }
}

// Pause every other doing task across the whole state — only one task may
// be running at a time, regardless of date or mode. The except (taskId,
// dateStr) pair preserves the row the user just (re)started.
function pauseAllOtherDoing(state, exceptTaskId, exceptDateStr, now) {
  state.tasks = state.tasks.map((t) => {
    if (t.mode !== 'recurring') {
      if (t.id === exceptTaskId) return t
      if ((t.status || 'todo') !== 'doing') return t
      return { ...t, ...pauseInPlace(t, now) }
    }
    // recurring: pause any doing occurrence. Skip the (taskId, dateStr)
    // pair the caller asked to preserve, and any task without occurrences.
    const occurrences = t.occurrences
    if (!occurrences) return t
    let changed = false
    let next = null
    for (const d of Object.keys(occurrences)) {
      const occ = occurrences[d]
      if (!occ || occ.status !== 'doing') continue
      if (t.id === exceptTaskId && d === exceptDateStr) continue
      if (!next) next = { ...occurrences }
      next[d] = pauseInPlace(occ, now)
      changed = true
    }
    if (!changed) return t
    return { ...t, occurrences: next }
  })
}

function startTask(taskId, dateStr) {
  const day = dateStr || todayStr()
  return updateState((state) => {
    const now = Date.now()
    pauseAllOtherDoing(state, taskId, day, now)
    const task = state.tasks.find((t) => t.id === taskId)
    if (!task) return state
    const cur = getTaskState(task, day)
    const patch = {
      status: 'doing',
      startedAt: cur.startedAt || now,
      currentSegmentStartedAt: now,
      accumulatedMs: cur.accumulatedMs || 0,
      events: appendEvent(cur.events, 'start', now)
    }
    state.tasks = state.tasks.map((t) =>
      t.id === taskId ? applyTaskState(t, day, patch) : t
    )
    return state
  })
}

function pauseTask(taskId, dateStr) {
  const day = dateStr || todayStr()
  return updateState((state) => {
    const now = Date.now()
    const task = state.tasks.find((t) => t.id === taskId)
    if (!task) return state
    const cur = getTaskState(task, day)
    state.tasks = state.tasks.map((t) =>
      t.id === taskId ? applyTaskState(t, day, pauseInPlace(cur, now)) : t
    )
    return state
  })
}

function resumeTask(taskId, dateStr) {
  const day = dateStr || todayStr()
  return updateState((state) => {
    const now = Date.now()
    pauseAllOtherDoing(state, taskId, day, now)
    const task = state.tasks.find((t) => t.id === taskId)
    if (!task) return state
    const cur = getTaskState(task, day)
    if (cur.status !== 'paused') return state
    const patch = {
      status: 'doing',
      currentSegmentStartedAt: now,
      events: appendEvent(cur.events, 'resume', now)
    }
    state.tasks = state.tasks.map((t) =>
      t.id === taskId ? applyTaskState(t, day, patch) : t
    )
    return state
  })
}

// Recompute streakDays from perfectDays: count the trailing run of
// consecutive calendar days ending at the latest entry. perfectDays itself
// is pruned to 14 days, so this caps at the same horizon — long-running
// streaks beyond that are bounded by the pruning, not by this walk.
function recomputeStreak(perfectDays) {
  if (!Array.isArray(perfectDays) || perfectDays.length === 0) return 0
  const sorted = perfectDays.slice().sort()
  let count = 1
  let cursor = sorted[sorted.length - 1]
  for (let i = sorted.length - 2; i >= 0; i--) {
    if (sorted[i] === addDays(cursor, -1)) {
      count++
      cursor = sorted[i]
    } else {
      break
    }
  }
  return count
}

// Claw back the daily bonus (and weekly bonus if any) recorded for `day`,
// recompute streakDays from the remaining perfectDays, and remove `day` from
// perfectDays. No-op if the day wasn't perfect or has no bonus log. The
// claw-back goes through applyCoinDelta so the server ledger sees a
// 'task_refund' event. 用户已经把奖励花掉的话余额会被拍负(欠债),
// 后续 task_reward 先补债。Used by revertTask (a finished task got
// un-done) and reconcilePerfectDays (a newly added task broke an
// all-done day).
//
// 注意:历史上这里用 `log.prevStreakDays` 做快照恢复,只对"revert 最近一天"
// 是对的。如果用户回去 revert 一个更早的 perfect 日,streak 应该按
// 剩下的 perfectDays 重算,而不是回到那一天被记进 streak 时的值。
// 已知遗留 corner case: revokePerfectDay 不级联回收下游已发的 weeklyBonus
// (e.g. revert day 1 → day 7 的 +100 应该作废但代码不动它)。改起来要重扫
// perfectDays 找所有 ≡ 0 mod 7 的 streak 命中点,scope 大,暂记 TODO。
function revokePerfectDay(state, day) {
  if (!Array.isArray(state.perfectDays) || !state.perfectDays.includes(day)) return
  const log = state.bonusByDay && state.bonusByDay[day]
  if (log) {
    const totalBonus = (log.dailyBonus || 0) + (log.weeklyBonus || 0)
    // 守卫:只有 bonusByDay[day] 带 ledgerEventId(代表 finishTask 入账
    // 真的走过 applyCoinDelta → coinLogs/pending)才发 task_refund。
    // 老路径残留(ledger 上线前 cloud-sync 直接覆写 coins,bonusByDay
    // 跟着 sync 上去但没进 ledger)或 flush 丢失的虚账,没标记,只清
    // bonusByDay 不退款 —— 否则就是 over-clawback(从根本没收过的钱
    // 里扣回去)。张天晴一案净流出 -130 但没看到任何对应 reward,就是
    // 这个 bug 造成的。
    if (totalBonus > 0 && log.ledgerEventId) {
      applyCoinDelta(state, 'task_refund', -totalBonus, {
        day, reason: 'perfect_day_clawback', refundOf: log.ledgerEventId
      })
    } else if (totalBonus > 0) {
      // 记一条 audit-only 的事件到 coinLogs(不动 coins,不入 pending),
      // 事后能看到"想 revoke 但没对应入账,跳过"的痕迹。
      if (!Array.isArray(state.coinLogs)) state.coinLogs = []
      state.coinLogs.push({
        eventId: genEventId(),
        kind: 'perfect_day_clawback_skipped',
        delta: 0, balanceBefore: state.coins || 0, balanceAfter: state.coins || 0,
        ts: Date.now(),
        meta: { day, reason: 'no_ledger_event_id', wouldRefund: -totalBonus }
      })
      if (state.coinLogs.length > COIN_LOG_KEEP) {
        state.coinLogs = state.coinLogs.slice(state.coinLogs.length - COIN_LOG_KEEP)
      }
    }
    delete state.bonusByDay[day]
  }
  state.perfectDays = state.perfectDays.filter((d) => d !== day)
  state.streakDays = recomputeStreak(state.perfectDays)
}

// After tasks are added (addTask / importSharedNotebook), any previously
// perfect day that now has an undone occurrence is no longer perfect.
// Revoke the bonus for each such day; finishTask will re-credit fresh
// (with the now-larger task base) when the user clears the day again.
// This blocks the "add 1 trivial task → grab early-bird bonus → add the
// real homework" exploit. Walks newest-first so multi-day streak
// snapshots unwind in the right order.
// 列出"归属"某日的所有 task(无视视图过滤,不管在哪天完成)。perfect-day
// 判定 / baseBonus 求和等业务逻辑要用这个,而不是 tasksForDate(它是给"显
// 示"用的,会把"提前完成"挪到完成日单显)。
//
// 返回 [{ task, occurrence }],一次性 task occurrence 从 task 顶层读,
// recurring 从 task.occurrences[date] 读。
function tasksScheduledOn(state, dateStr) {
  const out = []
  for (const t of state.tasks) {
    if (t.mode === 'recurring') {
      if (!isTaskActiveOn(t, dateStr)) continue
      out.push({ task: t, occurrence: getTaskState(t, dateStr) })
    } else {
      if (effectiveDueDate(t) !== dateStr) continue
      out.push({ task: t, occurrence: getTaskState(t, dateStr) })
    }
  }
  return out
}

function reconcilePerfectDays(state) {
  if (!Array.isArray(state.perfectDays) || state.perfectDays.length === 0) return
  const days = state.perfectDays.slice().sort().reverse()
  for (const d of days) {
    const items = tasksScheduledOn(state, d)
    const stillAllDone = items.length > 0 && items.every((it) => it.occurrence.status === 'done')
    if (!stillAllDone) revokePerfectDay(state, d)
  }
}

// Send a done task back to undone (paused) — used for "误点完成" recovery.
// Keeps accumulatedMs so the user picks up where they left off. Also claws
// back the +10 single-task reward; if reverting breaks an all-done day,
// refunds the daily bonus (and weekly bonus if any) too. 余额允许走负
// (用户已经把奖励花掉的话欠债),后续 task_reward 先补债。This anti-farms
// the finish→revert→finish loop: each cycle nets zero coins.
function revertTask(taskId, dateStr) {
  const day = dateStr || todayStr()
  let totalRefund = 0
  updateState((state) => {
    const task = state.tasks.find((t) => t.id === taskId)
    if (!task) return state
    const cur = getTaskState(task, day)
    if (cur.status !== 'done') return state

    const coinsBefore = state.coins || 0

    // Refund exactly what finishTask paid out (varies by overdue/today/future
    // and may be 0 if the 20-cap had been hit). Legacy occurrences finished
    // before rewardPaid existed are treated as having paid 10 (the old flat
    // per-task amount) so revert still claws back something reasonable.
    const refund = cur.rewardPaid != null ? cur.rewardPaid : REWARD_TASK_TODAY

    const patch = {
      status: 'paused',
      completedAt: null,
      actualMinutes: null,
      currentSegmentStartedAt: null,
      rewardPaid: null,
      rewardKind: null
    }
    state.tasks = state.tasks.map((t) =>
      t.id === taskId ? applyTaskState(t, day, patch) : t
    )

    if (refund > 0) {
      applyCoinDelta(state, 'task_refund', -refund, { taskId, day, reason: 'task_revert' })
    }
    // XP 不再跟作业挂钩 → revert 不退 XP(XP 是挂机来的,跟单题完成无关)。

    // Free up the slot in the cap counter for the wall-clock day the
    // completion happened on. cur.completedAt may be null on legacy data;
    // fall back to the task's occurrence date in that case.
    if (refund > 0 && state.completionsByDay && typeof state.completionsByDay === 'object') {
      const completionDay = cur.completedAt
        ? dateToStr(new Date(cur.completedAt))
        : day
      const n = state.completionsByDay[completionDay] || 0
      if (n > 0) state.completionsByDay[completionDay] = n - 1
    }

    revokePerfectDay(state, day)

    totalRefund = Math.max(0, coinsBefore - (state.coins || 0))
    return state
  })
  return totalRefund
}

function finishTask(taskId, dateStr) {
  const day = dateStr || todayStr()
  return updateState((state) => {
    const now = Date.now()
    const today = todayStr()
    let dailyBonus = 0
    let weeklyBonus = 0

    const task = state.tasks.find((t) => t.id === taskId)
    if (!task) return state
    const cur = getTaskState(task, day)
    // Re-finish of an already-done task (rare — UI only shows ✓ on doing) does
    // not get its happiness bump or the second perfect-day top-up.
    const wasNotDone = cur.status !== 'done'

    // Per-task reward depends on the task's occurrence date vs today (5 for
    // overdue, 10 today, 15 future). Then the 20-cap on the actual finish
    // calendar day (`today`) zeroes it out once the user has already been
    // paid for 20 finishes that day. Both the per-task amount AND the
    // daily-perfect base-per-task multiplier respect the cap.
    if (!state.completionsByDay || typeof state.completionsByDay !== 'object') state.completionsByDay = {}
    const perDayCount = state.completionsByDay[today] || 0
    const cappedOut = perDayCount >= DAILY_COMPLETION_CAP
    const tier = perTaskReward(day, today)
    const taskReward = cappedOut ? 0 : tier.amount
    const rewardKind = cappedOut ? 'capped' : tier.kind
    let reward = taskReward

    const segMs = cur.currentSegmentStartedAt ? Math.max(0, now - cur.currentSegmentStartedAt) : 0
    const totalMs = (cur.accumulatedMs || 0) + segMs

    // 把上次 commit 起累计的 stat 衰减刷到现在 — 顺便把挂机 XP 入账。
    // XP 跟作业完全脱钩(完成作业只发金币),不再在 finishTask 里发 XP。
    if (wasNotDone && state.pet && state.pet.species) {
      state.pet = commitPetDecay(state.pet)
    }

    const patch = {
      status: 'done',
      accumulatedMs: totalMs,
      completedAt: now,
      actualMinutes: Math.max(1, Math.round(totalMs / 60000)),
      currentSegmentStartedAt: null,
      rewardPaid: taskReward,
      rewardKind,
      events: appendEvent(cur.events, 'done', now)
    }
    state.tasks = state.tasks.map((t) =>
      t.id === taskId ? applyTaskState(t, day, patch) : t
    )

    if (!cappedOut) {
      state.completionsByDay[today] = perDayCount + 1
      // Prune so the map doesn't grow forever — same horizon as perfectDays.
      const cutoff = addDays(today, -14)
      for (const k of Object.keys(state.completionsByDay)) {
        if (k < cutoff) delete state.completionsByDay[k]
      }
    }

    // First all-done moment of the day → daily bonus + streak bookkeeping.
    // Re-completing after a revert doesn't double-credit because perfectDays
    // already contains the date.
    //
    // 用 tasksScheduledOn(按归属日)而不是 tasksForDate(按显示视图):
    // 一个归属 day 但提前完成于别天的 task 不会出现在 tasksForDate(state, day)
    // 视图里(单显于 completedDay),但归属意义上仍属于 day 当天 perfect 的计算。
    const dayTasks = tasksScheduledOn(state, day)
    const allDone = dayTasks.length > 0 && dayTasks.every((it) => it.occurrence.status === 'done')

    // Whether today's home view is now empty (all visible items done). When
    // `day === today` this is the same as `allDone`; when finishing a backlog
    // item from a past day, tasksForDate(state, day) sees only that single past
    // occurrence, so allDone may be true while today still has pending items.
    // Used by the home page to gate the "今日全部完成" toast so a single backlog
    // tap doesn't fire it.
    const todayViewItems = tasksForDate(state, today)
    const todayCleared = todayViewItems.length > 0 &&
      todayViewItems.every((it) => it.occurrence.status === 'done')

    // 完成某天「全部作业」→ 发当天的 perfect-day 奖。准时(当天完成)走完整逻辑;
    // 迟做(overdue,拖到之后才全做完)也补发 perfect 基础奖,但带迟做折扣:
    //   - base = 当天各题实发金币之和(迟做单题本就只 5,自带折扣)
    //   - 不发早鸟、不发周连击、不延长连续 streak(迟做不算「连续打卡」)
    // 这样「我把这天作业都做完了」总能拿到 perfect,但越拖奖越少、刷不了连击。
    if (allDone) {
      if (!Array.isArray(state.perfectDays)) state.perfectDays = []
      if (!state.perfectDays.includes(day)) {
        const onTime = tier.kind !== 'overdue'
        // Daily-perfect base = sum of rewardPaid across this day's tasks(镜像
        // 实发单题金币;超 20-cap 的题 rewardPaid=0,cap 自然传导)。
        const baseBonus = dayTasks.reduce(
          (sum, it) => sum + (it.occurrence.rewardPaid || 0),
          0
        )
        // 早鸟只给准时完成(迟做的「当天」早就过了)。
        dailyBonus = baseBonus + (onTime ? earlyBirdBonus(new Date(now)) : 0)
        reward += dailyBonus

        // Snapshot streak BEFORE any change so revertTask can restore it.
        const prevStreakDays = state.streakDays || 0

        // 连续 streak 只由准时完成驱动;迟做不动 streakDays(也不发周奖)。
        if (onTime) {
          const yesterday = addDays(day, -1)
          state.streakDays = state.perfectDays.includes(yesterday)
            ? prevStreakDays + 1
            : 1
        }

        state.perfectDays.push(day)
        // Prune to ~14 days of history — enough to span 2 weekly windows.
        const cutoff = addDays(day, -14)
        state.perfectDays = state.perfectDays.filter((d) => d >= cutoff).sort()

        if (onTime && state.streakDays > 0 && state.streakDays % 7 === 0) {
          weeklyBonus = REWARD_WEEKLY_STREAK
          reward += weeklyBonus
        }

        // Stash exact bonus paid + pre-update streak. revertTask refunds from
        // this map so the refund matches the credit. ledgerEventId 在下面
        // applyCoinDelta 后回填,revokePerfectDay 据此判断是否退款。
        if (!state.bonusByDay || typeof state.bonusByDay !== 'object') state.bonusByDay = {}
        state.bonusByDay[day] = { dailyBonus, weeklyBonus, prevStreakDays }
      }
    }

    if (reward > 0) {
      const eventId = applyCoinDelta(state, 'task_reward', reward, {
        taskId, day, rewardKind, taskReward, dailyBonus, weeklyBonus
      })
      // 只有 perfect bonus 命中(dailyBonus / weeklyBonus > 0)才需要标
      // ledgerEventId 给 revokePerfectDay 用。纯单题 reward 不会被 revoke
      // 走 perfect 路径(那走的是 task_revert 的 cur.rewardPaid)。
      if (eventId && state.bonusByDay && state.bonusByDay[day]) {
        state.bonusByDay[day].ledgerEventId = eventId
      }
    }

    state.lastReward = {
      reward,
      taskReward,
      rewardKind,
      dailyBonus,
      weeklyBonus,
      taskId,
      finishedAt: now,
      todayCleared
    }
    return state
  })
}

// === Pet shop (unchanged) === //

function buyItem(itemId) {
  return updateState((state) => {
    const item = state.shopItems.find((s) => s.id === itemId)
    if (!item || state.coins < item.price) return state
    if (!state.pet || !state.pet.species) return state
    state.pet = commitPetDecay(state.pet)
    applyCoinDelta(state, 'pet_purchase', -item.price, { itemId: item.id, itemName: item.name })
    state.pet.happiness   = Math.min((state.pet.happiness   || 0) + (item.happiness   || 0), 100)
    state.pet.fullness    = Math.min((state.pet.fullness    || 0) + (item.fullness    || 0), 100)
    state.pet.cleanliness = Math.min((state.pet.cleanliness || 0) + (item.cleanliness || 0), 100)
    state.pet.health      = Math.min((state.pet.health      || 0) + (item.health      || 0), 100)
    return state
  })
}

// 用一件家具:在冷却外回一点对应属性(免费),并记录冷却时间。
// 返回 { ok, stat, amount, value } 或 { ok:false, reason:'cooldown'|'nopet'|'unknown', remainingMs }。
function useFurnitureItem(kind) {
  const eff = FURNI_EFFECTS[kind]
  if (!eff) return { ok: false, reason: 'unknown' }
  let result = { ok: false, reason: 'unknown' }
  updateState((state) => {
    if (!state.pet || !state.pet.species) { result = { ok: false, reason: 'nopet' }; return state }
    const now = Date.now()
    const cd = (state.pet.furniAt && typeof state.pet.furniAt === 'object') ? state.pet.furniAt : {}
    const remain = FURNI_COOLDOWN_MS - (now - (Number(cd[kind]) || 0))
    if (remain > 0) { result = { ok: false, reason: 'cooldown', remainingMs: remain, stat: eff.stat }; return state }
    state.pet = commitPetDecay(state.pet)   // 先把衰减结算到当前,再在当前值上加(跟 buyItem 一致)
    const cur = Number(state.pet[eff.stat]) || 0
    const next = Math.min(100, cur + eff.amount)
    state.pet[eff.stat] = next
    state.pet.furniAt = Object.assign({}, cd, { [kind]: now })
    result = { ok: true, stat: eff.stat, amount: next - cur, value: next, cooldownMs: FURNI_COOLDOWN_MS }
    return state
  })
  return result
}

// 家具对应的属性 + 免费回多少(菜单里把「免费」做成一个价格 0 的道具展示用)。
function furnitureEffect(kind) {
  const e = FURNI_EFFECTS[kind]
  return e ? { stat: e.stat, amount: e.amount } : null
}

// 家具冷却剩余 ms(UI 提示用);0 = 可用。
function furnitureCooldownLeft(kind) {
  if (!FURNI_EFFECTS[kind]) return 0
  const pet = loadState().pet
  const cd = (pet && pet.furniAt) || {}
  return Math.max(0, FURNI_COOLDOWN_MS - (Date.now() - (Number(cd[kind]) || 0)))
}

// 手动升级:扣 getXpForLevel(level) 经验 → level += 1。溢出的 XP 留到下一级,
// 防止"卡了一会才点升级"丢经验。一次只升一级 —— 即使 xp 够升两级,也要再点一下,
// 播两次升级动画(spec 要求"手动点一下播放升级动画")。
//
// 返回值约定:
//   { ok: true, level, xp }                       — 升级成功;xp = 扣完 cost 后剩余
//   { ok: false, reason: 'no-pet' }               — 还没设置宠物
//   { ok: false, reason: 'max-level' }            — 已满级
//   { ok: false, reason: 'insufficient-xp', need, have } — XP 不够
function levelUpPet() {
  let result = null
  updateState((state) => {
    if (!state.pet || !state.pet.species) {
      result = { ok: false, reason: 'no-pet' }
      return state
    }
    const prevLevel = state.pet.level || 1
    if (prevLevel >= LEVEL_MAX) {
      result = { ok: false, reason: 'max-level' }
      return state
    }
    const cost = getXpForLevel(prevLevel)
    const xp = state.pet.xp | 0
    if (xp < cost) {
      result = { ok: false, reason: 'insufficient-xp', need: cost - xp, have: xp }
      return state
    }
    state.pet = commitPetDecay(state.pet)
    state.pet.xp = xp - cost
    state.pet.level = prevLevel + 1
    state.pet.lastLeveledAt = Date.now()
    state.lastLevelUp = { level: state.pet.level, at: Date.now() }
    result = { ok: true, level: state.pet.level, xp: state.pet.xp }
    return state
  })
  return result
}

function setupPet({ species, name }) {
  return updateState((state) => {
    const speciesEntry = PET_SPECIES.find((s) => s.id === species)
    if (!speciesEntry) return state
    const trimmed = (name || '').trim().slice(0, 12) || speciesEntry.label
    const now = Date.now()
    state.pet = {
      species,
      emoji: speciesEntry.emoji,
      name: trimmed,
      bornAt: now,
      lastDecayAt: now,
      level: 1,
      xp: 0,
      knowledge: 0,
      effort: 0,
      happiness: 100,
      fullness: 100,
      cleanliness: 100,
      health: 100
    }
    return state
  })
}

// Re-skin only: swap species/emoji on an existing pet for PET_SWITCH_COST coins.
// Stats, level, name, bornAt all preserved — the user paid for them.
function switchPetSpecies(species) {
  let result = null
  updateState((state) => {
    if (!state.pet || !state.pet.species) {
      result = { ok: false, reason: 'no-pet' }
      return state
    }
    const entry = PET_SPECIES.find((s) => s.id === species)
    if (!entry) {
      result = { ok: false, reason: 'unknown-species' }
      return state
    }
    if (state.pet.species === species) {
      result = { ok: false, reason: 'same-species' }
      return state
    }
    if ((state.coins || 0) < PET_SWITCH_COST) {
      result = { ok: false, reason: 'not-enough-coins', cost: PET_SWITCH_COST }
      return state
    }
    const fromSpecies = state.pet.species
    applyCoinDelta(state, 'pet_skin_switch', -PET_SWITCH_COST, { fromSpecies, toSpecies: species })
    state.pet = commitPetDecay(state.pet)
    state.pet.species = species
    state.pet.emoji = entry.emoji
    result = { ok: true, species, emoji: entry.emoji, label: entry.label, cost: PET_SWITCH_COST }
    return state
  })
  return result
}

// Rename: 花 PET_RENAME_COST 金币改 pet.name。属性/等级/种类/头像保留。
//   - reason='no-pet'         没设置过宠物
//   - reason='empty-name'     trim 后为空
//   - reason='name-too-long'  > PET_NAME_MAX_LEN
//   - reason='same-name'      跟当前完全一致(trim 后)
//   - reason='not-enough-coins' 余额不足
//   - ok                       扣 10 金币 + state.pet.name = trimmed
function renamePet(name) {
  let result = null
  updateState((state) => {
    if (!state.pet || !state.pet.species) {
      result = { ok: false, reason: 'no-pet' }
      return state
    }
    const trimmed = (name == null ? '' : String(name)).trim()
    if (!trimmed) {
      result = { ok: false, reason: 'empty-name' }
      return state
    }
    if (trimmed.length > PET_NAME_MAX_LEN) {
      result = { ok: false, reason: 'name-too-long', max: PET_NAME_MAX_LEN }
      return state
    }
    if (trimmed === state.pet.name) {
      result = { ok: false, reason: 'same-name' }
      return state
    }
    if ((state.coins || 0) < PET_RENAME_COST) {
      result = { ok: false, reason: 'not-enough-coins', cost: PET_RENAME_COST }
      return state
    }
    const oldName = state.pet.name
    // 走已有的 pet_purchase kind(server 已识别,不必再 deploy 云函数;
    // 客户端 coin-history 通过 meta.type=='rename' 把它显示成"改名宠物")。
    applyCoinDelta(state, 'pet_purchase', -PET_RENAME_COST,
      { type: 'rename', oldName, newName: trimmed })
    state.pet = commitPetDecay(state.pet)
    state.pet.name = trimmed
    result = { ok: true, oldName, newName: trimmed, cost: PET_RENAME_COST }
    return state
  })
  return result
}

// === OCR job (unchanged) === //

function setCurrentOcrJob(job) {
  return updateState((state) => {
    const normalized = {
      id: job.id || Date.now(),
      imagePath: job.imagePath || '',
      imageFileID: job.imageFileID || '',
      rawText: job.rawText || '',
      source: job.source || '',
      providerWarning: job.providerWarning || '',
      drafts: (job.drafts || []).map((d, i) => ({
        id: d.id || `${Date.now()}-${i}`,
        subject: d.subject || '',
        content: d.content || '',
        rawText: d.rawText || '',
        confidence: d.confidence || '中',
        needsConfirm: typeof d.needsConfirm === 'boolean' ? d.needsConfirm : true
      })),
      createdAt: job.createdAt || Date.now()
    }
    state.ocrCurrentJob = normalized
    state.ocrJobs = [normalized, ...(state.ocrJobs || []).filter((x) => x.id !== normalized.id)].slice(0, 10)
    return state
  })
}

function getCurrentOcrJob() {
  return loadState().ocrCurrentJob || null
}

function clearCurrentOcrJob() {
  return updateState((state) => { state.ocrCurrentJob = null; return state })
}

// === Profile === //

function getProfile() {
  const state = loadState()
  return state.profile || { nickname: '', avatar: '' }
}

function updateProfileNickname(nickname) {
  return updateState((state) => {
    state.profile = { ...(state.profile || {}), nickname: (nickname || '').trim() }
    return state
  })
}

function updateProfileAvatar(avatar) {
  return updateState((state) => {
    state.profile = { ...(state.profile || {}), avatar: avatar || '' }
    return state
  })
}

// === Organizations (custom tag list, edited in 我 Tab) === //

function getOrganizations() {
  const state = loadState()
  return Array.isArray(state.organizations) && state.organizations.length > 0
    ? state.organizations.slice()
    : DEFAULT_ORGANIZATIONS.slice()
}

// 新增标签。返回 { ok, reason } —— UI 据此 toast。
// reason: 'empty' | 'too_long' | 'duplicate' | 'too_many'
function addOrganization(name) {
  const raw = typeof name === 'string' ? name.trim() : ''
  if (!raw) return { ok: false, reason: 'empty' }
  if (raw.length > ORGANIZATION_MAX_LEN) return { ok: false, reason: 'too_long' }
  const cur = getOrganizations()
  if (cur.includes(raw)) return { ok: false, reason: 'duplicate' }
  if (cur.length >= ORGANIZATION_MAX_COUNT) return { ok: false, reason: 'too_many' }
  updateState((state) => {
    state.organizations = sanitizeOrganizationList(cur.concat([raw]))
    return state
  })
  return { ok: true }
}

// 删除标签。最后一个不允许删 —— 保证 picker 永远至少一个选项。
// 不级联改 task —— 已经用着该标签的 task 显示不变(以"历史值"形态保留),
// 仅影响新的 task-edit 下拉。
// reason: 'unknown' | 'last_one'
function removeOrganization(name) {
  const target = typeof name === 'string' ? name.trim() : ''
  const cur = getOrganizations()
  const idx = cur.indexOf(target)
  if (idx < 0) return { ok: false, reason: 'unknown' }
  if (cur.length <= 1) return { ok: false, reason: 'last_one' }
  updateState((state) => {
    const next = cur.slice()
    next.splice(idx, 1)
    state.organizations = sanitizeOrganizationList(next)
    return state
  })
  return { ok: true }
}

// 重命名标签 + 级联更新所有 task.organization。同名/空名/超长拒绝。
// reason: 'empty' | 'too_long' | 'duplicate' | 'unknown' | 'noop'
function renameOrganization(oldName, newName) {
  const oldTrim = typeof oldName === 'string' ? oldName.trim() : ''
  const newTrim = typeof newName === 'string' ? newName.trim() : ''
  if (!newTrim) return { ok: false, reason: 'empty' }
  if (newTrim.length > ORGANIZATION_MAX_LEN) return { ok: false, reason: 'too_long' }
  if (oldTrim === newTrim) return { ok: false, reason: 'noop' }
  const cur = getOrganizations()
  const idx = cur.indexOf(oldTrim)
  if (idx < 0) return { ok: false, reason: 'unknown' }
  if (cur.includes(newTrim)) return { ok: false, reason: 'duplicate' }
  updateState((state) => {
    const next = cur.slice()
    next[idx] = newTrim
    state.organizations = sanitizeOrganizationList(next)
    // 级联到所有引用了 oldTrim 的 task,保持显示连贯。
    state.tasks = state.tasks.map((t) => (
      t.organization === oldTrim ? { ...t, organization: newTrim } : t
    ))
    return state
  })
  return { ok: true }
}

function resetOrganizations() {
  updateState((state) => {
    state.organizations = DEFAULT_ORGANIZATIONS.slice()
    return state
  })
  return { ok: true }
}

// === Sharing === //

// Build a clean payload to embed into a WeChat share path.
// Strips per-occurrence state (status / elapsed / completedAt) — the
// receiver imports a fresh notebook with all tasks reset to "todo".
// `sharer` carries sharer's openid (when available) + a stable notebook id,
// so the receiver can credit a save back to the sharer via cloud function.
//
// 注意:不再写 `from` 字段(昵称)。原因:share URL 可能被截图、转发到群、
// 沉淀在 WeChat 服务端日志里;昵称是给孩子取的,放进 URL = PII 外流。
// 接收方落地页统一显示「好友分享给你的作业本」即可;WeChat 聊天 UI 自带
// 显示消息发件人,已经回答了"谁发的"。
// v3 分享:按日期 + 可选学科/组织过滤,序列化当日可见 task 列表。
// shareId 由调用方传入(客户端 nanoid),作为云函数 dedup key + 接收页 once-only 标记。
// `taskIds` 可选 —— 不传时序列化"当日全部",传时只取选中的 task。
// 接受两种调用方式以兼容老 caller:
//   serializeTasksForShare(dateStr, options)      // legacy: 单日,sub/org 过滤
//   serializeTasksForShare(options)               // new: 日期范围 + org 单选
// options:
//   - startDate / endDate: 日期范围 [起, 止] 闭区间。endDate 默认 = startDate(单日)
//   - organization: 单个组织名,空串 = 不过滤(全部)
//   - taskIds / subjects / organizations: legacy 多选过滤(保持兼容)
//   - sharerOpenid, shareId: 元数据
//
// 行为:
//   1) 在 [start, end] 范围内逐日 tasksForDate(state, d) 收集 item
//   2) 默认只取一次性 task — recurring 不进 payload(分享页 UI 也屏蔽)
//   3) 去重到 task.id
//   4) 按 organization / 旧 sub-org 过滤
//   5) 序列化为 v2 payload,附加 de(end date)+ org(选中标签)+ 每 task dd(displayDueDate)
function serializeTasksForShare(arg1, arg2) {
  let opts
  if (typeof arg1 === 'string' || arg1 == null) {
    opts = arg2 ? { ...arg2 } : {}
    if (arg1) opts.startDate = arg1
  } else {
    opts = arg1 || {}
  }

  const state = loadState()
  const startDate = opts.startDate || todayStr()
  const endDate = opts.endDate || startDate
  const includeRecurring = !!opts.includeRecurring  // 默认 false:一次性 only
  const sharerOpenid = opts.sharerOpenid || ''
  const shareId = opts.shareId || genId('sh')

  // 逐日收集,以 task.id 去重(同一一次性 task 在多日视图最多出 1 次)。
  const collected = []
  const seenTaskIds = new Set()
  const pushUnique = (it) => {
    if (seenTaskIds.has(it.task.id)) return
    seenTaskIds.add(it.task.id)
    collected.push(it)
  }

  // start ≤ end:逐日。start > end:直接空(空范围)。
  if (compareDateStr(startDate, endDate) <= 0) {
    let d = startDate
    let guard = 0
    while (compareDateStr(d, endDate) <= 0 && guard < 366) {
      for (const it of tasksForDate(state, d)) {
        if (!includeRecurring && it.task.mode === 'recurring') continue
        // 只要 occurrenceDate(一次性 task 即 effectiveDueDate)落在分享区间内。
        // 否则 d==today 时 tasksForDate 会带上 dueDate < startDate 的历史逾期 task。
        if (compareDateStr(it.occurrenceDate, startDate) < 0) continue
        if (compareDateStr(it.occurrenceDate, endDate) > 0) continue
        pushUnique(it)
      }
      d = addDays(d, 1)
      guard++
    }
  }

  let filtered = collected
  if (Array.isArray(opts.taskIds) && opts.taskIds.length > 0) {
    const idSet = new Set(opts.taskIds)
    filtered = filtered.filter((it) => idSet.has(it.task.id))
  }
  if (Array.isArray(opts.subjects) && opts.subjects.length > 0) {
    const set = new Set(opts.subjects)
    filtered = filtered.filter((it) => set.has(it.task.subject || '其他'))
  }
  if (typeof opts.organization === 'string' && opts.organization) {
    filtered = filtered.filter((it) => (it.task.organization || DEFAULT_ORGANIZATION) === opts.organization)
  }
  if (Array.isArray(opts.organizations) && opts.organizations.length > 0) {
    const set = new Set(opts.organizations)
    filtered = filtered.filter((it) => set.has(it.task.organization || DEFAULT_ORGANIZATION))
  }

  const tasks = filtered.map((it) => {
    const t = it.task
    const dd = t.mode === 'recurring' ? '' : (effectiveDueDate(t) || '')
    return {
      s: t.subject || '其他',
      o: t.organization || DEFAULT_ORGANIZATION,
      c: t.content || '',
      m: Number(t.estimatedMinutes) || 0,
      mo: t.mode === 'recurring' ? 'recurring' : 'one-shot',
      sd: t.startDate || startDate,
      ed: t.endDate === undefined ? null : t.endDate,
      // dd: 分享时刻的归属日,落地页用来画日期 chip。导入时 buildTaskFromShare 也会
      // 读这个字段做 dueDate 还原。
      dd,
      r: t.mode === 'recurring' ? (t.recurrence || { type: 'daily', weekdays: [] }) : null
    }
  })

  return {
    v: 2,
    sharer: sharerOpenid,
    shareId,
    d: startDate,
    de: endDate,
    org: typeof opts.organization === 'string' ? opts.organization : '',
    // 分享卡片 + 落地页通用标题。空串 = 接收方走默认 "{组织}作业({日期})"。
    title: typeof opts.title === 'string' ? opts.title.slice(0, SHARE_MAX_TITLE) : '',
    t: tasks
  }
}

// Apply share-save coins claimed from cloud. 客户端 = truth:走本地
// applyCoinDelta 入账并 append coinLogs,然后整包 push 上云。
// payload: { total, count, notebooks }
function applyShareRewardClaim({ total, count, notebooks }) {
  if (!total || total <= 0) return null
  let next = null
  updateState((state) => {
    applyCoinDelta(state, 'share_reward', total, {
      count: count || 0,
      notebooks: Array.isArray(notebooks) ? notebooks.slice(0, 5) : []
    })
    state.lastShareReward = {
      total,
      count: count || 0,
      notebooks: Array.isArray(notebooks) ? notebooks.slice(0, 5) : [],
      receivedAt: Date.now()
    }
    next = state.lastShareReward
    return state
  })
  return next
}

// Apply an admin-coin-inbox claim. 客户端 = truth:server 把 inbox items
// 推回来,这里逐条走 applyCoinDelta 入账,balanceBefore/After 自动落账。
//
// payload: { items, totalApplied?, addedTotal?, deductedTotal? }
//   items[i] = { delta, reason, adminOpenid, auditId, createdAt }
//     (老 payload 可能用 applied 字段,fallback 兼容)
function applyAdminCoinClaim({ items, totalApplied, addedTotal, deductedTotal }) {
  if (!Array.isArray(items) || items.length === 0) return null
  let summary = null
  updateState((state) => {
    const appliedItems = []
    for (const it of items) {
      const delta = typeof it.delta === 'number'
        ? it.delta
        : (typeof it.applied === 'number' ? it.applied : 0)
      if (!delta) continue
      const reason = (it.reason || '').toString()
      applyCoinDelta(state, 'admin_adjust', delta, {
        reason,
        adminOpenid: it.adminOpenid || '',
        auditId: it.auditId || '',
        adjustedAt: Number(it.createdAt) || 0
      })
      appliedItems.push({ delta, reason })
    }
    const totalAppliedFinal = typeof totalApplied === 'number'
      ? totalApplied
      : appliedItems.reduce((s, it) => s + it.delta, 0)
    state.lastAdminCoinClaim = {
      receivedAt: Date.now(),
      totalApplied: totalAppliedFinal,
      count: items.length
    }
    summary = {
      totalApplied: totalAppliedFinal,
      addedTotal: typeof addedTotal === 'number'
        ? addedTotal
        : appliedItems.reduce((s, it) => s + (it.delta > 0 ? it.delta : 0), 0),
      deductedTotal: typeof deductedTotal === 'number'
        ? deductedTotal
        : appliedItems.reduce((s, it) => s + (it.delta < 0 ? it.delta : 0), 0),
      count: items.length,
      items: appliedItems
    }
    return state
  })
  return summary
}

// v3: 从分享条目构建一个全字段 task。estimatedMinutes 缺失时按接收方历史估算。
// 调度字段(mode / startDate / endDate / recurrence)从 share 条目继承,recurring
// 任务的 startDate 钳到 ≤ 今天,避免分享方设了未来日期导致接收方看不到。
//
// dd(displayDueDate)优先用于一次性 task 的 dueDate:分享方原始的归属日(可能 ≠ ed),
// 接收方导入后保持挂在同一天。dd 缺失时退化到 endDate。
function buildTaskFromShare(item, today) {
  const mode = item.mo === 'recurring' ? 'recurring' : 'one-shot'
  let startDate = item.sd || today
  if (mode === 'recurring' && compareDateStr(startDate, today) > 0) startDate = today
  const endDate = item.ed === null
    ? null
    : (item.ed || (mode === 'one-shot' ? today : null))
  const recurrence = mode === 'recurring'
    ? (item.r && item.r.type
        ? { type: item.r.type === 'weekly' ? 'weekly' : 'daily',
            weekdays: Array.isArray(item.r.weekdays)
              ? item.r.weekdays.filter((w) => Number.isInteger(w) && w >= 1 && w <= 7)
              : [] }
        : { type: 'daily', weekdays: [] })
    : null

  const base = {
    id: genId('tk'),
    subject: item.s || '其他',
    organization: normalizeOrganization(item.o),
    content: item.c || '',
    estimatedMinutes: Number(item.m || estimateTaskMinutes(item.c, item.s) || 0),
    dueDate: mode === 'one-shot' ? (item.dd || null) : null,
    mode,
    startDate,
    endDate,
    recurrence,
    createdAt: Date.now()
  }
  if (mode === 'recurring') {
    base.occurrences = {}
  } else {
    Object.assign(base, defaultOccurrence())
  }
  return base
}

// 分享 payload 的边界。攻击者可以构造任意大 / 任意脏的链接,所以收到的
// 一切都要截断 + 类型校验。常规一天的作业不会超过几十条,200 已经很宽。
const SHARE_MAX_TASKS = 200
const SHARE_MAX_CONTENT = 500
const SHARE_MAX_SUBJECT = 16
const SHARE_MAX_ORGANIZATION = 16
const SHARE_MAX_FROM = 24
const SHARE_MAX_ID = 100
const SHARE_MAX_DATE_STR = 16
const SHARE_MAX_TASK_MINUTES = 600
// 分享标题:UI 输入框 maxlength 20,这里再多留些余量给 emoji / 多字节字符,
// 但拒绝撑过 30 个 char(payload 体积考虑)。
const SHARE_MAX_TITLE = 30

function safeShareString(s, maxLen) {
  if (typeof s !== 'string') return ''
  return s.slice(0, maxLen)
}

// 把任意来源的 share payload 规范化成 v2 schema。
// - v1 payload(老分享链接,带 .n 对象) → 在线转换为 v2 task 列表
// - v2 payload → 直接 sanitize
// - 未知字段直接丢
// - 字符串过长截断、数组过长截断、类型不对兜默认
// 没有合法 task 列表就返回 null。
function sanitizeSharePayload(payload) {
  if (!payload || typeof payload !== 'object') return null

  // v1 兼容:把整本(.n + .t)转成 v2 task 列表。.n 的 mode/dates/recurrence
  // 平移到每条 task 上,旧 task 没 organization → 默认 '其他'。
  if (payload.n && typeof payload.n === 'object') {
    const n = payload.n
    const mode = n.mode === 'recurring' ? 'recurring' : 'one-shot'
    const sd = safeShareString(n.startDate, SHARE_MAX_DATE_STR)
    const ed = n.endDate === null
      ? null
      : n.endDate === undefined
        ? undefined
        : safeShareString(n.endDate, SHARE_MAX_DATE_STR)
    const r = mode === 'recurring' && n.recurrence && typeof n.recurrence === 'object'
      ? {
          type: n.recurrence.type === 'weekly' ? 'weekly' : 'daily',
          weekdays: Array.isArray(n.recurrence.weekdays)
            ? n.recurrence.weekdays.slice(0, 7).filter((w) => Number.isInteger(w) && w >= 1 && w <= 7)
            : []
        }
      : null
    const rawTasks = Array.isArray(payload.t) ? payload.t.slice(0, SHARE_MAX_TASKS) : []
    const tasks = rawTasks.map((it) => {
      if (!it || typeof it !== 'object') return null
      const mNum = Number(it.m)
      return {
        s: safeShareString(it.s, SHARE_MAX_SUBJECT),
        o: DEFAULT_ORGANIZATION,
        c: safeShareString(it.c, SHARE_MAX_CONTENT),
        m: Number.isFinite(mNum) && mNum > 0 && mNum <= SHARE_MAX_TASK_MINUTES ? Math.trunc(mNum) : 0,
        mo: mode,
        sd,
        ed,
        dd: '',
        r
      }
    }).filter(Boolean)
    const dResolved = sd || todayStr()
    return {
      v: 2,
      from: safeShareString(payload.from, SHARE_MAX_FROM),
      sharer: safeShareString(payload.sharer, SHARE_MAX_ID),
      shareId: safeShareString(payload.nbId, SHARE_MAX_ID),  // v1 nbId 当 shareId 用
      d: dResolved,
      de: dResolved,
      org: '',
      title: '',  // v1 没有自定义标题字段
      t: tasks
    }
  }

  // v2 path
  if (!Array.isArray(payload.t)) return null
  const rawTasks = payload.t.slice(0, SHARE_MAX_TASKS)
  const tasks = rawTasks.map((it) => {
    if (!it || typeof it !== 'object') return null
    const mNum = Number(it.m)
    const mode = it.mo === 'recurring' ? 'recurring' : 'one-shot'
    const r = mode === 'recurring' && it.r && typeof it.r === 'object'
      ? {
          type: it.r.type === 'weekly' ? 'weekly' : 'daily',
          weekdays: Array.isArray(it.r.weekdays)
            ? it.r.weekdays.slice(0, 7).filter((w) => Number.isInteger(w) && w >= 1 && w <= 7)
            : []
        }
      : null
    const o = safeShareString(it.o, SHARE_MAX_ORGANIZATION)
    return {
      s: safeShareString(it.s, SHARE_MAX_SUBJECT),
      // 分享 payload 的 o 接收任意字符串(已 safeShareString 卡到 16 char,
      // buildTaskFromShare → normalizeOrganization 还会再 trim/cap 一次)。
      o: o || DEFAULT_ORGANIZATION,
      c: safeShareString(it.c, SHARE_MAX_CONTENT),
      m: Number.isFinite(mNum) && mNum > 0 && mNum <= SHARE_MAX_TASK_MINUTES ? Math.trunc(mNum) : 0,
      mo: mode,
      sd: safeShareString(it.sd, SHARE_MAX_DATE_STR),
      ed: it.ed === null ? null : (it.ed === undefined ? undefined : safeShareString(it.ed, SHARE_MAX_DATE_STR)),
      dd: safeShareString(it.dd, SHARE_MAX_DATE_STR),
      r
    }
  }).filter(Boolean)
  const dResolved = safeShareString(payload.d, SHARE_MAX_DATE_STR) || todayStr()
  return {
    v: 2,
    from: safeShareString(payload.from, SHARE_MAX_FROM),
    sharer: safeShareString(payload.sharer, SHARE_MAX_ID),
    shareId: safeShareString(payload.shareId, SHARE_MAX_ID),
    d: dResolved,
    de: safeShareString(payload.de, SHARE_MAX_DATE_STR) || dResolved,
    org: safeShareString(payload.org, SHARE_MAX_ORGANIZATION),
    title: safeShareString(payload.title, SHARE_MAX_TITLE),
    t: tasks
  }
}

// 判断两条 task 是否"算同一项"。
// 一次性:subject + content(trim) + dueDate(归属日)三者全等。
// 周期:subject + content + startDate + recurrence.type 全等(weekdays 不细比,
// 用户多半不会精确同 weekdays 又改成不同的)。空 content 不参与判重。
function _isSameTask(shareItem, existingTask) {
  const sub = shareItem.s || '其他'
  const cont = (shareItem.c || '').trim()
  if (!cont) return false
  const tSub = existingTask.subject || '其他'
  const tCont = (existingTask.content || '').trim()
  if (tSub !== sub || tCont !== cont) return false
  const shareMode = shareItem.mo === 'recurring' ? 'recurring' : 'one-shot'
  const taskMode = existingTask.mode === 'recurring' ? 'recurring' : 'one-shot'
  if (shareMode !== taskMode) return false
  if (shareMode === 'one-shot') {
    return (shareItem.dd || '') === (existingTask.dueDate || '')
  }
  const shareType = shareItem.r && shareItem.r.type === 'weekly' ? 'weekly' : 'daily'
  const taskType = existingTask.recurrence && existingTask.recurrence.type === 'weekly' ? 'weekly' : 'daily'
  if (shareType !== taskType) return false
  return (shareItem.sd || '') === (existingTask.startDate || '')
}

// 让 UI 在导入前预检重复 —— 让用户选择"替换 / 重命名 / 放弃重复 / 全部放弃"。
// 输入:任意来源的 share payload(会先 sanitize)。
// 输出:[{ shareIdx, existingTaskId, shareSubject, shareContent }, ...]
//   - shareIdx 是 sanitize 后 t[] 的下标,UI 拿到后展示给用户用。
//   - existingTaskId 用于 'replace' 模式精确删除目标。
function findShareDuplicates(payload) {
  const safe = sanitizeSharePayload(payload)
  if (!safe) return []
  const state = loadState()
  const dups = []
  for (let i = 0; i < safe.t.length; i++) {
    const it = safe.t[i]
    const exist = state.tasks.find((t) => _isSameTask(it, t))
    if (exist) {
      dups.push({
        shareIdx: i,
        existingTaskId: exist.id,
        shareSubject: it.s || '其他',
        shareContent: (it.c || '').trim()
      })
    }
  }
  return dups
}

// 重命名后缀:多次导入同一题会叠加成"X(副本)(副本)",可接受 —— 用户能区分,
// 也能从最后一次的内容看出导入了多少次。
function _renamedShareContent(content) {
  const c = (content || '').trim()
  return c ? `${c}（副本）` : '（副本）'
}

// v3 importSharedTasks: 把分享 payload 中的 task 列表追加到 state.tasks。
// options:
//   - selectedIndexes: number[]   只导入这些下标(UI 让用户勾选)。不传 = 全部。
//   - conflictMode: 'add' | 'replace' | 'rename' | 'skip'   重复处理策略:
//     - add (默认,向后兼容):不查重,全加 —— 会产生肉眼重复行,只在老路径用。
//     - replace:删掉现有 task,加新的(保留新 task 的 id;旧 task 连同
//       occurrences 一起没了)。
//     - rename:新 task 的 content 后加 "（副本）" 再加。
//     - skip:跳过 payload 里跟现有 task 重复的项,只加非重复的。
// 返回新增的 task id 数组。conflictMode='skip' 且全部重复时返回 [],
// 调用方据此判断"啥也没加"。
function importSharedTasks(payload, options) {
  // 即使调用方已经 sanitize 过,这里再做一次 —— 防止其它入口漏 sanitize。
  const safe = sanitizeSharePayload(payload)
  if (!safe) return []
  const opts = options || {}
  const sourceTasks = Array.isArray(opts.selectedIndexes) && opts.selectedIndexes.length
    ? opts.selectedIndexes.map((i) => safe.t[i]).filter(Boolean)
    : safe.t
  if (sourceTasks.length === 0) return []
  const conflictMode = ['add', 'replace', 'rename', 'skip'].includes(opts.conflictMode)
    ? opts.conflictMode
    : 'add'

  const today = todayStr()
  const newIds = []
  updateState((state) => {
    // 把 sourceTasks 跟 state.tasks 做一次比对 —— 即使调用方提前传了 findShareDuplicates
    // 结果,store 内部也要重检测一次防 race(中间可能 addTask 过)。
    const dupSourceIdx = new Set()
    const dupExistingIds = []
    if (conflictMode !== 'add') {
      for (let i = 0; i < sourceTasks.length; i++) {
        const it = sourceTasks[i]
        const exist = state.tasks.find((t) => _isSameTask(it, t))
        if (exist) {
          dupSourceIdx.add(i)
          dupExistingIds.push(exist.id)
        }
      }
    }

    // 'replace' 先删旧,再正常导入新的(走 push)。这样 newIds 仍然指向新行,
    // 上层 toast / 跳转逻辑不用区分。
    if (conflictMode === 'replace' && dupExistingIds.length > 0) {
      const set = new Set(dupExistingIds)
      state.tasks = state.tasks.filter((t) => !set.has(t.id))
    }

    const maxOrder = state.tasks.reduce((m, t) => Math.max(m, t.order || 0), -1)
    let cursor = maxOrder + 1
    for (let i = 0; i < sourceTasks.length; i++) {
      let it = sourceTasks[i]
      const isDup = dupSourceIdx.has(i)
      if (isDup && conflictMode === 'skip') continue
      if (isDup && conflictMode === 'rename') {
        it = { ...it, c: _renamedShareContent(it.c) }
      }
      const row = buildTaskFromShare(it, today)
      row.order = cursor++
      state.tasks.push(row)
      newIds.push(row.id)
    }
    reconcilePerfectDays(state)
    return state
  })
  return newIds
}

// 房间背景主题(可选)。存在 pet.roomTheme,随宠物一起持久化 + 云同步。
const ROOM_THEMES = ['cozy', 'castle']
function setRoomTheme(theme) {
  const t = ROOM_THEMES.indexOf(theme) >= 0 ? theme : 'cozy'
  updateState((state) => {
    if (state.pet) state.pet.roomTheme = t
    return state
  })
  return t
}

module.exports = {
  defaultState,
  ROOM_THEMES,
  setRoomTheme,
  // state
  getStateWithComputed,
  // dates
  todayStr,
  addDays,
  weekdayOf,
  dateToStr,
  strToDate,
  // task
  addTask,
  updateTask,
  deleteTask,
  detachOccurrence,
  excludeOccurrence,
  reorderTasks,
  reorderRows,
  getRowOrder,
  setEditTaskId,
  clearEditTaskId,
  findFinishedTasksByName,
  estimateTaskMinutes,
  inferSubjectByName,
  // task control
  startTask,
  pauseTask,
  resumeTask,
  finishTask,
  setActualMinutes,
  revertTask,
  // queries
  tasksForDate,
  tasksScheduledOn,
  effectiveDueDate,
  dateCountsForMonth,
  isTaskActiveOn,
  isRecurringTask,
  getTaskState,
  getTaskTimelineRows,
  getTaskWorkBreakSegments,
  nextPendingTaskOnDate,
  formatRecurrenceLabel,
  // organization
  DEFAULT_ORGANIZATIONS,
  DEFAULT_ORGANIZATION,
  ORGANIZATION_MAX_LEN,
  ORGANIZATION_MAX_COUNT,
  getOrganizations,
  addOrganization,
  removeOrganization,
  renameOrganization,
  resetOrganizations,
  // pet
  PET_SPECIES,
  PET_SWITCH_COST,
  PET_RENAME_COST,
  PET_NAME_MAX_LEN,
  PET_DECAY_PER_HOUR,
  LEVEL_MAX,
  XP_PER_LEVEL_BASE,
  XP_PER_LEVEL_OFFSET,
  XP_PER_HOUR_FULL,
  getXpForLevel,
  attrMultiplier,
  currentXpPerHour,
  petAgeDays,
  deriveAnimState,
  setupPet,
  switchPetSpecies,
  renamePet,
  buyItem,
  useFurnitureItem,
  furnitureEffect,
  furnitureCooldownLeft,
  FURNI_COOLDOWN_MS,
  levelUpPet,
  // ocr
  setCurrentOcrJob,
  getCurrentOcrJob,
  clearCurrentOcrJob,
  // profile
  getProfile,
  updateProfileNickname,
  updateProfileAvatar,
  // sharing
  serializeTasksForShare,
  sanitizeSharePayload,
  importSharedTasks,
  findShareDuplicates,
  applyShareRewardClaim,
  applyAdminCoinClaim,
  // cloud-sync interface (for cloud-sync module's use; pages should use
  // cloudSync.hydrateIfStale directly)
  applyHydratedState,
  getStateForSync,
  getUpdatedAt,
  consumeV2V3MigrationFlag,
  // local backup safety net (同步前先备份 + 每日快照 + 恢复)
  backupLocalState,
  listBackups,
  restoreBackup,
  // reward rules (read-only constants exposed for UI display + tests)
  REWARD_TASK_OVERDUE,
  REWARD_TASK_TODAY,
  REWARD_TASK_FUTURE,
  REWARD_WEEKLY_STREAK,
  DAILY_COMPLETION_CAP,
  EARLY_BIRD_TIERS,
  earlyBirdBonus,
  perTaskReward,
  projectedReward,
  coinsEarnedOn,
  // 背单词 / 单词库 SRS
  buildReciteSession,
  applyReciteSession,
  reciteCountToday,
  reciteRemaining,
  RECITE_DAILY_MAX,
  RECITE_DEFAULT_SIZE,
  RECITE_MIN_NEW,
  RECITE_SESSION_MIN,
  RECITE_SESSION_MAX,
  // 单词库管理
  CUSTOM_WORD_BOOKS_MAX,
  getCustomBookCount,
  addWordBook,
  removeWordBook,
  renameWordBook,
  getWordStats,
  setWordBookPublic,
  addReferencedBook,
  syncReferencedBook,
  addWord,
  removeWord,
  updateWord,
  stripWordNum,
  setReciteTargets,
  setReciteSessionSize,
  serializeWordBookForShare,
  importSharedWordBook,
  WORD_BOOK_NAME_MAX,
  WORD_TEXT_MAX,
  // misc
  getCurrentTime
}

// Wire cloud-sync with the small surface it needs. Done after module.exports
// so the functions are available as references. cloud-sync was required at
// the top — its `init` only stashes this object, no work happens until the
// first hydrate/push call.
cloudSync.init({
  applyHydratedState,
  getStateForSync,
  getUpdatedAt
})
