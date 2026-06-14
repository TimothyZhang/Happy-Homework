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
    pomoAlerting: false,      // 到点了:进度条闪烁 + 每分钟提醒(可手动停止)
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
    isLandscape: false,       // 横屏(JS 判定 —— WeChat 的 @media orientation 不可靠)
    isWide: false,            // 宽横屏(iPad)→ 按钮/大钟加大
    showPomoSettings: false,
    // 时间记录(开始/暂停/继续/完成)
    showTimeline: false,
    timelineRows: [],
    timelineSegs: [],
    timelineHasBar: false,
    // 完成后「是否做下一项」自定义弹窗(不用 native showModal)
    showNextPrompt: false,
    nextTask: null,
    pomoRows: []              // 设置面板各行 {key,label,optionLabels,index,valueLabel}
  },

  onLoad(options) {
    const opts = options || {}
    this.setData({ taskId: opts.id || '', date: opts.date || '' })
    this._lastBreakBeepMark = -1   // 休息到点后已提醒到第几分钟
    this._lastOvertimeBeep = null  // 到点后已提醒到第几分钟(防重复响铃)
    this._pomoDismissed = false    // 是否已手动停止闪烁/提醒
    this._segStart = null          // 当前作业段起点 = store 的 currentSegmentStartedAt(工时日志用)
    // 番茄锚点:默认 = 作业段起点;「完成→继续下一项」时由上一项用 ps 参数带过来,实现「番茄时间不重置」
    this._pomoStart = (opts.ps && Number(opts.ps)) ? Number(opts.ps) : null
    this._updateOrientation()
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
      // 贴胶囊左侧,再往左挪一个图标宽度(+间隙),离胶囊更远不挤
      const rightPx = Math.max(8, winW - cap.left + cap.height + 16)
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
    this._updateOrientation()
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
    patch.pomoAlerting = ps.alerting
    this.setData(patch)
  },

  // 番茄倒计时当前状态:从当前作业段起点(store 的 currentSegmentStartedAt)算,退出/后台都不重置。
  // 到点后【不自动重置】:停在 0、进度条满格闪烁(alerting),每分钟滴滴滴提醒一次,直到手动停止。
  _pomoState(cycleMs, allowBeep) {
    const seg = this._pomoStart
    if (this.data.isPaused || !seg || cycleMs <= 0) {
      return { percent: 0, leftDisplay: formatBigClock(cycleMs), alerting: false }
    }
    const segmentMs = Math.max(0, Date.now() - seg)
    if (segmentMs < cycleMs) {
      return {
        percent: Math.min(100, segmentMs / cycleMs * 100),
        leftDisplay: formatBigClock(cycleMs - segmentMs),
        alerting: false
      }
    }
    // 到点了:停在 0,不自动重置。未手动停止 → 闪烁 + 每分钟提醒
    const alerting = !this._pomoDismissed
    if (allowBeep && alerting) {
      const overMin = Math.floor((segmentMs - cycleMs) / 60000)
      if (overMin > (this._lastOvertimeBeep == null ? -1 : this._lastOvertimeBeep)) {
        this._lastOvertimeBeep = overMin
        if (overMin === 0) this._remind('rest')   // 第一次:响铃 + toast
        else this._beep()                          // 之后每分钟:只响铃
      }
    }
    return { percent: 100, leftDisplay: formatBigClock(0), alerting: alerting }
  },

  onHide() { this.stopTicker() },
  onUnload() {
    this.stopTicker()
    try { if (this._sfx) { this._sfx.destroy(); this._sfx = null } } catch (e) {}
  },
  // 横竖屏切换:更新横屏标记(切左右两栏布局)+ 重新把番茄设置图标贴到胶囊左侧
  onResize(res) { this._updateOrientation(res); this._positionPomoBtn() },
  _updateOrientation(res) {
    let w = 0, h = 0
    if (res && res.size) { w = res.size.windowWidth; h = res.size.windowHeight }
    if (!w || !h) {
      try {
        const s = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
        w = s.windowWidth; h = s.windowHeight
      } catch (e) {}
    }
    // isWide:横屏 iPad(短边≥700,跟别处 isPad 口径一致;原来卡 w>=1000,
    // 部分 iPad 横屏宽度不够 1000 → 没套上 .wide,按钮退回小尺寸偏短)→ 按钮/大钟加大
    if (w && h) this.setData({ isLandscape: w > h, isWide: w > h && Math.min(w, h) >= 700 })
  },

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
    else {
      this._pausedAt = null
      this._segStart = occState.currentSegmentStartedAt || this._segStart || Date.now()
      if (this._pomoStart == null) this._pomoStart = this._segStart   // 没带 ps → 番茄锚点就是作业段起点
    }
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
        // 建议休息时长到了 → 之后每分钟滴滴滴提醒继续作业(跟「专注到点」一致)
        const breakMs = this._breakMs || (this.data.shortBreakMin * 60000)
        if (ms >= breakMs) {
          const overMin = Math.floor((ms - breakMs) / 60000)
          if (overMin > (this._lastBreakBeepMark == null ? -1 : this._lastBreakBeepMark)) {
            this._lastBreakBeepMark = overMin
            if (overMin === 0) this._remind('resume')   // 第一次:响铃 + toast
            else this._beep()                            // 之后每分钟:只响铃
          }
        }
      } else {
        const next = this.data.elapsedMs + 1000
        // 番茄倒计时按墙钟锚点算(后台恢复也对);满一个周期 → 响铃提醒休息 + 归零重来
        const ps = this._pomoState(this.data.workMin * 60000, true)
        this.setData({
          elapsedMs: next,
          elapsedDisplay: formatBigClock(next),
          pomoPercent: ps.percent,
          pomoLeftDisplay: ps.leftDisplay,
          pomoAlerting: ps.alerting
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
    this._lastBreakBeepMark = -1   // 休息到点后从第 0 分钟起每分钟提醒
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
    this._segStart = Date.now()    // 新作业段
    this._pomoStart = Date.now()   // 暂停=休息,番茄从头算
    this._lastOvertimeBeep = null
    this._pomoDismissed = false
    this.setData({ isPaused: false, pomoAlerting: false })
    this.startTicker()
  },

  // 时间记录:计时旁的图标点开
  showTimeline() {
    const taskId = this.data.taskId, date = this.data.date || ''
    const rows = store.getTaskTimelineRows(taskId, date)
    const seg = store.getTaskWorkBreakSegments(taskId, date, Date.now())
    const total = seg.workMs + seg.breakMs
    this.setData({
      timelineRows: rows,
      timelineSegs: seg.segments.map((s) => ({ type: s.type, ms: Math.max(1, Math.round(s.ms)) })),
      timelineHasBar: total > 0,
      showTimeline: true
    })
  },
  closeTimeline() { this.setData({ showTimeline: false }) },

  // 手动停止「到点」闪烁 + 每分钟提醒(进度条停闪、不再响铃,倒计时仍停在 0)
  handleDismissPomo() {
    this._pomoDismissed = true
    this.setData({ pomoAlerting: false })
  },

  // 番茄钟设置面板
  openPomoSettings() { this.setData({ showPomoSettings: true }) },
  closePomoSettings() { this.setData({ showPomoSettings: false }) },
  handlePomoChange(e) {
    const key = e.currentTarget.dataset.key
    const p = POMO_PARAMS.find((x) => x.key === key)
    if (!p) return
    const val = p.opts[Number(e.detail.value)] || p.def
    try { wx.setStorageSync(p.sk, val) } catch (err) {}
    if (key === 'workMin') { this._lastOvertimeBeep = null; this._pomoDismissed = false }   // 周期变了,重新计
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
    // 完成后:还有没做完的作业 → 自定义弹窗(跟专注页暗色风格一致),问要不要直接做下一项
    const next = store.nextPendingTaskOnDate(this.data.taskId, this.data.date || '')
    if (!next) { wx.navigateBack(); return }
    this.stopTicker()
    this.setData({ nextTask: next, showNextPrompt: true })
  },

  // 「开始下一项」→ 启动并跳到它的专注页(redirectTo 不堆返回栈)
  confirmNext() {
    const next = this.data.nextTask
    if (!next) { wx.navigateBack(); return }
    store.startTask(next.taskId, next.date)
    // 把当前番茄锚点带给下一项 → 番茄时间不重置(继续倒计时)
    const ps = this._pomoStart || Date.now()
    wx.redirectTo({ url: `/pkg-notebook/task-focus/index?id=${next.taskId}&date=${next.date}&ps=${ps}` })
  },
  // 「先不用」→ 退回上一页
  dismissNext() {
    this.setData({ showNextPrompt: false })
    wx.navigateBack()
  },

  handleClose() {
    wx.navigateBack()
  }
})
