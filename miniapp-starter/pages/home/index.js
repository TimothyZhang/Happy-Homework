const store = require('../../utils/store')
const cloudSync = require('../../utils/cloud-sync')
const shareReward = require('../../utils/share-reward')

function formatElapsed(ms) {
  if (!ms || ms < 0) return ''
  const totalSec = Math.floor(ms / 1000)
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  if (min === 0) return `${sec} 秒`
  if (sec === 0) return `${min} 分钟`
  return `${min} 分 ${sec} 秒`
}

function formatDuration(minutes) {
  if (!minutes || minutes < 0) return '—'
  if (minutes < 60) return `${minutes} 分钟`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (m === 0) return `${h} 小时`
  return `${h}h${m}m`
}

function buildPetMessage({ isToday, totalCount, pendingCount, remainingMinutes }) {
  const timeStr = remainingMinutes > 0 ? formatDuration(remainingMinutes) : ''

  if (isToday) {
    if (totalCount === 0) return '今天还没有作业安排，可以陪我玩一会儿～'
    if (pendingCount === 0) return '太棒了，今天的作业全部完成啦！🎉'
    if (pendingCount === 1) {
      return timeStr
        ? `就剩最后 1 项啦，预计 ${timeStr}，冲呀～`
        : '就剩最后 1 项啦，冲呀～'
    }
    if (timeStr) {
      return `今天还有 ${pendingCount} 项作业，预计还需 ${timeStr}，加油哦～`
    }
    return `今天还有 ${pendingCount} 项作业，加油哦～`
  }

  if (totalCount === 0) return '这一天没有安排作业'
  if (pendingCount === 0) return `这天的 ${totalCount} 项作业都完成啦`
  return `这天还有 ${pendingCount} 项作业没完成`
}

function decorateItem(item, now) {
  const occ = item.occurrence
  let elapsedMs = occ.accumulatedMs || 0
  if (occ.status === 'doing' && occ.currentSegmentStartedAt) {
    elapsedMs += Math.max(0, now - occ.currentSegmentStartedAt)
  }
  // The "overdue" treatment (red row bg, 逾期 chip) only applies while the
  // task is still open. Once it's done, drop the urgency styling.
  const visualOverdue = !!item.isOverdue && occ.status !== 'done'
  const occurrenceDate = item.occurrenceDate || ''
  const rowOrder = store.getRowOrder(item.task, item.notebook, occurrenceDate)
  return {
    // composite key — same task across multiple missed dates needs distinct
    // wx:key entries
    id: occurrenceDate ? `${item.task.id}__${occurrenceDate}` : item.task.id,
    taskId: item.task.id,
    occurrenceDate,
    notebookId: item.notebook.id,
    notebookName: item.notebook.name,
    subject: item.task.subject || '',
    content: item.task.content,
    estimatedMinutes: item.task.estimatedMinutes,
    rowOrder,
    createdAt: item.task.createdAt || 0,
    completedAt: occ.completedAt || 0,
    status: occ.status,
    isOverdue: visualOverdue,
    elapsedMs,
    elapsedDisplay: elapsedMs > 0 ? formatElapsed(elapsedMs) : ''
  }
}

// Sort undone purely by user-controlled rowOrder. Overdue / virtual /
// today rows all live in the same orderable pool now — the user is free
// to interleave a missed-Monday recurring row between today's tasks.
function sortUndone(items) {
  return items.sort((a, b) => {
    const oa = a.rowOrder || 0
    const ob = b.rowOrder || 0
    if (oa !== ob) return oa - ob
    return (a.createdAt || 0) - (b.createdAt || 0)
  })
}

// Done sorted by most recent completion first.
function sortDone(items) {
  return items.sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0))
}

// Animation lifetimes — keep in sync with reward-toast/index.wxss keyframes
// (reward-task-pop, reward-card-pop+reward-card-out).
const TASK_ANIM_MS = 1200
const ALLDONE_ANIM_MS = 3500
// Gap between task and allDone reveal so the task pop has time to fade.
const TASK_TO_ALLDONE_GAP_MS = 200
// Throttle window — drop fast double-clicks on the finish button.
const TASK_THROTTLE_MS = 600

