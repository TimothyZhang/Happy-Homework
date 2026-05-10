// Quick correctness check after the perf optimizations.
// Compares outputs of optimized store against a reference oracle that
// reproduces the original (pre-optimization) algorithm.
// Run: `node scripts/perf-correctness.js`

let storage = {}
global.wx = {
  getStorageSync: (k) => {
    if (!(k in storage)) return ''
    return JSON.parse(storage[k])
  },
  setStorageSync: (k, v) => { storage[k] = JSON.stringify(v) },
  cloud: undefined,
  showToast: () => {},
  showModal: () => {}
}

function pad2(n) { return String(n).padStart(2, '0') }
function dateToStr(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` }
function strToDate(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d) }
function addDays(s, n) { const d = strToDate(s); d.setDate(d.getDate() + n); return dateToStr(d) }
function todayStr() { return dateToStr(new Date()) }
function compareDateStr(a, b) { return a === b ? 0 : (a < b ? -1 : 1) }
function weekdayOf(s) { const w = strToDate(s).getDay(); return w === 0 ? 7 : w }

function isNotebookActiveOn(nb, dateStr) {
  if (!nb) return false
  if (nb.startDate && compareDateStr(dateStr, nb.startDate) < 0) return false
  if (nb.mode === 'one-shot') return dateStr === (nb.endDate || nb.startDate)
  if (nb.endDate && compareDateStr(dateStr, nb.endDate) > 0) return false
  const rec = nb.recurrence || { type: 'daily' }
  if (rec.type === 'daily') return true
  if (rec.type === 'weekly') {
    const wds = Array.isArray(rec.weekdays) ? rec.weekdays : []
    return wds.includes(weekdayOf(dateStr))
  }
  return false
}

function defaultOcc() {
  return {
    status: 'todo', startedAt: null, currentSegmentStartedAt: null,
    accumulatedMs: 0, completedAt: null, actualMinutes: null
  }
}

function getTaskState(task, nb, dateStr) {
  if (!nb) return defaultOcc()
  if (nb.mode === 'one-shot') {
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
  return occ ? { ...defaultOcc(), ...occ } : defaultOcc()
}

// --- Reference (original) tasksForDate ---
function refTasksForDate(state, dateStr) {
  const today = todayStr()
  const isFuture = compareDateStr(dateStr, today) > 0
  const isToday = dateStr === today
  const notebookById = {}
  for (const nb of state.notebooks) notebookById[nb.id] = nb

  const items = []
  for (const task of state.tasks) {
    const nb = notebookById[task.notebookId]
    if (!nb) continue
    const onSchedule = isNotebookActiveOn(nb, dateStr)
    let isOverdue = false
    let completedOnDate = false
    if (!isFuture && nb.mode === 'one-shot') {
      const status = task.status || 'todo'
      if (status === 'done' && task.completedAt &&
          dateToStr(new Date(task.completedAt)) === dateStr) {
        completedOnDate = true
      }
    }
    if (!onSchedule && isToday && nb.mode === 'one-shot') {
      const due = nb.endDate || nb.startDate
      if (compareDateStr(due, today) < 0 && (task.status || 'todo') !== 'done') {
        isOverdue = true
      }
    }
    if (!onSchedule && !isOverdue && !completedOnDate) continue
    const occ = getTaskState(task, nb, dateStr)
    items.push({ taskId: task.id, nbId: nb.id, occurrenceDate: dateStr, status: occ.status, isOverdue })
  }

  if (isToday) {
    for (const task of state.tasks) {
      const nb = notebookById[task.notebookId]
      if (!nb || nb.mode !== 'recurring') continue
      if (!nb.startDate) continue
      let d = nb.startDate
      while (compareDateStr(d, today) < 0) {
        if (isNotebookActiveOn(nb, d)) {
          const raw = (task.occurrences || {})[d]
          const status = raw && raw.status ? raw.status : 'todo'
          if (status !== 'done') {
            const occ = { ...defaultOcc(), ...(raw || {}) }
            items.push({ taskId: task.id, nbId: nb.id, occurrenceDate: d, status: occ.status, isOverdue: true })
          } else if (raw && raw.completedAt &&
                     dateToStr(new Date(raw.completedAt)) === today) {
            const occ = { ...defaultOcc(), ...raw }
            items.push({ taskId: task.id, nbId: nb.id, occurrenceDate: d, status: occ.status, isOverdue: false })
          }
        }
        d = addDays(d, 1)
      }
    }
  }
  return items
}

function normalize(items) {
  return items
    .map((it) => ({
      taskId: it.task ? it.task.id : it.taskId,
      nbId: it.notebook ? it.notebook.id : it.nbId,
      occurrenceDate: it.occurrenceDate,
      status: it.occurrence ? it.occurrence.status : it.status,
      isOverdue: !!it.isOverdue
    }))
    .sort((a, b) => {
      if (a.taskId !== b.taskId) return a.taskId < b.taskId ? -1 : 1
      return a.occurrenceDate < b.occurrenceDate ? -1 : 1
    })
}

// --- Seed: a mix to exercise all code paths ---
function seed() {
  const today = todayStr()
  const y2 = addDays(today, -2)
  const y5 = addDays(today, -5)
  const tom = addDays(today, 1)
  const notebooks = []
  const tasks = []
  // one-shot: today
  notebooks.push({ id: 'nb1', name: 'today', mode: 'one-shot', startDate: today, endDate: today, recurrence: null, createdAt: 1, order: 0 })
  tasks.push({ id: 't1', notebookId: 'nb1', subject: '语', content: 'a', estimatedMinutes: 5, order: 0, createdAt: 1, status: 'todo', startedAt: null, currentSegmentStartedAt: null, accumulatedMs: 0, completedAt: null, actualMinutes: null })
  tasks.push({ id: 't2', notebookId: 'nb1', subject: '数', content: 'b', estimatedMinutes: 5, order: 1, createdAt: 2, status: 'done', startedAt: null, currentSegmentStartedAt: null, accumulatedMs: 0, completedAt: Date.now(), actualMinutes: 5 })
  // one-shot: overdue (yesterday) — t3 still todo, t4 done yesterday
  notebooks.push({ id: 'nb2', name: 'overdue', mode: 'one-shot', startDate: y2, endDate: y2, recurrence: null, createdAt: 2, order: 1 })
  tasks.push({ id: 't3', notebookId: 'nb2', subject: '语', content: 'c', estimatedMinutes: 5, order: 2, createdAt: 3, status: 'todo', startedAt: null, currentSegmentStartedAt: null, accumulatedMs: 0, completedAt: null, actualMinutes: null })
  tasks.push({ id: 't4', notebookId: 'nb2', subject: '数', content: 'd', estimatedMinutes: 5, order: 3, createdAt: 4, status: 'done', startedAt: null, currentSegmentStartedAt: null, accumulatedMs: 0, completedAt: strToDate(y2).getTime() + 12 * 3600 * 1000, actualMinutes: 5 })
  // one-shot: future
  notebooks.push({ id: 'nb3', name: 'future', mode: 'one-shot', startDate: tom, endDate: tom, recurrence: null, createdAt: 3, order: 2 })
  tasks.push({ id: 't5', notebookId: 'nb3', subject: '英', content: 'e', estimatedMinutes: 5, order: 4, createdAt: 5, status: 'todo', startedAt: null, currentSegmentStartedAt: null, accumulatedMs: 0, completedAt: null, actualMinutes: null })
  // recurring daily — backdated 5 days, with mixed occurrences
  notebooks.push({ id: 'nb4', name: 'daily', mode: 'recurring', startDate: y5, endDate: null, recurrence: { type: 'daily', weekdays: [] }, createdAt: 4, order: 3 })
  tasks.push({
    id: 't6', notebookId: 'nb4', subject: '语', content: 'f', estimatedMinutes: 5, order: 5, createdAt: 6,
    occurrences: {
      [addDays(today, -5)]: { ...defaultOcc(), status: 'done', completedAt: strToDate(addDays(today, -5)).getTime() },
      [addDays(today, -4)]: { ...defaultOcc(), status: 'todo' },
      [addDays(today, -3)]: { ...defaultOcc(), status: 'paused' },
      // -2 missing => default todo
      [addDays(today, -1)]: { ...defaultOcc(), status: 'done', completedAt: Date.now() }, // finished today off-schedule
      [today]: { ...defaultOcc(), status: 'todo' }
    }
  })
  tasks.push({ id: 't7', notebookId: 'nb4', subject: '数', content: 'g', estimatedMinutes: 5, order: 6, createdAt: 7, occurrences: {} })
  // recurring weekly — Mon/Wed only
  notebooks.push({ id: 'nb5', name: 'weekly', mode: 'recurring', startDate: y5, endDate: null, recurrence: { type: 'weekly', weekdays: [1, 3] }, createdAt: 5, order: 4 })
  tasks.push({ id: 't8', notebookId: 'nb5', subject: '英', content: 'h', estimatedMinutes: 5, order: 7, createdAt: 8, occurrences: {} })

  storage['homework-pet-v1'] = JSON.stringify({
    schemaVersion: 2, coins: 0, streakDays: 0, bonusCoins: 10,
    testCoinsGranted: true, coinLogs: [],
    editTaskId: null, editNotebookId: null, ocrCurrentJob: null, ocrJobs: [], rewardRules: [],
    pet: { name: 'p', emoji: '🐮', level: 1, growth: 0, nextLevelGrowth: 60, happiness: 50, fullness: 50 },
    shopItems: [], notebooks, tasks
  })
}

// --- Run ---
function run() {
  seed()
  const storePath = require('path').resolve(__dirname, '../utils/store.js')
  delete require.cache[require.resolve(storePath)]
  const store = require(storePath)

  let pass = 0, fail = 0
  function check(label, a, b) {
    const sa = JSON.stringify(a)
    const sb = JSON.stringify(b)
    if (sa === sb) {
      pass++
      console.log(`  ✓ ${label}`)
    } else {
      fail++
      console.log(`  ✗ ${label}`)
      console.log('    optimized:', sa)
      console.log('    reference:', sb)
    }
  }

  const state = store.getStateWithComputed()
  const today = todayStr()
  const dates = [today, addDays(today, -1), addDays(today, -2), addDays(today, -5), addDays(today, 1)]

  for (const d of dates) {
    const opt = normalize(store.tasksForDate(state, d))
    const ref = normalize(refTasksForDate(state, d))
    check(`tasksForDate(${d})`, opt, ref)
  }

  // tasksForDate with cache vs without — should match
  const cache = {}
  for (const d of dates) {
    const cached = normalize(store.tasksForDate(state, d, cache))
    const fresh = normalize(store.tasksForDate(state, d))
    check(`tasksForDate(${d}) cache==fresh`, cached, fresh)
  }

  // dateCountsForMonth aggregator vs per-day tasksForDate
  // Test current month (with backlog) and adjacent months
  const monthsToTest = [
    { y: strToDate(today).getFullYear(), m: strToDate(today).getMonth() },          // current
    { y: strToDate(today).getFullYear(), m: strToDate(today).getMonth() - 1 < 0
        ? 11 : strToDate(today).getMonth() - 1,
        adj: strToDate(today).getMonth() - 1 < 0 ? -1 : 0 },                          // prev
    { y: strToDate(today).getFullYear(), m: strToDate(today).getMonth() + 1 > 11
        ? 0 : strToDate(today).getMonth() + 1,
        adj: strToDate(today).getMonth() + 1 > 11 ? 1 : 0 }                           // next
  ]
  for (const mt of monthsToTest) {
    const yy = mt.y + (mt.adj || 0)
    const mm = mt.m
    const lastDay = new Date(yy, mm + 1, 0).getDate()
    const expected = {}
    for (let d = 1; d <= lastDay; d++) {
      const ds = `${yy}-${pad2(mm + 1)}-${pad2(d)}`
      const items = store.tasksForDate(state, ds)
      const tot = items.length
      if (tot === 0) continue
      const done = items.filter((it) => it.occurrence.status === 'done').length
      expected[ds] = {
        total: tot,
        done,
        hasOverdue: items.some((it) => it.isOverdue)
      }
    }
    const got = store.dateCountsForMonth(state, yy, mm)
    // Compare keysets and values (only non-zero from per-day match populated keys in got)
    const expKeys = Object.keys(expected).sort()
    const gotKeys = Object.keys(got).filter((k) => got[k].total > 0).sort()
    check(`dateCountsForMonth(${yy}-${pad2(mm + 1)}) keys`, gotKeys, expKeys)
    for (const k of expKeys) {
      check(`dateCountsForMonth(${k})`, got[k], expected[k])
    }
  }

  // Mutation: finishTask preserves invariants
  const before = store.getStateWithComputed()
  const task = before.tasks.find((t) => t.id === 't1')
  store.finishTask('t1', today)
  const after = store.getStateWithComputed()
  const t1After = after.tasks.find((t) => t.id === 't1')
  check('finishTask one-shot status', t1After.status, 'done')
  check('finishTask increments coins', after.coins > before.coins, true)
  check('other tasks untouched', after.tasks.find((t) => t.id === 't3').status, 'todo')

  // Mutation: startTask -> pauseAllOtherDoing
  store.startTask('t6', today)
  const s1 = store.getStateWithComputed()
  const t6_today = (s1.tasks.find((t) => t.id === 't6').occurrences || {})[today]
  check('startTask sets doing', t6_today.status, 'doing')

  store.startTask('t7', today)
  const s2 = store.getStateWithComputed()
  const t7_today = (s2.tasks.find((t) => t.id === 't7').occurrences || {})[today]
  const t6_again = (s2.tasks.find((t) => t.id === 't6').occurrences || {})[today]
  check('starting another task pauses prior doing', t6_again.status, 'paused')
  check('starting another task sets new doing', t7_today.status, 'doing')

  console.log(`\n  ${pass} passed, ${fail} failed.\n`)
  process.exit(fail === 0 ? 0 : 1)
}

run()
