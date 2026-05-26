const store = require('../../utils/store')
const shareReward = require('../../utils/share-reward')

const SUBJECT_ORDER = ['语文', '数学', '英语', '科学', '道法', '美术', '其他']

function subjectRank(s) {
  const i = SUBJECT_ORDER.indexOf(s)
  return i < 0 ? SUBJECT_ORDER.length : i
}

function shortMD(dateStr) {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(dateStr || '')
  if (!m) return dateStr || ''
  return `${Number(m[1])}/${Number(m[2])}`
}

function buildDateRangeLabel(start, end) {
  if (!start) return ''
  if (!end || end === start) return shortMD(start)
  return `${shortMD(start)} – ${shortMD(end)}`
}

// 默认标题:跟 share 页 buildDefaultTitle 同形式 —— 客态视角 "{组织}作业({日期})"。
// 老 payload(没 title 字段)在这里兜底,使得 "客态" 不再出现 "我分享的作业"。
function buildDefaultTitle(organization, startDate, endDate) {
  const org = (organization || '').trim()
  const range = buildDateRangeLabel(startDate, endDate)
  const prefix = org ? `${org}作业` : '作业'
  return range ? `${prefix}(${range})` : prefix
}

// payload.t 按学科分组,组内保留原顺序。每条 task 保留原下标 _idx 让导入时
// 可以精准定位回 payload.t。
function groupBySubject(tasks) {
  const list = tasks.map((t, idx) => ({
    _idx: idx,
    id: `${t.s || '其他'}-${idx}`,
    subject: t.s || '其他',
    content: t.c || '',
    organization: t.o || '校内',
    estimatedMinutes: Number(t.m) || 0,
    dueDateLabel: shortMD(t.dd || t.ed || t.sd || '')
  }))
  const buckets = new Map()
  for (const t of list) {
    if (!buckets.has(t.subject)) buckets.set(t.subject, [])
    buckets.get(t.subject).push(t)
  }
  const groups = Array.from(buckets.entries()).map(([subject, items]) => ({ subject, tasks: items }))
  groups.sort((a, b) => {
    const ra = subjectRank(a.subject)
    const rb = subjectRank(b.subject)
    if (ra !== rb) return ra - rb
    return a.subject.localeCompare(b.subject, 'zh')
  })
  return groups
}

