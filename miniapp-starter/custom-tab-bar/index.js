const perf = require('../utils/perf')
const i18n = require('../utils/i18n')

Component({
  data: {
    selected: 0,
    color: '#7b8794',
    selectedColor: '#245bdb',
    isLandscape: false,   // iPad 横屏 → tab 高度减半
    t: i18n.dict(),
    list: [
      { pagePath: '/pages/home/index', key: 'tab_home' },
      { pagePath: '/pages/pet/index', key: 'tab_pet' },
      { pagePath: '/pages/stats/index', key: 'tab_stats' },
      { pagePath: '/pages/profile/index', key: 'tab_me' }
    ]
  },
  lifetimes: {
    attached() {
      this._onResize = (res) => {
        const s = res && res.size
        if (s && s.windowWidth && s.windowHeight) this.setData({ isLandscape: s.windowWidth > s.windowHeight })
      }
      if (wx.onWindowResize) wx.onWindowResize(this._onResize)
      this._updateOrientation()
    },
    detached() {
      if (this._onResize && wx.offWindowResize) wx.offWindowResize(this._onResize)
    }
  },
  // 每次承载它的 tab 页 show 都重读当前语言字典 → 切换语言后回到 tab 标签即更新。
  pageLifetimes: {
    show() { this.setData({ t: i18n.dict() }); this._updateOrientation() }
  },
  methods: {
    _updateOrientation() {
      try {
        const s = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
        if (s.windowWidth && s.windowHeight) this.setData({ isLandscape: s.windowWidth > s.windowHeight })
      } catch (e) {}
    },
    handleTap(e) {
      const { path, index } = e.currentTarget.dataset
      if (this.data.selected === index) return
      perf.markTabTap(path)
      wx.switchTab({ url: path })
      this.setData({ selected: index })
    }
  }
})
