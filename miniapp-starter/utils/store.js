const STORAGE_KEY = 'homework-pet-v1'

const defaultState = {
  coins: 36,
  streakDays: 4,
  bonusCoins: 10,
  editTaskId: null,
  ocrCurrentJob: null,
  ocrJobs: [],
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

function pauseTaskInPlace(task, now) {
  if (task.status !== 'doing') return task
  const segMs = task.currentSegmentStartedAt ? Math.max(0, now - task.currentSegmentStartedAt) : 0
  return {
    ...task,
    status: 'paused',
    statusText: '已暂停',
    accumulatedMs: (task.accumulatedMs || 0) + segMs,
    currentSegmentStartedAt: null
  }
}

function startTask(taskId) {
  return updateState((state) => {
    const now = Date.now()
    state.tasks = state.tasks.map((task) => {
      if (task.id === taskId) {
        return {
          ...task,
          status: 'doing',
          statusText: '进行中',
          actualStart: task.actualStart || getCurrentTime(),
          actualStartedAt: task.actualStartedAt || now,
          currentSegmentStartedAt: now,
          accumulatedMs: task.accumulatedMs || 0
        }
      }
      // 同时把别的进行中任务自动暂停 —— 一次只能开一项
      return pauseTaskInPlace(task, now)
    })
    return state
  })
}

function pauseTask(taskId) {
  return updateState((state) => {
    const now = Date.now()
    state.tasks = state.tasks.map((task) => {
      if (task.id === taskId) return pauseTaskInPlace(task, now)
      return task
    })
    return state
  })
}

function resumeTask(taskId) {
  return updateState((state) => {
    const now = Date.now()
    state.tasks = state.tasks.map((task) => {
      if (task.id === taskId && task.status === 'paused') {
        return {
          ...task,
          status: 'doing',
          statusText: '进行中',
          currentSegmentStartedAt: now
        }
      }
      // 同时把别的进行中任务自动暂停
      return pauseTaskInPlace(task, now)
    })
    return state
  })
}

function finishTask(taskId) {
  return updateState((state) => {
    const now = Date.now()
    let reward = 8
    let leveledUp = false
    state.tasks = state.tasks.map((task) => {
      if (task.id === taskId) {
        const segMs = task.currentSegmentStartedAt ? Math.max(0, now - task.currentSegmentStartedAt) : 0
        const totalMs = (task.accumulatedMs || 0) + segMs
        return {
          ...task,
          status: 'done',
          statusText: '已完成',
          actualEnd: getCurrentTime(),
          actualEndedAt: now,
          accumulatedMs: totalMs,
          elapsedMs: totalMs,
          currentSegmentStartedAt: null
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

function reorderTasks(orderedIds) {
  return updateState((state) => {
    const idToTask = new Map(state.tasks.map((task) => [task.id, task]))
    const next = []
    // 先按用户给的顺序排
    for (const id of orderedIds) {
      const task = idToTask.get(id)
      if (task) {
        next.push(task)
        idToTask.delete(id)
      }
    }
    // 兜底:不在 orderedIds 里的(理论上不会有)按原顺序补到末尾
    for (const task of idToTask.values()) next.push(task)
    state.tasks = next
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

function setCurrentOcrJob(job) {
  return updateState((state) => {
    const normalizedJob = {
      id: job.id || Date.now(),
      imagePath: job.imagePath || '',
      rawText: job.rawText || '',
      source: job.source || '',
      providerWarning: job.providerWarning || '',
      drafts: (job.drafts || []).map((draft, index) => ({
        id: draft.id || `${Date.now()}-${index}`,
        subject: draft.subject || '',
        content: draft.content || '',
        rawText: draft.rawText || '',
        confidence: draft.confidence || '中',
        needsConfirm: typeof draft.needsConfirm === 'boolean' ? draft.needsConfirm : true
      })),
      createdAt: job.createdAt || Date.now()
    }

    state.ocrCurrentJob = normalizedJob
    state.ocrJobs = [normalizedJob, ...(state.ocrJobs || []).filter((item) => item.id !== normalizedJob.id)].slice(0, 10)
    return state
  })
}

function getCurrentOcrJob() {
  const state = loadState()
  return state.ocrCurrentJob || null
}

function clearCurrentOcrJob() {
  return updateState((state) => {
    state.ocrCurrentJob = null
    return state
  })
}

module.exports = {
  defaultState,
  getStateWithComputed,
  startTask,
  pauseTask,
  resumeTask,
  finishTask,
  reorderTasks,
  buyItem,
  addTask,
  updateTask,
  deleteTask,
  setEditTaskId,
  clearEditTaskId,
  setCurrentOcrJob,
  getCurrentOcrJob,
  clearCurrentOcrJob,
  getCurrentTime
}
