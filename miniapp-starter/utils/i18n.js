// 轻量多语言。语言存在本地 storage(key=app_lang),默认 en。页面在 onShow 里
// this.setData({ t: i18n.dict() }) 注入当前语言字典,WXML 用 {{t.key}}。
// 切换语言:i18n.setLang('zh'|'en') 后各页 onShow 会重新注入。
// 目前只翻了「设置 / 我 / tabbar」;其余页面逐步补(t() 缺 key 时回退英文再回退 key)。
const KEY = 'app_lang'

const DICT = {
  en: {
    // tab bar
    tab_home: 'Home', tab_pet: 'Pet', tab_stats: 'Stats', tab_me: 'Me',
    // profile
    prof_edit: 'Edit', prof_done: 'Done',
    prof_noNick: 'No nickname',
    prof_avatar: 'Avatar', prof_uploading: 'Uploading…', prof_change: 'change',
    prof_editHint: 'Tap avatar to change · edit nickname',
    prof_wbTitle: 'My Word Books',
    prof_wbSub: 'Create / set goals / import / share · word challenge with your pet',
    prof_settings: 'Settings',
    prof_settingsSub: 'Language · organization tags · data sync',
    prof_admin: '🛠 Admin Panel',
    prof_adminSub: 'View all users, adjust coins',
    prof_version: 'Version',
    // settings
    set_title: 'Settings',
    set_language: 'Language',
    set_zh: '中文', set_en: 'English',
    set_org: 'Organization Tags',
    set_orgSub: 'Tag homework by category (school / club …)',
    set_sync: 'Data Sync',
    sync_synced: 'Synced', sync_readonly: 'Read-only', sync_error: 'Sync failed', sync_none: 'Not synced',
    sync_last: 'Last sync: ',
    sync_now: 'Sync now', sync_reclaim: 'Use this device',
    sync_readonlyWarn: 'This device is read-only; changes won\'t save to the cloud.',
    set_count_suffix: ''
  },
  zh: {
    tab_home: '首页', tab_pet: '宠物', tab_stats: '数据', tab_me: '我',
    prof_edit: '编辑', prof_done: '完成',
    prof_noNick: '未设置昵称',
    prof_avatar: '头像', prof_uploading: '上传中…', prof_change: '换',
    prof_editHint: '点头像换一张 · 昵称可直接改',
    prof_wbTitle: '我的单词本',
    prof_wbSub: '建单词本 / 设目标 / 拍照导入 / 分享 · 和宠物玩单词挑战',
    prof_settings: '设置',
    prof_settingsSub: '语言 · 组织标签 · 数据同步',
    prof_admin: '🛠 管理后台',
    prof_adminSub: '查看所有用户、调整金币',
    prof_version: '版本',
    set_title: '设置',
    set_language: '语言',
    set_zh: '中文', set_en: 'English',
    set_org: '作业组织标签',
    set_orgSub: '给作业分门别类(校内 / 校外 / 兴趣班…)',
    set_sync: '数据同步',
    sync_synced: '已同步', sync_readonly: '只读', sync_error: '同步失败', sync_none: '未同步',
    sync_last: '上次同步：',
    sync_now: '立即同步', sync_reclaim: '切回此设备',
    sync_readonlyWarn: '本机当前为只读，写操作不会保存到云端。',
    set_count_suffix: ' 个'
  }
}

let _lang = null
function getLang() {
  if (_lang == null) {
    let v = 'en'
    try { v = wx.getStorageSync(KEY) || 'en' } catch (e) {}
    _lang = (v === 'zh') ? 'zh' : 'en'
  }
  return _lang
}
function setLang(l) {
  _lang = (l === 'zh') ? 'zh' : 'en'
  try { wx.setStorageSync(KEY, _lang) } catch (e) {}
  return _lang
}
function dict() { return DICT[getLang()] }
function t(key) {
  const d = DICT[getLang()]
  if (d && d[key] != null) return d[key]
  return DICT.en[key] != null ? DICT.en[key] : key
}

module.exports = { DICT, getLang, setLang, dict, t }
