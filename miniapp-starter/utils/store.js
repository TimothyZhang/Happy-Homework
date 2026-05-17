const cloudSync = require('./cloud-sync')
const coinLedger = require('./coin-ledger')

const STORAGE_KEY = 'homework-pet-v1'
const SCHEMA_VERSION = 3

// v3: 作业本(notebook)概念彻底拍平 —— mode / startDate / endDate / recurrence
// 全部下沉到 task 自身,task 增加 organization 字段(校内/校外/其他)。
// state.notebooks[] 在 v3 之后永远是 []。SYNC_FIELDS 仍保留 'notebooks' 一段
// 时间,让老 client 拿到云端空数组而不是 undefined,迁移更平滑。
const ORGANIZATIONS = ['校内', '校外', '其他']
// 默认 "校内" — 大多数作业是学校布置的,跟 task-edit 表单默认值保持一致。
// 影响:migrate v2→v3 给历史 task 补 organization、OCR 导入兜底、share import 兜底、
//      sanitize share payload 兜底。已经写过 organization 字段的 task 不会被覆盖
//      (v3 backfill 只在字段缺失或非法时才填默认值)。
const DEFAULT_ORGANIZATION = '校内'

// Subset of state fields synced to cloud. Everything else is local-only:
// transient UI state (editTaskId, editNotebookId), OCR jobs (ephemeral and
// large), and app-wide config that's the same for everyone (shopItems,
// schemaVersion).
// NOTE: `profile` carries both nickname AND avatar (a cloud:// fileID), so
// the avatar is synced through the existing entry — no separate field needed.
//
// `coins` 故意不在 sync list 里 —— 余额改成由服务端账本独占维护(coinLedger
// 云函数 + shareReward.claim + adminPanel.claimAdminCoins),客户端 push 整包
// state 时不携带 coins,避免 localStorage 篡改秒变 999999。本地 state.coins
// 仅作即时 UI 缓存,通过 hydrate 或事件 flush 的 newBalance 校准。
// `pendingCoinEvents` 也只在本机持久化 —— 它是未上报的 coin 事件队列,
// flush 成功后会被 drain。跨设备切换时未上报的事件会丢(很少),可接受。
const SYNC_FIELDS = [
  // schemaVersion 必须 sync — 否则 hydrate 拿到的 remote state 没这字段,
  // migrate 把 v2 数据(有 notebooks + 无 schemaVersion)误判为 v1,走 fallback
  // 把所有 task 塞进 nb_mig_today,首页"已完成"列表炸开。
  'schemaVersion',
  'notebooks', 'tasks',
  'streakDays', 'perfectDays', 'bonusByDay', 'completionsByDay',
  // coinLogs 是客户端完整审计:每次 applyCoinDelta 都 append 一条,
  // cap 至 COIN_LOG_KEEP 条防 cloud doc 膨胀。和服务端 coin_ledger 互为
  // 备份 —— ledger 漏了(client 端 pending event 没 flush 上就丢了 / 老
  // 版本走 cloud-sync 直接覆写 coins 路径)时,本地这份是 source of truth。
  // 也是 revokePerfectDay 检查"对应入账是否真的发生过"的依据。
  'coinLogs',
  'pet', 'lastReward',
  'profile'
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

function petAgeDays(pet) {
  if (!pet || !pet.bornAt) return 0
  return Math.max(0, Math.floor((Date.now() - pet.bornAt) / 86400000))
}

// Stat decay per real-world hour. Tuned so each stat goes 100 → 50 in roughly
// 12–20 hours, i.e. by the next day every attribute is asking to be topped up.
// Fullness is fastest (most-frequent feeding); health is slowest (occasional
// medicine). See V1-VALUES-DESIGN.md §3 for the rationale.
const PET_DECAY_PER_HOUR = { fullness: 4, cleanliness: 3, happiness: 3, health: 2.5 }

// 升级:手动按按钮花金币升级。 levelUpPet() 从 state.coins 扣 getLevelCost(level)
// 后 level += 1。没有自动累加经验。Lv.k → Lv.k+1 的花费 = level × LEVEL_COST_PER_STEP。
//
// 曲线设计目标:Lv.90-100 段约 2 周升一级(典型玩家 ~130 金币/天净产出 × 14 天
// ≈ 1820 金币/级)。LEVEL_COST_PER_STEP = 20 让 Lv.99→100 = 1980 金币 ≈ 15 天。
//
//   Lv.1→2  :    20 金币 (≈ 头几小时)
//   Lv.10→11:   200 金币 (≈ 1.5 天)
//   Lv.50→51: 1000 金币 (≈ 1 周)
//   Lv.90→91: 1800 金币 (≈ 2 周) ✓
//   Lv.99→100: 1980 金币 (≈ 2 周) ✓
//
// 累计到 Lv.100 = sum(1..99) × 20 = 99000 金币 ≈ 2 年。前期飞快(开局头一天可
// 连升 5-9 级),后期慢慢消耗 — 标准养成游戏曲线。
const LEVEL_MAX = 100
const LEVEL_COST_PER_STEP = 20

function getLevelCost(level) {
  const lvl = Math.max(1, level | 0)
  if (lvl >= LEVEL_MAX) return 0
  return lvl * LEVEL_COST_PER_STEP
}

// Pure: returns pet with stats reduced by elapsed-time decay (rounded to ints
// so the UI doesn't show "76.342"). Doesn't write — commitPetDecay stamps.
function petWithDecay(pet) {
  if (!pet || !pet.species) return pet
  const now = Date.now()
  const last = pet.lastDecayAt || pet.bornAt || now
  const hours = Math.max(0, (now - last) / 3600000)
  if (hours <= 0) return pet
  const drop = (cur, rate) =>
    Math.max(0, Math.round((cur == null ? 100 : cur) - hours * rate))
  return {
    ...pet,
    happiness:   drop(pet.happiness,   PET_DECAY_PER_HOUR.happiness),
    fullness:    drop(pet.fullness,    PET_DECAY_PER_HOUR.fullness),
    cleanliness: drop(pet.cleanliness, PET_DECAY_PER_HOUR.cleanliness),
    health:      drop(pet.health,      PET_DECAY_PER_HOUR.health)
  }
}

// "Catch-up" helper: call inside an updateState updater BEFORE applying any
// user-triggered change so the persisted stat numbers reflect "now" before
// being bumped. Stamps lastDecayAt so the next decay window starts here.
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

const defaultState = {
  schemaVersion: SCHEMA_VERSION,
  // ms timestamp of last sync-relevant local mutation. 0 = never written, so
  // anything from cloud will win on first hydrate.
  updatedAt: 0,
  // 服务端账本权威值的本地缓存。hydrate / coinLedger flush / claim 之后被
  // 重写。不在 SYNC_FIELDS 里 —— 客户端 push 不带这个字段。
  // 新用户首次启动从 100 起步(在 cloud-sync.createInitialDoc 里 seed
  // 进云端 user_state.state.coins,之后服务端账本独占维护)。
  coins: 100,
  // 未上报到 coinLedger 的事件队列。每次 coin 变更同时 push 进来,
  // coin-ledger.flush() 按批次提交后,server 返回 appliedEventIds 用来 drain。
  pendingCoinEvents: [],
  // 客户端完整金币交易审计。append-only,cap 至 COIN_LOG_KEEP 条。和
  // pendingCoinEvents 不同:flush 成功后 pending 会 drain,但 coinLogs
  // 永不删 —— 既能事后对账(本地 vs 服务端 ledger),也是 revokePerfectDay
  // 判定"对应 perfect 入账是否真发生过"的唯一依据。
  // 进 SYNC_FIELDS,sync 到 user_state,admin 后台可读。
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
  profile: { nickname: '', avatar: '' }
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
  // / pet exp 全部不动 —— 它们本来就是 task 粒度或全局粒度。
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
      if (!ORGANIZATIONS.includes(out.organization)) out.organization = DEFAULT_ORGANIZATION
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
    // shopItems is config (same for everyone), not user state — always
    // refresh from defaultState so item updates ship to existing users
    // without a manual cache wipe.
    raw.shopItems = clone(defaultState).shopItems
    if (!Array.isArray(raw.perfectDays)) raw.perfectDays = []
    if (!raw.bonusByDay || typeof raw.bonusByDay !== 'object') raw.bonusByDay = {}
    if (!raw.completionsByDay || typeof raw.completionsByDay !== 'object') raw.completionsByDay = {}
    if (typeof raw.streakDays !== 'number') raw.streakDays = 0
    if (typeof raw.coins !== 'number') raw.coins = 0
    if (!Array.isArray(raw.pendingCoinEvents)) raw.pendingCoinEvents = []
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
      // 老 exp/freeze 模型已废弃 — strip 历史字段,云端 doc 不再带它们。
      // lastLeveledAt 保留(给 pet 页升级 toast 复用)。
      if ('exp' in raw.pet)                   delete raw.pet.exp
      if ('happinessLastDecayAt' in raw.pet)  delete raw.pet.happinessLastDecayAt
      if ('growth' in raw.pet)                delete raw.pet.growth
      if ('nextLevelGrowth' in raw.pet)       delete raw.pet.nextLevelGrowth
      if (raw.pet.lastLeveledAt === undefined) raw.pet.lastLeveledAt = null
    }
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
  // Push synced subset to cloud (debounced inside cloud-sync). coins +
  // pendingCoinEvents 都不在 SYNC_FIELDS,这里只推非 coin 字段。
  cloudSync.pushState(pickSyncFields(state), state.updatedAt)
  // 顺手让 coin-ledger debounced flush。queue 为空时是个 no-op,有事件就
  // 批量上送 coinLedger.commit。
  coinLedger.scheduleFlush()
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
// 注意:remoteSyncedFields 是从云端 user_state.state 拉下来的整个 state 子集
// (包括 coins,因为云端 doc 上有这个字段 —— 由 coinLedger / shareReward.claim
// / adminPanel.claimAdminCoins 维护)。客户端 push 不写 coins,但 hydrate 必须
// 把 coins 当 truth 拉下来。
function applyHydratedState(remoteSyncedFields, remoteUpdatedAt) {
  const cur = loadState()
  const next = {
    ...cur,
    ...remoteSyncedFields,
    updatedAt: remoteUpdatedAt || Date.now()
  }
  // pendingCoinEvents 不在 SYNC_FIELDS,所以 spread 之后保留 cur 的本地队列。
  // 服务端 coins 没看过这些 pending,我们把它们的 delta 先乐观加上去,UI 不会
  // 看到 coins 短暂回落 —— 后续 coin-ledger.flush 会把它们送上,服务端返
  // newBalance 就是这个加完的值。
  const pending = Array.isArray(next.pendingCoinEvents) ? next.pendingCoinEvents : []
  if (pending.length > 0) {
    const pendingDelta = pending.reduce((s, ev) => s + (Math.trunc(Number(ev.delta) || 0)), 0)
    next.coins = Math.max(0, (typeof next.coins === 'number' ? next.coins : 0) + pendingDelta)
  }
  _stateCache = next
  wx.setStorageSync(STORAGE_KEY, next)
  // 触发 flush 让 pending 队列尽快归零,本机和云端 coins 对齐。
  coinLedger.scheduleFlush()
}

function getStateForSync() {
  return pickSyncFields(loadState())
}

function getUpdatedAt() {
  return loadState().updatedAt || 0
}

// 仅给 cloud-sync.createInitialDoc 用 —— 首次建云文档时把本地缓存的
// coins(新用户 defaultState 100 或老用户的最后余额)seed 进去。
// 后续 push 不带 coins, 服务端账本独占维护。
function getLocalCoins() {
  const s = loadState()
  return typeof s.coins === 'number' ? s.coins : 0
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
    rewardKind: null
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
      rewardKind: task.rewardKind || null
    }
  }
  const occ = (task.occurrences || {})[dateStr]
  return occ ? { ...defaultOccurrence(), ...occ } : defaultOccurrence()
}

