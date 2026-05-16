const store = require('../../utils/store')
const cloudSync = require('../../utils/cloud-sync')
const shareReward = require('../../utils/share-reward')

// Subject ordering only — used to group tasks visually under subject headers.
// The add/edit form moved to /pkg-notebook/notebook-task-edit/.
const SUBJECT_ORDER = ['语文', '数学', '英语', '科学', '道法', '美术', '其他']

// 规划模式的 view-mode 缓存 key 前缀。本地记忆即可,不进云同步:这是 UI 偏好,
// 跨设备没必要保持一致。
const VIEW_MODE_KEY = (nbId) => `notebookViewMode:${nbId}`
const WEEKDAY_CN = ['日', '一', '二', '三', '四', '五', '六']

function formatDateHeader(dateStr, todayStr) {
  // 渲染日期 folder 头部。用 "MM/DD 周X" + 可选的 "今天/明天" 副标签。
  const d = store.strToDate(dateStr)
  const m = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  const w = WEEKDAY_CN[d.getDay()]
  let sub = ''
  if (dateStr === todayStr) sub = '今天'
  else if (dateStr === store.addDays(todayStr, 1)) sub = '明天'
  else if (dateStr < todayStr) sub = '已过'
  return { main: `${m}/${day} 周${w}`, sub }
}

// Truncate text with "…" so it fits maxWidth at the current ctx font.
// Used by paintShareCard — long notebook names would overflow the 5:4 card.
function clipText(ctx, text, maxWidth) {
  const s = String(text || '')
  if (ctx.measureText(s).width <= maxWidth) return s
  let lo = 0
  let hi = s.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (ctx.measureText(s.slice(0, mid) + '…').width <= maxWidth) lo = mid
    else hi = mid - 1
  }
  return s.slice(0, lo) + '…'
}

// Path a rounded rect — Canvas 2D in WeChat doesn't ship roundRect natively
// across all base libs, so we trace it manually.
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h - r)
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}

function formatElapsed(ms) {
  if (!ms || ms < 0) return ''
  const totalSec = Math.floor(ms / 1000)
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  if (min === 0) return `${sec} 秒`
  if (sec === 0) return `${min} 分钟`
  return `${min} 分 ${sec} 秒`
}

function decorateTask(task, notebook, dateStr, now) {
  const occ = store.getTaskState(task, notebook, dateStr)
  let elapsedMs = occ.accumulatedMs || 0
  if (occ.status === 'doing' && occ.currentSegmentStartedAt) {
    elapsedMs += Math.max(0, now - occ.currentSegmentStartedAt)
  }
  return {
    ...task,
    subject: task.subject || '其他',
    status: occ.status,
    elapsedMs,
    elapsedDisplay: elapsedMs > 0 ? formatElapsed(elapsedMs) : ''
  }
}

// Sort tasks by subject (preferred order from SUBJECT_ORDER, unknowns last
// in name order), then by their global `order` within each subject. The
// flat list stays usable for drag — sort is stable so adjacency = group.
// Also annotate first-of-group rows so the WXML can render a header.
function arrangeBySubject(list) {
  const subjectRank = (s) => {
    const i = SUBJECT_ORDER.indexOf(s)
    return i < 0 ? SUBJECT_ORDER.length : i
  }
  const sorted = list.slice().sort((a, b) => {
    const ra = subjectRank(a.subject)
    const rb = subjectRank(b.subject)
    if (ra !== rb) return ra - rb
    if (a.subject !== b.subject) return a.subject < b.subject ? -1 : 1
    return (a.order || 0) - (b.order || 0)
  })
  let prev = null
  for (const t of sorted) {
    t.firstOfSubject = t.subject !== prev
    prev = t.subject
  }
  return sorted
}

