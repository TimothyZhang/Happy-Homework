const store = require('../../utils/store')
const cloudSync = require('../../utils/cloud-sync')
const shareReward = require('../../utils/share-reward')
const adminInbox = require('../../utils/admin-inbox')
const perf = require('../../utils/perf')

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

// "5/10" — short M/D suffix shown on segment buttons.
function formatShortMD(dateStr) {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(dateStr || '')
  if (!m) return ''
  return `${Number(m[1])}/${Number(m[2])}`
}

// Build the early-finish bonus chip data for the current hour. The chip shows
// the multiplier you'd lock in by finishing the day's last task right now — so
// it's only meaningful when there are pending tasks to finish today. When
// nothing's pending (or it's not today), drop the chip entirely; the rules
// help icon stays so the user can still check the table.
function buildBonusChip(isToday, pendingCount) {
  if (!isToday || pendingCount === 0) {
    return { active: false, icon: '', label: '' }
  }
  const m = store.dailyPerfectMultiplier()
  if (m === 2)    return { active: true,  icon: '🏆', label: '早完成加成 ×2' }
  if (m === 1.5)  return { active: true,  icon: '⏱',  label: '加成 ×1.5' }
  if (m === 1.25) return { active: true,  icon: '⏰', label: '加成 ×1.25' }
  return { active: false, icon: '', label: '当前无加成' }
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

// Build the rotating list of speech-bubble lines shown next to the pet. The
// first item is always the contextual progress message; the rest are the
// early-finish bonus tips relevant to the current time (only show a tier the
// user could still hit).
function buildPetTips(ctx) {
  const tips = [buildPetMessage(ctx)]
  if (!ctx.isToday || ctx.pendingCount === 0) return tips
  const m = store.dailyPerfectMultiplier()
  if (m >= 2)    tips.push('🏆 19:00 前完成所有作业，金币奖励增加 100%')
  if (m >= 1.5)  tips.push('⏱ 20:00 前完成所有作业，金币奖励增加 50%')
  if (m >= 1.25) tips.push('⏰ 21:00 前完成所有作业，金币奖励增加 25%')
  return tips
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
const ALLDONE_ANIM_MS = 3200
// Gap between task and allDone reveal so the task pop has time to fade.
const TASK_TO_ALLDONE_GAP_MS = 200
// Throttle window — drop fast double-clicks on the finish button.
const TASK_THROTTLE_MS = 600

Page({
  data: {
    selectedDate: '',
    isToday: true,
    // 'today' | 'tomorrow' | 'calendar' — drives segment highlight.
    activeSegment: 'today',
    calendarOpen: false,
    // Locks the inner <scroll-view> while a task-list drag is in progress.
    // The page itself has page-meta disable-scroll permanently on; the only
    // scrollable surface is .scroll-area. Toggling page-meta mid-gesture
    // wasn't preventing the screen from drifting once the touch had begun,
    // so we keep the page locked and flip scroll-y on the inner view instead
    // — that change is honored immediately even mid-gesture.
    disableScroll: false,
    todayLabel: '今天',
    tomorrowLabel: '明天',
    calendarLabel: '日历',
    overview: { totalCount: 0, pendingCount: 0, doneCount: 0 },
    remainingMinutesDisplay: '—',
    undoneItems: [],
    doneItems: [],
    pet: { emoji: '🐾' },
    petMessage: '',
    // True briefly while the pet-bubble text cross-fades to the next tip.
    petMessageFading: false,
    // Early-bird daily-perfect bonus, refreshed in refreshState.
    bonusActive: false,
    bonusIcon: '',
    bonusLabel: '',
    rewardRulesOpen: false,
    // reward-toast props
    taskRewardVisible: false,
    taskRewardCoins: 0,
    allDoneVisible: false,
    allDoneCoins: 0,
    allDoneSubtitle: ''
  },

  onShow() {
    const stamp = perf.markPageShow('home')
    const tb = typeof this.getTabBar === 'function' && this.getTabBar()
    if (tb) tb.setData({ selected: 0 })
    if (!this.data.selectedDate) {
      this.setData({ selectedDate: store.todayStr() })
    }
    this.refreshState({ perfStamp: stamp })
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

      // 拉 admin 调整 inbox。 throttle 30s，失败静默。
      adminInbox.claimPendingAdminCoins().then((r) => {
        if (!r) return
        const summary = store.applyAdminCoinClaim({ items: r.items })
        if (!summary || summary.totalApplied === 0) return
        this.refreshState()
        const t = summary.totalApplied
        const label = t > 0 ? `管理员奖励 +${t} 金币` : `管理员扣除 ${t} 金币`
        wx.showToast({ title: label, icon: 'none', duration: 2400 })
      }).catch(() => {})
    }
  },

  refreshState(opts = {}) {
    const today = store.todayStr()
    const tomorrow = store.addDays(today, 1)
    const selectedDate = this.data.selectedDate || today
    const isToday = selectedDate === today
    const state = store.getStateWithComputed()
    const now = Date.now()
    const raw = store.tasksForDate(state, selectedDate)
    const decorated = raw.map((it) => decorateItem(it, now))
    const undoneItems = sortUndone(decorated.filter((it) => it.status !== 'done'))
    const doneItems = sortDone(decorated.filter((it) => it.status === 'done'))
    const total = decorated.length
    const remainingMinutes = undoneItems
      .reduce((s, it) => s + Number(it.estimatedMinutes || 0), 0)
    const petTipCtx = {
      isToday,
      totalCount: total,
      pendingCount: undoneItems.length,
      remainingMinutes
    }
    this._petTipCtx = petTipCtx
    this._petTips = buildPetTips(petTipCtx)
    // Cap index to new tips length; keep current position otherwise so a
    // mid-rotation refresh (e.g. finishing one task) doesn't yank the user
    // back to the first message.
    this._petMessageIndex = Math.min(this._petMessageIndex || 0, Math.max(0, this._petTips.length - 1))
    const petMessage = this._petTips[this._petMessageIndex] || ''
    const bonus = buildBonusChip(isToday, undoneItems.length)

    // Segment labels — "今天 5/10", "明天 5/11", and "日历" or "日历 5/15"
    // when the user has picked a day that isn't today/tomorrow.
    const todayLabel = `今天 ${formatShortMD(today)}`
    const tomorrowLabel = `明天 ${formatShortMD(tomorrow)}`
    const showCalDate = selectedDate && selectedDate !== today && selectedDate !== tomorrow
    const calendarLabel = showCalDate ? `日历 ${formatShortMD(selectedDate)}` : '日历'

    let activeSegment
    if (this.data.calendarOpen) activeSegment = 'calendar'
    else if (selectedDate === today) activeSegment = 'today'
    else if (selectedDate === tomorrow) activeSegment = 'tomorrow'
    else activeSegment = 'calendar'

    this.setData({
      selectedDate,
      isToday,
      activeSegment,
      todayLabel,
      tomorrowLabel,
      calendarLabel,
      overview: { totalCount: total, pendingCount: undoneItems.length, doneCount: doneItems.length },
      remainingMinutesDisplay: formatDuration(remainingMinutes),
      undoneItems,
      doneItems,
      pet: (state.pet && state.pet.emoji) ? state.pet : this.data.pet,
      petMessage,
      bonusActive: bonus.active,
      bonusIcon: bonus.icon,
      bonusLabel: bonus.label
    }, opts.perfStamp ? () => perf.markPaint(opts.perfStamp) : undefined)
    // Repaint embedded calendar's day-count bubbles when store changes.
    if (this.data.calendarOpen) {
      const cal = this.selectComponent('#cal')
      if (cal) cal.refresh()
    }
    if (opts.maybeCelebrate) this.maybeShowReward(state)

    // Start / stop the speech-bubble rotation based on tip count.
    if (this._petTips.length > 1) this._startPetMessageRotation()
    else this._stopPetMessageRotation()
  },

  // === Pet speech bubble rotation === //
  // 4.5s cadence with a ~220ms cross-fade. The tips list is rebuilt on each
  // tick so a tier that's crossed its deadline (e.g. clock just passed 19:00)
  // drops out without waiting for the next refreshState.

  _startPetMessageRotation() {
    if (this._petMessageTimer) return
    this._petMessageTimer = setInterval(() => this._rotatePetMessage(), 4500)
  },
  _stopPetMessageRotation() {
    if (this._petMessageTimer) { clearInterval(this._petMessageTimer); this._petMessageTimer = null }
    if (this._petMessageFadeTimer) { clearTimeout(this._petMessageFadeTimer); this._petMessageFadeTimer = null }
  },
  _rotatePetMessage() {
    const ctx = this._petTipCtx
    if (!ctx) return
    const tips = buildPetTips(ctx)
    this._petTips = tips
    if (tips.length === 0) { this._stopPetMessageRotation(); return }
    if (tips.length === 1) {
      if (this.data.petMessage !== tips[0]) this.setData({ petMessage: tips[0] })
      this._stopPetMessageRotation()
      return
    }
    const next = ((this._petMessageIndex || 0) + 1) % tips.length
    this.setData({ petMessageFading: true })
    this._petMessageFadeTimer = setTimeout(() => {
      this._petMessageFadeTimer = null
      this._petMessageIndex = next
      this.setData({ petMessage: tips[next], petMessageFading: false })
    }, 220)
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

    // Flag the pet page to play one celebration animation on its next onShow.
    // Consumed in pages/pet/index.js. Cross-page because home & pet are
    // separate tabs — the pet page is typically not in the foreground when
    // a task finishes.
    const app = getApp()
    if (app) {
      app.globalData = app.globalData || {}
      app.globalData.petAnimQueue = 'celebrating'
    }

    if (bonusCoins > 0) {
      // 全完成: queue allDone after the task pop has had time to fade.
      const subtitle = weeklyBonus > 0
        ? '今日全部完成 · 连续 7 天!'
        : '今日全部完成!'
      const delay = TASK_ANIM_MS + TASK_TO_ALLDONE_GAP_MS
      this._allDoneTimer = setTimeout(() => {
        this.showAllDone(bonusCoins, subtitle)
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

  showAllDone(bonusCoins, subtitle) {
    if (this._allDoneHideTimer) { clearTimeout(this._allDoneHideTimer); this._allDoneHideTimer = null }
    this.setData({
      allDoneVisible: true,
      allDoneCoins: bonusCoins,
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

  openRewardRules() { this.setData({ rewardRulesOpen: true }) },
  closeRewardRules() { this.setData({ rewardRulesOpen: false }) },
  noop() {},

  handleTasksChanged(e) {
    const finished = e && e.detail && e.detail.finished
    this.refreshState({ maybeCelebrate: finished })
  },

  handleDragStart() { this.setData({ disableScroll: true }) },
  handleDragEnd() { this.setData({ disableScroll: false }) },

  onHide() { this.hideAllRewards(); this._stopPetMessageRotation() },
  onUnload() { this.hideAllRewards(); this._stopPetMessageRotation() },

  // === Date segment === //

  handleSegmentTap(e) {
    const seg = e.currentTarget.dataset.seg
    if (!seg) return
    this.hideAllRewards()
    if (seg === 'today') {
      this.setData({ selectedDate: store.todayStr(), calendarOpen: false })
      this.refreshState()
    } else if (seg === 'tomorrow') {
      this.setData({ selectedDate: store.addDays(store.todayStr(), 1), calendarOpen: false })
      this.refreshState()
    } else if (seg === 'calendar') {
      // Open the calendar; selectedDate stays where it is — user picks a
      // day to switch the task list.
      this.setData({ calendarOpen: true })
      this.refreshState()
    }
  },

  handleCalendarChange(e) {
    const date = e.detail && e.detail.date
    if (!date) return
    this.hideAllRewards()
    // Calendar stays open after picking — user can keep flipping days.
    this.setData({ selectedDate: date, calendarOpen: true })
    this.refreshState()
  }
})
