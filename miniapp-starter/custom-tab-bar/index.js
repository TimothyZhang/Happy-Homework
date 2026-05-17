const perf = require('../utils/perf')

Component({
  data: {
    selected: 0,
    color: '#7b8794',
    selectedColor: '#245bdb',
    list: [
      { pagePath: '/pages/home/index', text: '首页' },
      { pagePath: '/pages/pet/index', text: '宠物' },
      { pagePath: '/pages/stats/index', text: '数据' },
      { pagePath: '/pages/profile/index', text: '我的' }
    ]
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