// 规划模式:按 effectiveDueDate 把 task 摊到从 startDate 到 endDate 的每日 folder。
// 输出是扁平 list,每天先一个 __header row(占位 + 显示),后接该天的 task rows。
// 空 folder 仍保留 header(标 isEmpty=true,可作为拖入目标)。
// header 也参与扁平索引,但不可被拖动 —— handleLongPress 会拦掉。
function arrangeByDate(list, notebook, todayStr) {
  if (!notebook || notebook.mode !== 'one-shot') return []
  const start = notebook.startDate
  const end = notebook.endDate || notebook.startDate
  if (!start || !end) return []
  const dates = []
  let d = start
  while (true) {
    dates.push(d)
    if (d === end) break
    d = store.addDays(d, 1)
    // 防御:大于 366 天直接停,避免错配置死循环
    if (dates.length > 366) break
  }
  const buckets = new Map(dates.map((dt) => [dt, []]))
  const sorted = list.slice().sort((a, b) => (a.order || 0) - (b.order || 0))
  for (const t of sorted) {
    const due = store.effectiveDueDate(t, notebook) || end
    const bucket = buckets.get(due) || buckets.get(end)
    bucket.push(t)
  }
  const out = []
  for (const dt of dates) {
    const header = formatDateHeader(dt, todayStr)
    const items = buckets.get(dt) || []
    out.push({
      __header: true,
      id: `__h_${dt}`,
      date: dt,
      dateLabel: header.main,
      dateSub: header.sub,
      isEmpty: items.length === 0
    })
    for (const t of items) {
      out.push({ ...t, date: dt })
    }
  }
  return out
}

// 多天的一次性作业本才有"规划"这个概念。单天作业本 / 周期性作业本都不显示切换。
function canPlanNotebook(nb) {
  if (!nb || nb.mode !== 'one-shot') return false
  const end = nb.endDate || nb.startDate
  return !!(nb.startDate && end && nb.startDate !== end)
}

