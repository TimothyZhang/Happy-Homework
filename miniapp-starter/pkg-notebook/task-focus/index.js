const store = require('../../utils/store')
const i18n = require('../../utils/i18n')

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
    elapsedDisplay: '00:00',
    // 暂停后停留在本页:作业时间(elapsed)定格在上面,额外显示暂停时长
    isPaused: false,
    pausedDisplay: '00:00'
  },

  onLoad(options) {
    const opts = options || {}
    this.setData({ taskId: opts.id || '', date: opts.date || '' })
    if (!this.refresh()) return
    this.startTicker()
  },

  onShow() {
    this.setData({ t: i18n.dict() })
    wx.setNavigationBarTitle({ title: i18n.t('tfocus_navtitle') })
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
      wx.showToast({ title: i18n.t('tfocus_toast_not_found'), icon: 'none' })
      setTimeout(() => wx.navigateBack(), 400)
      return false
    }
    const occState = store.getTaskState(task, this.data.date || '')
    // doing 或 paused 都停留在 focus;只有被别处改成 done/todo 才退出
    if (occState.status !== 'doing' && occState.status !== 'paused') {
      wx.navigateBack()
      return false
    }
    const isPaused = occState.status === 'paused'
    const segMs = occState.currentSegmentStartedAt
      ? Math.max(0, Date.now() - occState.currentSegmentStartedAt)
      : 0
    const elapsedMs = (occState.accumulatedMs || 0) + segMs   // 作业时间(暂停时 seg=0 → 定格)
    if (isPaused) { if (!this._pausedAt) this._pausedAt = Date.now() }
    else { this._pausedAt = null }
    const pausedMs = isPaused ? Math.max(0, Date.now() - this._pausedAt) : 0
    const estMins = Number(task.estimatedMinutes) || 0
    this.setData({
      content: task.content || '',
      subject: task.subject || '',
      isRecurring: task.mode === 'recurring',
      recurrenceLabel: store.formatRecurrenceLabel(task),
      estimatedMinutes: estMins,
      estChip: i18n.t('tfocus_est_chip', { n: estMins }),
      occurrenceDate: this.data.date || task.startDate || '',
      isPaused,
      elapsedMs,
      elapsedDisplay: formatBigClock(elapsedMs),
      pausedDisplay: formatBigClock(pausedMs)
    })
    return true
  },

  startTicker() {
    this.stopTicker()
    this.tickerId = setInterval(() => {
      if (this.data.isPaused) {
        // 暂停中:作业时间定格,只走「暂停时长」
        const ms = Math.max(0, Date.now() - (this._pausedAt || Date.now()))
        this.setData({ pausedDisplay: formatBigClock(ms) })
      } else {
        const next = this.data.elapsedMs + 1000
        this.setData({ elapsedMs: next, elapsedDisplay: formatBigClock(next) })
      }
    }, 1000)
  },
  stopTicker() {
    if (this.tickerId) { clearInterval(this.tickerId); this.tickerId = null }
  },

  // 暂停:停留在本页,作业时间定格、开始计暂停时长
  handlePause() {
    if (!this.data.taskId) return
    store.pauseTask(this.data.taskId, this.data.date || '')
    this._pausedAt = Date.now()
    this.setData({ isPaused: true, pausedDisplay: '00:00' })
    this.startTicker()
  },

  // 继续:作业时间接着走
  handleResume() {
    if (!this.data.taskId) return
    store.resumeTask(this.data.taskId, this.data.date || '')
    this._pausedAt = null
    this.setData({ isPaused: false })
    this.startTicker()
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
