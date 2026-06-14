const store = require('../../utils/store')
const i18n = require('../../utils/i18n')

function formatElapsed(ms) {
  if (!ms || ms < 0) return ''
  const totalSec = Math.floor(ms / 1000)
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  if (min === 0) return i18n.t('tl_elapsed_sec', { s: sec })
  if (sec === 0) return i18n.t('tl_elapsed_min', { m: min })
  return i18n.t('tl_elapsed_minsec', { m: min, s: sec })
}

// undone row 只有 "编辑" 按钮(删除入口收进编辑页内) → 120rpx;
// done row 有 "编辑" + "继续" → 240rpx。
const SWIPE_MAX_RPX = { done: 240, undone: 120 }

// 顺延色块随滑动进度从红→琥珀→绿渐变:让用户看出「再滑一点就生效」。
// progress 0 = 刚起滑(红),1 = 到阈值(绿,松手即顺延);往回滑 progress 减小,颜色退回红。
const PP_RED = [207, 19, 34]     // #cf1322
const PP_AMBER = [245, 166, 35]  // #f5a623
const PP_GREEN = [38, 166, 91]   // #26a65b
function _ppMix(a, b, t) {
  const r = Math.round(a[0] + (b[0] - a[0]) * t)
  const g = Math.round(a[1] + (b[1] - a[1]) * t)
  const bl = Math.round(a[2] + (b[2] - a[2]) * t)
  return 'rgb(' + r + ',' + g + ',' + bl + ')'
}
function postponeColorFor(p) {
  // p>0 判定顺带把 NaN(阈值未就绪)兜成 0 → 红,不会渲染出 rgb(NaN…)。
  const x = p > 0 ? (p > 1 ? 1 : p) : 0
  if (x <= 0.5) return _ppMix(PP_RED, PP_AMBER, x / 0.5)
  return _ppMix(PP_AMBER, PP_GREEN, (x - 0.5) / 0.5)
}

