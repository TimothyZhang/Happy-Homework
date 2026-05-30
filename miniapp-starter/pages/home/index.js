const store = require('../../utils/store')
const cloudSync = require('../../utils/cloud-sync')
const shareReward = require('../../utils/share-reward')
const adminInbox = require('../../utils/admin-inbox')
const perf = require('../../utils/perf')
const homeTips = require('../../utils/home-tips')

const formatDuration = homeTips.formatDuration

function formatElapsed(ms) {
  if (!ms || ms < 0) return ''
  const totalSec = Math.floor(ms / 1000)
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  if (min === 0) return `${sec} 秒`
  if (sec === 0) return `${min} 分钟`
  return `${min} 分 ${sec} 秒`
}

// "5/10" — short M/D suffix shown on segment buttons.
function formatShortMD(dateStr) {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(dateStr || '')
  if (!m) return ''
  return `${Number(m[1])}/${Number(m[2])}`
}

// "5/16 Sat" — segment label format: 月/日 + 英文星期缩写。
const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
function formatShortMDW(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '')
  if (!m) return ''
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return `${Number(m[2])}/${Number(m[3])} ${WEEKDAY_SHORT[d.getDay()]}`
}

// Build the early-finish bonus chip data for the current hour. The chip shows
// the flat extra you'd lock in by finishing the day's last task right now — so
// it's only meaningful when there are pending tasks to finish today. When
// nothing's pending (or it's not today), drop the chip entirely; the rules
// help icon stays so the user can still check the table.
function buildBonusChip(isToday, pendingCount) {
  if (!isToday || pendingCount === 0) {
    return { active: false, icon: '', label: '' }
  }
  const b = store.earlyBirdBonus()
  if (b === 50) return { active: true, icon: '🏆', label: '19 点前完成 +50' }
  if (b === 30) return { active: true, icon: '⏱', label: '20 点前完成 +30' }
  if (b === 20) return { active: true, icon: '⏰', label: '21 点前完成 +20' }
  return { active: false, icon: '', label: '当前无加成' }
}

// buildPetMessage / buildPetTips moved to utils/home-tips.js so the pure
// formatters can be exercised by values-check.js without mocking Page().
const buildPetTips = homeTips.buildPetTips

// Subtitle shown under the per-task +N pill. Only decorate the cases the
// user can actually act on: 'future' explains the +5 over today's amount,
// 'overdue' explains the −5, 'capped' explains why the count was 0. The
// default 'today' case stays clean — no caption.
function captionForKind(kind) {
  if (kind === 'future')  return '提前完成 +5'
  if (kind === 'overdue') return '补做 (历史作业)'
  if (kind === 'capped')  return '今日已达 20 项上限'
  return ''
}

function decorateItem(item, now) {
  const occ = item.occurrence
  let elapsedMs = occ.accumulatedMs || 0
  if (occ.status === 'doing' && occ.currentSegmentStartedAt) {
    elapsedMs += Math.max(0, now - occ.currentSegmentStartedAt)
  }
  // Done rows render via a different wxml branch that doesn't apply the
  // is-overdue red row bg, so we can keep isOverdue=true even after completion
  // to preserve the overdue-date chip.
  const visualOverdue = !!item.isOverdue
  const occurrenceDate = item.occurrenceDate || ''
  const rowOrder = store.getRowOrder(item.task, occurrenceDate)
  return {
    // composite key — same task across multiple missed dates needs distinct
    // wx:key entries
    id: occurrenceDate ? `${item.task.id}__${occurrenceDate}` : item.task.id,
    taskId: item.task.id,
    taskMode: item.task.mode || 'one-shot',
    occurrenceDate,
    subject: item.task.subject || '',
    // recurring 的具体周期标签:"每天" / "每周一" / "每周二三四" / 等。
    // 一次性 task 为 ''(wxml 用 taskMode==='recurring' 过滤)。
    recurrenceLabel: store.formatRecurrenceLabel(item.task),
    organization: item.task.organization || '其他',
    content: item.task.content,
    estimatedMinutes: item.task.estimatedMinutes,
    rowOrder,
    createdAt: item.task.createdAt || 0,
    completedAt: occ.completedAt || 0,
    status: occ.status,
    isOverdue: visualOverdue,
    // 补做项:occurrenceDate < 今天且在今天才完成。背景黄底,与 is-overdue
    // 红底视觉分开 —— 当天本日完成的还是白底。
    isMakeup: !!item.isMakeup,
    elapsedMs,
    elapsedDisplay: elapsedMs > 0 ? formatElapsed(elapsedMs) : ''
  }
}

