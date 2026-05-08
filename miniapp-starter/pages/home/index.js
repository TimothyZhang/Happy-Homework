const store = require('../../utils/store')

// 排序:进行中固定置顶 → 其它未完成(todo/paused)按人工顺序 → 已完成沉底。
// 配合 auto-pause-others,任何时刻最多一个 doing,自动 pin 在最上方。
function sortTasks(tasks) {
  const doing = []
  const others = []
  const done = []
  for (const task of tasks) {
    if (task.status === 'done') done.push(task)
    else if (task.status === 'doing') doing.push(task)
    else others.push(task)
  }
  return [...doing, ...others, ...done]
}

function formatElapsed(ms) {
  if (!ms || ms < 0) return ''
  const totalSec = Math.floor(ms / 1000)
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  if (min === 0) return `${sec} 秒`
  if (sec === 0) return `${min} 分钟`
  return `${min} 分 ${sec} 秒`
}

function decorateTask(task, now) {
  let elapsedMs = task.accumulatedMs || 0
  if (task.status === 'doing' && task.currentSegmentStartedAt) {
    elapsedMs += Math.max(0, now - task.currentSegmentStartedAt)
  } else if (task.status === 'done' && task.elapsedMs) {
    elapsedMs = task.elapsedMs
  }
  let actualTimeDisplay = ''
  if (task.actualStart && task.actualEnd) {
    actualTimeDisplay = `实际 ${task.actualStart}-${task.actualEnd}`
  } else if (task.actualStart) {
    actualTimeDisplay = `${task.actualStart} 开始`
  }
  return {
    ...task,
    elapsedMs,
    elapsedDisplay: elapsedMs > 0 ? formatElapsed(elapsedMs) : '',
    actualTimeDisplay
  }
}

function formatDuration(minutes) {
  if (!minutes || minutes < 0) return '—'
  if (minutes < 60) return `${minutes} 分钟`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (m === 0) return `${h} 小时`
  return `${h}h${m}m`
}

function calcRemainingMinutes(tasks) {
  return tasks
    .filter((task) => task.status !== 'done')
    .reduce((sum, task) => sum + Number(task.estimatedMinutes || 0), 0)
}