Component({
  options: { addGlobalClass: true },
  properties: {
    // Pre-decorated items (id, taskId, taskMode, subject, organization, content,
    // estimatedMinutes, status, order, completedAt, isOverdue,
    // elapsedMs, elapsedDisplay)
    items: { type: Array, value: [] },
    // Date the items belong to. Passed through to store control calls so
    // recurring tasks update the right occurrence.
    activeDate: { type: String, value: '' },
    // Whether to enable long-press drag reorder.
    enableDrag: { type: Boolean, value: true },
    // 是否启用「右滑顺延到下一天」。只对一次性未完成 row 生效(组件内再判)。
    enablePostpone: { type: Boolean, value: true },
    // Optional row variant class (e.g. 'is-overdue') applied to every row.
    rowVariant: { type: String, value: '' },
    // 紧凑模式(横屏用):压低 row 高度,一屏多显示几条
    compact: { type: Boolean, value: false }
  },
  data: {
    t: {},
    list: [],
    dragId: null,
    dragDy: 0,
    swipeId: null,       // 当前正在 swipe 的 row id(touchmove 中)
    swipeDx: 0,          // swipe 期间 row 的 x 位移(rpx)
    swipeOpenId: null,   // 当前展开 swipe-action 的 row id
    swipeOpenMax: 0,     // 当前展开的 max 偏移(rpx) — done 120 / undone 240
    postponeId: null,    // 当前正在右滑顺延的 row id
    postponeDx: 0,       // 右滑期间 row 的 x 位移(rpx,正值=向右)
    postponeArmed: false,// 右滑距离 ≥ 40% 卡宽 → true(满绿,松手即顺延)
    postponeColor: 'rgb(207,19,34)', // 色块当前背景色(随滑动进度红→琥珀→绿渐变)
    postponeDragging: false, // 拖动中(true→关 transition 跟手;松手→开 transition 飞出/回弹)
    // 点「预计 X 分钟」弹出的设置时长弹窗
    showEstPopup: false,
    estTaskId: '',
    estDate: '',
    estInput: '',
    estCurrent: 0,
    estPresets: [5, 10, 15, 20, 25, 30, 40, 50, 60],
    // 点 elapsed-chip「实际用时」弹出的时间记录(timelog):进度条 + 事件列表
    showTimelog: false,
    timelogRows: [],
    timelogSegs: [],
    timelogHasBar: false,
    timelogWorkLabel: '',
    timelogBreakLabel: ''
  },
  observers: {
    'items': function (items) {
      const list = (items || []).map((it) => ({
        ...it,
        shiftY: 0,
        swipeMax: it.status === 'done' ? SWIPE_MAX_RPX.done : SWIPE_MAX_RPX.undone,
        makeupLabel: i18n.t('tl_makeup_from', { date: it.occurrenceDate || '' }),
        estLabel: i18n.t('tl_est_chip', { min: it.estimatedMinutes || 0 }),
        elapsedLabel: it.elapsedDisplay
          ? i18n.t(it.status === 'done' ? 'tl_elapsed_spent' : 'tl_elapsed_used', { t: it.elapsedDisplay })
          : ''
      }))
      this.setData({ list })
      this.startTickerIfNeeded()
    }
  },
  lifetimes: {
    attached() { this.setData({ t: i18n.dict() }) },
    detached() { this.stopTicker() }
  },
  pageLifetimes: {
    show() { this.setData({ t: i18n.dict() }) }
  },
  methods: {
    startTickerIfNeeded() {
      this.stopTicker()
      const list = this.data.list || []
      if (!list.some((it) => it.status === 'doing')) return
      this.tickerId = setInterval(() => {
        const next = (this.data.list || []).map((it) => {
          let ms = it.elapsedMs || 0
          if (it.status === 'doing') ms += 1000
          const elapsedDisplay = formatElapsed(ms)
          const elapsedLabel = elapsedDisplay
            ? i18n.t(it.status === 'done' ? 'tl_elapsed_spent' : 'tl_elapsed_used', { t: elapsedDisplay })
            : ''
          return { ...it, elapsedMs: ms, elapsedDisplay, elapsedLabel }
        })
        this.setData({ list: next })
        if (!next.some((it) => it.status === 'doing')) this.stopTicker()
      }, 1000)
    },
    stopTicker() {
      if (this.tickerId) { clearInterval(this.tickerId); this.tickerId = null }
    },

    // === Unified gesture dispatcher === //
    // 一条 row 同时支持:
    //   - 长按 → 拖拽排序(longpress 触发 mode=drag)
    //   - 横滑 → 显示 swipe-action(touchmove 横向偏移 > 阈值时 mode=swipe)
    //   - 纵滑 → 让父 scroll-view 滚(mode=scroll,不阻止)
    // 进入 drag/swipe 后,模式互斥到 touchend。

    // swipeOpenId / swipeOpenMax 的唯一收口。null↔id 切换时同步触发
    // swipeopen / swipeclose 事件,父组件据此锁屏(参见 home 页 scroll-y
    // 绑定:菜单展开期间禁止 scroll-view 上下滚动,避免菜单滑出视口)。
    _setSwipeOpen(id, max, extra) {
      const prevId = this.data.swipeOpenId
      const nextId = id || null
      const patch = Object.assign(
        { swipeOpenId: nextId, swipeOpenMax: nextId ? max : 0 },
        extra || {}
      )
      this.setData(patch)
      if (!prevId && nextId) this.triggerEvent('swipeopen')
      else if (prevId && !nextId) this.triggerEvent('swipeclose')
    },

    handleRowTouchStart(e) {
      const t = (e.touches && e.touches[0]) || null
      this.touchStartX = t ? t.pageX : 0
      this.touchStartY = t ? t.pageY : 0
      this._gestureMode = 'pending'
      this._gestureRowId = e.currentTarget.dataset.id
      this._swipeDir = null            // 'left'(编辑菜单)/ 'right'(顺延),进入 swipe 时锁定
      this._postponeEligible = false   // 右滑这一行能否顺延(一次性 + 未完成)
      // 触摸到另一个 row 时,关闭已展开的 swipe-action
      if (this.data.swipeOpenId && this.data.swipeOpenId !== this._gestureRowId) {
        this._setSwipeOpen(null)
      }
    },

    // 懒算 px→rpx 换算 + 卡片宽度(rpx)+ 1/3 阈值。rpx 在 750=屏宽 下自适应,
    // 卡片宽 ≈ 屏宽 - scroll-area 左右各 24rpx padding = 702rpx。
    _ensurePostponeMetrics() {
      if (this._pxToRpx) return
      let winPx = 375
      try {
        const info = (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()) || {}
        winPx = info.windowWidth || info.screenWidth || 375
      } catch (e) {}
      this._pxToRpx = 750 / winPx
      this._rowWidthRpx = 750 - 48
      // 顺延阈值 = 卡宽的 40%。左右滑共用:划过 40% 才 armed(满绿 + 松手生效);
      // 色块颜色按 当前位移/阈值 的比例红→绿渐变,提示「继续滑」。
      this._postponeThresholdRpx = this._rowWidthRpx * 0.4
    },

    handleRowLongPress(e) {
      // longpress 触发拖拽 — 仅 pending 状态可升级(用户没移动)
      if (this._gestureMode !== 'pending') return
      if (!this.data.enableDrag) return
      const id = e.currentTarget.dataset.id
      const item = this.data.list.find((it) => it.id === id)
      if (!item || item.status === 'done') return
      this._gestureMode = 'drag'
      this.dragStartY = this.touchStartY != null ? this.touchStartY : 0
      // itemHeightPx 缓存:第一次 longpress query 一次,后续复用。如果在这
      // 里强制重 query(this.itemHeightPx = null),query 是异步的,从重置到
      // callback 回填中间这几十 ms 里 handleRowTouchMove 会用 fallback 140
      // 算 shiftY/slotsDelta,跟随后回填的真实值不一致 — Tim 截图里 4 张
      // row 全部消失就是这种 transform 状态混乱。
      if (!this.itemHeightPx) {
        // .in(this) 必须有 — Component 内 createSelectorQuery 默认 select
        // page 级别,拿不到 component 内的 .task-row,rects[0] 一直是 null,
        // itemHeightPx 留 null,handleRowTouchMove 用 fallback 140 算 slotsDelta。
        // row 实际高度跟 140 差太多就让 toZoneIdx 算成 fromZoneIdx,reorder
        // 根本不进,松手 row 视觉回原位(因为 setData({list:reset}) 复位)。
        const q = this.createSelectorQuery().in(this)
        q.select('.task-row').boundingClientRect()
        q.exec((rects) => { if (rects && rects[0]) this.itemHeightPx = rects[0].height + 12 })
      }
      this.setData({ dragId: id, dragDy: 0 })
      if (wx.vibrateShort) wx.vibrateShort({ type: 'light' })
      this.triggerEvent('dragstart')
    },

    handleRowTouchMove(e) {
      const t = e.touches && e.touches[0]
      if (!t) return
      const dx = t.pageX - (this.touchStartX || 0)
      const dy = t.pageY - (this.touchStartY || 0)

      if (this._gestureMode === 'pending') {
        if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return
        if (Math.abs(dx) > Math.abs(dy)) {
          this._gestureMode = 'swipe'
          // 锁定横滑方向。菜单已展开的 row 一律走 left 逻辑(右滑用于关菜单),
          // 否则按起划方向:右(dx>0)= 顺延,左 = 编辑菜单。
          const rowId = this._gestureRowId
          if (this.data.swipeOpenId === rowId) {
            // 菜单已展开:这次横滑是关菜单,不进顺延。
            this._swipeDir = 'left'
            this._postponeEligible = false
          } else {
            this._swipeDir = dx > 0 ? 'right' : 'left'
            // 顺延(右滑→下一天 / 左滑→上一天)对「未完成」row 生效。一次性直接移动;
            // 重复性由 home 把当次 occurrence detach 成一次性后再移动(见 handlePostpone)。
            const it = this.data.list.find((x) => x.id === rowId)
            let eligible = !!this.data.enablePostpone && !!it &&
              it.status !== 'done'
            // 左滑→上一天:仅当查看的是「未来日期」才允许。否则把今天的作业拉到
            // 昨天 = 立即逆期红显在今天,语义混乱。activeDate 空(首页今日)视为今天。
            if (eligible && this._swipeDir === 'left') {
              const todayS = store.todayStr()
              const viewDate = this.data.activeDate || todayS
              if (viewDate <= todayS) eligible = false
            }
            this._postponeEligible = eligible
            if (this._postponeEligible) this._ensurePostponeMetrics()
          }
          // 起划:让父页锁 scroll,免得 swipe 后续 touchmove 的 dy 分量带着
          // scroll-view 一起动。第一帧 dy(就是越过 6rpx 阈值的那次)还是会
          // 漏给 native 滚一点点 —— 1-5rpx 量级,用户视觉上注意力都在 row 横
          // 向偏移,基本察觉不到。
          this.triggerEvent('swipestart')
        } else {
          this._gestureMode = 'scroll'
          // scroll 模式下我们什么都不做 —— bindtouchmove 自然冒泡到 scroll-view,
          // 原生 GPU 滚动接管,自带 momentum / bounce / scrollbar 全套。
          return
        }
      }

      if (this._gestureMode === 'scroll') return

      if (this._gestureMode === 'drag') {
        const now = Date.now()
        if (this._lastMoveAt && now - this._lastMoveAt < 16) return
        this._lastMoveAt = now
        if (Math.abs(dy - this.data.dragDy) < 2) return
        const itemH = this.itemHeightPx || 140
        const list = this.data.list
        const draggedIdx = list.findIndex((it) => it.id === this.data.dragId)
        const dragZone = []
        list.forEach((it, i) => {
          if (it.status === 'done') return
          dragZone.push(i)
        })
        if (dragZone.length === 0) return
        const minIdx = dragZone[0]
        const maxIdx = dragZone[dragZone.length - 1]
        const slotsDelta = Math.round(dy / itemH)
        const hoverIdx = Math.max(minIdx, Math.min(maxIdx, draggedIdx + slotsDelta))
        const updated = list.map((it, i) => {
          if (it.id === this.data.dragId) return it
          if (it.status === 'done') return it
          let shiftY = 0
          if (draggedIdx < hoverIdx && i > draggedIdx && i <= hoverIdx) shiftY = -itemH
          else if (draggedIdx > hoverIdx && i >= hoverIdx && i < draggedIdx) shiftY = itemH
          return { ...it, shiftY }
        })
        this.setData({ list: updated, dragDy: dy })
      } else if (this._gestureMode === 'swipe' && this._swipeDir === 'right') {
        // 右滑顺延:卡片跟手向右,左侧露出「移至下一天」色块。
        if (!this._postponeEligible) return
        const id = this._gestureRowId
        const dxRpx = Math.max(0, dx * this._pxToRpx)
        const tx = Math.min(this._rowWidthRpx, dxRpx)
        const armed = dxRpx >= this._postponeThresholdRpx
        const color = postponeColorFor(dxRpx / this._postponeThresholdRpx)
        this.setData({ postponeId: id, postponeDx: tx, postponeArmed: armed, postponeColor: color, postponeDragging: true })
      } else if (this._gestureMode === 'swipe') {
        // 左滑:浅划(≤ 菜单宽)露编辑菜单【原行为】;eligible 时继续左划过
        // 菜单宽 → 进入「移至上一天」顺延区,卡片继续跟手,藏菜单显左滑色块。
        const id = this._gestureRowId
        const item = this.data.list.find((it) => it.id === id)
        if (!item) return
        if (!this._pxToRpx) this._ensurePostponeMetrics()
        const swipeMax = item.swipeMax || SWIPE_MAX_RPX.undone
        const isOpen = this.data.swipeOpenId === id
        const base = isOpen ? -swipeMax : 0
        const raw = base + dx * this._pxToRpx   // 跟手位移(rpx,左滑为负)
        if (this._postponeEligible && !isOpen && -raw > swipeMax) {
          // 顺延区:卡片跟手(切换点 raw=-swipeMax 与菜单态连续,无跳变),
          // 藏菜单(swipeId=null)只显色块。armed = 过半屏。
          const tx = Math.max(-this._rowWidthRpx, raw)
          const armed = -tx >= this._postponeThresholdRpx
          const color = postponeColorFor(-tx / this._postponeThresholdRpx)
          this.setData({
            postponeId: id, postponeDx: tx, postponeArmed: armed, postponeColor: color,
            postponeDragging: true, swipeId: null, swipeDx: 0
          })
        } else {
          // 菜单区:卡片钳在菜单宽内,露编辑菜单。
          const tx = Math.max(-swipeMax, Math.min(0, raw))
          const patch = { swipeId: id, swipeDx: tx }
          if (this.data.postponeId === id) {
            patch.postponeId = null
            patch.postponeArmed = false
            patch.postponeDx = 0
          }
          this.setData(patch)
        }
      }
    },

    handleRowTouchEnd() {
      if (this._gestureMode === 'drag') {
        this.triggerEvent('dragend')
        const dragId = this.data.dragId
        const dragDy = this.data.dragDy
        const itemH = this.itemHeightPx || 140
        const list = this.data.list
        const dragZone = []
        list.forEach((it, i) => {
          if (it.status === 'done') return
          dragZone.push(i)
        })
        const fromIdx = list.findIndex((it) => it.id === dragId)
        const fromZoneIdx = dragZone.indexOf(fromIdx)
        const slotsDelta = Math.round(dragDy / itemH)
        const toZoneIdx = Math.max(0, Math.min(dragZone.length - 1, fromZoneIdx + slotsDelta))
        // list/dragId/dragDy 必须一次 setData 合并:分开 setData 时 wechat 帧
        // 调度可能让 shiftY=0 先 commit 而 dragId 仍是 truthy → is-dragging-mode
        // class 还在 → transition 启动了一两帧"从下往上"动画,期间露出底层
        // swipe-action。合并后 dragId=null 和 shiftY=0 同帧生效,class 移除让
        // transition 消失,shiftY 瞬间应用,无动画无残影。
        const reset = list.map((it) => ({ ...it, shiftY: 0 }))
        if (fromZoneIdx !== -1 && fromZoneIdx !== toZoneIdx) {
          const rows = dragZone.map((listIdx) => {
            const it = list[listIdx]
            return { taskId: it.taskId || it.id, occurrenceDate: it.occurrenceDate || '' }
          })
          const [moved] = rows.splice(fromZoneIdx, 1)
          rows.splice(toZoneIdx, 0, moved)
          store.reorderRows(rows)
          this.setData({ list: reset, dragId: null, dragDy: 0 })
          this.triggerEvent('changed')
        } else {
          this.setData({ list: reset, dragId: null, dragDy: 0 })
        }
      } else if (this._gestureMode === 'swipe' && this._swipeDir === 'right') {
        // 右滑顺延松手:postponeDragging=false 让 transition 生效。
        const id = this.data.postponeId
        if (id && this.data.postponeArmed) {
          // 已过 40%(绿):卡片飞出右侧,动画结束后触发 postpone(dir=+1 → 下一天)。
          const item = this.data.list.find((it) => it.id === id)
          const taskId = (item && (item.taskId || item.id)) || ''
          const occurrenceDate = (item && item.occurrenceDate) || ''
          const taskMode = (item && item.taskMode) || 'one-shot'
          this.setData({ postponeDragging: false, postponeDx: this._rowWidthRpx + 120 })
          setTimeout(() => {
            this.triggerEvent('postpone', { taskId, occurrenceDate, taskMode, dir: 1 })
            this.setData({ postponeId: null, postponeDx: 0, postponeArmed: false, postponeColor: 'rgb(207,19,34)' })
          }, 200)
        } else if (id) {
          // 没到 40%(红):回弹归位,色块淡回红。
          this.setData({ postponeDragging: false, postponeDx: 0, postponeArmed: false, postponeColor: 'rgb(207,19,34)' })
          setTimeout(() => {
            if (this.data.postponeId === id && this.data.postponeDx === 0) {
              this.setData({ postponeId: null })
            }
          }, 200)
        }
        this.triggerEvent('swipeend')
      } else if (this._gestureMode === 'swipe' && this.data.postponeId === this._gestureRowId) {
        // 左滑进了顺延区松手。
        const id = this.data.postponeId
        if (this.data.postponeArmed) {
          // 已过 40%(绿):卡片飞出左侧,触发 postpone(dir=-1 → 上一天)。
          const item = this.data.list.find((it) => it.id === id)
          const taskId = (item && (item.taskId || item.id)) || ''
          const occurrenceDate = (item && item.occurrenceDate) || ''
          const taskMode = (item && item.taskMode) || 'one-shot'
          this.setData({ postponeDragging: false, postponeDx: -(this._rowWidthRpx + 120) })
          setTimeout(() => {
            this.triggerEvent('postpone', { taskId, occurrenceDate, taskMode, dir: -1 })
            this.setData({ postponeId: null, postponeDx: 0, postponeArmed: false, postponeColor: 'rgb(207,19,34)' })
          }, 200)
        } else {
          // 未过 40%(红):回弹到「菜单展开态」(露出编辑菜单),而非完全归位。
          // 清 postpone 状态 + _setSwipeOpen 切菜单态:transform 从 postponeDx 落到
          // swipeOpenId 分支(-swipeOpenMax),即时吸附到菜单宽,和正常左滑开菜单一致;
          // swipeopen 事件让父页锁 scroll。
          const item = this.data.list.find((it) => it.id === id)
          const swipeMax = (item && item.swipeMax) || SWIPE_MAX_RPX.undone
          this._setSwipeOpen(id, swipeMax, {
            postponeId: null, postponeDx: 0, postponeArmed: false, postponeDragging: false,
            postponeColor: 'rgb(207,19,34)'
          })
        }
        this.triggerEvent('swipeend')
      } else if (this._gestureMode === 'swipe') {
        // 左滑菜单区松手(原逻辑不动):过半菜单宽吸附打开,否则回弹。
        const id = this._gestureRowId
        const item = this.data.list.find((it) => it.id === id)
        const swipeMax = (item && item.swipeMax) || SWIPE_MAX_RPX.undone
        const dx = this.data.swipeDx
        const opened = dx <= -swipeMax / 2
        this._setSwipeOpen(opened ? id : null, swipeMax, { swipeId: null, swipeDx: 0 })
        this.triggerEvent('swipeend')
      }
      this.touchStartX = null
      this.touchStartY = null
      this.dragStartY = null
      this._gestureMode = null
      this._gestureRowId = null
    },

    // === Actions === //

    _actionTarget(e) {
      const ds = e.currentTarget.dataset
      return {
        taskId: ds.taskId || ds.id,
        date: ds.occurrenceDate || this.data.activeDate
      }
    },
    handleStart(e) {
      const t = this._actionTarget(e)
      store.startTask(t.taskId, t.date)
      this.triggerEvent('changed')
      // 开始后立即进入全屏 focus 页(大时钟 + 暂停/完成大按钮)。
      this._openFocus(t.taskId, t.date)
    },
    handlePause(e) {
      const t = this._actionTarget(e)
      store.pauseTask(t.taskId, t.date)
      this.triggerEvent('changed')
    },
    handleResume(e) {
      const t = this._actionTarget(e)
      store.resumeTask(t.taskId, t.date)
      this.triggerEvent('changed')
      // 继续(从 paused 进 doing)也跳 focus 页 — 跟 handleStart 一致。
      this._openFocus(t.taskId, t.date)
    },
    handleFinish(e) {
      const t = this._actionTarget(e)
      store.finishTask(t.taskId, t.date)
      this.triggerEvent('changed', { finished: true })
    },

    // 整行 tap:进行中的作业 → 进 focus 页;其他状态忽略(start/resume/pause/
    // finish/edit/swipe 各自的按钮 / 手势已覆盖,行 tap 不做事)。touchmove
    // 触发 swipe/drag 后,小程序不会再触发 bindtap,所以不会跟手势冲突。
    handleRowTap(e) {
      const ds = e.currentTarget.dataset
      if (ds.status !== 'doing') return
      this._openFocus(ds.taskId || ds.id, ds.occurrenceDate || this.data.activeDate)
    },

    _openFocus(taskId, date) {
      if (!taskId) return
      const query = date ? `id=${taskId}&date=${date}` : `id=${taskId}`
      wx.navigateTo({ url: `/pkg-notebook/task-focus/index?${query}` })
    },

    // 左滑后的"编辑"按钮。recurring 弹"此次/整个"二选;one-shot 直接跳整个编辑。
    handleEdit(e) {
      const { taskId, occurrenceDate, taskMode } = e.currentTarget.dataset
      if (!taskId) return
      const date = occurrenceDate || ''
      this._setSwipeOpen(null)
      if (taskMode === 'recurring' && date) {
        wx.showActionSheet({
          itemList: [i18n.t('tl_edit_once'), i18n.t('tl_edit_all')],
          success(res) {
            if (res.tapIndex === 0) {
              wx.navigateTo({ url: `/pkg-notebook/task-edit/index?id=${taskId}&instance=${date}` })
            } else if (res.tapIndex === 1) {
              wx.navigateTo({ url: `/pkg-notebook/task-edit/index?id=${taskId}` })
            }
          }
        })
      } else {
        wx.navigateTo({ url: `/pkg-notebook/task-edit/index?id=${taskId}` })
      }
    },

    // done 行 swipe 后的"继续"按钮 — 把任务从 done 退回 paused。
    handleRevert(e) {
      const ds = e.currentTarget.dataset
      const taskId = ds.taskId || ds.id
      const date = ds.occurrenceDate || this.data.activeDate
      const refund = store.revertTask(taskId, date)
      this._setSwipeOpen(null, 0, { swipeId: null, swipeDx: 0 })
      this.triggerEvent('changed')
      if (refund > 0) {
        wx.showToast({ title: i18n.t('tl_toast_deduct', { n: refund }), icon: 'none', duration: 1500 })
      }
    },

    noop() {},

    // === 设置「预计需要时间」(点 est-chip 弹窗:预设按钮 5~60 或自定义输入)===
    openEstPopup(e) {
      const ds = e.currentTarget.dataset
      this.setData({
        showEstPopup: true,
        estTaskId: ds.taskId || ds.id,
        estDate: ds.occurrenceDate || this.data.activeDate,
        estCurrent: Number(ds.min) || 0,
        estInput: ''
      })
    },
    closeEstPopup() { this.setData({ showEstPopup: false }) },

    // === 点「实际用时」elapsed-chip → 弹时间记录(timelog):作业/休息进度条 + 事件列表 ===
    openTimelog(e) {
      const ds = e.currentTarget.dataset
      const taskId = ds.taskId || ds.id
      const date = ds.occurrenceDate || this.data.activeDate
      const rows = store.getTaskTimelineRows(taskId, date)
      const seg = store.getTaskWorkBreakSegments(taskId, date, Date.now())
      const total = seg.workMs + seg.breakMs
      this.setData({
        showTimelog: true,
        timelogRows: rows,
        timelogSegs: seg.segments.map((s) => ({ type: s.type, ms: Math.max(1, Math.round(s.ms)) })),
        timelogHasBar: total > 0,
        timelogWorkLabel: i18n.t('tl_tlog_work', { t: formatElapsed(seg.workMs) }),
        timelogBreakLabel: i18n.t('tl_tlog_break', { t: formatElapsed(seg.breakMs) })
      })
    },
    closeTimelog() { this.setData({ showTimelog: false }) },
    onEstInput(e) { this.setData({ estInput: e.detail.value }) },
    pickEst(e) { this._applyEst(Number(e.currentTarget.dataset.min) || 0) },
    confirmEst() {
      const v = Math.round(Number(this.data.estInput))
      if (!v || v <= 0) { wx.showToast({ title: i18n.t('tl_toast_enter_min'), icon: 'none' }); return }
      this._applyEst(v)
    },
    _applyEst(min) {
      const m = Math.max(1, Math.min(600, Math.round(min)))
      if (!this.data.estTaskId) { this.setData({ showEstPopup: false }); return }
      store.updateTask(this.data.estTaskId, { estimatedMinutes: m })
      this.setData({ showEstPopup: false })
      this.triggerEvent('changed')
    }
  }
})
