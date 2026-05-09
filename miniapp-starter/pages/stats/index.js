const store = require('../../utils/store')

Page({
  data: {
    stats: {
      todayTotal: 0,
      todayDone: 0,
      totalMinutes: 0,
      coins: 0,
      lifetimeDone: 0
    },
    doneList: []
  },

  onShow() {
    const state = store.getStateWithComputed()
    const today = store.todayStr()
    const todayItems = store.tasksForDate(state, today)
    const todayDone = todayItems.filter((it) => it.occurrence.status === 'done')
    const todayTotalMinutes = todayItems.reduce((s, it) => s + Number(it.task.estimatedMinutes || 0), 0)

    // Lifetime done count: one-shot status===done OR any recurring occurrence with status===done
    const notebookById = {}
    for (const nb of state.notebooks) notebookById[nb.id] = nb
    let lifetimeDone = 0
    const doneList = []
    for (const t of state.tasks) {
      const nb = notebookById[t.notebookId]
      if (!nb) continue
      if (nb.mode === 'one-shot') {
        if ((t.status || 'todo') === 'done') {
          lifetimeDone++
          doneList.push({
            id: t.id,
            content: t.content,
            notebookName: nb.name,
            subject: nb.subject,
            doneOn: t.completedAt ? new Date(t.completedAt).toISOString().slice(0, 10) : ''
          })
        }
      } else {
        const occurrences = t.occurrences || {}
        for (const dateStr of Object.keys(occurrences)) {
          if (occurrences[dateStr].status === 'done') {
            lifetimeDone++
            doneList.push({
              id: `${t.id}_${dateStr}`,
              content: t.content,
              notebookName: nb.name,
              subject: t.subject || '',
              doneOn: dateStr
            })
          }
        }
      }
    }
    doneList.sort((a, b) => (b.doneOn || '').localeCompare(a.doneOn || ''))

    this.setData({
      stats: {
        todayTotal: todayItems.length,
        todayDone: todayDone.length,
        totalMinutes: todayTotalMinutes,
        coins: state.coins,
        lifetimeDone
      },
      doneList: doneList.slice(0, 30)
    })
  }
})
