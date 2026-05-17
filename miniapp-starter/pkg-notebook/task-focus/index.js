const store = require('../../utils/store')

// "进行中" 大数字格式:
//   < 1 小时 → MM:SS
//   ≥ 1 小时 → H:MM:SS
function formatBigClock(ms) {
  const total = Math.max(0, Math.floor((ms || 0) / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n) => `${n}`.padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

Page({
  data: {
    taskId: '',
    date: '',
    content: '',
    subject: '',
    isRecurring: false,
    recurrenceLabel: '',
    estimatedMinutes: 0,
    occurrenceDate: '',
    elapsedMs: 0,
    elapsedDisplay: '00:00'
  },

  onLoad(options) {
    const opts = options || {}
    this.setData({ taskId: opts.id || '', date: opts.date || '' })
    if (!this.refresh()) return
    this.startTicker()
  },

  onShow() {
    if (!this.data.taskId) return
    if (!this.refresh()) return
    this.startTicker()
  },

  onHide() { this.stopTicker() },
  onUnload() { this.stopTicker() },

  // 拉最新 task,装到 data。返回 false 表示 task 不再 doing(或不存在),
  // 此时已 navigateBack。
  refresh() {
    const state = store.getStateWithComputed()
    const task = state.tasks.find((t) => t.id === this.data.taskId)
    if (!task) {
      wx.showToast({ title: '作业不存在', icon: 'none' })
      setTimeout(() => wx.navigateBack(), 400)
      return false
    }
    const occState = store.getTaskState(task, this.data.date || '')
    if (occState.status !== 'doing') {
      // 别的入口已经把任务暂停/完成了 — 直接退出 focus
      wx.navigateBack()
      return false
    }
    const segMs = occState.currentSegmentStartedAt
      ? Math.max(0, Date.now() - occState.currentSegmentStartedAt)
      : 0
    const elapsedMs = (occState.accumulatedMs || 0) + segMs
    this.setData({
      content: task.content || '',
      subject: task.subject || '',
      isRecurring: task.mode === 'recurring',
      recurrenceLabel: store.formatRecurrenceLabel(task),
      estimatedMinutes: Number(task.estimatedMinutes) || 0,
      occurrenceDate: this.data.date || task.startDate || '',
      elapsedMs,
      elapsedDisplay: formatBigClock(elapsedMs)
    })
    return true
  },

  startTicker() {
    this.stopTicker()
    this.tickerId = setInterval(() => {
      const next = this.data.elapsedMs + 1000
      this.setData({ elapsedMs: next, elapsedDisplay: formatBigClock(next) })
    }, 1000)
  },
  stopTicker() {
    if (this.tickerId) { clearInterval(this.tickerId); this.tickerId = null }
  },

  handlePause() {
    if (!this.data.taskId) return
    store.pauseTask(this.data.taskId, this.data.date || '')
    wx.navigateBack()
  },

  handleFinish() {
    if (!this.data.taskId) return
    store.finishTask(this.data.taskId, this.data.date || '')
    wx.navigateBack()
  },

  handleClose() {
    wx.navigateBack()
  }
})
