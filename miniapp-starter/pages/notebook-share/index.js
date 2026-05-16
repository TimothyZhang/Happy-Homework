const store = require('../../utils/store')
const shareReward = require('../../utils/share-reward')

const SUBJECT_ORDER = ['语文', '数学', '英语', '科学', '道法', '美术', '其他']

// Mirrors arrangeBySubject in pages/notebook-detail — share preview is
// read-only, grouped by subject only (planning view stays on detail page).
function arrangeBySubject(rawTasks) {
  const subjectRank = (s) => {
    const i = SUBJECT_ORDER.indexOf(s)
    return i < 0 ? SUBJECT_ORDER.length : i
  }
  const list = rawTasks.map((t, idx) => ({
    _idx: idx,
    subject: t.s || '其他',
    content: t.c || '',
    estimatedMinutes: Number(t.m) || 0
  }))
  list.sort((a, b) => {
    const ra = subjectRank(a.subject)
    const rb = subjectRank(b.subject)
    if (ra !== rb) return ra - rb
    if (a.subject !== b.subject) return a.subject < b.subject ? -1 : 1
    return a._idx - b._idx
  })
  let prev = null
  for (const t of list) {
    t.firstOfSubject = t.subject !== prev
    prev = t.subject
  }
  return list
}

function summarize(n) {
  if (!n) return ''
  if (n.mode === 'one-shot') {
    const due = n.endDate || n.startDate
    return `一次性 · 截止 ${due}`
  }
  const rec = n.recurrence || { type: 'daily' }
  let recLabel = '每日'
  if (rec.type === 'weekly') {
    const names = ['一', '二', '三', '四', '五', '六', '日']
    recLabel = '每周' + (rec.weekdays || []).slice().sort().map((w) => names[w - 1]).join('、')
  }
  const range = `${n.startDate} → ${n.endDate || '长期'}`
  return `重复 · ${recLabel} · ${range}`
}

Page({
  data: {
    payload: null,
    arrangedTasks: [],
    notebookSummary: '',
    sharerLabel: '',
    sharerNickname: '',
    sharerAvatar: '',
    error: '',
    importing: false
  },

  onLoad(options) {
    const raw = options && options.d
    if (!raw) {
      this.setData({ error: '分享链接里没有作业本数据' })
      return
    }
    try {
      const rawPayload = JSON.parse(decodeURIComponent(raw))
      // sanitize 把 schema 收敛到已知字段、字符串截断、数组截 200。攻击者
      // 构造 100k 条任务的 ?d= 想撑爆 setData / 本地存储,在这一关就被截掉。
      const payload = store.sanitizeSharePayload(rawPayload)
      if (!payload) throw new Error('payload invalid')
      // URL 里只带 sharer (openid),不带昵称 —— PII 不入路径。
      // 接收端拿 openid 异步去云端反查 profile,拿到再补 nickname/avatar。
      this.setData({
        payload,
        arrangedTasks: arrangeBySubject(payload.t),
        notebookSummary: summarize(payload.n),
        sharerLabel: '好友分享给你的作业本'
      })
      wx.setNavigationBarTitle({ title: payload.n.name || '导入作业本' })
      if (payload.sharer) {
        // 失败 / 没填 profile → 保持默认通用文案,不弹错。
        shareReward.fetchSharerProfile(payload.sharer).then((profile) => {
          if (!profile) return
          const nickname = (profile.nickname || '').trim()
          this.setData({
            sharerNickname: nickname,
            sharerAvatar: profile.avatar || '',
            sharerLabel: nickname ? `${nickname} 分享给你的作业本` : '好友分享给你的作业本'
          })
        }).catch(() => {})
      }
    } catch (e) {
      this.setData({ error: '分享数据已损坏，无法读取' })
    }
  },

  handleImport() {
    if (this.data.importing) return
    if (!this.data.payload) return
    const payload = this.data.payload
    const name = (payload.n && payload.n.name) || ''
    const dupe = store.findNotebookByName(name)
    if (dupe) {
      this.showDuplicateActionSheet(dupe.id)
      return
    }
    this.runImport({ mode: 'new' })
  },

  // Three-way conflict resolver when the import name collides with an
  // existing notebook. Choices:
  //   合并 — append shared tasks to the existing notebook (no dedupe; all
  //          incoming tasks land as todo).
  //   重命名 — auto-suffix " 复制" until unique, then create as new.
  //   覆盖 — destructive: replaces metadata + tasks under the same id.
  //          Coin/streak history is keyed elsewhere and stays intact.
  showDuplicateActionSheet(targetId) {
    wx.showActionSheet({
      itemList: ['合并到现有作业本', '重命名后保存', '覆盖现有作业本'],
      success: (res) => {
        if (res.tapIndex === 0) {
          this.runImport({ mode: 'merge', targetNotebookId: targetId })
        } else if (res.tapIndex === 1) {
          this.runImport({ mode: 'rename' })
        } else if (res.tapIndex === 2) {
          // Second confirm — overwrite is destructive.
          wx.showModal({
            title: '覆盖作业本？',
            content: '现有作业本里的所有作业会被替换，进度记录保留。',
            confirmText: '覆盖',
            confirmColor: '#e54545',
            success: (r) => {
              if (r.confirm) {
                this.runImport({ mode: 'overwrite', targetNotebookId: targetId })
              }
            }
          })
        }
      }
    })
  },

  runImport(options) {
    if (this.data.importing) return
    this.setData({ importing: true })
    const payload = this.data.payload
    const newId = store.importSharedNotebook(payload, options)
    if (!newId) {
      this.setData({ importing: false, error: '保存失败，请稍后再试' })
      return
    }
    wx.showToast({ title: '已保存', icon: 'success' })
    // Best-effort credit the original sharer with +3 coins. Cloud function
    // dedups (importer × notebookId) so re-imports won't double-credit.
    // Failure is silent — main flow already succeeded.
    if (payload.sharer && payload.nbId) {
      shareReward.reportShareSave({
        sharerOpenid: payload.sharer,
        notebookId: payload.nbId,
        notebookName: (payload.n && payload.n.name) || ''
      }).catch(() => {})
    }
    setTimeout(() => {
      wx.redirectTo({ url: `/pages/notebook-detail/index?id=${newId}` })
    }, 600)
  },

  handleCancel() {
    if (getCurrentPages().length > 1) {
      wx.navigateBack()
    } else {
      wx.switchTab({ url: '/pages/home/index' })
    }
  },

  // Forward the same shared payload onward — re-encode rather than relying
  // on `currentRoute + options`, so we don't rebuild the URL by hand.
  // payload 里不再含发送者昵称(serializeNotebookForShare 已不写、转发也
  // 不补)—— share URL 是 PII 泄露面,昵称不入路径。WeChat 转发的卡片
  // 本身会显示"X 转发给你",身份信息有别的地方承载,不需要塞 URL。
  // payload.sharer (openid) 保留 —— 奖励归属还是要回到原作者。
  onShareAppMessage() {
    const payload = this.data.payload
    if (!payload || !payload.n) {
      return { title: '作业本', path: '/pages/tasks/index' }
    }
    // 显式剔除 from,即使老 payload 上携带也别带出去。
    const forwarded = { ...payload }
    delete forwarded.from
    const title = `好友分享给你的作业：${payload.n.name}`
    const encoded = encodeURIComponent(JSON.stringify(forwarded))
    return { title, path: `/pages/notebook-share/index?d=${encoded}` }
  }
})
