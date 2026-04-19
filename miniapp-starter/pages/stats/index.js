const store = require('../../utils/store')

Page({
  data: {
    stats: {
      totalTasks: 0,
      doneTasks: 0,
      totalMinutes: 0,
      coins: 0
    },
    doneTasks: []
  },

  onShow() {
    const state = store.getStateWithComputed()
    const doneTasks = state.tasks.filter((task) => task.status === 'done')
    const totalMinutes = state.tasks.reduce((sum, task) => sum + Number(task.estimatedMinutes || 0), 0)
    this.setData({
      stats: {
        totalTasks: state.tasks.length,
        doneTasks: doneTasks.length,
        totalMinutes,
        coins: state.coins
      },
      doneTasks
    })
  }
})