const STORAGE_KEY = 'homework-pet-v1'
const SCHEMA_VERSION = 2

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
  return [
    {
      id: 'nb_seed_1',
      name: '语文 · 春晓',
      subject: '语文',
      mode: 'one-shot',
      startDate: today,
      endDate: today,
      recurrence: null,
      createdAt: Date.now(),
      order: 0
    },
    {
      id: 'nb_seed_2',
      name: '数学 · 每日口算',
      subject: '数学',
      mode: 'recurring',
      startDate: today,
      endDate: null,
      recurrence: { type: 'daily', weekdays: [] },
      createdAt: Date.now(),
      order: 1
    }
  ]
}

function seedTasks() {
  return [
    {
      id: 'tk_seed_1',
      notebookId: 'nb_seed_1',
      content: '完成《春晓》抄写 2 遍，并朗读 3 次',
      estimatedMinutes: 20,
      order: 0,
      createdAt: Date.now(),
      status: 'todo',
      startedAt: null,
      currentSegmentStartedAt: null,
      accumulatedMs: 0,
      completedAt: null,
      actualMinutes: null
    },
    {
      id: 'tk_seed_2',
      notebookId: 'nb_seed_2',
      content: '口算练习 2 页',
      estimatedMinutes: 25,
      order: 0,
      createdAt: Date.now(),
      occurrences: {}
    }
  ]
}

