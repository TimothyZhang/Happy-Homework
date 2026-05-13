const cloudSync = require('./cloud-sync')

const STORAGE_KEY = 'homework-pet-v1'
const SCHEMA_VERSION = 2

// Subset of state fields synced to cloud. Everything else is local-only:
// transient UI state (editTaskId, editNotebookId), OCR jobs (ephemeral and
// large), and app-wide config that's the same for everyone (shopItems,
// schemaVersion).
// NOTE: `profile` carries both nickname AND avatar (a cloud:// fileID), so
// the avatar is synced through the existing entry — no separate field needed.
const SYNC_FIELDS = [
  'notebooks', 'tasks',
  'coins', 'streakDays', 'perfectDays', 'bonusByDay',
  'pendingShareCoins',
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

const REWARD_PER_TASK = 10
const REWARD_DAILY_PERFECT_PER_TASK = 10  // base bonus per task on first all-done of day
const REWARD_WEEKLY_STREAK = 50            // every 7 consecutive perfect days

// Daily-perfect bonus is scaled by completion hour of the last task — keyed on
// evening hours since homework is an evening task. Finishing before 19:00 (7
// PM) doubles the bonus; 19:00–20:00 = ×1.5; 20:00–21:00 = ×1.25; on/after
// 21:00 the base bonus (×1) applies. Each tier matches hour < hourEnd, so
// anything earlier than the first hourEnd is also ×2 (afternoon, morning, or
// past-midnight all fall into that bucket).
const EARLY_BIRD_TIERS = [
  { hourEnd: 19, multiplier: 2,    label: '早完成加成 ×2', window: '21:00 前一整天 / 当晚 19:00 前' },
  { hourEnd: 20, multiplier: 1.5,  label: '加成 ×1.5',     window: '19:00–20:00' },
  { hourEnd: 21, multiplier: 1.25, label: '加成 ×1.25',    window: '20:00–21:00' }
]

// Returns the daily-perfect bonus multiplier for a given Date (or now). Pure.
function dailyPerfectMultiplier(date) {
  const d = date || new Date()
  const h = d.getHours()
  for (const tier of EARLY_BIRD_TIERS) {
    if (h < tier.hourEnd) return tier.multiplier
  }
  return 1
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

// Coins required to upgrade to (level + 1). Cap = LEVEL_COSTS_PLATEAU once
// past the explicit table. Daily-spend assumption: ~70 coins/day banked for
// upgrades → L1→L2 ≈ 2.5d, L2→L3 ≈ 7d, L3→L4 ≈ 14d, L4+ ≈ 28d.
const LEVEL_COSTS = [180, 500, 1000, 2000]
const LEVEL_COSTS_PLATEAU = 2000

function getLevelCost(level) {
  const idx = Math.max(1, level | 0) - 1
  return idx < LEVEL_COSTS.length ? LEVEL_COSTS[idx] : LEVEL_COSTS_PLATEAU
}

// Pure: returns pet with stats reduced by elapsed-time decay (rounded to ints
// so the UI doesn't show "76.342"). Doesn't write.
function petWithDecay(pet) {
  if (!pet || !pet.species) return pet
  const last = pet.lastDecayAt || pet.bornAt || Date.now()
  const hours = Math.max(0, (Date.now() - last) / 3600000)
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
  return { ...petWithDecay(pet), lastDecayAt: Date.now() }
}

// === Default seed === //

function seedNotebooks() {
  const today = todayStr()
  const y1 = addDays(today, -1)
  const y2 = addDays(today, -2)
  const tom = addDays(today, 1)
  return [
    // overdue (2 days ago)
    {
      id: 'nb_seed_old2',
      name: y2,
      mode: 'one-shot',
      startDate: y2,
      endDate: y2,
      recurrence: null,
      createdAt: Date.now() - 172800000,
      order: 0
    },
    // overdue (yesterday) — has both done and not-done tasks
    {
      id: 'nb_seed_old1',
      name: y1,
      mode: 'one-shot',
      startDate: y1,
      endDate: y1,
      recurrence: null,
      createdAt: Date.now() - 86400000,
      order: 1
    },
    // today
    {
      id: 'nb_seed_today',
      name: today,
      mode: 'one-shot',
      startDate: today,
      endDate: today,
      recurrence: null,
      createdAt: Date.now(),
      order: 2
    },
    // recurring daily — backdated 2 days so demo shows the past-missed
    // occurrences feature on home today view
    {
      id: 'nb_seed_recur',
      name: '每日口算',
      mode: 'recurring',
      startDate: y2,
      endDate: null,
      recurrence: { type: 'daily', weekdays: [] },
      createdAt: Date.now() - 172800000,
      order: 3
    },
    // tomorrow (won't show today)
    {
      id: 'nb_seed_tom',
      name: tom,
      mode: 'one-shot',
      startDate: tom,
      endDate: tom,
      recurrence: null,
      createdAt: Date.now(),
      order: 4
    }
  ]
}

function seedTasks() {
  const now = Date.now()
  return [
    // 2 days ago — still not done → overdue
    {
      id: 'tk_seed_old2_1',
      notebookId: 'nb_seed_old2',
      subject: '语文',
      content: '阅读《小王子》第 3 章并写读后感',
      estimatedMinutes: 30,
      order: 0,
      createdAt: now - 172800000,
      status: 'todo',
      startedAt: null,
      currentSegmentStartedAt: null,
      accumulatedMs: 0,
      completedAt: null,
      actualMinutes: null
    },
    // yesterday — one done, one overdue
    {
      id: 'tk_seed_old1_1',
      notebookId: 'nb_seed_old1',
      subject: '数学',
      content: '应用题练习 5 道',
      estimatedMinutes: 25,
      order: 1,
      createdAt: now - 86400000,
      status: 'done',
      startedAt: now - 86000000,
      currentSegmentStartedAt: null,
      accumulatedMs: 1500000,
      completedAt: now - 80000000,
      actualMinutes: 25
    },
    {
      id: 'tk_seed_old1_2',
      notebookId: 'nb_seed_old1',
      subject: '英语',
      content: 'Unit 5 单词默写',
      estimatedMinutes: 15,
      order: 2,
      createdAt: now - 86400000,
      status: 'todo',
      startedAt: null,
      currentSegmentStartedAt: null,
      accumulatedMs: 0,
      completedAt: null,
      actualMinutes: null
    },
    // today
    {
      id: 'tk_seed_today_1',
      notebookId: 'nb_seed_today',
      subject: '语文',
      content: '完成《春晓》抄写 2 遍，并朗读 3 次',
      estimatedMinutes: 20,
      order: 3,
      createdAt: now,
      status: 'todo',
      startedAt: null,
      currentSegmentStartedAt: null,
      accumulatedMs: 0,
      completedAt: null,
      actualMinutes: null
    },
    {
      id: 'tk_seed_today_2',
      notebookId: 'nb_seed_today',
      subject: '科学',
      content: '观察豆子发芽并记录',
      estimatedMinutes: 10,
      order: 4,
      createdAt: now,
      status: 'todo',
      startedAt: null,
      currentSegmentStartedAt: null,
      accumulatedMs: 0,
      completedAt: null,
      actualMinutes: null
    },
    // recurring daily
    {
      id: 'tk_seed_recur_1',
      notebookId: 'nb_seed_recur',
      subject: '数学',
      content: '口算练习 2 页',
      estimatedMinutes: 25,
      order: 5,
      createdAt: now,
      occurrences: {}
    },
    // tomorrow
    {
      id: 'tk_seed_tom_1',
      notebookId: 'nb_seed_tom',
      subject: '英语',
      content: '听写课文 Unit 6',
      estimatedMinutes: 20,
      order: 6,
      createdAt: now,
      status: 'todo',
      startedAt: null,
      currentSegmentStartedAt: null,
      accumulatedMs: 0,
      completedAt: null,
      actualMinutes: null
    }
  ]
}

const defaultState = {
  schemaVersion: SCHEMA_VERSION,
  // ms timestamp of last sync-relevant local mutation. 0 = never written, so
  // anything from cloud will win on first hydrate.
  updatedAt: 0,
  coins: 0,
  streakDays: 0,
  // YYYY-MM-DD strings for days where every task got completed. Used to
  // compute consecutive-perfect-day streak. Pruned to ~14 days of history.
  perfectDays: [],
  // Per-day bonus paid on first all-done. Keyed by YYYY-MM-DD; value is
  // { dailyBonus, weeklyBonus, prevStreakDays }. Read by revertTask to claw
  // back the exact bonus that was credited (and restore prior streak).
  bonusByDay: {},
  // Coins credited from share-saves that haven't been applied to local
  // coins yet. Filled by the shareReward cloud function on the sharer's
  // user_state doc; claimed (added to coins, reset to 0) on next hydrate.
  pendingShareCoins: 0,
  editTaskId: null,
  editNotebookId: null,
  ocrCurrentJob: null,
  ocrJobs: [],
  // Empty pet object → triggers first-time setup flow on the pet tab.
  pet: {},
  // Each item lifts one primary stat back to a comfy zone and may nudge a
  // secondary stat too. Every attribute (饱腹/清洁/开心/健康) has at least a
  // cheap + mid-tier option; 蝴蝶结 is the high-tier reward splurge.
  // See V1-VALUES-DESIGN.md §4 for daily-spend math.
  shopItems: [
    { id: 1, emoji: '🥕', name: '营养胡萝卜', effect: '饱腹+30 开心+4',     price: 16, happiness: 4,  fullness: 30, cleanliness: 0,  health: 0  },
    { id: 2, emoji: '🍱', name: '丰盛便当',   effect: '饱腹+50 开心+8',     price: 28, happiness: 8,  fullness: 50, cleanliness: 0,  health: 0  },
    { id: 3, emoji: '🧼', name: '香皂',       effect: '清洁+30',            price: 18, happiness: 0,  fullness: 0,  cleanliness: 30, health: 0  },
    { id: 4, emoji: '🛁', name: '泡泡浴',     effect: '清洁+60 开心+5',     price: 32, happiness: 5,  fullness: 0,  cleanliness: 60, health: 0  },
    { id: 5, emoji: '🧸', name: '陪玩玩具熊', effect: '开心+25',            price: 18, happiness: 25, fullness: 0,  cleanliness: 0,  health: 0  },
    { id: 6, emoji: '💊', name: '维生素',     effect: '健康+25',            price: 20, happiness: 0,  fullness: 0,  cleanliness: 0,  health: 25 },
    { id: 7, emoji: '🏃', name: '健身房一次', effect: '健康+55 开心+5',     price: 35, happiness: 5,  fullness: 0,  cleanliness: 0,  health: 55 },
    { id: 8, emoji: '🎀', name: '粉色蝴蝶结', effect: '开心+15 形象更可爱', price: 50, happiness: 15, fullness: 0,  cleanliness: 0,  health: 0  }
  ],
  notebooks: seedNotebooks(),
  tasks: seedTasks(),
  profile: { nickname: '', avatar: '' }
}

// === Storage / migration === //

function clone(data) { return JSON.parse(JSON.stringify(data)) }

function migrateState(raw) {
  if (!raw || typeof raw !== 'object') return clone(defaultState)
  if (raw.schemaVersion === SCHEMA_VERSION && Array.isArray(raw.notebooks) && Array.isArray(raw.tasks)) {
    // already v2 — backfill missing fields just in case
    raw.notebooks = raw.notebooks.map((nb, i) => ({
      recurrence: null,
      endDate: null,
      order: i,
      ...nb
    }))
    // notebook.subject is no longer used; carry it down to tasks that lack one.
    const nbSubjectById = {}
    for (const nb of raw.notebooks) nbSubjectById[nb.id] = nb.subject || ''
    raw.tasks = raw.tasks.map((t, i) => ({
      order: i,
      subject: t.subject || nbSubjectById[t.notebookId] || '其他',
      ...t
    }))
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
    if (typeof raw.pendingShareCoins !== 'number') raw.pendingShareCoins = 0
    if (typeof raw.streakDays !== 'number') raw.streakDays = 0
    if (typeof raw.coins !== 'number') raw.coins = 0
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
      // Growth-XP system was replaced by coin-cost upgrades — strip the old
      // fields so cloud-sync doesn't carry them around forever.
      if ('growth' in raw.pet)          delete raw.pet.growth
      if ('nextLevelGrowth' in raw.pet) delete raw.pet.nextLevelGrowth
    }
    // Pre-cloud-sync data: stamp current time so this device's data wins on
    // first cloud sync (over a fresh empty cloud doc with updatedAt=0).
    if (typeof raw.updatedAt !== 'number') raw.updatedAt = Date.now()
    return raw
  }

  // v1 → v2: bucket all old tasks into one notebook for today (named by date).
  // Subject moves onto each task.
  const today = todayStr()
  const oldTasks = Array.isArray(raw.tasks) ? raw.tasks : []
  const notebooks = []
  const tasks = []
  if (oldTasks.length) {
    const nbId = 'nb_mig_today'
    notebooks.push({
      id: nbId,
      name: today,
      mode: 'one-shot',
      startDate: today,
      endDate: today,
      recurrence: null,
      createdAt: Date.now(),
      order: 0
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

  return {
    ...clone(defaultState),
    ...raw,
    schemaVersion: SCHEMA_VERSION,
    notebooks: notebooks.length ? notebooks : seedNotebooks(),
    tasks: notebooks.length ? tasks : seedTasks(),
    editTaskId: null,
    editNotebookId: null
  }
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
  // Push synced subset to cloud (debounced inside cloud-sync).
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
function applyHydratedState(remoteSyncedFields, remoteUpdatedAt) {
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

// === Notebook scheduling === //

function isNotebookActiveOn(nb, dateStr) {
  if (!nb) return false
  if (nb.startDate && compareDateStr(dateStr, nb.startDate) < 0) return false
  if (nb.mode === 'one-shot') {
    return dateStr === (nb.endDate || nb.startDate)
  }
  // recurring
  if (nb.endDate && compareDateStr(dateStr, nb.endDate) > 0) return false
  const rec = nb.recurrence || { type: 'daily' }
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
    actualMinutes: null
  }
}

function isRecurringTask(task, notebookById) {
  const nb = notebookById ? notebookById[task.notebookId] : null
  return !!(nb && nb.mode === 'recurring')
}

function getTaskState(task, notebook, dateStr) {
  if (!notebook) return defaultOccurrence()
  if (notebook.mode === 'one-shot') {
    return {
      status: task.status || 'todo',
      startedAt: task.startedAt || null,
      currentSegmentStartedAt: task.currentSegmentStartedAt || null,
      accumulatedMs: task.accumulatedMs || 0,
      completedAt: task.completedAt || null,
      actualMinutes: task.actualMinutes || null
    }
  }
  const occ = (task.occurrences || {})[dateStr]
  return occ ? { ...defaultOccurrence(), ...occ } : defaultOccurrence()
}

function applyTaskState(task, notebook, dateStr, patch) {
  if (notebook.mode === 'one-shot') {
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
function buildNotebookById(notebooks) {
  const map = {}
  for (const nb of notebooks) map[nb.id] = nb
  return map
}

// `cache` (optional) lets callers reuse precomputed lookups across many
// tasksForDate calls — e.g. calendar's monthly grid. Pass {} the first time
// and reuse the populated object across subsequent calls.
function tasksForDate(state, dateStr, cache) {
  const today = todayStr()
  const isFuture = compareDateStr(dateStr, today) > 0
  const isToday = dateStr === today
  const notebookById = (cache && cache.notebookById) || buildNotebookById(state.notebooks)
  if (cache && !cache.notebookById) cache.notebookById = notebookById

  const items = []
  for (const task of state.tasks) {
    const nb = notebookById[task.notebookId]
    if (!nb) continue
    const onSchedule = isNotebookActiveOn(nb, dateStr)
    let isOverdue = false
    let completedOnDate = false

    // For past/today views, also surface tasks actually completed that day.
    // Recurring tasks are date-keyed via occurrences so onSchedule already
    // covers them; this only matters for one-shot tasks completed off-schedule.
    if (!isFuture && nb.mode === 'one-shot') {
      const status = task.status || 'todo'
      if (status === 'done' && task.completedAt &&
          dateToStr(new Date(task.completedAt)) === dateStr) {
        completedOnDate = true
      }
    }

    // Overdue: still-open one-shot whose due date already passed. Today only.
    if (!onSchedule && isToday && nb.mode === 'one-shot') {
      const due = nb.endDate || nb.startDate
      if (compareDateStr(due, today) < 0 && (task.status || 'todo') !== 'done') {
        isOverdue = true
      }
    }

    if (!onSchedule && !isOverdue && !completedOnDate) continue
    const occ = getTaskState(task, nb, dateStr)
    items.push({
      task,
      notebook: nb,
      occurrence: occ,
      occurrenceDate: dateStr,
      isOverdue
    })
  }

  // Today view: surface past recurring occurrences that are either still
  // not done (red) OR were finished today (so a freshly-cleared backlog
  // item still appears, this time in the done section).
  if (isToday) {
    // Group recurring tasks by notebook so the active-date walk runs once
    // per notebook instead of once per task.
    const recurringTasksByNb = {}
    for (const task of state.tasks) {
      const nb = notebookById[task.notebookId]
      if (!nb || nb.mode !== 'recurring' || !nb.startDate) continue
      const list = recurringTasksByNb[nb.id] || (recurringTasksByNb[nb.id] = [])
      list.push(task)
    }
    for (const nbId of Object.keys(recurringTasksByNb)) {
      const nb = notebookById[nbId]
      const tasks = recurringTasksByNb[nbId]
      // Precompute the active dates from startDate up to (but not including)
      // today — depends only on the notebook.
      const activeDates = []
      let d = nb.startDate
      while (compareDateStr(d, today) < 0) {
        if (isNotebookActiveOn(nb, d)) activeDates.push(d)
        d = addDays(d, 1)
      }
      for (const task of tasks) {
        const occMap = task.occurrences || {}
        for (const ad of activeDates) {
          const raw = occMap[ad]
          const status = raw && raw.status ? raw.status : 'todo'
          if (status !== 'done') {
            items.push({
              task,
              notebook: nb,
              occurrence: { ...defaultOccurrence(), ...(raw || {}) },
              occurrenceDate: ad,
              isOverdue: true
            })
          } else if (raw && raw.completedAt &&
                     dateToStr(new Date(raw.completedAt)) === today) {
            items.push({
              task,
              notebook: nb,
              occurrence: { ...defaultOccurrence(), ...raw },
              occurrenceDate: ad,
              isOverdue: false
            })
          }
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

  // Group tasks by notebook so per-notebook computation (active-date walks)
  // happens once instead of per task.
  const tasksByNb = {}
  for (const t of state.tasks) {
    const list = tasksByNb[t.notebookId] || (tasksByNb[t.notebookId] = [])
    list.push(t)
  }

  for (const nb of state.notebooks) {
    const tasks = tasksByNb[nb.id]
    if (!tasks || !tasks.length) continue

    if (nb.mode === 'one-shot') {
      const due = nb.endDate || nb.startDate
      if (!due) continue
      const dueInMonth = compareDateStr(due, monthFirst) >= 0 &&
                        compareDateStr(due, monthLast) <= 0
      const dueIsPast = compareDateStr(due, today) < 0

      for (const t of tasks) {
        const status = t.status || 'todo'
        const isDone = status === 'done'

        // Cell on its scheduled (due) date — the task is on-schedule there.
        if (dueInMonth) {
          const c = ensure(due)
          c.total++
          if (isDone) c.done++
        }

        // Off-schedule completion: if completed on a non-future date
        // different from `due`, that cell also shows the task as done.
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

        // Overdue surfaces on TODAY'S cell (not on the due cell).
        if (todayInMonth && dueIsPast && !isDone) {
          const c = ensure(today)
          c.total++
          c.hasOverdue = true
        }
      }
    } else {
      // recurring
      if (!nb.startDate) continue

      // Active dates within the visible month — contribute to that cell.
      // Cap walk by nb.endDate if it falls before monthLast.
      const walkStart = compareDateStr(nb.startDate, monthFirst) >= 0 ? nb.startDate : monthFirst
      const walkEnd = nb.endDate && compareDateStr(nb.endDate, monthLast) < 0 ? nb.endDate : monthLast
      const monthActive = []
      if (compareDateStr(walkStart, walkEnd) <= 0) {
        let d = walkStart
        while (compareDateStr(d, walkEnd) <= 0) {
          if (isNotebookActiveOn(nb, d)) monthActive.push(d)
          d = addDays(d, 1)
        }
      }

      // Backlog: when today is in this month, today's cell also gets every
      // pre-today active occurrence that's still undone (red) or was
      // finished on today (cleared backlog row).
      let backlogActive = null
      if (todayInMonth) {
        backlogActive = []
        let d = nb.startDate
        while (compareDateStr(d, today) < 0) {
          if (isNotebookActiveOn(nb, d)) backlogActive.push(d)
          d = addDays(d, 1)
        }
      }

      for (const t of tasks) {
        const occMap = t.occurrences || {}

        // Per-active-date contribution to its own cell.
        for (let i = 0; i < monthActive.length; i++) {
          const ad = monthActive[i]
          const occ = occMap[ad]
          const c = ensure(ad)
          c.total++
          if (occ && occ.status === 'done') c.done++
        }

        // Backlog into today's cell.
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

// === Notebook CRUD === //

function genId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

function addNotebook(nb) {
  return updateState((state) => {
    const today = todayStr()
    const order = state.notebooks.length
    const item = {
      id: genId('nb'),
      name: nb.name || today,
      mode: nb.mode === 'recurring' ? 'recurring' : 'one-shot',
      startDate: nb.startDate || today,
      endDate: nb.endDate === undefined
        ? (nb.mode === 'recurring' ? null : today)
        : nb.endDate,
      recurrence: nb.mode === 'recurring'
        ? (nb.recurrence || { type: 'daily', weekdays: [] })
        : null,
      createdAt: Date.now(),
      order
    }
    state.notebooks.push(item)
    state._lastNotebookId = item.id
    return state
  })
}

function updateNotebook(id, patch) {
  return updateState((state) => {
    state.notebooks = state.notebooks.map((nb) => {
      if (nb.id !== id) return nb
      const merged = { ...nb, ...patch }
      if (merged.mode === 'recurring') {
        merged.recurrence = patch.recurrence || nb.recurrence || { type: 'daily', weekdays: [] }
      } else {
        merged.recurrence = null
      }
      return merged
    })
    return state
  })
}

function deleteNotebook(id) {
  return updateState((state) => {
    state.notebooks = state.notebooks.filter((nb) => nb.id !== id)
    state.tasks = state.tasks.filter((t) => t.notebookId !== id)
    return state
  })
}

function setEditNotebookId(id) {
  return updateState((state) => { state.editNotebookId = id; return state })
}

function clearEditNotebookId() {
  return updateState((state) => { state.editNotebookId = null; return state })
}

function getNotebookById(id) {
  const state = loadState()
  return state.notebooks.find((nb) => nb.id === id) || null
}

// Find an existing notebook with the same trimmed name (case-sensitive).
// Pass `excludeId` to skip a specific notebook (so editing a notebook to keep
// its current name doesn't false-positive on itself). Returns null if none.
function findNotebookByName(name, excludeId) {
  const target = (name || '').trim()
  if (!target) return null
  const state = loadState()
  for (const nb of state.notebooks) {
    if (excludeId && nb.id === excludeId) continue
    if ((nb.name || '').trim() === target) return nb
  }
  return null
}

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

function tasksOfNotebook(state, notebookId) {
  return state.tasks
    .filter((t) => t.notebookId === notebookId)
    .sort((a, b) => (a.order || 0) - (b.order || 0))
}

function addTask(payload) {
  return updateState((state) => {
    let notebookId = payload.notebookId
    // Legacy callers (OCR import) may pass {subject, content, ...} without
    // notebookId — auto-bucket into the one-shot notebook for today.
    if (!notebookId) {
      const today = todayStr()
      const existing = state.notebooks.find(
        (nb) => nb.mode === 'one-shot' && (nb.endDate || nb.startDate) === today
      )
      if (existing) {
        notebookId = existing.id
      } else {
        const nb = {
          id: genId('nb'),
          name: today,
          mode: 'one-shot',
          startDate: today,
          endDate: today,
          recurrence: null,
          createdAt: Date.now(),
          order: state.notebooks.length
        }
        state.notebooks.push(nb)
        notebookId = nb.id
      }
    }
    const nb = state.notebooks.find((n) => n.id === notebookId)
    // Append to the END of the global order space so new tasks land at the
    // bottom of the home undone list.
    const maxOrder = state.tasks.reduce((m, t) => Math.max(m, t.order || 0), -1)
    const base = {
      id: genId('tk'),
      notebookId,
      subject: payload.subject || '其他',
      content: payload.content || '',
      estimatedMinutes: Number(payload.estimatedMinutes || 0),
      order: maxOrder + 1,
      createdAt: Date.now()
    }
    if (nb && nb.mode === 'recurring') {
      base.occurrences = {}
    } else {
      Object.assign(base, defaultOccurrence())
    }
    state.tasks.push(base)
    return state
  })
}

function updateTask(taskId, updates) {
  return updateState((state) => {
    state.tasks = state.tasks.map((t) => {
      if (t.id !== taskId) return t
      const next = { ...t }
      if ('content' in updates) next.content = updates.content
      if ('subject' in updates) next.subject = updates.subject
      if ('estimatedMinutes' in updates) next.estimatedMinutes = Number(updates.estimatedMinutes || 0)
      if ('notebookId' in updates && updates.notebookId !== t.notebookId) {
        next.notebookId = updates.notebookId
        // append to end of new notebook
        next.order = state.tasks.filter((x) => x.notebookId === updates.notebookId).length
      }
      return next
    })
    return state
  })
}

function deleteTask(taskId) {
  return updateState((state) => {
    state.tasks = state.tasks.filter((t) => t.id !== taskId)
    return state
  })
}

function reorderTasksInNotebook(notebookId, orderedIds) {
  return updateState((state) => {
    const others = state.tasks.filter((t) => t.notebookId !== notebookId)
    const inNb = state.tasks.filter((t) => t.notebookId === notebookId)
    const idMap = new Map(inNb.map((t) => [t.id, t]))
    const next = []
    orderedIds.forEach((id, i) => {
      const t = idMap.get(id)
      if (t) {
        next.push({ ...t, order: i })
        idMap.delete(id)
      }
    })
    for (const t of idMap.values()) next.push({ ...t, order: next.length })
    state.tasks = [...others, ...next]
    return state
  })
}

// Rewrite the global `order` field for the listed tasks (in given sequence),
// leaving all other tasks' orders untouched. Used by the home page when the
// user drags across notebooks.
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
    const notebookById = {}
    for (const nb of state.notebooks) notebookById[nb.id] = nb
    // Group target order assignments by task
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
      const nb = notebookById[t.notebookId]
      if (!nb) return t
      if (nb.mode === 'one-shot') {
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
function getRowOrder(task, notebook, dateStr) {
  if (!notebook || notebook.mode === 'one-shot') return task.order || 0
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
  const notebookById = {}
  for (const nb of state.notebooks) notebookById[nb.id] = nb
  state.tasks = state.tasks.map((t) => {
    const nb = notebookById[t.notebookId]
    if (!nb) return t
    if (nb.mode === 'one-shot') {
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
    const nb = state.notebooks.find((n) => n.id === task.notebookId)
    if (!nb) return state
    const cur = getTaskState(task, nb, day)
    const patch = {
      status: 'doing',
      startedAt: cur.startedAt || now,
      currentSegmentStartedAt: now,
      accumulatedMs: cur.accumulatedMs || 0
    }
    state.tasks = state.tasks.map((t) =>
      t.id === taskId ? applyTaskState(t, nb, day, patch) : t
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
    const nb = state.notebooks.find((n) => n.id === task.notebookId)
    if (!nb) return state
    const cur = getTaskState(task, nb, day)
    state.tasks = state.tasks.map((t) =>
      t.id === taskId ? applyTaskState(t, nb, day, pauseInPlace(cur, now)) : t
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
    const nb = state.notebooks.find((n) => n.id === task.notebookId)
    if (!nb) return state
    const cur = getTaskState(task, nb, day)
    if (cur.status !== 'paused') return state
    const patch = { status: 'doing', currentSegmentStartedAt: now }
    state.tasks = state.tasks.map((t) =>
      t.id === taskId ? applyTaskState(t, nb, day, patch) : t
    )
    return state
  })
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
    const nb = state.notebooks.find((n) => n.id === task.notebookId)
    if (!nb) return state
    const cur = getTaskState(task, nb, day)
    if (cur.status !== 'done') return state
    const patch = {
      status: 'paused',
      completedAt: null,
      actualMinutes: null,
      currentSegmentStartedAt: null
    }
    state.tasks = state.tasks.map((t) =>
      t.id === taskId ? applyTaskState(t, nb, day, patch) : t
    )

    state.coins = Math.max(0, (state.coins || 0) - REWARD_PER_TASK)

    if (Array.isArray(state.perfectDays) && state.perfectDays.includes(day)) {
      const log = state.bonusByDay && state.bonusByDay[day]
      if (log) {
        const totalBonus = (log.dailyBonus || 0) + (log.weeklyBonus || 0)
        state.coins = Math.max(0, state.coins - totalBonus)
        state.streakDays = Math.max(0, log.prevStreakDays || 0)
        delete state.bonusByDay[day]
      }
      state.perfectDays = state.perfectDays.filter((d) => d !== day)
    }

    return state
  })
}

function finishTask(taskId, dateStr) {
  const day = dateStr || todayStr()
  return updateState((state) => {
    const now = Date.now()
    let reward = REWARD_PER_TASK
    let dailyBonus = 0
    let weeklyBonus = 0

    const task = state.tasks.find((t) => t.id === taskId)
    if (!task) return state
    const nb = state.notebooks.find((n) => n.id === task.notebookId)
    if (!nb) return state
    const cur = getTaskState(task, nb, day)
    const segMs = cur.currentSegmentStartedAt ? Math.max(0, now - cur.currentSegmentStartedAt) : 0
    const totalMs = (cur.accumulatedMs || 0) + segMs
    const patch = {
      status: 'done',
      accumulatedMs: totalMs,
      completedAt: now,
      actualMinutes: Math.max(1, Math.round(totalMs / 60000)),
      currentSegmentStartedAt: null
    }
    state.tasks = state.tasks.map((t) =>
      t.id === taskId ? applyTaskState(t, nb, day, patch) : t
    )

    // First all-done moment of the day → daily bonus + streak bookkeeping.
    // Re-completing after a revert doesn't double-credit because perfectDays
    // already contains the date.
    const todayItems = tasksForDate(state, day)
    const allDone = todayItems.length > 0 && todayItems.every((it) => it.occurrence.status === 'done')

    if (allDone) {
      if (!Array.isArray(state.perfectDays)) state.perfectDays = []
      if (!state.perfectDays.includes(day)) {
        // Bonus = today's item count × per-task coin, doubling the day's
        // earnings on a regular all-done. Early-bird tiers further scale by
        // completion hour (×2 / ×1.5 / ×1.25 before 19/20/21, see
        // EARLY_BIRD_TIERS) — only the daily bonus is scaled, not the per-task
        // +10 or the weekly streak.
        const baseBonus = todayItems.length * REWARD_DAILY_PERFECT_PER_TASK
        const multiplier = dailyPerfectMultiplier(new Date(now))
        dailyBonus = Math.round(baseBonus * multiplier)
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
        if (!state.bonusByDay || typeof state.bonusByDay !== 'object') state.bonusByDay = {}
        state.bonusByDay[day] = { dailyBonus, weeklyBonus, prevStreakDays }
      }
    }

    state.coins += reward
    state.lastReward = { reward, dailyBonus, weeklyBonus, taskId, finishedAt: now }
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
    state.coins -= item.price
    state.pet.happiness   = Math.min(state.pet.happiness   + (item.happiness   || 0), 100)
    state.pet.fullness    = Math.min(state.pet.fullness    + (item.fullness    || 0), 100)
    state.pet.cleanliness = Math.min(state.pet.cleanliness + (item.cleanliness || 0), 100)
    state.pet.health      = Math.min(state.pet.health      + (item.health      || 0), 100)
    return state
  })
}

// Manual coin-cost upgrade: caller should gate on coins >= getLevelCost(level).
// Returns { ok, level, cost } via state.lastLevelUp so UI can flash a toast.
function levelUpPet() {
  let result = null
  updateState((state) => {
    if (!state.pet || !state.pet.species) {
      result = { ok: false, reason: 'no-pet' }
      return state
    }
    const cost = getLevelCost(state.pet.level || 1)
    if ((state.coins || 0) < cost) {
      result = { ok: false, reason: 'not-enough-coins', cost }
      return state
    }
    state.coins -= cost
    state.pet = commitPetDecay(state.pet)
    state.pet.level = (state.pet.level || 1) + 1
    // Tiny celebration: top off the most decay-prone stats so the upgrade
    // moment feels rewarding instead of immediately needy.
    state.pet.happiness = Math.min((state.pet.happiness || 0) + 20, 100)
    state.pet.fullness  = Math.min((state.pet.fullness  || 0) + 20, 100)
    state.lastLevelUp = { level: state.pet.level, cost, at: Date.now() }
    result = { ok: true, level: state.pet.level, cost }
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
    state.coins -= PET_SWITCH_COST
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
      // 当 OCR 从某个作业本详情页发起时,带上 notebookId,
      // 让 ocr-result 把 drafts 落到指定作业本,而不是默认的当日 one-shot。
      notebookId: job.notebookId || '',
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
// `from` carries the sharer's nickname (empty if not set).
// `sharer` carries sharer's openid (when available) + a stable notebook id,
// so the receiver can credit a save back to the sharer via cloud function.
function serializeNotebookForShare(notebookId, sharerOpenid) {
  const state = loadState()
  const nb = state.notebooks.find((n) => n.id === notebookId)
  if (!nb) return null
  // estimatedMinutes is intentionally omitted from the share payload so the
  // receiver can auto-estimate against THEIR own history (different kid,
  // different pace) instead of inheriting the sharer's number.
  const tasks = state.tasks
    .filter((t) => t.notebookId === notebookId)
    .sort((a, b) => (a.order || 0) - (b.order || 0))
    .map((t) => ({
      s: t.subject || '其他',
      c: t.content || ''
    }))
  return {
    v: 1,
    from: (state.profile && state.profile.nickname) || '',
    sharer: sharerOpenid || '',
    nbId: nb.id,
    n: {
      name: nb.name,
      mode: nb.mode,
      startDate: nb.startDate,
      endDate: nb.endDate,
      recurrence: nb.recurrence
    },
    t: tasks
  }
}

// Apply share-save coins claimed from cloud. Caller passes the total coins
// already aggregated by the cloud function; we just credit them locally and
// record a lastReward so the UI can flash a "+X 金币" message.
function applyShareRewardClaim({ total, count, notebooks }) {
  if (!total || total <= 0) return null
  let next = null
  updateState((state) => {
    state.coins = (state.coins || 0) + total
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

// Build the metadata block for a freshly-imported notebook from a share
// payload. Does NOT touch state — pure derivation.
function buildNotebookFromShare(n, today, order, name) {
  return {
    id: genId('nb'),
    name: name || n.name || today,
    mode: n.mode === 'recurring' ? 'recurring' : 'one-shot',
    startDate: n.startDate || today,
    endDate: n.endDate === undefined
      ? (n.mode === 'recurring' ? null : today)
      : n.endDate,
    recurrence: n.mode === 'recurring'
      ? (n.recurrence || { type: 'daily', weekdays: [] })
      : null,
    createdAt: Date.now(),
    order
  }
}

// Build a task row from a share payload entry under a target notebook.
// Auto-estimates `estimatedMinutes` from the user's finished-task history
// when the share didn't carry one (it never does — we strip it on share).
// Status is reset to fresh: every imported task starts as todo.
function buildTaskFromShare(item, nb) {
  const base = {
    id: genId('tk'),
    notebookId: nb.id,
    subject: item.s || '其他',
    content: item.c || '',
    estimatedMinutes: Number(item.m || estimateTaskMinutes(item.c, item.s) || 0),
    createdAt: Date.now()
  }
  if (nb.mode === 'recurring') {
    base.occurrences = {}
  } else {
    Object.assign(base, defaultOccurrence())
  }
  return base
}

// Generate a unique-name candidate by appending " 复制" until no other
// notebook has the same trimmed name. Existing match's id can be excluded
// (caller may want to rename when the share IS the same notebook reimported).
function pickRenameCandidate(state, baseName) {
  const trimmed = (baseName || '').trim() || todayStr()
  let candidate = `${trimmed} 复制`
  while (state.notebooks.some((nb) => (nb.name || '').trim() === candidate)) {
    candidate = `${candidate} 复制`
  }
  return candidate
}

// Import a shared notebook payload. `options.mode` controls duplicate-name
// handling:
//   'new'       — caller already verified no name conflict; create as-is
//   'rename'    — append " 复制" (repeated if needed) to dodge the conflict
//   'merge'     — append the share's tasks to options.targetNotebookId.
//                 No dedupe; every imported task starts as todo.
//   'overwrite' — replace options.targetNotebookId's metadata + tasks.
//                 KEEPS the original notebook id, so existing progress
//                 (coins / streak history) stays intact —
//                 only this notebook's task rows are swapped out.
// Returns the resulting notebook id (caller usually navigates to it), or
// null if the device is read-only or the payload is invalid.
function importSharedNotebook(payload, options) {
  if (!payload || !payload.n) return null
  const opts = options || {}
  const mode = opts.mode || 'new'
  const targetId = opts.targetNotebookId
  const n = payload.n
  const tasks = Array.isArray(payload.t) ? payload.t : []
  const today = todayStr()
  let resultId = null
  updateState((state) => {
    if (mode === 'merge') {
      const target = state.notebooks.find((nb) => nb.id === targetId)
      if (!target) return state
      const maxOrder = state.tasks.reduce((m, t) => Math.max(m, t.order || 0), -1)
      let cursor = maxOrder + 1
      for (const it of tasks) {
        const row = buildTaskFromShare(it, target)
        row.order = cursor++
        state.tasks.push(row)
      }
      resultId = target.id
      return state
    }
    if (mode === 'overwrite') {
      const idx = state.notebooks.findIndex((nb) => nb.id === targetId)
      if (idx < 0) return state
      // Drop just the old tasks; keep the notebook id so any external
      // references (recent rewards logged against this nb, etc.) remain
      // valid and the user's progress history isn't reset.
      state.tasks = state.tasks.filter((t) => t.notebookId !== targetId)
      const old = state.notebooks[idx]
      const replaced = {
        ...old,
        name: n.name || old.name,
        mode: n.mode === 'recurring' ? 'recurring' : 'one-shot',
        startDate: n.startDate || old.startDate || today,
        endDate: n.endDate === undefined
          ? (n.mode === 'recurring' ? null : (n.startDate || today))
          : n.endDate,
        recurrence: n.mode === 'recurring'
          ? (n.recurrence || { type: 'daily', weekdays: [] })
          : null
      }
      state.notebooks[idx] = replaced
      const maxOrder = state.tasks.reduce((m, t) => Math.max(m, t.order || 0), -1)
      let cursor = maxOrder + 1
      for (const it of tasks) {
        const row = buildTaskFromShare(it, replaced)
        row.order = cursor++
        state.tasks.push(row)
      }
      resultId = replaced.id
      return state
    }
    // 'new' or 'rename'
    const finalName = mode === 'rename'
      ? pickRenameCandidate(state, n.name)
      : (n.name || today)
    const nb = buildNotebookFromShare(n, today, state.notebooks.length, finalName)
    state.notebooks.push(nb)
    resultId = nb.id
    const maxOrder = state.tasks.reduce((m, t) => Math.max(m, t.order || 0), -1)
    let cursor = maxOrder + 1
    for (const it of tasks) {
      const row = buildTaskFromShare(it, nb)
      row.order = cursor++
      state.tasks.push(row)
    }
    return state
  })
  return resultId
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
  // notebook
  addNotebook,
  updateNotebook,
  deleteNotebook,
  setEditNotebookId,
  clearEditNotebookId,
  getNotebookById,
  findNotebookByName,
  // task
  addTask,
  updateTask,
  deleteTask,
  reorderTasksInNotebook,
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
  tasksOfNotebook,
  dateCountsForMonth,
  isNotebookActiveOn,
  getTaskState,
  // pet
  PET_SPECIES,
  PET_SWITCH_COST,
  PET_DECAY_PER_HOUR,
  LEVEL_COSTS,
  getLevelCost,
  petAgeDays,
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
  serializeNotebookForShare,
  importSharedNotebook,
  applyShareRewardClaim,
  // cloud-sync interface (for cloud-sync module's use; pages should use
  // cloudSync.hydrateIfStale directly)
  applyHydratedState,
  getStateForSync,
  getUpdatedAt,
  // reward rules (read-only constants exposed for UI display + tests)
  REWARD_PER_TASK,
  REWARD_DAILY_PERFECT_PER_TASK,
  REWARD_WEEKLY_STREAK,
  EARLY_BIRD_TIERS,
  dailyPerfectMultiplier,
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
