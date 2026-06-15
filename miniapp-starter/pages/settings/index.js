const i18n = require('../../utils/i18n')

Page({
  data: {
    t: {},
    lang: 'en'
  },

  onShow() {
    this.setData({ t: i18n.dict(), lang: i18n.getLang() })
    wx.setNavigationBarTitle({ title: i18n.t('set_title') })
  },

  // 切换语言:写本地 + 重注入当前页字典;其它页/tabbar 各自 onShow 时更新。
  setLang(e) {
    const l = e.currentTarget.dataset.lang
    if (l === this.data.lang) return
    i18n.setLang(l)
    this.setData({ t: i18n.dict(), lang: i18n.getLang() })
    wx.setNavigationBarTitle({ title: i18n.t('set_title') })
    const tb = typeof this.getTabBar === 'function' && this.getTabBar()
    if (tb && tb.setData) tb.setData({ t: i18n.dict() })
  },

  goOrgTags() {
    wx.navigateTo({ url: '/pages/org-tags/index' })
  },

  // 数据同步 / 本地+云端备份 / 恢复 / 登录记录,都挪到这个子页了。
  goDataRecovery() {
    wx.navigateTo({ url: '/pages/data-recovery/index' })
  }
})