const defaultState = {
  schemaVersion: SCHEMA_VERSION,
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
    raw.tasks = raw.tasks.map((t, i) => ({
      order: i,
      ...t
    }))
    raw.editNotebookId = raw.editNotebookId || null
    return raw
  }

  // v1 → v2: bucket existing tasks by subject into one-shot notebooks for today
  const today = todayStr()
  const oldTasks = Array.isArray(raw.tasks) ? raw.tasks : []
  const subjectToNotebookId = new Map()
  const notebooks = []
  const tasks = []
  let notebookSeq = 1

  for (const old of oldTasks) {
    const subject = old.subject || '其他'
    let nbId = subjectToNotebookId.get(subject)
    if (!nbId) {
      nbId = `nb_mig_${notebookSeq++}`
      subjectToNotebookId.set(subject, nbId)
      notebooks.push({
        id: nbId,
        name: subject,
        subject,
        mode: 'one-shot',
        startDate: today,
        endDate: today,
        recurrence: null,
        createdAt: Date.now(),
        order: notebooks.length
      })
    }
    tasks.push({
      id: `tk_mig_${old.id || tasks.length + 1}`,
      notebookId: nbId,
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

function loadState() {
  try {
    const raw = wx.getStorageSync(STORAGE_KEY)
    if (raw && typeof raw === 'object') {
      return migrateState(raw)
    }
  } catch (error) {
    console.warn('loadState failed', error)
  }
  return clone(defaultState)
}

function saveState(state) {
  wx.setStorageSync(STORAGE_KEY, state)
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

// All tasks visible on a given date.
// Today view also includes overdue one-shot tasks (endDate < today AND not done).
function tasksForDate(state, dateStr) {
  const today = todayStr()
  const isToday = dateStr === today
  const notebookById = {}
  for (const nb of state.notebooks) notebookById[nb.id] = nb

  const items = []
  for (const task of state.tasks) {
    const nb = notebookById[task.notebookId]
    if (!nb) continue
    const onSchedule = isNotebookActiveOn(nb, dateStr)
    let isOverdue = false
    if (!onSchedule && isToday && nb.mode === 'one-shot') {
      const due = nb.endDate || nb.startDate
      if (compareDateStr(due, today) < 0 && (task.status || 'todo') !== 'done') {
        isOverdue = true
      }
    }
    if (!onSchedule && !isOverdue) continue
    const occ = getTaskState(task, nb, dateStr)
    items.push({
      task,
      notebook: nb,
      occurrence: occ,
      isOverdue
    })
  }
  return items
}

// === Compute helpers === //

function calcOverview(state) {
  const today = todayStr()
  const items = tasksForDate(state, today)
  const total = items.length
  const done = items.filter((it) => it.occurrence.status === 'done').length
  const pending = total - done
  const totalMinutes = items.reduce((s, it) => s + Number(it.task.estimatedMinutes || 0), 0)
  const completedMinutes = items
    .filter((it) => it.occurrence.status === 'done')
    .reduce((s, it) => s + Number(it.task.estimatedMinutes || 0), 0)
  return {
    pendingCount: pending,
    todayCoins: state.coins,
    completedMinutes,
    totalMinutes,
    progressPercent: total ? Math.round((done / total) * 100) : 0,
    doneCount: done,
    totalCount: total,
    streakDays: state.streakDays
  }
}

function getStateWithComputed() {
  const state = loadState()
  return { ...state, overview: calcOverview(state) }
}

function updateState(updater) {
  const state = loadState()
  const next = updater(clone(state))
  saveState(next)
  return { ...next, overview: calcOverview(next) }
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
      name: nb.name || '未命名作业本',
      subject: nb.subject || '其他',
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

function reorderNotebooks(orderedIds) {
  return updateState((state) => {
    const idMap = new Map(state.notebooks.map((nb) => [nb.id, nb]))
    const next = []
    orderedIds.forEach((id, i) => {
      const nb = idMap.get(id)
      if (nb) {
        next.push({ ...nb, order: i })
        idMap.delete(id)
      }
    })
    for (const nb of idMap.values()) next.push({ ...nb, order: next.length })
    state.notebooks = next
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
    // Legacy callers may pass {subject, content, ...} without notebookId (e.g. OCR import).
    // Auto-bucket into a today one-shot notebook per subject.
    if (!notebookId) {
      const today = todayStr()
      const subject = payload.subject || '其他'
      const existing = state.notebooks.find(
        (nb) => nb.mode === 'one-shot' && nb.subject === subject && (nb.endDate || nb.startDate) === today
      )
      if (existing) {
        notebookId = existing.id
      } else {
        const nb = {
          id: genId('nb'),
          name: `${subject} · 今日`,
          subject,
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
    // bottom of the home undone list. Notebook-detail still sorts by `order`,
    // so within a notebook this also reads as "appended at the end".
    const maxOrder = state.tasks.reduce((m, t) => Math.max(m, t.order || 0), -1)
    const base = {
      id: genId('tk'),
      notebookId,
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

// Auto-pause every other doing task on the same date — only one active at a time.
function pauseOthersOnDate(state, exceptTaskId, dateStr, now) {
  const notebookById = {}
  for (const nb of state.notebooks) notebookById[nb.id] = nb
  state.tasks = state.tasks.map((t) => {
    if (t.id === exceptTaskId) return t
    const nb = notebookById[t.notebookId]
    if (!nb) return t
    if (!isNotebookActiveOn(nb, dateStr)) return t
    const cur = getTaskState(t, nb, dateStr)
    if (cur.status !== 'doing') return t
    return applyTaskState(t, nb, dateStr, pauseInPlace(cur, now))
  })
}

function startTask(taskId, dateStr) {
  const day = dateStr || todayStr()
  return updateState((state) => {
    const now = Date.now()
    pauseOthersOnDate(state, taskId, day, now)
    state.tasks = state.tasks.map((t) => {
      if (t.id !== taskId) return t
      const nb = state.notebooks.find((n) => n.id === t.notebookId)
      if (!nb) return t
      const cur = getTaskState(t, nb, day)
      const patch = {
        status: 'doing',
        startedAt: cur.startedAt || now,
        currentSegmentStartedAt: now,
        accumulatedMs: cur.accumulatedMs || 0
      }
      return applyTaskState(t, nb, day, patch)
    })
    return state
  })
}

function pauseTask(taskId, dateStr) {
  const day = dateStr || todayStr()
  return updateState((state) => {
    const now = Date.now()
    state.tasks = state.tasks.map((t) => {
      if (t.id !== taskId) return t
      const nb = state.notebooks.find((n) => n.id === t.notebookId)
      if (!nb) return t
      const cur = getTaskState(t, nb, day)
      return applyTaskState(t, nb, day, pauseInPlace(cur, now))
    })
    return state
  })
}

function resumeTask(taskId, dateStr) {
  const day = dateStr || todayStr()
  return updateState((state) => {
    const now = Date.now()
    pauseOthersOnDate(state, taskId, day, now)
    state.tasks = state.tasks.map((t) => {
      if (t.id !== taskId) return t
      const nb = state.notebooks.find((n) => n.id === t.notebookId)
      if (!nb) return t
      const cur = getTaskState(t, nb, day)
      if (cur.status !== 'paused') return t
      return applyTaskState(t, nb, day, {
        status: 'doing',
        currentSegmentStartedAt: now
      })
    })
    return state
  })
}

function finishTask(taskId, dateStr) {
  const day = dateStr || todayStr()
  return updateState((state) => {
    const now = Date.now()
    let reward = 8
    let leveledUp = false

    state.tasks = state.tasks.map((t) => {
      if (t.id !== taskId) return t
      const nb = state.notebooks.find((n) => n.id === t.notebookId)
      if (!nb) return t
      const cur = getTaskState(t, nb, day)
      const segMs = cur.currentSegmentStartedAt ? Math.max(0, now - cur.currentSegmentStartedAt) : 0
      const totalMs = (cur.accumulatedMs || 0) + segMs
      return applyTaskState(t, nb, day, {
        status: 'done',
        accumulatedMs: totalMs,
        completedAt: now,
        actualMinutes: Math.max(1, Math.round(totalMs / 60000)),
        currentSegmentStartedAt: null
      })
    })

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
  reorderNotebooks,
  setEditNotebookId,
  clearEditNotebookId,
  getNotebookById,
  // task
  addTask,
  updateTask,
  deleteTask,
  reorderTasksInNotebook,
  reorderTasks,
  setEditTaskId,
  clearEditTaskId,
  // task control
  startTask,
  pauseTask,
  resumeTask,
  finishTask,
  // queries
  tasksForDate,
  tasksOfNotebook,
  isNotebookActiveOn,
  getTaskState,
  // pet
  buyItem,
  // ocr
  setCurrentOcrJob,
  getCurrentOcrJob,
  clearCurrentOcrJob,
  // misc
  getCurrentTime
}