// Sort undone purely by user-controlled rowOrder. Overdue / virtual /
// today rows all live in the same orderable pool now — the user is free
// to interleave a missed-Monday recurring row between today's tasks.
//
// 不再做"同 subject 推到末尾"的二次重排 — 那个会让用户拖动 reorder 的
// 结果失效:同 subject 的卡片(比如 Tim 的两张"语文")被强制分开,后者一
// 律推末尾,看起来"拖了没生效"。用户拖完位置就是最终位置。
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
    // 'today' | 'tomorrow' | 'day-after' | 'calendar' — drives segment highlight.
    activeSegment: 'today',
    calendarOpen: false,
    // Locks the inner <scroll-view> while a task-list drag is in progress.
    // 仅在 row 高亮态 drag 时还保留 — 主要拦截是靠 task-row 上 catchtouchmove
    // (不冒泡到 scroll-view),这个软锁是兜底。
    disableScroll: false,
    // 任一 task-list row 左滑展开了 swipe-action 菜单时为 true。两个
    // task-list (未完成 / 已完成) 各自触发 swipeopen / swipeclose,这里
    // 用计数避免两个区先后打开 → 先关一个就误以为都关了。
    swipeMenuOpen: false,
    todayLabel: '今天',
    tomorrowLabel: '明天',
    dayAfterLabel: '后天',
    calendarLabel: '日历',
    overview: { totalCount: 0, pendingCount: 0, doneCount: 0 },
    remainingMinutesDisplay: '—',
    undoneItems: [],
    doneItems: [],
    pet: { emoji: '🐾' },
    // Mood overlay for the home mascot — same derivation as pet page so the
    // small SVG here never shows a different state than the big one. 'idle'
    // when no pet has been set up yet.
    animState: 'idle',
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
    // Optional caption for the per-task toast: '提前完成 +5' / '补做 (历史作业)'
    // / '今日已达 20 项上限'. Empty for plain today-task finishes.
    taskRewardCaption: '',
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
    // maybeCelebrate: 让 home 在 onShow 时也跑一次 reward 检查 —— 用户在
    // task-focus 页点完成 → navigateBack 回 home,完成动作发生在另一个页面,
    // home 自己的 handleTaskTap 路径没走过。maybeShowReward 内部有 3s 守卫 +
    // _lastSeenRewardAt dedupe,onShow 反复触发也不会 double-pop。
    this.refreshState({ perfStamp: stamp, maybeCelebrate: true })
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

      // 拉 admin 调整 inbox。 throttle 30s，失败静默。server 现在做服务端
      // clamp + 余额更新,返 newBalance/items(含 applied)/totalApplied 等,
      // 客户端只做 UI 闪 toast + coinLogs 记录。
      adminInbox.claimPendingAdminCoins().then((r) => {
        if (!r) return
        const summary = store.applyAdminCoinClaim(r)
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
    const dayAfter = store.addDays(today, 2)
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
    // Project total coins earnable if the user finishes all pending items by
    // each tier deadline. Only today view computes this (tomorrow/future views
    // can't trigger today's early-bird math). projectedReward consults the
    // raw (un-decorated) items so it can read occurrence.rewardPaid.
    const projected19 = isToday ? store.projectedReward(state, raw, 19) : 0
    const projected20 = isToday ? store.projectedReward(state, raw, 20) : 0
    const projected21 = isToday ? store.projectedReward(state, raw, 21) : 0
    const coinsToday = isToday ? store.coinsEarnedOn(state, selectedDate) : 0
    // Sum actualMinutes across done items in today's view (drives the
    // all-done summary tip). 用 raw 而非 decorated 是为了直接读 occurrence
    // 里持久化的 actualMinutes —— 由 finishTask 一次性写定,不会被显示层四舍五入。
    let totalDoneMinutes = 0
    if (isToday) {
      for (const it of raw) {
        const occ = it.occurrence || {}
        if (occ.status === 'done') totalDoneMinutes += Number(occ.actualMinutes || 0)
      }
    }
    const petTipCtx = {
      isToday,
      totalCount: total,
      pendingCount: undoneItems.length,
      remainingMinutes,
      coinsToday,
      totalDoneMinutes,
      projected19,
      projected20,
      projected21
    }
    this._petTipCtx = petTipCtx
    this._petTips = buildPetTips(petTipCtx)
    // Cap index to new tips length; keep current position otherwise so a
    // mid-rotation refresh (e.g. finishing one task) doesn't yank the user
    // back to the first message.
    this._petMessageIndex = Math.min(this._petMessageIndex || 0, Math.max(0, this._petTips.length - 1))
    const petMessage = this._petTips[this._petMessageIndex] || ''
    const bonus = buildBonusChip(isToday, undoneItems.length)

    // Segment labels — 都是 "5/16 Sat" 格式;日历未选自定义日期时显示 "日历"。
    const todayLabel = formatShortMDW(today)
    const tomorrowLabel = formatShortMDW(tomorrow)
    const dayAfterLabel = formatShortMDW(dayAfter)
    const showCalDate = selectedDate &&
      selectedDate !== today && selectedDate !== tomorrow && selectedDate !== dayAfter
    const calendarLabel = showCalDate ? formatShortMDW(selectedDate) : '日历'

    let activeSegment
    if (this.data.calendarOpen) activeSegment = 'calendar'
    else if (selectedDate === today) activeSegment = 'today'
    else if (selectedDate === tomorrow) activeSegment = 'tomorrow'
    else if (selectedDate === dayAfter) activeSegment = 'day-after'
    else activeSegment = 'calendar'

    this.setData({
      selectedDate,
      isToday,
      activeSegment,
      todayLabel,
      tomorrowLabel,
      dayAfterLabel,
      calendarLabel,
      overview: { totalCount: total, pendingCount: undoneItems.length, doneCount: doneItems.length },
      remainingMinutesDisplay: formatDuration(remainingMinutes),
      undoneItems,
      doneItems,
      pet: (state.pet && state.pet.emoji) ? state.pet : this.data.pet,
      animState: store.deriveAnimState(state.pet),
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
    // No isToday gate on the per-task toast — finishing a future task from the
    // "tomorrow" segment must still surface the "+5 提前完成" caption, otherwise
    // the +5 has no UI affordance. The allDone celebration further down stays
    // gated to today since its subtitle says "今日".
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
    // Per-task pill comes from lr.taskReward (the 5/10/15 or 0 the cap clamped
    // to). Fall back to the legacy subtraction for any pre-upgrade lastReward
    // that doesn't have taskReward stamped.
    const taskCoins = lr.taskReward != null
      ? lr.taskReward
      : Math.max(1, (lr.reward || 0) - dailyBonus - weeklyBonus)
    const taskCaption = captionForKind(lr.rewardKind)
    const bonusCoins = dailyBonus + weeklyBonus

    this.showTaskReward(taskCoins, taskCaption)

    // Flag the pet page to play one celebration animation on its next onShow.
    // Consumed in pages/pet/index.js. Cross-page because home & pet are
    // separate tabs — the pet page is typically not in the foreground when
    // a task finishes.
    const app = getApp()
    if (app) {
      app.globalData = app.globalData || {}
      app.globalData.petAnimQueue = 'celebrating'
    }

    if (bonusCoins > 0 && this.data.isToday && lr.rewardKind === 'today') {
      // 全完成: queue allDone after the task pop has had time to fade.
      // 触发条件:今日视图 + 本次完成的是 today 归属的 task + 该次触发了 perfect 奖。
      // rewardKind 取代了原本的 todayCleared 门槛 —— overdue 补做不再发 perfect
      // (bonusCoins=0 自动过滤),所以不需要再用 todayCleared 来防"过去日补做误
      // 触发 today toast"了。todayCleared 在有未补 overdue 时为 false,会错挡掉
      // today 真完成时的庆祝。
      const subtitle = weeklyBonus > 0
        ? '今日全部完成 · 连续 7 天!'
        : '今日全部完成!'
      const delay = TASK_ANIM_MS + TASK_TO_ALLDONE_GAP_MS
      this._allDoneTimer = setTimeout(() => {
        this.showAllDone(bonusCoins, subtitle)
      }, delay)
    }
  },

  showTaskReward(coins, caption) {
    if (this._taskTimer) { clearTimeout(this._taskTimer); this._taskTimer = null }
    this.setData({
      taskRewardVisible: true,
      taskRewardCoins: coins,
      taskRewardCaption: caption || ''
    })
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

  // swipestart / swipeend:row 横向手势期间锁 scroll-view scroll-y,免得
  // swipe 的 dy 分量被 native scroll 吃掉。注意第一帧(越过 6rpx 阈值
  // 那次)还是会带一点点 native 滚动,可接受。
  handleSwipeStart() { this.setData({ disableScroll: true }) },
  handleSwipeEnd() { this.setData({ disableScroll: false }) },

  // 右滑顺延:把一次性 task 的 dueDate 改到「当前查看日 + 1」再刷新。用
  // selectedDate 而非 row 自己的 occurrenceDate —— 这样逾期项也能正确移到明天,
  // 不会出现"顺延后还留在今天"。组件已保证只有一次性未完成 row 会触发本事件。
  handlePostpone(e) {
    const taskId = e.detail && e.detail.taskId
    if (!taskId) return
    const base = this.data.selectedDate || store.todayStr()
    store.updateTask(taskId, { dueDate: store.addDays(base, 1) })
    this.refreshState()
    wx.showToast({ title: '已移到下一天', icon: 'none' })
  },

  handleSwipeOpen() {
    this._openSwipeCount = (this._openSwipeCount || 0) + 1
    if (!this.data.swipeMenuOpen) this.setData({ swipeMenuOpen: true })
  },
  handleSwipeClose() {
    this._openSwipeCount = Math.max(0, (this._openSwipeCount || 0) - 1)
    if (this._openSwipeCount === 0 && this.data.swipeMenuOpen) {
      this.setData({ swipeMenuOpen: false })
    }
  },

  onHide() { this.hideAllRewards(); this._stopPetMessageRotation() },
  onUnload() { this.hideAllRewards(); this._stopPetMessageRotation() },

  handleAddTask() {
    // 默认日期跟随首页当前选中(今天/明天/后天/日历选的日子)。
    const date = this.data.selectedDate || store.todayStr()
    wx.navigateTo({ url: `/pkg-notebook/task-edit/index?date=${date}` })
  },

  handleNavigateToShare() {
    // 分享页默认带当前选中的日期 — start/end 都设到这天,用户再调范围。
    const date = this.data.selectedDate || store.todayStr()
    wx.navigateTo({ url: `/pages/share/index?date=${date}` })
  },

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
    } else if (seg === 'day-after') {
      this.setData({ selectedDate: store.addDays(store.todayStr(), 2), calendarOpen: false })
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
