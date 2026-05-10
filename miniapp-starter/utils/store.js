const cloudSync = require('./cloud-sync')

const STORAGE_KEY = 'homework-pet-v1'
const SCHEMA_VERSION = 2

// Subset of state fields synced to cloud. Everything else is local-only:
// transient UI state (editTaskId, editNotebookId), OCR jobs (ephemeral and
// large), and app-wide config that's the same for everyone (rewardRules,
// shopItems, schemaVersion).
const SYNC_FIELDS = [
  'notebooks', 'tasks',
  'coins', 'streakDays', 'bonusCoins',
  'pet', 'lastReward'
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
  coins: 36,
  streakDays: 4,
  bonusCoins: 10,
  editTaskId: null,
  editNotebookId: null,
  ocrCurrentJob: null,
  ocrJobs: [],
  rewardRules: [
    { title: '完成单项作业', coins: 5 },
    { title: '按计划完成', coins: 3 },
    { title: '全部完成奖励', coins: 10 },
    { title: '连续 3 天打卡', coins: 20 }
  ],
  pet: {
    name: '小牛同学',
    emoji: '🐮',
    level: 2,
    growth: 38,
    nextLevelGrowth: 60,
    happiness: 76,
    fullness: 68
  },
  shopItems: [
    { id: 1, emoji: '🥕', name: '营养胡萝卜', effect: '开心值 +8，饱腹值 +12', price: 12, happiness: 8, fullness: 12, growth: 5 },
    { id: 2, emoji: '🧸', name: '陪玩玩具熊', effect: '开心值 +15', price: 20, happiness: 15, fullness: 0, growth: 8 },
    { id: 3, emoji: '🎀', name: '粉色蝴蝶结', effect: '成长值 +10，形象更可爱', price: 28, happiness: 5, fullness: 0, growth: 10 }
  ],
  notebooks: seedNotebooks(),
  tasks: seedTasks()
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
  try {
    const raw = wx.getStorageSync(STORAGE_KEY)
    if (raw && typeof raw === 'object') {
      _stateCache = migrateState(raw)
      return _stateCache
    }
  } catch (error) {
    console.warn('loadState failed', error)
  }
  _stateCache = clone(defaultState)
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
  return { ...loadState() }
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
// Keeps accumulatedMs so the user picks up where they left off.
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
    return state
  })
}

function finishTask(taskId, dateStr) {
  const day = dateStr || todayStr()
  return updateState((state) => {
    const now = Date.now()
    let reward = 8
    let leveledUp = false

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

    // Check if all today's tasks are done — bonus.
    const remaining = tasksForDate(state, day).filter((it) => it.occurrence.status !== 'done')
    if (remaining.length === 0) reward += state.bonusCoins

    state.coins += reward
    state.pet.growth += 6
    state.pet.happiness = Math.min(state.pet.happiness + 6, 100)
    if (state.pet.growth >= state.pet.nextLevelGrowth) {
      state.pet.level += 1
      state.pet.growth -= state.pet.nextLevelGrowth
      state.pet.nextLevelGrowth += 20
      state.pet.fullness = Math.min(state.pet.fullness + 10, 100)
      leveledUp = true
    }
    state.lastReward = { reward, leveledUp, taskId, finishedAt: now }
    return state
  })
}

// === Pet shop (unchanged) === //

function buyItem(itemId) {
  return updateState((state) => {
    const item = state.shopItems.find((s) => s.id === itemId)
    if (!item || state.coins < item.price) return state
    state.coins -= item.price
    state.pet.happiness = Math.min(state.pet.happiness + item.happiness, 100)
    state.pet.fullness = Math.min(state.pet.fullness + item.fullness, 100)
    state.pet.growth = Math.min(state.pet.growth + item.growth, state.pet.nextLevelGrowth)
    return state
  })
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
  buyItem,
  // ocr
  setCurrentOcrJob,
  getCurrentOcrJob,
  clearCurrentOcrJob,
  // cloud-sync interface (for cloud-sync module's use; pages should use
  // cloudSync.hydrateIfStale directly)
  applyHydratedState,
  getStateForSync,
  getUpdatedAt,
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
