const store = require('../../utils/store')
const i18n = require('../../utils/i18n')

// 作业组织标签的管理页(从「我」tab 折叠卡片点进来)。增 / 改名 / 删 / 恢复默认
// 都在这里做;「我」tab 只展示只读概览。逻辑整体从 pages/profile 迁过来。
Page({
  data: {
    organizations: [],
    orgMaxLen: store.ORGANIZATION_MAX_LEN,
    orgMaxCount: store.ORGANIZATION_MAX_COUNT,
    newOrgInput: '',
    t: {}
  },

  onShow() {
    this.setData({
      t: i18n.dict(),
      organizations: store.getOrganizations()
    })
    wx.setNavigationBarTitle({ title: i18n.t('org_navtitle') })
  },

  handleOrgInput(e) {
    this.setData({ newOrgInput: e.detail.value })
  },

  handleAddOrg() {
    const name = (this.data.newOrgInput || '').trim()
    if (!name) {
      wx.showToast({ title: i18n.t('org_toast_empty_input'), icon: 'none' })
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
    wx.showToast({ title: i18n.t('org_toast_added'), icon: 'success' })
  },

  handleRemoveOrg(e) {
    const name = e.currentTarget.dataset.name
    if (!name) return
    wx.showModal({
      title: i18n.t('org_modal_delete_title', { name }),
      content: i18n.t('org_modal_delete_content'),
      confirmColor: '#e54545',
      confirmText: i18n.t('org_modal_delete_confirm'),
      cancelText: i18n.t('org_modal_delete_cancel'),
      success: (r) => {
        if (!r.confirm) return
        const res = store.removeOrganization(name)
        if (!res.ok) {
          wx.showToast({ title: this.orgErrorMessage(res.reason), icon: 'none' })
          return
        }
        this.setData({ organizations: store.getOrganizations() })
        wx.showToast({ title: i18n.t('org_toast_deleted'), icon: 'success' })
      }
    })
  },

  handleRenameOrg(e) {
    const name = e.currentTarget.dataset.name
    if (!name) return
    wx.showModal({
      title: i18n.t('org_modal_rename_title', { name }),
      editable: true,
      placeholderText: i18n.t('org_modal_rename_placeholder'),
      content: name,
      confirmText: i18n.t('org_modal_rename_confirm'),
      cancelText: i18n.t('org_modal_rename_cancel'),
      success: (r) => {
        if (!r.confirm) return
        const next = (r.content || '').trim()
        if (!next) {
          wx.showToast({ title: i18n.t('org_toast_new_empty'), icon: 'none' })
          return
        }
        if (next === name) return
        const res = store.renameOrganization(name, next)
        if (!res.ok) {
          wx.showToast({ title: this.orgErrorMessage(res.reason), icon: 'none' })
          return
        }
        this.setData({ organizations: store.getOrganizations() })
        wx.showToast({ title: i18n.t('org_toast_renamed'), icon: 'success' })
      }
    })
  },

  handleResetOrgs() {
    wx.showModal({
      title: i18n.t('org_modal_reset_title'),
      content: i18n.t('org_modal_reset_content'),
      confirmText: i18n.t('org_modal_reset_confirm'),
      cancelText: i18n.t('org_modal_reset_cancel'),
      success: (r) => {
        if (!r.confirm) return
        store.resetOrganizations()
        this.setData({ organizations: store.getOrganizations() })
        wx.showToast({ title: i18n.t('org_toast_reset'), icon: 'success' })
      }
    })
  },

  orgErrorMessage(reason) {
    switch (reason) {
      case 'empty':     return i18n.t('org_err_empty')
      case 'too_long':  return i18n.t('org_err_too_long', { n: store.ORGANIZATION_MAX_LEN })
      case 'duplicate': return i18n.t('org_err_duplicate')
      case 'too_many':  return i18n.t('org_err_too_many', { n: store.ORGANIZATION_MAX_COUNT })
      case 'last_one':  return i18n.t('org_err_last_one')
      case 'unknown':   return i18n.t('org_err_unknown')
      case 'noop':      return ''
      default:          return i18n.t('org_err_default')
    }
  }
})
