// 建议反馈:用户写建议/反馈 → adminPanel.submitFeedback 落 feedback 集合,管理员可看。
const i18n = require('../../utils/i18n')
const buildInfo = require('../../utils/build-info')

Page({
  data: {
    t: {},
    text: '',
    contact: '',
    countLabel: '',
    submitting: false,
    textMax: 1000
  },

  onLoad() {
    this.setData({ t: i18n.dict(), countLabel: i18n.t('fb_count', { n: 0 }) })
    wx.setNavigationBarTitle({ title: i18n.t('fb_navtitle') })
  },

  onShow() {
    this.setData({ t: i18n.dict() })
    wx.setNavigationBarTitle({ title: i18n.t('fb_navtitle') })
  },

  onText(e) {
    const text = e.detail.value || ''
    this.setData({ text, countLabel: i18n.t('fb_count', { n: text.length }) })
  },

  onContact(e) { this.setData({ contact: e.detail.value || '' }) },

  submit() {
    if (this.data.submitting) return
    const text = (this.data.text || '').trim()
    if (!text) { wx.showToast({ title: i18n.t('fb_empty'), icon: 'none' }); return }
    if (!wx.cloud || !wx.cloud.callFunction) {
      wx.showToast({ title: i18n.t('fb_no_cloud'), icon: 'none' }); return
    }
    this.setData({ submitting: true })
    wx.showLoading({ title: i18n.t('fb_submitting'), mask: true })
    wx.cloud.callFunction({
      name: 'adminPanel',
      data: { action: 'submitFeedback', text, contact: (this.data.contact || '').trim(), version: (buildInfo && buildInfo.version) || '' }
    }).then((res) => {
      wx.hideLoading(); this.setData({ submitting: false })
      const r = (res && res.result) || {}
      if (r.ok) {
        wx.showToast({ title: i18n.t('fb_thanks'), icon: 'success' })
        this.setData({ text: '', contact: '', countLabel: i18n.t('fb_count', { n: 0 }) })
        setTimeout(() => wx.navigateBack({ delta: 1, fail: () => {} }), 900)
      } else if (r.reason === 'too_frequent') {
        wx.showToast({ title: i18n.t('fb_too_frequent'), icon: 'none' })
      } else {
        wx.showToast({ title: i18n.t('fb_fail'), icon: 'none' })
      }
    }).catch(() => {
      wx.hideLoading(); this.setData({ submitting: false })
      wx.showToast({ title: i18n.t('fb_fail'), icon: 'none' })
    })
  }
})
