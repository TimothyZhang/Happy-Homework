const store = require('../../utils/store')

Page({
  data: {
    tasks: [],
    coins: 0,
    bonusCoins: 0,
    rewardRules: [],
    pet: {},
    shopItems: [],
    lastReward: null,
    overview: {
      pendingCount: 0,
      todayCoins: 0,
      completedMinutes: 0,
      totalMinutes: 0,
      progressPercent: 0,
      doneCount: 0,
      totalCount: 0,
      streakDays: 0
    }
  },

  onShow() {
    this.refreshState()
  },

  refreshState() {
    const state = store.getStateWithComputed()
    this.setData(state)
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
    wx.showModal({
      title: `${task.subject} 作业详情`,
      content: `${task.content}\n\n计划 ${task.planStart} - ${task.planEnd}\n预计 ${task.estimatedMinutes} 分钟`,
      showCancel: false,
      confirmText: '知道了'
    })
  },

  handleStartTask(event) {
    const { id } = event.currentTarget.dataset
    const state = store.startTask(id)
    this.setData(state)
    wx.showToast({
      title: '已开始计时',
      icon: 'success'
    })
  },

  handleFinishTask(event) {
    const { id } = event.currentTarget.dataset
    const before = store.getStateWithComputed()
    const state = store.finishTask(id)
    const reward = state.coins - before.coins
    this.setData(state)
    wx.showToast({
      title: state.lastReward && state.lastReward.leveledUp ? `+${reward} 金币，升级啦` : `+${reward} 金币`,
      icon: 'success'
    })
  },

  handleBuyItem(event) {
    const { id } = event.currentTarget.dataset
    const before = store.getStateWithComputed()
    const item = before.shopItems.find((shopItem) => shopItem.id === id)

    if (before.coins < item.price) {
      wx.showToast({
        title: '金币不够',
        icon: 'none'
      })
      return
    }

    const state = store.buyItem(id)
    this.setData(state)
    wx.showToast({
      title: `${item.name} 已购买`,
      icon: 'success'
    })
  }
})