function applyTaskState(task, dateStr, patch) {
  if (task.mode !== 'recurring') {
    return { ...task, ...patch }
  }
  const occurrences = { ...(task.occurrences || {}) }
  occurrences[dateStr] = { ...defaultOccurrence(), ...occurrences[dateStr], ...patch }
  return { ...task, occurrences }
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

  const items = []
  for (const task of state.tasks) {
    let onSchedule = false
    let isOverdue = false
    let completedOnDate = false

    // occurrenceDate 的语义是"这个 row 归属哪一天"。一次性 task 一律归
    // effectiveDueDate(task),这样 finishTask 拿到的 day 就是 task 自己的 due,
    // perTaskReward / perfectDays 都按 task 级日期走。recurring task 则归
    // 当前 dateStr(每天独立 occurrence)。
    let oneShotDue = null

    if (task.mode !== 'recurring') {
      oneShotDue = effectiveDueDate(task)
      onSchedule = !!oneShotDue && oneShotDue === dateStr

      // For past/today views, also surface tasks actually completed that day.
      if (!isFuture) {
        const status = task.status || 'todo'
        if (status === 'done' && task.completedAt &&
            dateToStr(new Date(task.completedAt)) === dateStr) {
          completedOnDate = true
        }
      }

      // Overdue: still-open one-shot whose own due date already passed. Today only.
      if (!onSchedule && isToday) {
        if (oneShotDue && compareDateStr(oneShotDue, today) < 0 && (task.status || 'todo') !== 'done') {
          isOverdue = true
        }
      }
    } else {
      onSchedule = isTaskActiveOn(task, dateStr)
    }

    if (!onSchedule && !isOverdue && !completedOnDate) continue
    const occ = getTaskState(task, dateStr)
    items.push({
      task,
      occurrence: occ,
      occurrenceDate: task.mode === 'recurring' ? dateStr : (oneShotDue || dateStr),
      isOverdue
    })
  }

  // Today view: surface past recurring occurrences that are either still
  // not done (red) OR were finished today (so a freshly-cleared backlog
  // item still appears, this time in the done section).
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
          items.push({
            task,
            occurrence: { ...defaultOccurrence(), ...(raw || {}) },
            occurrenceDate: ad,
            isOverdue: true
          })
        } else if (raw && raw.completedAt &&
                   dateToStr(new Date(raw.completedAt)) === today) {
          items.push({
            task,
            occurrence: { ...defaultOccurrence(), ...raw },
            occurrenceDate: ad,
            isOverdue: false
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
  wx.showToast({ title: '只读模式：已在其他设备登录', icon: 'none', duration: 1800 })
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

// === Server-authoritative coin ledger === //
//
// 余额改成由服务端账本独占维护(见 cloudfunctions/coinLedger + shareReward.claim
// + adminPanel.claimAdminCoins)。客户端这边:
//   - 每次 coin 变更都同时改 state.coins(乐观 UI)+ 推一条 event 进 queue
//   - utils/coin-ledger 模块 debounce 把 queue 批量送给 coinLedger.commit
//   - server 返回 newBalance + appliedEventIds,client 用来对齐 state.coins
//     和 drain queue
//   - 任何 claim(share / admin)直接返回 newBalance,client set 即可
//
// applyCoinDelta 是给 updateState 的 updater 函数内调用的工具 —— 它同时改
// state.coins(本地缓存)和 state.pendingCoinEvents(事件队列)。

function genEventId() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

// In-updater coin mutation. Caller must be inside `updateState((state) => {...})`.
// kind: 'task_reward' | 'task_refund' | 'pet_purchase' | 'level_upgrade' | 'pet_skin_switch'
// delta: signed integer matching kind's allowed range (server re-validates).
// meta:  optional debug context for the ledger entry (taskId, itemId, etc.).
// 返回写入的 eventId(no-op 时返 null) —— finishTask 用来 stamp 到
// bonusByDay[day].ledgerEventId,后续 revokePerfectDay 凭它判定那次入账
// 真的发生过、可以放心退款。
function applyCoinDelta(state, kind, delta, meta) {
  if (!delta) return null
  const d = Math.trunc(Number(delta) || 0)
  if (!d) return null
  const before = state.coins || 0
  // 乐观更新本地缓存 —— 服务端 commit 后会回 newBalance 覆盖纠偏
  state.coins = Math.max(0, before + d)
  const after = state.coins
  const eventId = genEventId()
  const ts = Date.now()
  if (!Array.isArray(state.pendingCoinEvents)) state.pendingCoinEvents = []
  state.pendingCoinEvents.push({ eventId, kind, delta: d, ts, meta: meta || null })
  // 同步 append 到 coinLogs(永久审计,不随 flush drain)。带 balance
  // before/after 方便事后看每条 event 对账面的真实影响 —— ledger 也存
  // balanceAfter 但只服务端有,本地这份独立。
  if (!Array.isArray(state.coinLogs)) state.coinLogs = []
  state.coinLogs.push({
    eventId, kind, delta: d, balanceBefore: before, balanceAfter: after,
    ts, meta: meta || null
  })
  // Prune 防 cloud doc 撑爆。早期记录进 coin_ledger 兜底(只要 flush 过),
  // 本地这里只留最近 COIN_LOG_KEEP 条够人工审查。
  if (state.coinLogs.length > COIN_LOG_KEEP) {
    state.coinLogs = state.coinLogs.slice(state.coinLogs.length - COIN_LOG_KEEP)
  }
  return eventId
}

// Read-only snapshot of unflushed events; coin-ledger module pulls this batch.
function getPendingCoinEvents() {
  const events = loadState().pendingCoinEvents
  return Array.isArray(events) ? events.slice() : []
}

// Drain events that the server confirmed applied, and snap local coins to
// the server-returned balance. Called from coin-ledger after a successful
// commit (or after a claim returns newBalance with no events).
function applyServerCoinResult({ appliedEventIds, newBalance }) {
  const drained = Array.isArray(appliedEventIds) ? new Set(appliedEventIds) : null
  updateState((state) => {
    if (drained && Array.isArray(state.pendingCoinEvents)) {
      state.pendingCoinEvents = state.pendingCoinEvents.filter((ev) => !drained.has(ev.eventId))
    }
    if (typeof newBalance === 'number' && Number.isFinite(newBalance)) {
      state.coins = Math.max(0, Math.trunc(newBalance))
    }
    return state
  })
}

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

// v3: 标准化 organization,落不到三选一就回退默认。
function normalizeOrganization(v) {
  return ORGANIZATIONS.includes(v) ? v : DEFAULT_ORGANIZATION
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
      organization: ORGANIZATIONS.includes(src.organization) ? src.organization : DEFAULT_ORGANIZATION,
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
    currentSegmentStartedAt: null
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
      accumulatedMs: cur.accumulatedMs || 0
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
    const patch = { status: 'doing', currentSegmentStartedAt: now }
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
// 'task_refund' event (coins clip to 0 inside applyCoinDelta if user has
// spent the bonus already). Used by revertTask (a finished task got
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
function reconcilePerfectDays(state) {
  if (!Array.isArray(state.perfectDays) || state.perfectDays.length === 0) return
  const days = state.perfectDays.slice().sort().reverse()
  for (const d of days) {
    const items = tasksForDate(state, d)
    const stillAllDone = items.length > 0 && items.every((it) => it.occurrence.status === 'done')
    if (!stillAllDone) revokePerfectDay(state, d)
  }
}

// Send a done task back to undone (paused) — used for "误点完成" recovery.
// Keeps accumulatedMs so the user picks up where they left off. Also claws
// back the +10 single-task reward; if reverting breaks an all-done day,
// refunds the daily bonus (and weekly bonus if any) too. Coins clip to 0
// rather than going negative — the user may have spent some between finish
// and revert. This anti-farms the finish→revert→finish loop: each cycle
// nets zero coins.
function revertTask(taskId, dateStr) {
  const day = dateStr || todayStr()
  return updateState((state) => {
    const task = state.tasks.find((t) => t.id === taskId)
    if (!task) return state
    const cur = getTaskState(task, day)
    if (cur.status !== 'done') return state

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

    return state
  })
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

    // 把上次 commit 起累计的 stat 衰减刷到现在 — 不再加 happiness。
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
      rewardKind
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
    const todayItems = tasksForDate(state, day)
    const allDone = todayItems.length > 0 && todayItems.every((it) => it.occurrence.status === 'done')

    // Whether today's home view is now empty (all visible items done). When
    // `day === today` this is the same as `allDone`; when finishing a backlog
    // item from a past day, tasksForDate(state, day) sees only that single past
    // occurrence, so allDone may be true while today still has pending items.
    // Used by the home page to gate the "今日全部完成" toast so a single backlog
    // tap doesn't fire it.
    const todayViewItems = day === today ? todayItems : tasksForDate(state, today)
    const todayCleared = todayViewItems.length > 0 &&
      todayViewItems.every((it) => it.occurrence.status === 'done')

    if (allDone) {
      if (!Array.isArray(state.perfectDays)) state.perfectDays = []
      if (!state.perfectDays.includes(day)) {
        // Daily-perfect base = sum of rewardPaid across this day's tasks (i.e.
        // mirror whatever per-task coins were actually credited). Tasks beyond
        // the 20-cap have rewardPaid=0 already, so the cap propagates here for
        // free. Early-bird extra (flat +50/+30/+20) stacks on top. Weekly
        // streak is tracked separately, not part of dailyBonus.
        const baseBonus = todayItems.reduce(
          (sum, it) => sum + (it.occurrence.rewardPaid || 0),
          0
        )
        dailyBonus = baseBonus + earlyBirdBonus(new Date(now))
        reward += dailyBonus

        // Snapshot streak BEFORE the increment so revertTask can restore it.
        const prevStreakDays = state.streakDays || 0

        // Consecutive-day streak: if yesterday was also a perfect day, keep
        // counting; otherwise reset to 1.
        const yesterday = addDays(day, -1)
        state.streakDays = state.perfectDays.includes(yesterday)
          ? prevStreakDays + 1
          : 1

        state.perfectDays.push(day)
        // Prune to ~14 days of history — enough to span 2 weekly windows.
        const cutoff = addDays(day, -14)
        state.perfectDays = state.perfectDays.filter((d) => d >= cutoff).sort()

        if (state.streakDays > 0 && state.streakDays % 7 === 0) {
          weeklyBonus = REWARD_WEEKLY_STREAK
          reward += weeklyBonus
        }

        // Stash exact bonus paid + pre-update streak. revertTask refunds from
        // this map so the refund matches the credit even if task count or
        // streak state changes between finish and revert.
        // ledgerEventId 在下面 applyCoinDelta 后回填 —— 标记这次 perfect
        // 入账真的发生过(写进 coinLogs / pending queue)。revokePerfectDay
        // 用它判断要不要发 task_refund:没标记的天数 = 老路径残留或 flush
        // 丢失的虚账,只清 bonusByDay 不退款,避免 over-clawback。
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

// 手动升级:花 getLevelCost(level) 金币 → level += 1。
// 返回值约定:
//   { ok: true, level }          — 升级成功
//   { ok: false, reason: 'no-pet' }              — 还没设置宠物
//   { ok: false, reason: 'max-level' }           — 已满级
//   { ok: false, reason: 'insufficient-coins', need, have } — 金币不够
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
    const cost = getLevelCost(prevLevel)
    const coins = state.coins || 0
    if (coins < cost) {
      result = { ok: false, reason: 'insufficient-coins', need: cost - coins, have: coins }
      return state
    }
    state.pet = commitPetDecay(state.pet)
    applyCoinDelta(state, 'pet_level_up', -cost, { fromLevel: prevLevel, toLevel: prevLevel + 1 })
    state.pet.level = prevLevel + 1
    state.pet.lastLeveledAt = Date.now()
    state.lastLevelUp = { level: state.pet.level, at: Date.now() }
    result = { ok: true, level: state.pet.level }
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

// === OCR job (unchanged) === //

function setCurrentOcrJob(job) {
  return updateState((state) => {
    const normalized = {
      id: job.id || Date.now(),
      imagePath: job.imagePath || '',
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
function serializeTasksForShare(dateStr, options) {
  const state = loadState()
  const opts = options || {}
  const day = dateStr || todayStr()
  const sharerOpenid = opts.sharerOpenid || ''
  const shareId = opts.shareId || genId('sh')

  const items = tasksForDate(state, day)
  // taskIds 过滤:UI 让用户勾选要分享哪些。
  let filtered = items
  if (Array.isArray(opts.taskIds) && opts.taskIds.length > 0) {
    const idSet = new Set(opts.taskIds)
    filtered = items.filter((it) => idSet.has(it.task.id))
  }
  // 学科/组织过滤(快速分享按钮)。
  if (Array.isArray(opts.subjects) && opts.subjects.length > 0) {
    const set = new Set(opts.subjects)
    filtered = filtered.filter((it) => set.has(it.task.subject || '其他'))
  }
  if (Array.isArray(opts.organizations) && opts.organizations.length > 0) {
    const set = new Set(opts.organizations)
    filtered = filtered.filter((it) => set.has(it.task.organization || DEFAULT_ORGANIZATION))
  }

  // 同一 task 在同一日期最多 1 行 — tasksForDate 已经去重(recurring task 在 today
  // 会按 backlog 输出多行,但每行 occurrenceDate 不同 → 这里序列化时去重到 task.id)。
  const seenTaskIds = new Set()
  const tasks = []
  for (const it of filtered) {
    if (seenTaskIds.has(it.task.id)) continue
    seenTaskIds.add(it.task.id)
    const t = it.task
    tasks.push({
      s: t.subject || '其他',
      o: t.organization || DEFAULT_ORGANIZATION,
      c: t.content || '',
      m: Number(t.estimatedMinutes) || 0,
      mo: t.mode === 'recurring' ? 'recurring' : 'one-shot',
      sd: t.startDate || day,
      ed: t.endDate === undefined ? null : t.endDate,
      r: t.mode === 'recurring' ? (t.recurrence || { type: 'daily', weekdays: [] }) : null
    })
  }

  return {
    v: 2,
    sharer: sharerOpenid,
    shareId,
    d: day,
    t: tasks
  }
}

// Apply share-save coins claimed from cloud. Cloud function已经服务端入账,
// 这里只做本地缓存校准 + 触发 toast UI。
// payload: { total, count, notebooks, newBalance }
function applyShareRewardClaim({ total, count, notebooks, newBalance }) {
  if (!total || total <= 0) return null
  let next = null
  updateState((state) => {
    // 服务端账本权威 —— 直接 set,不再 +=。
    if (typeof newBalance === 'number' && Number.isFinite(newBalance)) {
      state.coins = Math.max(0, Math.trunc(newBalance))
    } else {
      // 老版云函数没返 newBalance,fallback 走 += 以免本次 claim 看不到金币。
      state.coins = (state.coins || 0) + total
    }
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

// Apply an admin-coin-inbox claim. Server 已经完成 clamp ≥0 + 余额更新 +
// 审计写入,本地这边只:
//   - 把 state.coins 校准到 server 返的 newBalance
//   - 追加 coinLogs(用 item.applied 而不是 item.requested,因为 server 已 clamp)
//   - 触发 lastAdminCoinClaim 给 UI 闪 toast
//
// payload: { totalApplied, addedTotal, deductedTotal, count, items, newBalance }
//   items[i] = { requested, applied, delta, reason, adminOpenid, auditId, createdAt }
//   (delta 字段是老 client 兼容字段,等价 applied)
function applyAdminCoinClaim({ items, totalApplied, addedTotal, deductedTotal, newBalance }) {
  if (!Array.isArray(items) || items.length === 0) return null
  let summary = null
  updateState((state) => {
    const logs = Array.isArray(state.coinLogs) ? state.coinLogs : []
    const appliedItems = []
    for (const it of items) {
      // Server 已经做过 clamp;applied 字段就是真实入账值。老版兼容:如果
      // 只有 delta 没有 applied,把 delta 当 applied 用。
      const applied = typeof it.applied === 'number' ? it.applied : (Number(it.delta) || 0)
      const requested = typeof it.requested === 'number' ? it.requested : applied
      if (!applied && !requested) continue
      const reason = (it.reason || '').toString()
      logs.push({
        at: Number(it.createdAt) || Date.now(),
        delta: applied,
        reason: `admin-adjust:${reason}`,
        adminOpenid: it.adminOpenid || '',
        auditId: it.auditId || ''
      })
      appliedItems.push({ requested, applied, reason })
    }
    // 服务端账本权威 —— 直接 set。老版云函数没返 newBalance 的话维持原值
    // (后续 hydrate 会拉到正确值)。
    if (typeof newBalance === 'number' && Number.isFinite(newBalance)) {
      state.coins = Math.max(0, Math.trunc(newBalance))
    }
    // 防止 coinLogs 无限增长。云端单文档 + 客户端 storage 都有上限,长期
    // 重度调整的用户(测试号 / admin 自己)会撑爆。只留最近 200 条够审查。
    state.coinLogs = logs.length > COIN_LOG_KEEP ? logs.slice(-COIN_LOG_KEEP) : logs
    const totalAppliedFinal = typeof totalApplied === 'number'
      ? totalApplied
      : appliedItems.reduce((s, it) => s + (it.applied || 0), 0)
    state.lastAdminCoinClaim = {
      receivedAt: Date.now(),
      totalApplied: totalAppliedFinal,
      count: items.length
    }
    summary = {
      totalApplied: totalAppliedFinal,
      addedTotal: typeof addedTotal === 'number'
        ? addedTotal
        : appliedItems.reduce((s, it) => s + (it.applied > 0 ? it.applied : 0), 0),
      deductedTotal: typeof deductedTotal === 'number'
        ? deductedTotal
        : appliedItems.reduce((s, it) => s + (it.applied < 0 ? it.applied : 0), 0),
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
    organization: ORGANIZATIONS.includes(item.o) ? item.o : DEFAULT_ORGANIZATION,
    content: item.c || '',
    estimatedMinutes: Number(item.m || estimateTaskMinutes(item.c, item.s) || 0),
    dueDate: null,
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
        r
      }
    }).filter(Boolean)
    return {
      v: 2,
      from: safeShareString(payload.from, SHARE_MAX_FROM),
      sharer: safeShareString(payload.sharer, SHARE_MAX_ID),
      shareId: safeShareString(payload.nbId, SHARE_MAX_ID),  // v1 nbId 当 shareId 用
      d: sd || todayStr(),
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
      o: ORGANIZATIONS.includes(o) ? o : DEFAULT_ORGANIZATION,
      c: safeShareString(it.c, SHARE_MAX_CONTENT),
      m: Number.isFinite(mNum) && mNum > 0 && mNum <= SHARE_MAX_TASK_MINUTES ? Math.trunc(mNum) : 0,
      mo: mode,
      sd: safeShareString(it.sd, SHARE_MAX_DATE_STR),
      ed: it.ed === null ? null : (it.ed === undefined ? undefined : safeShareString(it.ed, SHARE_MAX_DATE_STR)),
      r
    }
  }).filter(Boolean)
  return {
    v: 2,
    from: safeShareString(payload.from, SHARE_MAX_FROM),
    sharer: safeShareString(payload.sharer, SHARE_MAX_ID),
    shareId: safeShareString(payload.shareId, SHARE_MAX_ID),
    d: safeShareString(payload.d, SHARE_MAX_DATE_STR) || todayStr(),
    t: tasks
  }
}

// v3 importSharedTasks: 把分享 payload 中的 task 列表追加到 state.tasks。
// options:
//   - selectedIndexes: number[]   只导入这些下标(UI 让用户勾选)。不传 = 全部。
// 返回新增的 task id 数组。
function importSharedTasks(payload, options) {
  // 即使调用方已经 sanitize 过,这里再做一次 —— 防止其它入口漏 sanitize。
  const safe = sanitizeSharePayload(payload)
  if (!safe) return []
  const opts = options || {}
  const sourceTasks = Array.isArray(opts.selectedIndexes) && opts.selectedIndexes.length
    ? opts.selectedIndexes.map((i) => safe.t[i]).filter(Boolean)
    : safe.t
  if (sourceTasks.length === 0) return []

  const today = todayStr()
  const newIds = []
  updateState((state) => {
    const maxOrder = state.tasks.reduce((m, t) => Math.max(m, t.order || 0), -1)
    let cursor = maxOrder + 1
    for (const it of sourceTasks) {
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

module.exports = {
  defaultState,
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
  revertTask,
  // queries
  tasksForDate,
  effectiveDueDate,
  dateCountsForMonth,
  isTaskActiveOn,
  isRecurringTask,
  getTaskState,
  // organization
  ORGANIZATIONS,
  DEFAULT_ORGANIZATION,
  // pet
  PET_SPECIES,
  PET_SWITCH_COST,
  PET_DECAY_PER_HOUR,
  LEVEL_MAX,
  getLevelCost,
  petAgeDays,
  deriveAnimState,
  setupPet,
  switchPetSpecies,
  buyItem,
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
  applyShareRewardClaim,
  applyAdminCoinClaim,
  // cloud-sync interface (for cloud-sync module's use; pages should use
  // cloudSync.hydrateIfStale directly)
  applyHydratedState,
  getStateForSync,
  getUpdatedAt,
  getLocalCoins,
  consumeV2V3MigrationFlag,
  // coin-ledger interface (for utils/coin-ledger module)
  getPendingCoinEvents,
  applyServerCoinResult,
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
  getUpdatedAt,
  getLocalCoins
})

// Wire coin-ledger with the same init pattern as cloud-sync. coin-ledger 自己
// 不 require store(它只用 init 传进来的接口),所以这两个 require 在文件顶部
// 不会产生循环依赖。
coinLedger.init({
  getPendingCoinEvents,
  applyServerCoinResult
})