Page({
  data: {
    payload: null,
    subjectGroups: [],
    headerTitle: '',
    sharerNickname: '',
    sharerAvatar: '',
    orgLabel: '全部组织',
    dateRangeLabel: '',
    error: '',
    importing: false,
    imported: false
  },

  onLoad(options) {
    const raw = options && options.d
    if (!raw) {
      this.setData({ error: '分享链接里没有作业数据' })
      return
    }
    try {
      const rawPayload = JSON.parse(decodeURIComponent(raw))
      const payload = store.sanitizeSharePayload(rawPayload)
      if (!payload || !Array.isArray(payload.t)) {
        throw new Error('payload invalid')
      }
      const subjectGroups = groupBySubject(payload.t)
      // 标题优先级:payload.title(分享方自定义)→ buildDefaultTitle(org+日期)。
      // 不再用 "{nickname} 分享的作业" / "好友分享的作业" 这种 fallback —— 客态
      // 视角不应该出现"我分享的"/"好友分享的"这种关于"谁"的描述,只描述作业本身。
      const customTitle = (payload.title || '').trim()
      const headerTitle = customTitle ||
        buildDefaultTitle(payload.org, payload.d, payload.de)
      const orgLabel = payload.org ? payload.org : '全部组织'
      const dateRangeLabel = buildDateRangeLabel(payload.d, payload.de)
      this.setData({
        payload,
        subjectGroups,
        headerTitle,
        orgLabel,
        dateRangeLabel
      })
      wx.setNavigationBarTitle({ title: '导入作业' })
      if (payload.sharer) {
        // 仍然 fetch 头像/昵称用于头像位的展示,但 *不再覆盖 headerTitle* —
        // 标题由 payload.title / 默认推导,跟分享者身份解耦。
        shareReward.fetchSharerProfile(payload.sharer).then((profile) => {
          if (!profile) return
          this.setData({
            sharerNickname: (profile.nickname || '').trim(),
            sharerAvatar: profile.avatar || ''
          })
        }).catch(() => {})
      }
    } catch (e) {
      this.setData({ error: '分享数据已损坏，无法读取' })
    }
  },

  handleImport() {
    if (this.data.importing || this.data.imported) return
    if (!this.data.payload) return
    const payload = this.data.payload
    if (!payload.t || payload.t.length === 0) {
      wx.showToast({ title: '没有可保存的作业', icon: 'none' })
      return
    }
    // 先检测和现有作业的重复 —— 有重复就弹 actionSheet 让用户选;
    // 没重复直接走 'add' 默认路径。
    const dups = store.findShareDuplicates(payload)
    if (dups.length > 0) {
      this.promptConflict(dups.length, payload.t.length)
      return
    }
    this.doImport('add')
  },

  // 提示用户选重复处理策略。actionSheet 的取消按钮 = "全部放弃"。
  // 4 项中"放弃重复项" / "全部放弃" 语义有重叠,分别对应:
  //   - "跳过重复": 只导入不重复的部分(有 N-dup 项被加)
  //   - "全部放弃": 整次 import 取消(没有任何变更)
  promptConflict(dupCount, total) {
    const newCount = total - dupCount
    const itemList = [
      `替换重复项(覆盖现有 ${dupCount} 项)`,
      `重命名重复项(加"（副本）"导入)`,
      `跳过重复项(仅导入新增 ${newCount} 项)`
    ]
    wx.showActionSheet({
      itemList,
      success: (res) => {
        const modes = ['replace', 'rename', 'skip']
        const mode = modes[res.tapIndex]
        if (!mode) return
        // skip 模式如果没有非重复项,等于啥也不加,直接给用户一个明确提示。
        if (mode === 'skip' && newCount === 0) {
          wx.showToast({ title: '没有可新增的作业', icon: 'none' })
          return
        }
        this.doImport(mode)
      },
      fail: () => {
        // 用户点取消按钮 = 全部放弃,啥也不做。
      }
    })
  },

  // 真正写 store + 跳转。封装出来让 handleImport 和 promptConflict 共用。
  doImport(conflictMode) {
    const payload = this.data.payload
    this.setData({ importing: true })
    const newIds = store.importSharedTasks(payload, { conflictMode })
    if (!newIds || newIds.length === 0) {
      this.setData({ importing: false, error: '保存失败，请稍后再试' })
      return
    }
    // 保存成功:importing→false, imported→true,按钮文本变 "✓ 已保存",
    // 在 600ms 跳转 tasks tab 之前用户能看到完成状态(原来一直停在 "保存中…")。
    this.setData({ importing: false, imported: true })
    const verb = conflictMode === 'replace'
      ? '已替换'
      : (conflictMode === 'rename' ? '已重命名导入' : '已保存')
    wx.showToast({ title: `${verb} ${newIds.length} 项`, icon: 'success' })
    // 服务端 shareReward 给分享者 +3 coin(以 shareId 做 dedup,重复导入不会重复发)。
    if (payload.sharer && payload.shareId) {
      shareReward.reportShareSave({
        sharerOpenid: payload.sharer,
        notebookId: payload.shareId,
        notebookName: this.data.headerTitle
      }).catch(() => {})
    }
    setTimeout(() => {
      // 没有 notebook-detail 可跳,直接回任务列表
      wx.switchTab({ url: '/pages/tasks/index' })
    }, 600)
  },

  handleCancel() {
    if (getCurrentPages().length > 1) {
      wx.navigateBack()
    } else {
      wx.switchTab({ url: '/pages/home/index' })
    }
  },

  // 转发卡片继续往下传播 — payload 里包含 shareId,reportShareSave 仍归属原作者。
  // title 跟当前页头部 headerTitle 一致(payload.title 或默认组织-日期),转发出去的
  // 卡片还是客态视角。
  onShareAppMessage() {
    const payload = this.data.payload
    if (!payload) return { title: '作业分享', path: '/pages/tasks/index' }
    const forwarded = { ...payload }
    delete forwarded.from
    const title = this.data.headerTitle || '作业分享'
    const encoded = encodeURIComponent(JSON.stringify(forwarded))
    return { title, path: `/pages/notebook-share/index?d=${encoded}` }
  }
})
