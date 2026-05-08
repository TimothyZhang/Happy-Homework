const store = require('../../utils/store')

Page({
  data: {
    tasks: [],
    overview: {
      pendingCount: 0,
      completedMinutes: 0,
      todayCoins: 0,
      streakDays: 0
    },
    progressPercent: 0,
    completedCount: 0
  },

  onShow() {
    this.refreshState()
  },

  refreshState() {
    const state = store.getStateWithComputed()
    const completedCount = state.tasks.filter((task) => task.status === 'done').length
    const progressPercent = state.tasks.length ? Math.round((completedCount / state.tasks.length) * 100) : 0
    this.setData({
      tasks: state.tasks,
      overview: state.overview,
      completedCount,
      progressPercent
    })
  },

  handleStartTask(event) {
    const { id } = event.currentTarget.dataset
    store.startTask(id)
    this.refreshState()
    wx.showToast({ title: '已开始', icon: 'success' })
  },

  handlePauseTask(event) {
    const { id } = event.currentTarget.dataset
    store.pauseTask(id)
    this.refreshState()
    wx.showToast({ title: '已暂停', icon: 'none' })
  },

  handleResumeTask(event) {
    const { id } = event.currentTarget.dataset
    store.resumeTask(id)
    this.refreshState()
    wx.showToast({ title: '继续', icon: 'success' })
  },

  handleFinishTask(event) {
    const { id } = event.currentTarget.dataset
    store.finishTask(id)
    this.refreshState()
    wx.showToast({ title: '完成并奖励金币', icon: 'success' })
  }
})