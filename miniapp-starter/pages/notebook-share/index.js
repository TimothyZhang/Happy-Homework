const store = require('../../utils/store')
const shareReward = require('../../utils/share-reward')
const i18n = require('../../utils/i18n')

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
  if (org) {
    return range
      ? i18n.t('share_default_title_range', { org, range })
      : i18n.t('share_default_title_norange', { org })
  }
  return range
    ? i18n.t('share_default_title_noorg', { range })
    : i18n.t('share_default_title_noorg_norange')
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
    dueDateLabel: shortMD(t.dd || t.ed || t.sd || ''),
    estimatedMinutesLabel: Number(t.m) > 0 ? i18n.t('share_min', { n: Number(t.m) }) : ''
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
    orgLabel: '',
    dateRangeLabel: '',
    sharerHint: '',
    error: '',
    importing: false,
    imported: false,
    saveBtnLabel: '',
    t: {}
  },

  onLoad(options) {
    const raw = options && options.d
    if (!raw) {
      this.setData({ error: i18n.t('nbshare_err_nodata') })
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
      const customTitle = (payload.title || '').trim()
      const headerTitle = customTitle ||
        buildDefaultTitle(payload.org, payload.d, payload.de)
      const orgLabel = payload.org ? payload.org : i18n.t('nbshare_org_all')
      const dateRangeLabel = buildDateRangeLabel(payload.d, payload.de)
      this.setData({
        payload,
        subjectGroups,
        headerTitle,
        orgLabel,
        dateRangeLabel,
        sharerHint: i18n.t('nbshare_hint', { n: payload.t.length }),
        saveBtnLabel: i18n.t('nbshare_btn_save', { n: payload.t.length })
      })
      wx.setNavigationBarTitle({ title: i18n.t('nbshare_navtitle') })
      if (payload.sharer) {
        shareReward.fetchSharerProfile(payload.sharer).then((profile) => {
          if (!profile) return
          this.setData({
            sharerNickname: (profile.nickname || '').trim(),
            sharerAvatar: profile.avatar || ''
          })
        }).catch(() => {})
      }
    } catch (e) {
      this.setData({ error: i18n.t('nbshare_err_corrupt') })
    }
  },

  onShow() {
    this.setData({ t: i18n.dict() })
    wx.setNavigationBarTitle({ title: i18n.t('nbshare_navtitle') })
  },

  handleImport() {
    if (this.data.importing || this.data.imported) return
    if (!this.data.payload) return
    const payload = this.data.payload
    if (!payload.t || payload.t.length === 0) {
      wx.showToast({ title: i18n.t('nbshare_toast_none'), icon: 'none' })
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
  promptConflict(dupCount, total) {
    const newCount = total - dupCount
    const itemList = [
      i18n.t('nbshare_conflict_replace', { dup: dupCount }),
      i18n.t('nbshare_conflict_rename'),
      i18n.t('nbshare_conflict_skip', { new: newCount })
    ]
    wx.showActionSheet({
      itemList,
      success: (res) => {
        const modes = ['replace', 'rename', 'skip']
        const mode = modes[res.tapIndex]
        if (!mode) return
        // skip 模式如果没有非重复项,等于啥也不加,直接给用户一个明确提示。
        if (mode === 'skip' && newCount === 0) {
          wx.showToast({ title: i18n.t('nbshare_toast_skip_empty'), icon: 'none' })
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
    this.setData({ importing: true, saveBtnLabel: i18n.t('nbshare_btn_saving') })
    const newIds = store.importSharedTasks(payload, { conflictMode })
    if (!newIds || newIds.length === 0) {
      this.setData({ importing: false, error: i18n.t('nbshare_err_save') })
      return
    }
    // 保存成功:importing→false, imported→true,按钮文本变"✓ 已保存"。
    this.setData({
      importing: false,
      imported: true,
      saveBtnLabel: i18n.t('nbshare_btn_saved')
    })
    const verb = conflictMode === 'replace'
      ? i18n.t('nbshare_verb_replaced')
      : (conflictMode === 'rename' ? i18n.t('nbshare_verb_renamed') : i18n.t('nbshare_verb_saved'))
    wx.showToast({ title: i18n.t('nbshare_toast_done', { verb, n: newIds.length }), icon: 'success' })
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
  onShareAppMessage() {
    const payload = this.data.payload
    if (!payload) return { title: i18n.t('nbshare_fwd_fallback'), path: '/pages/tasks/index' }
    const forwarded = { ...payload }
    delete forwarded.from
    const nickname = (this.data.sharerNickname || '').trim()
    const title = nickname
      ? i18n.t('nbshare_fwd_named', { nickname })
      : i18n.t('nbshare_fwd_anon')
    const encoded = encodeURIComponent(JSON.stringify(forwarded))
    return { title, path: `/pages/notebook-share/index?d=${encoded}` }
  }
})
