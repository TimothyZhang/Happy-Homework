const store = require('../../utils/store')
const i18n = require('../../utils/i18n')

// 番茄钟参数(都可设置)。连续写作业满 workMin 分钟 → 提醒休息;
// 暂停时按「近 windowMin 分钟作业时长」决定休息多久:> heavyThreshMin → 长休息,否则短休息。
// 每项:data key、storage key、默认值、可选项(分钟)、i18n 标签。
const POMO_PARAMS = [
  { key: 'workMin',        sk: 'focusWorkMin',     def: 25,  opts: [15, 20, 25, 30, 35, 40, 45, 50, 60], label: 'tfocus_set_work' },
  { key: 'shortBreakMin',  sk: 'focusShortBreak',  def: 5,   opts: [3, 5, 8, 10, 15],                    label: 'tfocus_set_short' },
  { key: 'longBreakMin',   sk: 'focusLongBreak',   def: 20,  opts: [10, 15, 20, 25, 30, 45],             label: 'tfocus_set_long' },
  { key: 'heavyThreshMin', sk: 'focusHeavyThresh', def: 100, opts: [60, 80, 100, 120, 150],              label: 'tfocus_set_thresh' },
  { key: 'windowMin',      sk: 'focusWindow',      def: 120, opts: [60, 90, 120, 150, 180],              label: 'tfocus_set_window' }
]
const WORK_LOG_KEY = 'focusWorkLog'   // 全局作业段日志 [{s,e}],用于算「近 N 分钟作业时长」

function loadPomoParam(p) {
  let v = p.def
  try { v = Number(wx.getStorageSync(p.sk)) || p.def } catch (e) {}
  return p.opts.indexOf(v) >= 0 ? v : p.def
}
function loadWorkLog() {
  try { const a = wx.getStorageSync(WORK_LOG_KEY); return Array.isArray(a) ? a : [] } catch (e) { return [] }
}
// 追加一段已结束的作业 [s,e],顺手裁掉太老的(留够 window + 余量)
function appendWorkSeg(s, e, windowMs) {
  if (!(e > s)) return
  const cutoff = e - Math.max(windowMs, 7200000) - 60000
  const log = loadWorkLog().filter((seg) => seg && seg.e > cutoff)
  log.push({ s: s, e: e })
  try { wx.setStorageSync(WORK_LOG_KEY, log) } catch (err) {}
}
// 近 windowMs 内的作业总时长(各段与 [now-window, now] 的交叠之和)
function recentWorkMs(windowMs, now) {
  const lo = now - windowMs
  let total = 0
  for (const seg of loadWorkLog()) {
    if (!seg) continue
    const a = Math.max(seg.s, lo), b = Math.min(seg.e, now)
    if (b > a) total += (b - a)
  }
  return total
}