Page({
  data: {
    tasks: [],
    sortedTasks: [],
    lastReward: null,
    showCongrats: false,
    totalElapsedDisplay: '',
    remainingMinutesDisplay: '—',
    dragId: null,
    dragDy: 0,
    overview: {
      pendingCount: 0,
      progressPercent: 0,
      doneCount: 0,
      totalCount: 0
    }
  },

  onShow() {
    this.refreshState()
    this.startTickerIfNeeded()
  },

  onHide() {
    this.stopTicker()
  },

  onUnload() {
    this.stopTicker()
  },

  refreshState() {
    this.applyState(store.getStateWithComputed())
  },

  startTickerIfNeeded() {
    this.stopTicker()
    const hasRunning = (this.data.tasks || []).some((task) => task.status === 'doing')
    if (!hasRunning) return
    this.tickerId = setInterval(() => {
      const now = Date.now()
      const tasks = (this.data.tasks || []).map((task) => decorateTask(task, now))
      this.setData({ tasks, sortedTasks: sortTasks(tasks) })
      if (!tasks.some((task) => task.status === 'doing')) {
        this.stopTicker()
      }
    }, 1000)
  },

  stopTicker() {
    if (this.tickerId) {
      clearInterval(this.tickerId)
      this.tickerId = null
    }
  },

  applyState(state, opts = {}) {
    const now = Date.now()
    const decorated = (state.tasks || []).map((task) => decorateTask(task, now))
    const sortedTasks = sortTasks(decorated)
    const remainingMinutes = calcRemainingMinutes(decorated)
    this.setData({
      tasks: decorated,
      sortedTasks,
      overview: state.overview || this.data.overview,
      lastReward: state.lastReward || null,
      remainingMinutesDisplay: formatDuration(remainingMinutes)
    })
    this.startTickerIfNeeded()
    if (opts.maybeCelebrate) this.maybeShowCongrats(decorated)
  },

  maybeShowCongrats(tasks) {
    if (!tasks || tasks.length === 0) return
    const allDone = tasks.every((task) => task.status === 'done')
    if (!allDone) return
    const totalMs = tasks.reduce((sum, task) => sum + (task.elapsedMs || task.accumulatedMs || 0), 0)
    this.setData({
      showCongrats: true,
      totalElapsedDisplay: totalMs > 0 ? formatElapsed(totalMs) : ''
    })
  },

  handleDismissCongrats() {
    this.setData({ showCongrats: false })
  },

  handleAddHomework() {
    wx.switchTab({
      url: '/pages/tasks/index'
    })
  },

  handleManageTasks() {
    wx.switchTab({
      url: '/pages/tasks/index'
    })
  },

  handlePhotoImport() {
    wx.navigateTo({
      url: '/pages/ocr-import/index'
    })
  },

  handleStartTask(event) {
    const { id } = event.currentTarget.dataset
    const state = store.startTask(id)
    this.applyState(state)
    wx.showToast({ title: '已开始计时', icon: 'success' })
  },

  handlePauseTask(event) {
    const { id } = event.currentTarget.dataset
    const state = store.pauseTask(id)
    this.applyState(state)
    wx.showToast({ title: '已暂停', icon: 'none' })
  },

  handleResumeTask(event) {
    const { id } = event.currentTarget.dataset
    const state = store.resumeTask(id)
    this.applyState(state)
    wx.showToast({ title: '继续计时', icon: 'success' })
  },

  handleFinishTask(event) {
    const { id } = event.currentTarget.dataset
    const before = store.getStateWithComputed()
    const state = store.finishTask(id)
    const reward = state.coins - before.coins
    this.applyState(state, { maybeCelebrate: true })
    wx.showToast({
      title: state.lastReward && state.lastReward.leveledUp ? `+${reward} 金币，升级啦` : `+${reward} 金币`,
      icon: 'success'
    })
  },

  // === 拖拽排序 === //

  handleLongPress(event) {
    const { id } = event.currentTarget.dataset
    // 只允许重排未完成的任务,已完成的不参与
    const task = this.data.sortedTasks.find((t) => t.id === id)
    if (!task || task.status === 'done') return
    if (event.touches && event.touches[0]) {
      this.dragStartY = event.touches[0].pageY
    }
    // 测一次卡片高度,后面用来折算移动到第几项
    if (!this.itemHeightPx) {
      const query = wx.createSelectorQuery()
      query.select('.task-item').boundingClientRect()
      query.exec((rects) => {
        if (rects && rects[0]) {
          // 加上下方间距作为单元高度
          this.itemHeightPx = rects[0].height + 12
        }
      })
    }
    this.setData({ dragId: id, dragDy: 0 })
    if (wx.vibrateShort) {
      wx.vibrateShort({ type: 'light' })
    }
  },

  handleTouchMove(event) {
    if (!this.data.dragId || !this.dragStartY) return
    const now = Date.now()
    if (this._lastMoveAt && now - this._lastMoveAt < 16) return
    this._lastMoveAt = now
    const t = event.touches && event.touches[0]
    if (!t) return
    const dy = t.pageY - this.dragStartY
    if (Math.abs(dy - this.data.dragDy) < 2) return

    const itemH = this.itemHeightPx || 140
    const sorted = this.data.sortedTasks
    const draggedIdx = sorted.findIndex((task) => task.id === this.data.dragId)
    const undoneCount = sorted.filter((task) => task.status !== 'done').length
    // 把当前位置折算到目标槽 0..(undoneCount-1)
    const slotsDelta = Math.round(dy / itemH)
    const hoverIdx = Math.max(0, Math.min(undoneCount - 1, draggedIdx + slotsDelta))

    // 给非拖拽项算 shiftY:中间被「让位」的整体平移一格
    const updated = sorted.map((task, i) => {
      if (task.id === this.data.dragId) return task
      let shiftY = 0
      if (draggedIdx < hoverIdx && i > draggedIdx && i <= hoverIdx) {
        shiftY = -itemH
      } else if (draggedIdx > hoverIdx && i >= hoverIdx && i < draggedIdx) {
        shiftY = itemH
      }
      return { ...task, shiftY }
    })
    this.setData({ sortedTasks: updated, dragDy: dy })
  },

  handleTouchEnd() {
    if (!this.data.dragId) {
      this.dragStartY = null
      return
    }
    const dragId = this.data.dragId
    const dragDy = this.data.dragDy
    const itemH = this.itemHeightPx || 140
    const sorted = this.data.sortedTasks
    const fromIdx = sorted.findIndex((t) => t.id === dragId)
    const undoneCount = sorted.filter((t) => t.status !== 'done').length
    const slotsDelta = Math.round(dragDy / itemH)
    const toIdx = Math.max(0, Math.min(undoneCount - 1, fromIdx + slotsDelta))

    if (fromIdx !== -1 && fromIdx !== toIdx) {
      const ids = sorted.map((t) => t.id)
      const [moved] = ids.splice(fromIdx, 1)
      ids.splice(toIdx, 0, moved)
      const state = store.reorderTasks(ids)
      this.applyState(state)
    } else {
      // 没换槽 —— 让其它卡片从 shiftY 平滑归位
      const reset = sorted.map((t) => ({ ...t, shiftY: 0 }))
      this.setData({ sortedTasks: reset })
    }
    this.dragStartY = null
    this.setData({ dragId: null, dragDy: 0 })
  }
})
