const store = require('../../utils/store')

// 作业组织标签的管理页(从「我」tab 折叠卡片点进来)。增 / 改名 / 删 / 恢复默认
// 都在这里做;「我」tab 只展示只读概览。逻辑整体从 pages/profile 迁过来。
Page({
  data: {
    organizations: [],
    orgMaxLen: store.ORGANIZATION_MAX_LEN,
    orgMaxCount: store.ORGANIZATION_MAX_COUNT,
    newOrgInput: ''
  },

  onShow() {
    this.setData({ organizations: store.getOrganizations() })
  },

  handleOrgInput(e) {
    this.setData({ newOrgInput: e.detail.value })
  },

  handleAddOrg() {
    const name = (this.data.newOrgInput || '').trim()
    if (!name) {
      wx.showToast({ title: '请输入标签名', icon: 'none' })
      return
    }
    const res = store.addOrganization(name)
    if (!res.ok) {
      wx.showToast({ title: this.orgErrorMessage(res.reason), icon: 'none' })
      return
    }
    this.setData({
      organizations: store.getOrganizations(),
      newOrgInput: ''
    })
    wx.showToast({ title: '已添加', icon: 'success' })
  },

  handleRemoveOrg(e) {
    const name = e.currentTarget.dataset.name
    if (!name) return
    wx.showModal({
      title: `删除「${name}」？`,
      content: '已用该标签的作业仍保留显示，仅在下次选择时不再出现。',
      confirmColor: '#e54545',
      confirmText: '删除',
      cancelText: '取消',
      success: (r) => {
        if (!r.confirm) return
        const res = store.removeOrganization(name)
        if (!res.ok) {
          wx.showToast({ title: this.orgErrorMessage(res.reason), icon: 'none' })
          return
        }
        this.setData({ organizations: store.getOrganizations() })
        wx.showToast({ title: '已删除', icon: 'success' })
      }
    })
  },

  handleRenameOrg(e) {
    const name = e.currentTarget.dataset.name
    if (!name) return
    wx.showModal({
      title: `重命名「${name}」`,
      editable: true,
      placeholderText: '新标签名',
      content: name,
      confirmText: '保存',
      cancelText: '取消',
      success: (r) => {
        if (!r.confirm) return
        const next = (r.content || '').trim()
        if (!next) {
          wx.showToast({ title: '请输入新标签名', icon: 'none' })
          return
        }
        if (next === name) return
        const res = store.renameOrganization(name, next)
        if (!res.ok) {
          wx.showToast({ title: this.orgErrorMessage(res.reason), icon: 'none' })
          return
        }
        this.setData({ organizations: store.getOrganizations() })
        wx.showToast({ title: '已重命名', icon: 'success' })
      }
    })
  },

  handleResetOrgs() {
    wx.showModal({
      title: '恢复默认标签？',
      content: '会重置为「校内 / 校外 / 其他」。已存在的作业标签不变。',
      confirmText: '恢复',
      cancelText: '取消',
      success: (r) => {
        if (!r.confirm) return
        store.resetOrganizations()
        this.setData({ organizations: store.getOrganizations() })
        wx.showToast({ title: '已恢复默认', icon: 'success' })
      }
    })
  },

  orgErrorMessage(reason) {
    switch (reason) {
      case 'empty':     return '请输入标签名'
      case 'too_long':  return `标签最长 ${store.ORGANIZATION_MAX_LEN} 字`
      case 'duplicate': return '该标签已存在'
      case 'too_many':  return `最多 ${store.ORGANIZATION_MAX_COUNT} 个标签`
      case 'last_one':  return '至少保留一个标签'
      case 'unknown':   return '标签不存在'
      case 'noop':      return ''
      default:          return '操作失败'
    }
  }
})
