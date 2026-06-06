const perf = require('../utils/perf')
const i18n = require('../utils/i18n')

Component({
  data: {
    selected: 0,
    color: '#7b8794',
    selectedColor: '#245bdb',
    t: i18n.dict(),
    list: [
      { pagePath: '/pages/home/index', key: 'tab_home' },
      { pagePath: '/pages/pet/index', key: 'tab_pet' },
      { pagePath: '/pages/stats/index', key: 'tab_stats' },
      { pagePath: '/pages/profile/index', key: 'tab_me' }
    ]
  },
  // 每次承载它的 tab 页 show 都重读当前语言字典 → 切换语言后回到 tab 标签即更新。
  pageLifetimes: {
    show() { this.setData({ t: i18n.dict() }) }
  },
  methods: {
    handleTap(e) {
      const { path, index } = e.currentTarget.dataset
      if (this.data.selected === index) return
      perf.markTabTap(path)
      wx.switchTab({ url: path })
      this.setData({ selected: index })
    }
  }
})
