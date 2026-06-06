// 分享页 pages/share — prefix: share_
module.exports = {
  en: {
    share_navtitle: 'Share Homework',
    // sharer-hint: "{n} tasks · edit title"
    share_hint: '{n} tasks · edit title',
    // endDate chip prefix "to "
    share_to_prefix: 'to ',
    // empty state
    share_empty: 'No homework to share in this range',
    // estimated minutes chip suffix
    share_min: '{n} min',
    // share button: "Share {n} tasks"
    share_btn: 'Share {n} tasks',
    // default title fallback when org is empty
    share_default_title_noorg: 'Homework({range})',
    share_default_title_noorg_norange: 'Homework',
    // default title with org: "{org}Homework({range})" — org is user data, not translated
    share_default_title_range: '{org} Homework({range})',
    share_default_title_norange: '{org} Homework',
    // share card title (WeChat dialog)
    share_card_title_named: '{nickname}\'s shared homework',
    share_card_title_anon: 'A friend\'s shared homework'
  },
  zh: {
    share_navtitle: '分享作业',
    share_hint: '共 {n} 项作业 · 可改标题',
    share_to_prefix: '至 ',
    share_empty: '该范围内没有可分享的作业',
    share_min: '{n} 分钟',
    share_btn: '💬 分享 {n} 项作业',
    share_default_title_noorg: '作业({range})',
    share_default_title_noorg_norange: '作业',
    share_default_title_range: '{org}作业({range})',
    share_default_title_norange: '{org}作业',
    share_card_title_named: '{nickname} 分享给你的作业',
    share_card_title_anon: '好友分享给你的作业'
  }
}