Page({
  data: {
    notebookId: null,
    notebook: null,
    notebookSummary: '',
    tasks: [],
    dragId: null,
    dragDy: 0,
    // Bound to <page-meta disable-scroll>. WXML can't toggle catch/bind on
    // touchmove dynamically, so we use bindtouchmove (lets ordinary swipes
    // scroll the page) and flip this flag during a drag to suppress scroll.
    disableScroll: false,
    // 'subject' | 'date'。仅多天一次性作业本可切到 'date'。默认 'subject'(opt-in)。
    viewMode: 'subject',
    canPlan: false
  },

  onLoad(options) {
    if (options && options.id) {
      const id = options.id
      // 偏好本地缓存,未设过就默认 'subject'。canPlan 在 refreshState 里再算。
      const cached = (() => {
        try { return wx.getStorageSync(VIEW_MODE_KEY(id)) || '' } catch (e) { return '' }
      })()
      this.setData({ notebookId: id, viewMode: cached === 'date' ? 'date' : 'subject' })
    }
  },

  onShow() {
    this.refreshState()
    this.startTickerIfNeeded()
    cloudSync.hydrateIfStale().then((r) => {
      if (r && r.changed) this.refreshState()
    }).catch(() => {})
    // Warm the openid cache so onShareAppMessage (sync) can embed it.
    shareReward.preloadOpenid().catch(() => {})
  },

  onHide() { this.stopTicker() },
  onUnload() { this.stopTicker() },

  refreshState() {
    const id = this.data.notebookId
    if (!id) return
    const state = store.getStateWithComputed()
    const nb = state.notebooks.find((n) => n.id === id)
    if (!nb) {
      wx.showToast({ title: '作业本不存在', icon: 'none' })
      setTimeout(() => wx.navigateBack(), 600)
      return
    }
    const today = store.todayStr()
    const now = Date.now()
    const canPlan = canPlanNotebook(nb)
    // 不支持规划的本(单天 / 周期性)强制回到 subject 视图,避免脏状态。
    const viewMode = canPlan ? this.data.viewMode : 'subject'
    const rawTasks = store.tasksOfNotebook(state, id).map((t) => decorateTask(t, nb, today, now))
    const list = viewMode === 'date'
      ? arrangeByDate(rawTasks, nb, today)
      : arrangeBySubject(rawTasks)
    wx.setNavigationBarTitle({ title: nb.name })
    this.setData({
      notebook: nb,
      notebookSummary: this.summarize(nb),
      tasks: list,
      canPlan,
      viewMode
    })
    this.startTickerIfNeeded()
    // 重画分享卡片图。debounce 不必要 —— refreshState 也不频繁,
    // canvas 操作即使串行也很快。
    this.paintShareCard().catch(() => {})
  },

  // 绘制 WeChat 分享卡片缩略图,排版完全对齐接收页 notebook-share:
  //   📥 X 分享给你的作业本   ← sharer hint
  //   作业本名字              ← 大字加粗
  //   摘要                    ← 灰色小字
  //   共 N 项作业             ← 蓝色加粗
  //   ──── 学科 1 ────
  //   • 任务...
  //   • 任务...
  //   ──── 学科 2 ────
  //   ...
  //   (任务超出可视区时:最后一行 "+N 项更多")
  // canvas 用 600x480(5:4),够塞 ~10 行任务。结果路径缓存到 this.shareImagePath,
  // onShareAppMessage 同步取用。
  // 失败(canvas node 拿不到 / canvasToTempFilePath 报错)时,shareImagePath
  // 保持 null —— onShareAppMessage 不带 imageUrl,WeChat 回退到默认截图,
  // 不至于把分享流程整个挂掉。
  paintShareCard() {
    return new Promise((resolve, reject) => {
      const nb = this.data.notebook
      if (!nb) { resolve(null); return }
      const query = wx.createSelectorQuery().in(this)
      query.select('#shareCanvas').fields({ node: true, size: true }).exec((res) => {
        if (!res || !res[0] || !res[0].node) {
          resolve(null)
          return
        }
        const canvas = res[0].node
        const ctx = canvas.getContext('2d')
        const sys = wx.getSystemInfoSync()
        const dpr = sys.pixelRatio || 2
        const W = 600
        const H = 480
        canvas.width = W * dpr
        canvas.height = H * dpr
        ctx.scale(dpr, dpr)

        // 渐变背景,与接收页 page 浅蓝色系一致
        const grad = ctx.createLinearGradient(0, 0, 0, H)
        grad.addColorStop(0, '#f7f9fc')
        grad.addColorStop(1, '#eef4ff')
        ctx.fillStyle = grad
        ctx.fillRect(0, 0, W, H)

        // 白色卡片背景(模拟接收页的 .card 圆角块)
        const padX = 28
        const cardX = padX
        const cardY = 24
        const cardW = W - padX * 2
        const cardH = H - 48
        ctx.fillStyle = '#ffffff'
        roundRect(ctx, cardX, cardY, cardW, cardH, 22)
        ctx.fill()

        const innerX = cardX + 24
        const innerW = cardW - 48
        let y = cardY + 22

        // sharer hint —— 与接收页 .sharer-hint 文案一致(本地预览不知道
        // 接收方反查到什么 nickname,所以用本地 profile.nickname,跟分享
        // 卡片 title 对齐)。
        const state = store.getStateWithComputed()
        const myNickname = ((state.profile && state.profile.nickname) || '').trim()
        const hintText = myNickname
          ? `📥 ${myNickname} 分享给你的作业本`
          : '📥 好友分享给你的作业本'
        ctx.fillStyle = '#6b7785'
        ctx.font = '18px sans-serif'
        ctx.textAlign = 'left'
        ctx.textBaseline = 'top'
        ctx.fillText(clipText(ctx, hintText, innerW), innerX, y)
        y += 30

        // 作业本名字
        ctx.fillStyle = '#1f2329'
        ctx.font = 'bold 30px sans-serif'
        ctx.fillText(clipText(ctx, nb.name || '作业本', innerW), innerX, y)
        y += 42

        // 摘要
        ctx.fillStyle = '#6b7785'
        ctx.font = '18px sans-serif'
        ctx.fillText(clipText(ctx, this.summarize(nb), innerW), innerX, y)
        y += 28

        // 任务数
        const allTasks = this.data.tasks.filter((t) => !t.__header)
        ctx.fillStyle = '#245bdb'
        ctx.font = 'bold 20px sans-serif'
        ctx.fillText(`共 ${allTasks.length} 项作业`, innerX, y)
        y += 32

        // 学科分组任务列表 —— 用接收页 arrangeBySubject 同款排序;
        // 字段名差异:detail 的 task 已 decorate,有 .subject/.content,
        // arrangeBySubject 直接按 .subject 分组。
        const tasksBySubject = arrangeBySubject(
          allTasks.map((t) => ({ subject: t.subject || '其他', content: t.content || '' }))
        )

        const lineH = 22
        const subjectH = 26
        const cardBottom = cardY + cardH - 16
        let drawn = 0
        let truncated = false
        for (let i = 0; i < tasksBySubject.length; i++) {
          const it = tasksBySubject[i]
          // 学科 header(只画第一项)
          if (it.firstOfSubject) {
            // 学科 header 也会占一行,如果加上去就装不下任务,直接停
            if (y + subjectH + lineH > cardBottom) {
              truncated = true
              break
            }
            ctx.fillStyle = '#245bdb'
            ctx.font = 'bold 18px sans-serif'
            ctx.fillText(it.subject, innerX, y)
            y += subjectH
          }
          // 任务行
          if (y + lineH > cardBottom) {
            truncated = true
            break
          }
          ctx.fillStyle = '#1f2329'
          ctx.font = '18px sans-serif'
          // 「• 内容」前缀对齐接收页的 .dot
          const line = '• ' + clipText(ctx, it.content, innerW - 18)
          ctx.fillText(line, innerX, y)
          y += lineH
          drawn++
        }
        if (truncated) {
          const remaining = allTasks.length - drawn
          ctx.fillStyle = '#8a96a6'
          ctx.font = '16px sans-serif'
          ctx.fillText(`+ 还有 ${remaining} 项 …`, innerX, Math.min(y, cardBottom - 4))
        }

        wx.canvasToTempFilePath({
          canvas,
          x: 0,
          y: 0,
          width: W,
          height: H,
          destWidth: W * dpr,
          destHeight: H * dpr,
          fileType: 'png',
          success: (r) => {
            this.shareImagePath = r.tempFilePath
            resolve(r.tempFilePath)
          },
          fail: (e) => {
            this.shareImagePath = null
            reject(e)
          }
        })
      })
    })
  },

  handleSwitchView(e) {
    const mode = e.currentTarget.dataset.mode
    if (mode !== 'subject' && mode !== 'date') return
    if (mode === this.data.viewMode) return
    if (mode === 'date' && !this.data.canPlan) return
    try { wx.setStorageSync(VIEW_MODE_KEY(this.data.notebookId), mode) } catch (e2) {}
    this.setData({ viewMode: mode })
    this.refreshState()
  },

  summarize(nb) {
    if (nb.mode === 'one-shot') {
      const due = nb.endDate || nb.startDate
      return `一次性 · 截止 ${due}`
    }
    const rec = nb.recurrence || { type: 'daily' }
    let recLabel = '每日'
    if (rec.type === 'weekly') {
      const names = ['一', '二', '三', '四', '五', '六', '日']
      recLabel = '每周' + (rec.weekdays || []).slice().sort().map((w) => names[w - 1]).join('、')
    }
    const range = `${nb.startDate} → ${nb.endDate || '长期'}`
    return `重复 · ${recLabel} · ${range}`
  },

  startTickerIfNeeded() {
    this.stopTicker()
    const hasRunning = (this.data.tasks || []).some((t) => !t.__header && t.status === 'doing')
    if (!hasRunning) return
    this.tickerId = setInterval(() => {
      const tasks = (this.data.tasks || []).map((t) => {
        if (t.__header) return t
        let ms = t.elapsedMs || 0
        if (t.status === 'doing') ms += 1000
        return { ...t, elapsedMs: ms, elapsedDisplay: formatElapsed(ms) }
      })
      this.setData({ tasks })
      if (!tasks.some((t) => !t.__header && t.status === 'doing')) this.stopTicker()
    }, 1000)
  },

  stopTicker() {
    if (this.tickerId) { clearInterval(this.tickerId); this.tickerId = null }
  },

  // === Notebook actions === //

  handleEditNotebook() {
    wx.navigateTo({ url: `/pkg-notebook/notebook-edit/index?id=${this.data.notebookId}` })
  },

  onShareAppMessage() {
    const nb = this.data.notebook
    if (!nb) return { title: '作业本', path: '/pages/tasks/index' }
    const state = store.getStateWithComputed()
    const nickname = ((state.profile && state.profile.nickname) || '').trim() || '好友'
    const title = `${nickname}分享给你的作业：${nb.name}`
    // Embed the notebook + tasks into the share path so the receiver can
    // import it. The receiver's local store doesn't have our notebook id,
    // so a bare ?id=... would just toast "作业本不存在".
    // Read sharer openid from cache (preloaded during onShow); if unset
    // here the share still works, just no reward attribution.
    const myOpenid = shareReward.getMyOpenidSync() || ''
    const payload = store.serializeNotebookForShare(nb.id, myOpenid)
    // shareImagePath 由 paintShareCard (refreshState 后异步执行) 缓存到
    // 实例。第一次进入页面时可能还没画完,此时 imageUrl=undefined,WeChat
    // 退化到截屏当前页 —— 这就是我们想避免的(规划切换器会出现在缩略图)。
    // 实践中 onShow → refreshState → paintShareCard 在用户能点到分享按钮
    // 之前已经跑完,首次未命中的概率很低;命中失败也只是退化,不报错。
    const imageUrl = this.shareImagePath || undefined
    if (payload) {
      const encoded = encodeURIComponent(JSON.stringify(payload))
      const sharePath = `/pages/notebook-share/index?d=${encoded}`
      // WeChat caps share path length around 1024 chars; if a notebook
      // grew very large, fall back to the local-only path rather than
      // silently producing a broken share link.
      if (sharePath.length <= 1024) {
        return { title, path: sharePath, imageUrl }
      }
    }
    return { title, path: `/pages/notebook-detail/index?id=${nb.id}`, imageUrl }
  },

  handleDeleteNotebook() {
    const nb = this.data.notebook
    if (!nb) return
    wx.showModal({
      title: `删除作业本「${nb.name}」？`,
      content: `本里 ${this.data.tasks.length} 项作业也会一起删除。`,
      confirmColor: '#e54545',
      success: (res) => {
        if (res.confirm) {
          store.deleteNotebook(this.data.notebookId)
          setTimeout(() => wx.navigateBack(), 200)
        }
      }
    })
  },

  // === Task CRUD === //
  // Add/edit moved to /pkg-notebook/notebook-task-edit/. We push that page
  // and rely on onShow → refreshState() to repaint when the user backs out.

  handleAddTask() {
    wx.navigateTo({
      url: `/pkg-notebook/notebook-task-edit/index?notebookId=${this.data.notebookId}`
    })
  },

  handleOcrImport() {
    wx.navigateTo({
      url: `/pages/ocr-import/index?notebookId=${this.data.notebookId}`
    })
  },

  handleEditTask(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({
      url: `/pkg-notebook/notebook-task-edit/index?notebookId=${this.data.notebookId}&taskId=${id}`
    })
  },

  handleDeleteTask(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '删除作业？',
      confirmColor: '#e54545',
      success: (res) => {
        if (res.confirm) {
          store.deleteTask(id)
          this.refreshState()
        }
      }
    })
  },

  // === Drag-reorder within this notebook === //

  handleTouchStart(e) {
    if (e.touches && e.touches[0]) this.touchStartY = e.touches[0].pageY
  },

  handleLongPress(e) {
    const id = e.currentTarget.dataset.id
    const list = this.data.tasks
    const idx = list.findIndex((t) => t.id === id)
    // header 不绑事件,理论上拿不到;再防御一层。
    if (idx < 0 || list[idx].__header) return
    this.dragStartY = this.touchStartY != null
      ? this.touchStartY
      : (e.detail && typeof e.detail.y === 'number' ? e.detail.y : 0)
    this.rowRects = null
    this._lastHoverIdx = idx
    // 学科模式只需要单 row 高度做估算;规划模式额外测全 row 真实位置,
    // touchmove/touchend 用真实位置判断落点,避免 header 与 task 高度不一致
    // 导致 slot 估算偏差(原本 Math.round(dy/itemH) 误差会让"拖到前一天"
    // 实际落回原 folder)。
    if (!this.itemHeightPx) {
      const q = wx.createSelectorQuery()
      q.select('.task-row').boundingClientRect()
      q.exec((rects) => { if (rects && rects[0]) this.itemHeightPx = rects[0].height + 12 })
    }
    if (this.data.viewMode === 'date') {
      const q = wx.createSelectorQuery()
      q.selectAll('.flow-row').boundingClientRect()
      q.exec((res) => {
        if (res && res[0] && res[0].length === list.length) this.rowRects = res[0]
      })
    }
    this.setData({ dragId: id, dragDy: 0, disableScroll: true })
    if (wx.vibrateShort) wx.vibrateShort({ type: 'light' })
  },

  // 规划模式:用 longpress 时测得的真实 rect cache,根据 dragged row 视觉中心
  // 找最接近的 row。平局取后到的 idx(<= bestDist),这样 dragDy=0 时 dragged
  // 自己永远胜出 → 不动。视觉跟 dragged 实际重叠最多的那一行就是落点。
  _hoverIdxFromRects(fromIdx, dragDy) {
    const rects = this.rowRects
    if (!rects || !rects[fromIdx]) return null
    const orig = rects[fromIdx]
    const draggedCenter = orig.top + orig.height / 2 + dragDy
    let bestIdx = fromIdx
    let bestDist = Infinity
    for (let i = 0; i < rects.length; i++) {
      const c = rects[i].top + rects[i].height / 2
      const dist = Math.abs(c - draggedCenter)
      // <= 让后到的 idx 覆盖,平局偏后(包括自己 fromIdx)
      if (dist <= bestDist) { bestDist = dist; bestIdx = i }
    }
    return bestIdx
  },

  // 根据落点 toIdx + 拖动方向算 newDueDate:
  //   - 落点是 task:归该 task 所属 folder(不分方向)
  //   - 落点是 __header + 向上(dragDy < 0):dragged 想"插到该 header 之前"
  //     → 归上一 folder(toIdx=0 时无上一行,退到 header 自己)
  //   - 落点是 __header + 向下(dragDy >= 0):dragged 想"进入该 header 的 folder"
  //     → 归 header 自己的 date
  // 方向性是必要的:同一个视觉位置(dragged 覆盖某 header)在向上/向下时语义相反,
  // 跟 Finder reordering 一致。
  _newDueDateForToIdx(list, toIdx, dragDy) {
    const row = list[toIdx]
    if (!row) return null
    if (row.__header) {
      if (dragDy < 0) {
        if (toIdx === 0) return row.date
        const prev = list[toIdx - 1]
        return prev && prev.date ? prev.date : row.date
      }
      return row.date
    }
    return row.date
  },

  // Find the [start, end] index range of the dragged task's subject group
  // within the flat task list (sorted-by-subject = group members are
  // contiguous). Drag is constrained to this range.
  _subjectGroupRange(list, draggedIdx) {
    const subj = list[draggedIdx].subject
    let start = draggedIdx
    while (start > 0 && list[start - 1].subject === subj) start--
    let end = draggedIdx
    while (end < list.length - 1 && list[end + 1].subject === subj) end++
    return [start, end]
  },

  // 拖拽范围:学科模式只能在同学科组内换序;规划模式允许跨整个 list(含 header
  // —— hover 到 header 上 = 放到该 folder 顶端)。
  _dragRange(list, draggedIdx) {
    if (this.data.viewMode === 'date') return [0, list.length - 1]
    return this._subjectGroupRange(list, draggedIdx)
  },

  handleTouchMove(e) {
    if (!this.data.dragId || this.dragStartY == null) return
    const now = Date.now()
    if (this._lastMoveAt && now - this._lastMoveAt < 16) return
    this._lastMoveAt = now
    const t = e.touches && e.touches[0]
    if (!t) return
    const dy = t.pageY - this.dragStartY
    if (Math.abs(dy - this.data.dragDy) < 2) return
    const itemH = this.itemHeightPx || 140
    const list = this.data.tasks
    const draggedIdx = list.findIndex((task) => task.id === this.data.dragId)
    if (draggedIdx < 0) return
    const [groupStart, groupEnd] = this._dragRange(list, draggedIdx)
    // 规划模式优先用真实 rect 算 hoverIdx;rect 还没就绪时 fallback 到估算
    let hoverIdx
    if (this.data.viewMode === 'date' && this.rowRects) {
      const fromRects = this._hoverIdxFromRects(draggedIdx, dy)
      hoverIdx = fromRects != null
        ? Math.max(groupStart, Math.min(groupEnd, fromRects))
        : draggedIdx
    } else {
      const slotsDelta = Math.round(dy / itemH)
      hoverIdx = Math.max(groupStart, Math.min(groupEnd, draggedIdx + slotsDelta))
    }

    // 只在 hoverIdx 变化时才重写整个 tasks(shift 计算),平时只更 dragDy。
    // 这样 touchmove 高频时 setData 数据量小,渲染线程不堵,page-meta
    // disable-scroll 能及时生效 —— 修 "page 跟着拖动一起滚" 的体感。
    if (hoverIdx !== this._lastHoverIdx) {
      this._lastHoverIdx = hoverIdx
      const updated = list.map((task, i) => {
        if (task.id === this.data.dragId) return task
        let shiftY = 0
        if (draggedIdx < hoverIdx && i > draggedIdx && i <= hoverIdx) shiftY = -itemH
        else if (draggedIdx > hoverIdx && i >= hoverIdx && i < draggedIdx) shiftY = itemH
        return { ...task, shiftY }
      })
      this.setData({ tasks: updated, dragDy: dy })
    } else {
      this.setData({ dragDy: dy })
    }
  },

  handleTouchEnd() {
    if (!this.data.dragId) {
      this.dragStartY = null
      this.touchStartY = null
      return
    }
    const dragId = this.data.dragId
    const dragDy = this.data.dragDy
    const itemH = this.itemHeightPx || 140
    const list = this.data.tasks
    const fromIdx = list.findIndex((t) => t.id === dragId)
    if (fromIdx < 0) {
      this.dragStartY = null
      this.touchStartY = null
      this.setData({ dragId: null, dragDy: 0, disableScroll: false })
      return
    }
    const [groupStart, groupEnd] = this._dragRange(list, fromIdx)
    let toIdx
    if (this.data.viewMode === 'date' && this.rowRects) {
      const fromRects = this._hoverIdxFromRects(fromIdx, dragDy)
      toIdx = fromRects != null
        ? Math.max(groupStart, Math.min(groupEnd, fromRects))
        : fromIdx
    } else {
      const slotsDelta = Math.round(dragDy / itemH)
      toIdx = Math.max(groupStart, Math.min(groupEnd, fromIdx + slotsDelta))
    }

    if (this.data.viewMode === 'date') {
      // 落点 toIdx + 拖动方向 决定 newDueDate(详见 _newDueDateForToIdx)。
      const newDueDate = this._newDueDateForToIdx(list, toIdx, dragDy)
      // 构造新扁平 list,过滤出真 task id 顺序
      const newFlat = list.slice()
      const [moved] = newFlat.splice(fromIdx, 1)
      newFlat.splice(toIdx, 0, moved)
      const ids = newFlat.filter((t) => !t.__header).map((t) => t.id)
      const draggedTask = list[fromIdx]
      const oldDueDate = store.effectiveDueDate(draggedTask, this.data.notebook)
      const dueChanged = newDueDate && newDueDate !== oldDueDate
      const orderChanged = fromIdx !== toIdx
      if (dueChanged) {
        store.updateTask(dragId, { dueDate: newDueDate })
      }
      if (orderChanged) {
        store.reorderTasksInNotebook(this.data.notebookId, ids)
      }
      if (dueChanged || orderChanged) {
        this.refreshState()
      } else {
        this.setData({ tasks: list.map((t) => ({ ...t, shiftY: 0 })) })
      }
    } else {
      if (fromIdx !== toIdx) {
        const ids = list.map((t) => t.id)
        const [moved] = ids.splice(fromIdx, 1)
        ids.splice(toIdx, 0, moved)
        store.reorderTasksInNotebook(this.data.notebookId, ids)
        this.refreshState()
      } else {
        this.setData({ tasks: list.map((t) => ({ ...t, shiftY: 0 })) })
      }
    }
    this.dragStartY = null
    this.touchStartY = null
    this.rowRects = null
    this._lastHoverIdx = null
    this.setData({ dragId: null, dragDy: 0, disableScroll: false })
  }
})
