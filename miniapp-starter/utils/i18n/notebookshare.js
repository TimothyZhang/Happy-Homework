// 导入分享落地页 pages/notebook-share — prefix: nbshare_
module.exports = {
  en: {
    nbshare_navtitle: 'Import Homework',
    // sharer-hint: "N tasks"
    nbshare_hint: '{n} tasks',
    // org fallback when no org in payload
    nbshare_org_all: 'All groups',
    // empty state in payload
    nbshare_empty: 'No homework in this share — you can add your own after importing',
    // error states
    nbshare_err_nodata: 'No homework data found in this link',
    nbshare_err_corrupt: 'Share data is corrupted and cannot be read',
    // save button states
    nbshare_btn_saved: '✓ Saved',
    nbshare_btn_saving: 'Saving…',
    // save button: "Save {n} tasks"
    nbshare_btn_save: 'Save {n} tasks',
    // cancel / back button
    nbshare_btn_back: 'Back',
    // toast: no saveable tasks
    nbshare_toast_none: 'Nothing to save',
    // conflict action sheet items
    nbshare_conflict_replace: 'Replace duplicates (overwrite {dup} existing)',
    nbshare_conflict_rename: 'Rename duplicates (import as copies)',
    nbshare_conflict_skip: 'Skip duplicates (import {new} new only)',
    // toast when skip yields nothing
    nbshare_toast_skip_empty: 'No new tasks to add',
    // import result toasts
    nbshare_verb_replaced: 'Replaced',
    nbshare_verb_renamed: 'Renamed & imported',
    nbshare_verb_saved: 'Saved',
    // "{verb} {n} items" — assembled in JS
    nbshare_toast_done: '{verb} {n} items',
    // save failed
    nbshare_err_save: 'Save failed, please try again',
    // forward share card (no sharer nickname)
    nbshare_fwd_anon: 'A friend\'s shared homework',
    // forward share card (has nickname)
    nbshare_fwd_named: '{nickname}\'s shared homework',
    // fallback share card when no payload
    nbshare_fwd_fallback: 'Shared homework'
  },
  zh: {
    nbshare_navtitle: '导入作业',
    nbshare_hint: '共 {n} 项作业',
    nbshare_org_all: '全部组织',
    nbshare_empty: '分享里没有作业,导入后可以自己再添加',
    nbshare_err_nodata: '分享链接里没有作业数据',
    nbshare_err_corrupt: '分享数据已损坏，无法读取',
    nbshare_btn_saved: '✓ 已保存',
    nbshare_btn_saving: '保存中…',
    nbshare_btn_save: '💾 保存 {n} 项作业',
    nbshare_btn_back: '返回',
    nbshare_toast_none: '没有可保存的作业',
    nbshare_conflict_replace: '替换重复项(覆盖现有 {dup} 项)',
    nbshare_conflict_rename: '重命名重复项(加"（副本）"导入)',
    nbshare_conflict_skip: '跳过重复项(仅导入新增 {new} 项)',
    nbshare_toast_skip_empty: '没有可新增的作业',
    nbshare_verb_replaced: '已替换',
    nbshare_verb_renamed: '已重命名导入',
    nbshare_verb_saved: '已保存',
    nbshare_toast_done: '{verb} {n} 项',
    nbshare_err_save: '保存失败，请稍后再试',
    nbshare_fwd_anon: '好友分享给你的作业',
    nbshare_fwd_named: '{nickname} 分享给你的作业',
    nbshare_fwd_fallback: '作业分享'
  }
}
