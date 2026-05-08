const store = require('../../utils/store')

const STATUS_ORDER = { doing: 0, paused: 1, todo: 2, done: 3 }

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
  return {
    ...task,
    elapsedMs,
    elapsedDisplay: elapsedMs > 0 ? formatElapsed(elapsedMs) : ''
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

function sortTasks(tasks) {
  return [...tasks].sort((a, b) => {
    const oa = STATUS_ORDER[a.status] != null ? STATUS_ORDER[a.status] : 9
    const ob = STATUS_ORDER[b.status] != null ? STATUS_ORDER[b.status] : 9
    if (oa !== ob) return oa - ob
    // 同状态内：未完成的按计划开始时间正序，已完成的按完成时间倒序
    if (a.status === 'done' && b.status === 'done') {
      return (b.actualEndedAt || 0) - (a.actualEndedAt || 0)
    }
    return String(a.planStart || '').localeCompare(String(b.planStart || ''))
  })
}

Page({
  data: {
    tasks: [],
    sortedTasks: [],
    lastReward: null,
    showCongrats: false,
    totalElapsedDisplay: '',
    remainingMinutesDisplay: '—',
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

  handlePhotoImport() {
    wx.navigateTo({
      url: '/pages/ocr-import/index'
    })
  },

  handleEditTask(event) {
    const { id } = event.currentTarget.dataset
    const task = this.data.tasks.find((item) => item.id === id)
    const elapsedLine = task.elapsedDisplay ? `\n实际${task.status === 'done' ? '花费' : '已用'} ${task.elapsedDisplay}` : ''
    wx.showModal({
      title: `${task.subject} 作业详情`,
      content: `${task.content}\n\n计划 ${task.planStart} - ${task.planEnd}\n预计 ${task.estimatedMinutes} 分钟${elapsedLine}`,
      showCancel: false,
      confirmText: '知道了'
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
  }
})
