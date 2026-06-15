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
    prof_feedback: 'Feedback',
    prof_feedbackSub: 'Suggestions or report a problem',
    prof_avatar_no_cloud: 'Cloud storage is off; can\'t upload avatar',
    prof_avatar_updated: 'Avatar updated',
    prof_avatar_fail_space: 'Cloud storage full; can\'t upload avatar',
    prof_avatar_fail_big: 'Image too large, try another',
    prof_avatar_fail_net: 'Network unstable, try again later',
    prof_avatar_fail_nofileid: 'Uploaded but got no fileID, try again later',
    prof_avatar_fail_generic: 'Avatar upload failed, please retry',
    prof_sync_fail: 'Sync failed: {e}',
    prof_sync_error: 'Sync error',
    prof_switch_title: 'Use this device',
    prof_switch_content: 'This overwrites local data with the latest cloud copy and signs out the other device. Continue?',
    prof_switch_confirm: 'OK',
    prof_cancel: 'Cancel',
    prof_switch_done: 'Switched to this device',
    prof_switch_fail: 'Switch failed',
    prof_switch_error: 'Switch error',
    prof_modal_fail: 'Failed to open dialog',
    prof_unknown_err: 'unknown error',
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
    sync_never: 'Never', sync_just_now: 'just now', sync_sec_ago: '{n}s ago', sync_min_ago: '{n} min ago', sync_hr_ago: '{n}h ago',
    sync_last: 'Last sync: ',
    sync_now: 'Sync now', sync_reclaim: 'Use this device',
    sync_readonlyWarn: 'This device is read-only; changes won\'t save to the cloud.',
    sync_unsynced: 'Not uploaded',
    // home sync-warning banner (loud, tappable)
    home_sync_readonly: '⚠️ Read-only on this device — changes won\'t be saved. Tap to switch back.',
    home_sync_unsynced: '⚠️ Changes not uploaded to the cloud. Tap to sync now.',
    home_sync_error: '⚠️ Sync error — tap to retry.',
    home_sync_fixing: 'Working…',
    // local backups (settings → restore lost data)
    bk_title: 'Local backups',
    bk_sub: 'Auto-saved before every sync and once a day. Restore here if data is ever lost.',
    bk_empty: 'No backups yet',
    bk_restore: 'Restore',
    bk_backup_now: 'Back up now',
    bk_backed_up: 'Backed up',
    bk_meta: '{tasks} tasks · {done} done',
    bk_reason_presync: 'before sync', bk_reason_daily: 'daily', bk_reason_prerestore: 'before restore', bk_reason_manual: 'manual',
    bk_restore_title: 'Restore this backup?',
    bk_restore_content: 'This overwrites current data with the snapshot. Current data is backed up first so you can undo. Continue?',
    bk_restore_confirm: 'Restore',
    bk_restored: 'Restored',
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
    prof_feedback: '建议反馈',
    prof_feedbackSub: '提建议或反馈问题',
    prof_avatar_no_cloud: '云存储未启用，无法上传头像',
    prof_avatar_updated: '头像已更新',
    prof_avatar_fail_space: '云存储空间不足，无法上传头像',
    prof_avatar_fail_big: '图片过大，换一张再试',
    prof_avatar_fail_net: '网络不稳定，稍后再试',
    prof_avatar_fail_nofileid: '上传完成但没拿到 fileID，稍后再试',
    prof_avatar_fail_generic: '头像上传失败，请重试',
    prof_sync_fail: '同步失败：{e}',
    prof_sync_error: '同步出错',
    prof_switch_title: '切回此设备',
    prof_switch_content: '会以云端最新数据覆盖本机当前 state，并踢下线另一台设备。继续？',
    prof_switch_confirm: '用此设备',
    prof_cancel: '取消',
    prof_switch_done: '已切回此设备',
    prof_switch_fail: '切回失败',
    prof_switch_error: '切回出错',
    prof_modal_fail: '弹窗打开失败',
    prof_unknown_err: '未知错误',
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
    sync_never: '从未', sync_just_now: '刚刚', sync_sec_ago: '{n} 秒前', sync_min_ago: '{n} 分钟前', sync_hr_ago: '{n} 小时前',
    sync_last: '上次同步：',
    sync_now: '立即同步', sync_reclaim: '切回此设备',
    sync_readonlyWarn: '本机当前为只读，写操作不会保存到云端。',
    sync_unsynced: '未上传',
    // 首页同步告警横幅(醒目、可点)
    home_sync_readonly: '⚠️ 此设备只读，改动不会保存。点此切回此设备',
    home_sync_unsynced: '⚠️ 有改动还没上传到云端，点此立即同步',
    home_sync_error: '⚠️ 同步出错，点此重试',
    home_sync_fixing: '处理中…',
    // 本地备份(设置 → 丢数据可恢复)
    bk_title: '本地备份',
    bk_sub: '每次同步前 / 每天自动留底。万一数据丢了可在此恢复。',
    bk_empty: '暂无备份',
    bk_restore: '恢复',
    bk_backup_now: '立即备份',
    bk_backed_up: '已备份',
    bk_meta: '{tasks} 项作业 · {done} 已完成',
    bk_reason_presync: '同步前', bk_reason_daily: '每日', bk_reason_prerestore: '恢复前', bk_reason_manual: '手动',
    bk_restore_title: '恢复这份备份？',
    bk_restore_content: '会用这份快照覆盖当前数据。覆盖前会自动再备份当前数据，可以再恢复回来。继续？',
    bk_restore_confirm: '恢复',
    bk_restored: '已恢复',
    set_count_suffix: ' 个'
  }
}

// 各页面的分字典模块合并进来(每页一个 utils/i18n/<page>.js,避免一个巨型文件 +
// 便于并行维护)。模块导出 { en:{...}, zh:{...} },键名加页面前缀防撞。
try {
  const extra = require('./i18n/index')
  if (extra && extra.en) Object.assign(DICT.en, extra.en)
  if (extra && extra.zh) Object.assign(DICT.zh, extra.zh)
} catch (e) { /* 分模块还没建时静默 */ }

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
// 占位替换:t('imported', { n: 5 }),字典里写 "Imported {n} words" / "已导入 {n} 个"。
function applyParams(s, params) {
  if (!params) return s
  return String(s).replace(/\{(\w+)\}/g, (m, k) => (params[k] != null ? params[k] : m))
}
function t(key, params) {
  const d = DICT[getLang()]
  const s = (d && d[key] != null) ? d[key] : (DICT.en[key] != null ? DICT.en[key] : key)
  return applyParams(s, params)
}

module.exports = { DICT, getLang, setLang, dict, t }