// "进行中" 大数字格式:
//   < 1 小时 → MM:SS
//   ≥ 1 小时 → H:MM:SS
function formatBigClock(ms) {
  const total = Math.max(0, Math.floor((ms || 0) / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n) => `${n}`.padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

Page({
  data: {
    taskId: '',
    date: '',
    content: '',
    subject: '',
    isRecurring: false,
    recurrenceLabel: '',
    estimatedMinutes: 0,
    occurrenceDate: '',
    elapsedMs: 0,
    elapsedDisplay: '00:00',
    // 暂停后停留在本页:作业时间(elapsed)定格在上面,额外显示暂停时长
    isPaused: false,
    pausedDisplay: '00:00',
    // 番茄倒计时进度条:本次专注进度(填充 %)+ 距离休息剩余时间
    pomoPercent: 0,
    pomoLeftDisplay: '',
    // 番茄钟(都可设置)
    workMin: 25,
    shortBreakMin: 5,
    longBreakMin: 20,
    heavyThreshMin: 100,
    windowMin: 120,
    workMinLabel: '',
    breakMin: 5,              // 本次暂停建议休息几分钟(暂停时按近期作业量算出)
    breakHint: '',            // 「建议休息 N 分钟」提示文案
    pomoBtnStyle: '',         // 右上角番茄设置图标位置(对齐胶囊左侧,动态算)
    showPomoSettings: false,
    // 时间记录(开始/暂停/继续/完成)
    showTimeline: false,
    timelineRows: [],
    pomoRows: []              // 设置面板各行 {key,label,optionLabels,index,valueLabel}
  },

  onLoad(options) {
    const opts = options || {}
    this.setData({ taskId: opts.id || '', date: opts.date || '' })
    this._lastBreakBeepMark = 0    // 暂停已提醒到第几个 break
    this._lastPomoCycle = 0        // 番茄已跨过第几个周期(防重复响铃;退出重进会按段重算)
    this._segStart = null          // 当前作业段起点 = store 的 currentSegmentStartedAt(番茄钟也用它,退出/重进/后台都不丢)
    this._positionPomoBtn()
    if (!this.refresh()) return    // 先 refresh 设好 _segStart + isPaused
    this._loadPomo()
    this.startTicker()
  },

  // 右上角番茄设置图标:贴着小程序胶囊左侧、与之等高对齐(custom 导航,胶囊不可遮挡)
  _positionPomoBtn() {
    try {
      const cap = wx.getMenuButtonBoundingClientRect()
      const sys = wx.getSystemInfoSync()
      const winW = (sys && sys.windowWidth) || 375
      const rightPx = Math.max(8, winW - cap.left + 8)
      this.setData({
        pomoBtnStyle: 'position:fixed; top:' + cap.top + 'px; right:' + rightPx + 'px; width:' + cap.height + 'px; height:' + cap.height + 'px; line-height:' + cap.height + 'px;'
      })
    } catch (e) {
      this.setData({ pomoBtnStyle: 'position:fixed; top:calc(env(safe-area-inset-top) + 36rpx); right:200rpx; width:60rpx; height:60rpx; line-height:60rpx;' })
    }
  },

  onShow() {
    this.setData({ t: i18n.dict() })
    wx.setNavigationBarTitle({ title: i18n.t('tfocus_navtitle') })
    if (!this.data.taskId) return
    if (!this.refresh()) return   // 先 refresh 设好 _segStart + isPaused
    this._loadPomo()              // 再按当前作业段算番茄进度(+刷新参数文案)
    this.startTicker()
  },

  // 读取所有番茄钟参数 → data;构建设置面板行 + 药丸文案
  _loadPomo() {
    const patch = {}
    const rows = POMO_PARAMS.map((p) => {
      const val = loadPomoParam(p)
      patch[p.key] = val
      return {
        key: p.key,
        label: i18n.t(p.label),
        optionLabels: p.opts.map((n) => i18n.t('tfocus_pomo_min', { n })),
        index: Math.max(0, p.opts.indexOf(val)),
        valueLabel: i18n.t('tfocus_pomo_min', { n: val })
      }
    })
    patch.pomoRows = rows
    patch.workMinLabel = i18n.t('tfocus_pomo_label', { n: patch.workMin })
    const ps = this._pomoState(patch.workMin * 60000, false)   // 后台恢复时按墙钟重算(不响铃)
    patch.pomoPercent = ps.percent
    patch.pomoLeftDisplay = ps.leftDisplay
    this.setData(patch)
  },

  // 番茄倒计时当前状态:从当前作业段起点(store 的 currentSegmentStartedAt)按 cycle=workMin 取模循环算。
  // → 退出专注(不暂停/完成)再回来、以及后台恢复,都不重置(段起点不变)。跨过周期边界时响铃(allowBeep)。
  _pomoState(cycleMs, allowBeep) {
    const seg = this._segStart
    if (this.data.isPaused || !seg || cycleMs <= 0) {
      return { percent: 0, leftDisplay: formatBigClock(cycleMs) }
    }
    const segmentMs = Math.max(0, Date.now() - seg)
    const cyclesPassed = Math.floor(segmentMs / cycleMs)
    if (cyclesPassed > (this._lastPomoCycle || 0)) {
      if (allowBeep) this._remind('rest')
      this._lastPomoCycle = cyclesPassed
    }
    const workSince = segmentMs - cyclesPassed * cycleMs
    return {
      percent: Math.min(100, workSince / cycleMs * 100),
      leftDisplay: formatBigClock(Math.max(0, cycleMs - workSince))
    }
  },

  onHide() { this.stopTicker() },
  onUnload() {
    this.stopTicker()
    try { if (this._sfx) { this._sfx.destroy(); this._sfx = null } } catch (e) {}
  },
  // 横竖屏切换:胶囊位置变了,重新把番茄设置图标贴到它左侧
  onResize() { this._positionPomoBtn() },

  // 拉最新 task,装到 data。返回 false 表示 task 不再 doing(或不存在),
  // 此时已 navigateBack。
  refresh() {
    const state = store.getStateWithComputed()
    const task = state.tasks.find((t) => t.id === this.data.taskId)
    if (!task) {
      wx.showToast({ title: i18n.t('tfocus_toast_not_found'), icon: 'none' })
      setTimeout(() => wx.navigateBack(), 400)
      return false
    }
    const occState = store.getTaskState(task, this.data.date || '')
    // doing 或 paused 都停留在 focus;只有被别处改成 done/todo 才退出
    if (occState.status !== 'doing' && occState.status !== 'paused') {
      wx.navigateBack()
      return false
    }
    const isPaused = occState.status === 'paused'
    const segMs = occState.currentSegmentStartedAt
      ? Math.max(0, Date.now() - occState.currentSegmentStartedAt)
      : 0
    const elapsedMs = (occState.accumulatedMs || 0) + segMs   // 作业时间(暂停时 seg=0 → 定格)
    if (isPaused) { if (!this._pausedAt) this._pausedAt = Date.now() }
    else { this._pausedAt = null; this._segStart = occState.currentSegmentStartedAt || this._segStart || Date.now() }
    const pausedMs = isPaused ? Math.max(0, Date.now() - this._pausedAt) : 0
    const estMins = Number(task.estimatedMinutes) || 0
    this.setData({
      content: task.content || '',
      subject: task.subject || '',
      isRecurring: task.mode === 'recurring',
      recurrenceLabel: store.formatRecurrenceLabel(task),
      estimatedMinutes: estMins,
      estChip: i18n.t('tfocus_est_chip', { n: estMins }),
      occurrenceDate: this.data.date || task.startDate || '',
      isPaused,
      elapsedMs,
      elapsedDisplay: formatBigClock(elapsedMs),
      pausedDisplay: formatBigClock(pausedMs)
    })
    return true
  },

  startTicker() {
    this.stopTicker()
    this.tickerId = setInterval(() => {
      if (this.data.isPaused) {
        // 暂停中:作业时间定格,只走「暂停时长」
        const ms = Math.max(0, Date.now() - (this._pausedAt || Date.now()))
        this.setData({ pausedDisplay: formatBigClock(ms) })
        // 暂停满「建议休息时长」(5 或 20 分钟)→ 滴滴滴提醒继续,之后每隔同样时长再提醒
        const breakMs = this._breakMs || (this.data.shortBreakMin * 60000)
        const mark = Math.floor(ms / breakMs)
        if (mark > (this._lastBreakBeepMark || 0)) {
          this._lastBreakBeepMark = mark
          this._remind('resume')
        }
      } else {
        const next = this.data.elapsedMs + 1000
        // 番茄倒计时按墙钟锚点算(后台恢复也对);满一个周期 → 响铃提醒休息 + 归零重来
        const ps = this._pomoState(this.data.workMin * 60000, true)
        this.setData({
          elapsedMs: next,
          elapsedDisplay: formatBigClock(next),
          pomoPercent: ps.percent,
          pomoLeftDisplay: ps.leftDisplay
        })
      }
    }, 1000)
  },
  stopTicker() {
    if (this.tickerId) { clearInterval(this.tickerId); this.tickerId = null }
  },

  // 暂停:停留在本页,作业时间定格、开始计暂停时长。
  // 按「近 windowMin 分钟作业时长」决定建议休息多久:> heavyThresh → 长休息,否则短休息。
  handlePause() {
    if (!this.data.taskId) return
    const now = Date.now()
    if (this._segStart) appendWorkSeg(this._segStart, now, this.data.windowMin * 60000)
    this._segStart = null
    const recentMs = recentWorkMs(this.data.windowMin * 60000, now)
    const breakMin = recentMs > this.data.heavyThreshMin * 60000
      ? this.data.longBreakMin
      : this.data.shortBreakMin
    this._breakMs = breakMin * 60000
    store.pauseTask(this.data.taskId, this.data.date || '')
    this._pausedAt = now
    this._lastBreakBeepMark = 0
    this.setData({
      isPaused: true,
      pausedDisplay: '00:00',
      breakMin: breakMin,
      breakHint: i18n.t('tfocus_break_hint', { n: breakMin })
    })
    this.startTicker()
  },

  // 继续:作业时间接着走;连续计时重置(暂停 = 休息过了),开新作业段
  handleResume() {
    if (!this.data.taskId) return
    store.resumeTask(this.data.taskId, this.data.date || '')
    this._pausedAt = null
    this._segStart = Date.now()    // 新作业段(番茄也跟着从这里重新算)
    this._lastPomoCycle = 0
    this.setData({ isPaused: false })
    this.startTicker()
  },

  // 时间记录:计时旁的图标点开
  showTimeline() {
    const rows = store.getTaskTimelineRows(this.data.taskId, this.data.date || '')
    this.setData({ timelineRows: rows, showTimeline: true })
  },
  closeTimeline() { this.setData({ showTimeline: false }) },

  // 番茄钟设置面板
  openPomoSettings() { this.setData({ showPomoSettings: true }) },
  closePomoSettings() { this.setData({ showPomoSettings: false }) },
  handlePomoChange(e) {
    const key = e.currentTarget.dataset.key
    const p = POMO_PARAMS.find((x) => x.key === key)
    if (!p) return
    const val = p.opts[Number(e.detail.value)] || p.def
    try { wx.setStorageSync(p.sk, val) } catch (err) {}
    if (key === 'workMin') this._lastPomoCycle = 0   // 周期长度变了,重新数已过周期(不补响)
    this._loadPomo()
    this._beep()   // 改完预览一下提醒音
  },

  // 滴滴滴提醒(休息 / 继续):播音 + 震动 + 一句 toast
  _remind(kind) {
    this._beep()
    const title = kind === 'rest'
      ? i18n.t('tfocus_remind_rest', { n: this.data.workMin })
      : i18n.t('tfocus_remind_resume')
    try { wx.showToast({ title, icon: 'none', duration: 2600 }) } catch (e) {}
  },
  _beep() {
    try { if (this._sfx) { this._sfx.stop(); this._sfx.destroy() } } catch (e) {}
    try {
      this._sfx = wx.createInnerAudioContext()
      this._sfx.obeyMuteSwitch = false   // 静音也响(提醒用)
      this._sfx.src = '/assets/sounds/didi.mp3'
      this._sfx.play()
    } catch (e) {}
    try { if (wx.vibrateLong) wx.vibrateLong() } catch (e) {}
  },

  handleFinish() {
    if (!this.data.taskId) return
    if (this._segStart) appendWorkSeg(this._segStart, Date.now(), this.data.windowMin * 60000)
    this._segStart = null
    store.finishTask(this.data.taskId, this.data.date || '')
    wx.navigateBack()
  },

  handleClose() {
    wx.navigateBack()
  }
})
