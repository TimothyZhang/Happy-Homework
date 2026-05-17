const store = require('../../utils/store')

function lifetimeDoneOnTask(t) {
  if (t.mode === 'recurring') {
    const occs = t.occurrences || {}
    let n = 0
    for (const k in occs) if (occs[k].status === 'done') n++
    return n
  }
  return (t.status || 'todo') === 'done' ? 1 : 0
}

Page({
  data: {
    stats: {
      todayTotal: 0,
      todayDone: 0,
      totalMinutes: 0,
      coins: 0,
      lifetimeDone: 0
    },
    bySubject: [],         // [{ key, done }]
    byOrganization: [],    // [{ key, done }]
    doneList: []
  },

  onShow() {
    const state = store.getStateWithComputed()
    const today = store.todayStr()
    const todayItems = store.tasksForDate(state, today)
    const todayDone = todayItems.filter((it) => it.occurrence.status === 'done')
    const todayTotalMinutes = todayItems.reduce((s, it) => s + Number(it.task.estimatedMinutes || 0), 0)

    let lifetimeDone = 0
    const subjectCounts = {}
    const orgCounts = {}
    for (const t of state.tasks) {
      const n = lifetimeDoneOnTask(t)
      lifetimeDone += n
      if (n > 0) {
        const s = t.subject || '其他'
        const o = t.organization || '其他'
        subjectCounts[s] = (subjectCounts[s] || 0) + n
        orgCounts[o] = (orgCounts[o] || 0) + n
      }
    }
    const bySubject = Object.entries(subjectCounts)
      .map(([key, done]) => ({ key, done }))
      .sort((a, b) => b.done - a.done)
    const orgOrder = ['校内', '校外', '其他']
    const byOrganization = orgOrder
      .map((key) => ({ key, done: orgCounts[key] || 0 }))
      .filter((r) => r.done > 0)

    this.setData({
      stats: {
        todayTotal: todayItems.length,
        todayDone: todayDone.length,
        totalMinutes: todayTotalMinutes,
        coins: state.coins,
        lifetimeDone
      },
      bySubject,
      byOrganization
    })

    wx.nextTick(() => this._buildDoneList(state))
  },

  _buildDoneList(state) {
    const doneList = []
    for (const t of state.tasks) {
      if (t.mode !== 'recurring') {
        if ((t.status || 'todo') === 'done') {
          doneList.push({
            id: t.id,
            content: t.content,
            subject: t.subject || '',
            organization: t.organization || '其他',
            doneOn: t.completedAt ? new Date(t.completedAt).toISOString().slice(0, 10) : ''
          })
        }
      } else {
        const occurrences = t.occurrences || {}
        for (const dateStr of Object.keys(occurrences)) {
          if (occurrences[dateStr].status === 'done') {
            doneList.push({
              id: `${t.id}_${dateStr}`,
              content: t.content,
              subject: t.subject || '',
              organization: t.organization || '其他',
              doneOn: dateStr
            })
          }
        }
      }
    }
    doneList.sort((a, b) => (b.doneOn || '').localeCompare(a.doneOn || ''))
    this.setData({ doneList: doneList.slice(0, 30) })
  }
})
