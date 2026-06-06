// 分页面字典清单。每页一个模块导出 { en, zh },在这里 require + 合并。
// 新增一页:建 utils/i18n/<page>.js,再在下面 MODULES 里 require 进来。
const MODULES = [
  require('./store'),
  require('./calendar'),
  require('./tasks'),
  require('./stats'),
  require('./home'),
  require('./tasklist'),
  require('./wordrecite'),
  require('./wordbook'),
  require('./wordbooks'),
  require('./worddiscover'),
  require('./pet'),
  require('./feedback'),
]

const en = {}
const zh = {}
for (const m of MODULES) {
  if (m && m.en) Object.assign(en, m.en)
  if (m && m.zh) Object.assign(zh, m.zh)
}

module.exports = { en, zh }
