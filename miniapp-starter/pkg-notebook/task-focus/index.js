const store = require('../../utils/store')
const i18n = require('../../utils/i18n')

// 番茄钟:连续写作业满 workMin 分钟 → 滴滴滴提醒休息(可设置,默认 25)。
// 暂停每满 5 分钟 → 滴滴滴提醒继续。
const WORK_OPTIONS = [15, 20, 25, 30, 35, 40, 45, 50, 60]
const WORK_MIN_DEFAULT = 25
const WORK_MIN_KEY = 'focusWorkMin'
const BREAK_REMIND_MS = 5 * 60 * 1000   // 暂停每 5 分钟提醒一次

function loadWorkMin() {
  let v = WORK_MIN_DEFAULT
  try { v = Number(wx.getStorageSync(WORK_MIN_KEY)) || WORK_MIN_DEFAULT } catch (e) {}
  return WORK_OPTIONS.indexOf(v) >= 0 ? v : WORK_MIN_DEFAULT
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
    // 番茄钟:连续写作业 workMin 分钟提醒休息(可设置)
    workMin: WORK_MIN_DEFAULT,
    workMinIndex: 0,
    workOptionsLabels: [],
    workMinLabel: ''
  },

  onLoad(options) {
    const opts = options || {}
    this.setData({ taskId: opts.id || '', date: opts.date || '' })
    this._workSinceBreakMs = 0     // 连续写作业累计(满 workMin 提醒休息;暂停/继续会重置)
    this._lastPauseBeepMark = 0    // 暂停已提醒到第几个 5 分钟
    this._applyWorkMin(loadWorkMin())
    if (!this.refresh()) return
    this.startTicker()
  },

  onShow() {
    this.setData({ t: i18n.dict() })
    wx.setNavigationBarTitle({ title: i18n.t('tfocus_navtitle') })
    this._applyWorkMin(this.data.workMin)   // 语言可能变了,刷新番茄钟文案
    if (!this.data.taskId) return
    if (!this.refresh()) return
    this.startTicker()
  },

  // 应用番茄钟间隔(分钟):更新选择器值 + 文案
  _applyWorkMin(min) {
    const idx = Math.max(0, WORK_OPTIONS.indexOf(min))
    this.setData({
      workMin: min,
      workMinIndex: idx,
      workOptionsLabels: WORK_OPTIONS.map((n) => i18n.t('tfocus_pomo_min', { n })),
      workMinLabel: i18n.t('tfocus_pomo_label', { n: min })
    })
  },

  onHide() { this.stopTicker() },
  onUnload() {
    this.stopTicker()
    try { if (this._sfx) { this._sfx.destroy(); this._sfx = null } } catch (e) {}
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
    else { this._pausedAt = null }
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
        // 暂停每满 5 分钟 → 滴滴滴提醒继续写作业
        const mark = Math.floor(ms / BREAK_REMIND_MS)
        if (mark > (this._lastPauseBeepMark || 0)) {
          this._lastPauseBeepMark = mark
          this._remind('resume')
        }
      } else {
        const next = this.data.elapsedMs + 1000
        this.setData({ elapsedMs: next, elapsedDisplay: formatBigClock(next) })
        // 连续写作业满 workMin 分钟 → 滴滴滴提醒休息,然后重新计时
        this._workSinceBreakMs = (this._workSinceBreakMs || 0) + 1000
        if (this._workSinceBreakMs >= this.data.workMin * 60000) {
          this._workSinceBreakMs = 0
          this._remind('rest')
        }
      }
    }, 1000)
  },
  stopTicker() {
    if (this.tickerId) { clearInterval(this.tickerId); this.tickerId = null }
  },

  // 暂停:停留在本页,作业时间定格、开始计暂停时长
  handlePause() {
    if (!this.data.taskId) return
    store.pauseTask(this.data.taskId, this.data.date || '')
    this._pausedAt = Date.now()
    this._lastPauseBeepMark = 0
    this.setData({ isPaused: true, pausedDisplay: '00:00' })
    this.startTicker()
  },

  // 继续:作业时间接着走;番茄钟重新计(暂停 = 休息过了)
  handleResume() {
    if (!this.data.taskId) return
    store.resumeTask(this.data.taskId, this.data.date || '')
    this._pausedAt = null
    this._workSinceBreakMs = 0
    this.setData({ isPaused: false })
    this.startTicker()
  },

  // 设置番茄钟间隔(分钟),持久化 + 重新计时
  handleWorkMinChange(e) {
    const idx = Number(e.detail.value)
    const min = WORK_OPTIONS[idx] || WORK_MIN_DEFAULT
    try { wx.setStorageSync(WORK_MIN_KEY, min) } catch (err) {}
    this._workSinceBreakMs = 0
    this._applyWorkMin(min)
    this._beep()   // 改完顺便预览一下提醒音
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
    store.finishTask(this.data.taskId, this.data.date || '')
    wx.navigateBack()
  },

  handleClose() {
    wx.navigateBack()
  }
})