Page({
  data: {
    activeDate: '',
    activeDateLabel: '',
    isToday: true,
    overview: { totalCount: 0, pendingCount: 0, doneCount: 0 },
    remainingMinutesDisplay: '—',
    undoneItems: [],
    doneItems: [],
    pet: { emoji: '🐾' },
    petMessage: '',
    // reward-toast props
    taskRewardVisible: false,
    taskRewardCoins: 0,
    allDoneVisible: false,
    allDoneCoins: 0,
    allDoneLastTaskCoins: 0,
    allDoneSubtitle: ''
  },

  onShow() {
    const tb = typeof this.getTabBar === 'function' && this.getTabBar()
    if (tb) tb.setData({ selected: 0 })
    if (!this.data.activeDate) {
      this.setData({ activeDate: store.todayStr() })
    }
    this.refreshState()
    // Background-check cloud (debounced 30s). Repaint if remote was newer.
    cloudSync.hydrateIfStale().then((r) => {
      if (r && r.changed) this.refreshState()
    }).catch(() => {})
    // Pull pending share-save rewards (throttled in the helper). Silent on
    // failure — cloud function may not be deployed in dev. Skip claim in
    // read-only mode so we don't lose rewards on a state we can't write.
    if (!cloudSync.isReadOnly()) {
      shareReward.claimPendingRewards().then((r) => {
        if (!r) return
        const claim = store.applyShareRewardClaim(r)
        if (!claim) return
        this.refreshState()
        const label = r.count > 1 ? `${r.count} 位好友保存了你的作业` : '好友保存了你分享的作业'
        wx.showToast({ title: `${label}，+${r.total} 金币`, icon: 'none', duration: 2400 })
      }).catch(() => {})
    }
  },

  refreshState(opts = {}) {
    const today = store.todayStr()
    const activeDate = this.data.activeDate || today
    const isToday = activeDate === today
    const state = store.getStateWithComputed()
    const now = Date.now()
    const raw = store.tasksForDate(state, activeDate)
    const decorated = raw.map((it) => decorateItem(it, now))
    const undoneItems = sortUndone(decorated.filter((it) => it.status !== 'done'))
    const doneItems = sortDone(decorated.filter((it) => it.status === 'done'))
    const total = decorated.length
    const remainingMinutes = undoneItems
      .reduce((s, it) => s + Number(it.estimatedMinutes || 0), 0)
    const petMessage = buildPetMessage({
      isToday,
      totalCount: total,
      pendingCount: undoneItems.length,
      remainingMinutes
    })
    this.setData({
      activeDate,
      activeDateLabel: this.formatDateLabel(activeDate, today),
      isToday,
      overview: { totalCount: total, pendingCount: undoneItems.length, doneCount: doneItems.length },
      remainingMinutesDisplay: formatDuration(remainingMinutes),
      undoneItems,
      doneItems,
      pet: (state.pet && state.pet.emoji) ? state.pet : this.data.pet,
      petMessage
    })
    if (opts.maybeCelebrate) this.maybeShowReward(state)
  },

  formatDateLabel(date, today) {
    if (date === today) return `今日 · ${date}`
    if (date === store.addDays(today, -1)) return `昨日 · ${date}`
    if (date === store.addDays(today, 1)) return `明日 · ${date}`
    return date
  },

  // Decides whether the just-finished tap actually awarded coins (vs. a
  // revert/redo or read-only no-op) and triggers the corresponding pet
  // animation. We compare lastReward.finishedAt against the last value we
  // celebrated — if they match, this `changed` event was not a fresh finish.
  maybeShowReward(state) {
    if (!this.data.isToday) return
    const lr = state && state.lastReward
    if (!lr || !lr.finishedAt) return
    if (lr.finishedAt === this._lastSeenRewardAt) return

    const now = Date.now()
    // Guard against stale lastReward — e.g. read-only mode where finishTask
    // is a no-op so finishedAt may be from a previous session. Only celebrate
    // a finish that happened in the last few seconds.
    if (now - lr.finishedAt > 3000) {
      this._lastSeenRewardAt = lr.finishedAt
      return
    }
    if (this._lastTaskAnimAt && now - this._lastTaskAnimAt < TASK_THROTTLE_MS) {
      // Fast double-click — still mark the reward as seen so we don't replay
      // the same animation later.
      this._lastSeenRewardAt = lr.finishedAt
      return
    }
    this._lastSeenRewardAt = lr.finishedAt
    this._lastTaskAnimAt = now

    const dailyBonus = lr.dailyBonus || 0
    const weeklyBonus = lr.weeklyBonus || 0
    const taskCoins = Math.max(1, (lr.reward || 0) - dailyBonus - weeklyBonus)
    const bonusCoins = dailyBonus + weeklyBonus

    this.showTaskReward(taskCoins)

    if (bonusCoins > 0) {
      // 全完成: queue allDone after the task pop has had time to fade.
      const subtitle = weeklyBonus > 0
        ? '今日全部完成 · 连续 7 天!'
        : '今日全部完成!'
      const delay = TASK_ANIM_MS + TASK_TO_ALLDONE_GAP_MS
      this._allDoneTimer = setTimeout(() => {
        this.showAllDone(taskCoins, bonusCoins, subtitle)
      }, delay)
    }
  },

  showTaskReward(coins) {
    if (this._taskTimer) { clearTimeout(this._taskTimer); this._taskTimer = null }
    this.setData({ taskRewardVisible: true, taskRewardCoins: coins })
    this._taskTimer = setTimeout(() => {
      this._taskTimer = null
      this.setData({ taskRewardVisible: false })
    }, TASK_ANIM_MS)
  },

  showAllDone(lastTaskCoins, bonusCoins, subtitle) {
    if (this._allDoneHideTimer) { clearTimeout(this._allDoneHideTimer); this._allDoneHideTimer = null }
    this.setData({
      allDoneVisible: true,
      allDoneCoins: bonusCoins,
      allDoneLastTaskCoins: lastTaskCoins,
      allDoneSubtitle: subtitle || ''
    })
    this._allDoneHideTimer = setTimeout(() => {
      this._allDoneHideTimer = null
      this.setData({ allDoneVisible: false })
    }, ALLDONE_ANIM_MS)
  },

  hideAllRewards() {
    if (this._taskTimer) { clearTimeout(this._taskTimer); this._taskTimer = null }
    if (this._allDoneTimer) { clearTimeout(this._allDoneTimer); this._allDoneTimer = null }
    if (this._allDoneHideTimer) { clearTimeout(this._allDoneHideTimer); this._allDoneHideTimer = null }
    if (this.data.taskRewardVisible || this.data.allDoneVisible) {
      this.setData({ taskRewardVisible: false, allDoneVisible: false })
    }
  },

  handleSkipTaskReward() {
    if (this._taskTimer) { clearTimeout(this._taskTimer); this._taskTimer = null }
    this.setData({ taskRewardVisible: false })
  },

  handleSkipAllDone() {
    if (this._allDoneHideTimer) { clearTimeout(this._allDoneHideTimer); this._allDoneHideTimer = null }
    this.setData({ allDoneVisible: false })
  },

  handleTasksChanged(e) {
    const finished = e && e.detail && e.detail.finished
    this.refreshState({ maybeCelebrate: finished })
  },

  onHide() { this.hideAllRewards() },
  onUnload() { this.hideAllRewards() },

  // === Day switcher === //

  handlePrevDay() {
    this.hideAllRewards()
    this.setData({ activeDate: store.addDays(this.data.activeDate, -1) })
    this.refreshState()
  },

  handleNextDay() {
    this.hideAllRewards()
    this.setData({ activeDate: store.addDays(this.data.activeDate, 1) })
    this.refreshState()
  },

  handleJumpToday() {
    this.hideAllRewards()
    this.setData({ activeDate: store.todayStr() })
    this.refreshState()
  }
})
