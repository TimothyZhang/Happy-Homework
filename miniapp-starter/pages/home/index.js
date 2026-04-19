const initialTasks = [
  {
    id: 1,
    subject: '语文',
    content: '完成《春晓》抄写 2 遍，并朗读 3 次',
    estimatedMinutes: 20,
    planStart: '18:30',
    planEnd: '18:50',
    actualStart: '',
    actualEnd: '',
    status: 'todo',
    statusText: '未开始'
  },
  {
    id: 2,
    subject: '数学',
    content: '完成口算练习 2 页',
    estimatedMinutes: 25,
    planStart: '18:50',
    planEnd: '19:15',
    actualStart: '18:52',
    actualEnd: '',
    status: 'doing',
    statusText: '进行中'
  },
  {
    id: 3,
    subject: '英语',
    content: '背诵 Unit 3 单词并完成听写',
    estimatedMinutes: 15,
    planStart: '19:20',
    planEnd: '19:35',
    actualStart: '19:18',
    actualEnd: '19:31',
    status: 'done',
    statusText: '已完成'
  }
]

const initialShopItems = [
  { id: 1, emoji: '🥕', name: '营养胡萝卜', effect: '开心值 +8，饱腹值 +12', price: 12, happiness: 8, fullness: 12, growth: 5 },
  { id: 2, emoji: '🧸', name: '陪玩玩具熊', effect: '开心值 +15', price: 20, happiness: 15, fullness: 0, growth: 8 },
  { id: 3, emoji: '🎀', name: '粉色蝴蝶结', effect: '成长值 +10，形象更可爱', price: 28, happiness: 5, fullness: 0, growth: 10 }
]

function calcOverview(tasks, coins) {
  const pendingCount = tasks.filter((task) => task.status !== 'done').length
  const completedMinutes = tasks
    .filter((task) => task.status === 'done')
    .reduce((sum, task) => sum + task.estimatedMinutes, 0)

  return {
    pendingCount,
    todayCoins: coins,
    completedMinutes,
    streakDays: 4
  }
}

Page({
  data: {
    tasks: initialTasks,
    coins: 36,
    bonusCoins: 10,
    rewardRules: [
      { title: '完成单项作业', coins: 5 },
      { title: '按计划完成', coins: 3 },
      { title: '全部完成奖励', coins: 10 },
      { title: '连续 3 天打卡', coins: 20 }
    ],
    pet: {
      name: '小牛同学',
      emoji: '🐮',
      level: 2,
      growth: 38,
      nextLevelGrowth: 60,
      happiness: 76,
      fullness: 68
    },
    shopItems: initialShopItems,
    overview: calcOverview(initialTasks, 36)
  },

  handleAddHomework() {
    wx.showModal({
      title: '新增作业',
      content: 'V1 下一步会接成真正的新增表单。现在先保留体验入口。',
      showCancel: false
    })
  },

  handlePhotoImport() {
    wx.showModal({
      title: '拍照识别作业',
      content: '这里下一步会接 OCR 识别流程，目前先把业务闭环做出来。',
      showCancel: false
    })
  },

  handleEditTask(event) {
    const { id } = event.currentTarget.dataset
    const task = this.data.tasks.find((item) => item.id === id)
    wx.showModal({
      title: `编辑 ${task.subject}`,
      content: task.content,
      showCancel: false,
      confirmText: '知道了'
    })
  },

  handleStartTask(event) {
    const { id } = event.currentTarget.dataset
    const tasks = this.data.tasks.map((task) => {
      if (task.id === id) {
        return {
          ...task,
          status: 'doing',
          statusText: '进行中',
          actualStart: this.getCurrentTime()
        }
      }
      return task
    })

    this.setData({
      tasks,
      overview: calcOverview(tasks, this.data.coins)
    })

    wx.showToast({
      title: '已开始计时',
      icon: 'success'
    })
  },

  handleFinishTask(event) {
    const { id } = event.currentTarget.dataset
    const reward = 8
    const tasks = this.data.tasks.map((task) => {
      if (task.id === id) {
        return {
          ...task,
          status: 'done',
          statusText: '已完成',
          actualEnd: this.getCurrentTime()
        }
      }
      return task
    })

    const coins = this.data.coins + reward
    const pet = {
      ...this.data.pet,
      growth: Math.min(this.data.pet.growth + 6, this.data.pet.nextLevelGrowth),
      happiness: Math.min(this.data.pet.happiness + 6, 100)
    }

    this.setData({
      tasks,
      coins,
      pet,
      overview: calcOverview(tasks, coins)
    })

    wx.showToast({
      title: `+${reward} 金币`,
      icon: 'success'
    })
  },

  handleBuyItem(event) {
    const { id } = event.currentTarget.dataset
    const item = this.data.shopItems.find((shopItem) => shopItem.id === id)

    if (this.data.coins < item.price) {
      wx.showToast({
        title: '金币不够',
        icon: 'none'
      })
      return
    }

    const coins = this.data.coins - item.price
    const pet = {
      ...this.data.pet,
      happiness: Math.min(this.data.pet.happiness + item.happiness, 100),
      fullness: Math.min(this.data.pet.fullness + item.fullness, 100),
      growth: Math.min(this.data.pet.growth + item.growth, this.data.pet.nextLevelGrowth)
    }

    this.setData({
      coins,
      pet,
      overview: calcOverview(this.data.tasks, coins)
    })

    wx.showToast({
      title: `${item.name} 已购买`,
      icon: 'success'
    })
  },

  getCurrentTime() {
    const date = new Date()
    const hours = `${date.getHours()}`.padStart(2, '0')
    const minutes = `${date.getMinutes()}`.padStart(2, '0')
    return `${hours}:${minutes}`
  }
})