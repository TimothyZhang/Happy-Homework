const store = require('../../utils/store')

function formatElapsed(ms) {
  if (!ms || ms < 0) return ''
  const totalSec = Math.floor(ms / 1000)
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  if (min === 0) return `${sec} 秒`
  if (sec === 0) return `${min} 分钟`
  return `${min} 分 ${sec} 秒`
}

function formatDuration(minutes) {
  if (!minutes || minutes < 0) return '—'
  if (minutes < 60) return `${minutes} 分钟`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (m === 0) return `${h} 小时`
  return `${h}h${m}m`
}

function decorateItem(item, now) {
  const occ = item.occurrence
  let elapsedMs = occ.accumulatedMs || 0
  if (occ.status === 'doing' && occ.currentSegmentStartedAt) {
    elapsedMs += Math.max(0, now - occ.currentSegmentStartedAt)
  }
  return {
    id: item.task.id,
    notebookId: item.notebook.id,
    notebookName: item.notebook.name,
    subject: item.notebook.subject,
    content: item.task.content,
    estimatedMinutes: item.task.estimatedMinutes,
    status: occ.status,
    isOverdue: item.isOverdue,
    elapsedMs,
    elapsedDisplay: elapsedMs > 0 ? formatElapsed(elapsedMs) : ''
  }
}

// Sort: doing on top, then todo/paused (by user order = order in tasksForDate),
// then done at the bottom.
function sortItems(items) {
  const doing = []
  const others = []
  const done = []
  for (const it of items) {
    if (it.status === 'done') done.push(it)
    else if (it.status === 'doing') doing.push(it)
    else others.push(it)
  }
  return [...doing, ...others, ...done]
}

