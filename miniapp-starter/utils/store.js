const STORAGE_KEY = 'homework-pet-v1'

const defaultState = {
  coins: 36,
  streakDays: 4,
  bonusCoins: 10,
  editTaskId: null,
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
  shopItems: [
    { id: 1, emoji: '🥕', name: '营养胡萝卜', effect: '开心值 +8，饱腹值 +12', price: 12, happiness: 8, fullness: 12, growth: 5 },
    { id: 2, emoji: '🧸', name: '陪玩玩具熊', effect: '开心值 +15', price: 20, happiness: 15, fullness: 0, growth: 8 },
    { id: 3, emoji: '🎀', name: '粉色蝴蝶结', effect: '成长值 +10，形象更可爱', price: 28, happiness: 5, fullness: 0, growth: 10 }
  ],
  tasks: [
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
      statusText: '未开始',
      priority: '高'
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
      statusText: '进行中',
      priority: '高'
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
      statusText: '已完成',
      priority: '中'
    }
  ]
}

function clone(data) {
  return JSON.parse(JSON.stringify(data))
}

function loadState() {
  try {
    const localState = wx.getStorageSync(STORAGE_KEY)
    if (localState && typeof localState === 'object') {
      return localState
    }
  } catch (error) {
    console.warn('loadState failed', error)
  }
  return clone(defaultState)
}

function saveState(state) {
  wx.setStorageSync(STORAGE_KEY, state)
}

function getCurrentTime() {
  const date = new Date()
  const hours = `${date.getHours()}`.padStart(2, '0')
  const minutes = `${date.getMinutes()}`.padStart(2, '0')
  return `${hours}:${minutes}`
}

function calcOverview(state) {
  const pendingCount = state.tasks.filter((task) => task.status !== 'done').length
  const doneTasks = state.tasks.filter((task) => task.status === 'done')
  const completedMinutes = doneTasks.reduce((sum, task) => sum + Number(task.estimatedMinutes || 0), 0)
  const totalMinutes = state.tasks.reduce((sum, task) => sum + Number(task.estimatedMinutes || 0), 0)
  const progressPercent = state.tasks.length ? Math.round((doneTasks.length / state.tasks.length) * 100) : 0

  return {
    pendingCount,
    todayCoins: state.coins,
    completedMinutes,
    totalMinutes,
    progressPercent,
    doneCount: doneTasks.length,
    totalCount: state.tasks.length,
    streakDays: state.streakDays
  }
}

function getStateWithComputed() {
  const state = loadState()
  return {
    ...state,
    overview: calcOverview(state)
  }
}

function updateState(updater) {
  const state = loadState()
  const nextState = updater(clone(state))
  saveState(nextState)
  return {
    ...nextState,
    overview: calcOverview(nextState)
  }
}

function startTask(taskId) {
  return updateState((state) => {
    state.tasks = state.tasks.map((task) => {
      if (task.id === taskId) {
        return {
          ...task,
          status: 'doing',
          statusText: '进行中',
          actualStart: task.actualStart || getCurrentTime()
        }
      }
      return task
    })
    return state
  })
}

function finishTask(taskId) {
  return updateState((state) => {
    let reward = 8
    let leveledUp = false
    state.tasks = state.tasks.map((task) => {
      if (task.id === taskId) {
        return {
          ...task,
          status: 'done',
          statusText: '已完成',
          actualEnd: getCurrentTime()
        }
      }
      return task
    })

    if (state.tasks.every((task) => task.status === 'done')) {
      reward += state.bonusCoins
    }

    state.coins += reward
    state.pet.growth += 6
    state.pet.happiness = Math.min(state.pet.happiness + 6, 100)

    if (state.pet.growth >= state.pet.nextLevelGrowth) {
      state.pet.level += 1
      state.pet.growth = state.pet.growth - state.pet.nextLevelGrowth
      state.pet.nextLevelGrowth += 20
      state.pet.fullness = Math.min(state.pet.fullness + 10, 100)
      leveledUp = true
    }

    state.lastReward = {
      reward,
      leveledUp,
      taskId,
      finishedAt: Date.now()
    }
    return state
  })
}

function buyItem(itemId) {
  return updateState((state) => {
    const item = state.shopItems.find((shopItem) => shopItem.id === itemId)
    if (!item || state.coins < item.price) {
      return state
    }

    state.coins -= item.price
    state.pet.happiness = Math.min(state.pet.happiness + item.happiness, 100)
    state.pet.fullness = Math.min(state.pet.fullness + item.fullness, 100)
    state.pet.growth = Math.min(state.pet.growth + item.growth, state.pet.nextLevelGrowth)
    return state
  })
}

function addTask(task) {
  return updateState((state) => {
    const nextId = state.tasks.length ? Math.max(...state.tasks.map((item) => item.id)) + 1 : 1
    state.tasks.push({
      id: nextId,
      status: 'todo',
      statusText: '未开始',
      actualStart: '',
      actualEnd: '',
      createdAt: Date.now(),
      ...task
    })
    return state
  })
}

function updateTask(taskId, updates) {
  return updateState((state) => {
    state.tasks = state.tasks.map((task) => {
      if (task.id === taskId) {
        return {
          ...task,
          ...updates,
          estimatedMinutes: Number(updates.estimatedMinutes || task.estimatedMinutes)
        }
      }
      return task
    })
    return state
  })
}

function deleteTask(taskId) {
  return updateState((state) => {
    state.tasks = state.tasks.filter((task) => task.id !== taskId)
    return state
  })
}

function setEditTaskId(taskId) {
  return updateState((state) => {
    state.editTaskId = taskId
    return state
  })
}

function clearEditTaskId() {
  return updateState((state) => {
    state.editTaskId = null
    return state
  })
}

module.exports = {
  defaultState,
  getStateWithComputed,
  startTask,
  finishTask,
  buyItem,
  addTask,
  updateTask,
  deleteTask,
  setEditTaskId,
  clearEditTaskId,
  getCurrentTime
}