Page({
  data: {
    activeDate: '',
    activeDateLabel: '',
    isToday: true,
    canPrev: true,
    canNext: true,
    overview: { totalCount: 0, pendingCount: 0, doneCount: 0 },
    remainingMinutesDisplay: '—',
    items: [],
    showCongrats: false,
    totalElapsedDisplay: '',
    lastReward: null,
    dragId: null,
    dragDy: 0
  },

  onShow() {
    if (!this.data.activeDate) {
      this.setData({ activeDate: store.todayStr() })
    }
    this.refreshState()
    this.startTickerIfNeeded()
  },
  onHide() { this.stopTicker() },
  onUnload() { this.stopTicker() },

  refreshState(opts = {}) {
    const today = store.todayStr()
    const activeDate = this.data.activeDate || today
    const state = store.getStateWithComputed()
    const now = Date.now()
    const raw = store.tasksForDate(state, activeDate)
    const items = sortItems(raw.map((it) => decorateItem(it, now)))
    const total = items.length
    const done = items.filter((it) => it.status === 'done').length
    const pending = total - done
    const remainingMinutes = items
      .filter((it) => it.status !== 'done')
      .reduce((s, it) => s + Number(it.estimatedMinutes || 0), 0)
    this.setData({
      activeDate,
      activeDateLabel: this.formatDateLabel(activeDate, today),
      isToday: activeDate === today,
      overview: { totalCount: total, pendingCount: pending, doneCount: done },
      remainingMinutesDisplay: formatDuration(remainingMinutes),
      items,
      lastReward: state.lastReward || null
    })
    this.startTickerIfNeeded()
    if (opts.maybeCelebrate) this.maybeShowCongrats(items)
  },

  formatDateLabel(date, today) {
    if (date === today) return `今日 · ${date}`
    if (date === store.addDays(today, -1)) return `昨日 · ${date}`
    if (date === store.addDays(today, 1)) return `明日 · ${date}`
    return date
  },

  startTickerIfNeeded() {
    this.stopTicker()
    if (!this.data.isToday) return
    const hasRunning = (this.data.items || []).some((it) => it.status === 'doing')
    if (!hasRunning) return
    this.tickerId = setInterval(() => {
      const items = (this.data.items || []).map((it) => {
        let ms = it.elapsedMs || 0
        if (it.status === 'doing') ms += 1000
        return { ...it, elapsedMs: ms, elapsedDisplay: formatElapsed(ms) }
      })
      this.setData({ items })
      if (!items.some((it) => it.status === 'doing')) this.stopTicker()
    }, 1000)
  },

  stopTicker() {
    if (this.tickerId) { clearInterval(this.tickerId); this.tickerId = null }
  },

  maybeShowCongrats(items) {
    if (!items || items.length === 0) return
    if (!this.data.isToday) return
    const allDone = items.every((it) => it.status === 'done')
    if (!allDone) return
    const totalMs = items.reduce((s, it) => s + (it.elapsedMs || 0), 0)
    this.setData({
      showCongrats: true,
      totalElapsedDisplay: totalMs > 0 ? formatElapsed(totalMs) : ''
    })
  },

  handleDismissCongrats() { this.setData({ showCongrats: false }) },

  // === Day switcher === //

  handlePrevDay() {
    this.setData({ activeDate: store.addDays(this.data.activeDate, -1) })
    this.refreshState()
  },

  handleNextDay() {
    this.setData({ activeDate: store.addDays(this.data.activeDate, 1) })
    this.refreshState()
  },

  handleJumpToday() {
    this.setData({ activeDate: store.todayStr() })
    this.refreshState()
  },

  handleOpenCalendar() {
    wx.switchTab({ url: '/pages/calendar/index' })
  },

  // === Task control (locked to active date) === //

  handleStartTask(e) {
    if (!this.data.isToday) {
      wx.showToast({ title: '只能在「今日」开始计时', icon: 'none' })
      return
    }
    store.startTask(e.currentTarget.dataset.id, this.data.activeDate)
    this.refreshState()
    wx.showToast({ title: '开始啦', icon: 'success' })
  },

  handlePauseTask(e) {
    store.pauseTask(e.currentTarget.dataset.id, this.data.activeDate)
    this.refreshState()
    wx.showToast({ title: '已暂停', icon: 'none' })
  },

  handleResumeTask(e) {
    store.resumeTask(e.currentTarget.dataset.id, this.data.activeDate)
    this.refreshState()
    wx.showToast({ title: '继续', icon: 'success' })
  },

  handleFinishTask(e) {
    const before = store.getStateWithComputed()
    const after = store.finishTask(e.currentTarget.dataset.id, this.data.activeDate)
    const reward = after.coins - before.coins
    this.refreshState({ maybeCelebrate: true })
    wx.showToast({
      title: after.lastReward && after.lastReward.leveledUp ? `+${reward} 金币，升级啦` : `+${reward} 金币`,
      icon: 'success'
    })
  },

  // === Navigation === //

  handleManageTasks() { wx.switchTab({ url: '/pages/tasks/index' }) },

  handleAddHomework() { wx.switchTab({ url: '/pages/tasks/index' }) },

  handlePhotoImport() { wx.navigateTo({ url: '/pages/ocr-import/index' }) },

  handleOpenNotebook(e) {
    const { notebookId } = e.currentTarget.dataset
    wx.navigateTo({ url: `/pages/notebook-detail/index?id=${notebookId}` })
  },

  // === Drag-reorder (today only, within their notebook) === //

  handleLongPress(e) {
    if (!this.data.isToday) return
    const { id } = e.currentTarget.dataset
    const item = this.data.items.find((it) => it.id === id)
    if (!item || item.status === 'done') return
    if (e.touches && e.touches[0]) this.dragStartY = e.touches[0].pageY
    this.dragNotebookId = item.notebookId
    if (!this.itemHeightPx) {
      const q = wx.createSelectorQuery()
      q.select('.task-row').boundingClientRect()
      q.exec((rects) => { if (rects && rects[0]) this.itemHeightPx = rects[0].height + 12 })
    }
    this.setData({ dragId: id, dragDy: 0 })
    if (wx.vibrateShort) wx.vibrateShort({ type: 'light' })
  },

  handleTouchMove(e) {
    if (!this.data.dragId || !this.dragStartY) return
    const now = Date.now()
    if (this._lastMoveAt && now - this._lastMoveAt < 16) return
    this._lastMoveAt = now
    const t = e.touches && e.touches[0]
    if (!t) return
    const dy = t.pageY - this.dragStartY
    if (Math.abs(dy - this.data.dragDy) < 2) return
    const itemH = this.itemHeightPx || 140
    const list = this.data.items
    const draggedIdx = list.findIndex((it) => it.id === this.data.dragId)
    // Only reorder among same-notebook undone items.
    const sameNbUndone = list.filter((it) => it.notebookId === this.dragNotebookId && it.status !== 'done')
    const localIdxOf = (id) => sameNbUndone.findIndex((it) => it.id === id)
    const localFrom = localIdxOf(this.data.dragId)
    const slotsDelta = Math.round(dy / itemH)
    const localTo = Math.max(0, Math.min(sameNbUndone.length - 1, localFrom + slotsDelta))
    // Map local target back to global hover idx (idx of sameNbUndone[localTo] in list).
    const targetGlobal = list.findIndex((it) => it.id === sameNbUndone[localTo].id)
    const updated = list.map((it, i) => {
      if (it.id === this.data.dragId) return it
      let shiftY = 0
      if (it.notebookId === this.dragNotebookId && it.status !== 'done') {
        if (draggedIdx < targetGlobal && i > draggedIdx && i <= targetGlobal) shiftY = -itemH
        else if (draggedIdx > targetGlobal && i >= targetGlobal && i < draggedIdx) shiftY = itemH
      }
      return { ...it, shiftY }
    })
    this.setData({ items: updated, dragDy: dy })
  },

  handleTouchEnd() {
    if (!this.data.dragId) {
      this.dragStartY = null
      return
    }
    const dragId = this.data.dragId
    const dragDy = this.data.dragDy
    const itemH = this.itemHeightPx || 140
    const list = this.data.items
    const sameNb = list.filter((it) => it.notebookId === this.dragNotebookId && it.status !== 'done')
    const localFrom = sameNb.findIndex((it) => it.id === dragId)
    const slotsDelta = Math.round(dragDy / itemH)
    const localTo = Math.max(0, Math.min(sameNb.length - 1, localFrom + slotsDelta))

    if (localFrom !== -1 && localFrom !== localTo) {
      // Build new sequence within this notebook (include done at original tail order).
      const state = store.getStateWithComputed()
      const allInNb = store.tasksOfNotebook(state, this.dragNotebookId)
      const undoneIds = sameNb.map((it) => it.id)
      const [moved] = undoneIds.splice(localFrom, 1)
      undoneIds.splice(localTo, 0, moved)
      // Keep done tasks where they were (at end).
      const doneIds = allInNb.filter((t) => !undoneIds.includes(t.id)).map((t) => t.id)
      const finalIds = [...undoneIds, ...doneIds]
      store.reorderTasksInNotebook(this.dragNotebookId, finalIds)
      this.refreshState()
    } else {
      this.setData({ items: list.map((it) => ({ ...it, shiftY: 0 })) })
    }
    this.dragStartY = null
    this.dragNotebookId = null
    this.setData({ dragId: null, dragDy: 0 })
  }
})
