// 新建/编辑作业页 pkg-notebook/task-edit
module.exports = {
  en: {
    // nav titles
    tedit_navtitle_new: 'New Homework',
    tedit_navtitle_edit: 'Edit Homework',
    tedit_navtitle_instance: 'Edit This Occurrence ({date})',

    // tab bar (new mode)
    tedit_tab_manual: 'Manual Entry',
    tedit_tab_ocr: 'Scan & Recognize',

    // field labels
    tedit_label_content: 'Content',
    tedit_label_subject: 'Subject',
    tedit_label_org: 'Organization',
    tedit_label_minutes: 'Est. time (min, optional)',
    tedit_label_actual: 'Actual time spent (min)',
    tedit_ph_actual: 'e.g. 25',
    tedit_label_type: 'Type',
    tedit_label_date: 'Date',
    tedit_label_start_date: 'Start date',
    tedit_label_end_date: 'End date (optional, blank = ongoing)',
    tedit_label_recur_freq: 'Repeat',
    tedit_label_weekdays: 'Days of week',

    // placeholders
    tedit_ph_content: 'e.g. Complete 2 pages of mental math',
    tedit_ph_minutes: 'e.g. 20',
    tedit_ph_date: 'Select',

    // infer hint
    tedit_infer_hint: 'Inferred "{subject}" from history (change above)',

    // est hint
    tedit_est_autofilled: 'Auto-filled {n} min from history — feel free to edit',
    tedit_est_hint: 'History estimate: ~{n} min',

    // mode options
    tedit_mode_oneshot: 'One-time',
    tedit_mode_recurring: 'Recurring',

    // recurrence type options
    tedit_recur_daily: 'Daily',
    tedit_recur_weekly: 'Weekly',

    // weekday labels (Mon–Sun)
    tedit_wd_1: 'Mon',
    tedit_wd_2: 'Tue',
    tedit_wd_3: 'Wed',
    tedit_wd_4: 'Thu',
    tedit_wd_5: 'Fri',
    tedit_wd_6: 'Sat',
    tedit_wd_7: 'Sun',

    // date picker: ongoing placeholder
    tedit_ongoing: 'Ongoing',

    // instance detach lock hint
    tedit_lock_hint: 'Editing this occurrence only — locked to one-time',

    // action buttons
    tedit_btn_save_edit: 'Save',
    tedit_btn_save_new: 'Add Homework',
    tedit_btn_delete: 'Delete',

    // toasts / modals
    tedit_toast_no_content: 'Please enter homework content',
    tedit_toast_detach_fail: 'Split failed',
    tedit_toast_detached: 'Saved as separate homework',
    tedit_toast_saved: 'Saved',
    tedit_toast_added: 'Added',
    tedit_toast_not_found: 'Homework not found',
    tedit_toast_deleted_once: 'Occurrence deleted',
    tedit_toast_deleted: 'Deleted',

    tedit_del_once_title: 'Delete this occurrence?',
    tedit_del_once_content: 'Only today\'s occurrence is deleted; future dates still appear.',
    tedit_del_title: 'Delete this homework?',
    tedit_del_content: 'Past completion records are kept, but this homework will no longer appear.',
    tedit_del_confirm_color: '#e54545',

    // clear button
    tedit_clear: 'Clear'
  },
  zh: {
    // nav titles
    tedit_navtitle_new: '新增作业',
    tedit_navtitle_edit: '编辑作业',
    tedit_navtitle_instance: '编辑此次 ({date})',

    // tab bar (new mode)
    tedit_tab_manual: '新增作业',
    tedit_tab_ocr: '拍照识别',

    // field labels
    tedit_label_content: '作业内容',
    tedit_label_subject: '学科',
    tedit_label_org: '组织',
    tedit_label_minutes: '预计耗时（分钟，可选）',
    tedit_label_actual: '实际用时（分钟）',
    tedit_ph_actual: '例：25',
    tedit_label_type: '类型',
    tedit_label_date: '日期',
    tedit_label_start_date: '开始日期',
    tedit_label_end_date: '结束日期（可选，留空 = 长期）',
    tedit_label_recur_freq: '重复频率',
    tedit_label_weekdays: '每周哪几天',

    // placeholders
    tedit_ph_content: '例：完成口算练习 2 页',
    tedit_ph_minutes: '例：20',
    tedit_ph_date: '请选择',

    // infer hint
    tedit_infer_hint: '根据历史推断「{subject}」（可在上方手动改）',

    // est hint
    tedit_est_autofilled: '已按历史预估 {n} 分钟，可改',
    tedit_est_hint: '历史预估约 {n} 分钟',

    // mode options
    tedit_mode_oneshot: '一次性',
    tedit_mode_recurring: '重复',

    // recurrence type options
    tedit_recur_daily: '每日',
    tedit_recur_weekly: '每周',

    // weekday labels (Mon–Sun)
    tedit_wd_1: '一',
    tedit_wd_2: '二',
    tedit_wd_3: '三',
    tedit_wd_4: '四',
    tedit_wd_5: '五',
    tedit_wd_6: '六',
    tedit_wd_7: '日',

    // date picker: ongoing placeholder
    tedit_ongoing: '长期',

    // instance detach lock hint
    tedit_lock_hint: '编辑此次:实例只能是一次性,无法切换为重复',

    // action buttons
    tedit_btn_save_edit: '保存修改',
    tedit_btn_save_new: '添加作业',
    tedit_btn_delete: '删除',

    // toasts / modals
    tedit_toast_no_content: '请填作业内容',
    tedit_toast_detach_fail: '拆分失败',
    tedit_toast_detached: '已拆出独立作业',
    tedit_toast_saved: '已保存',
    tedit_toast_added: '已添加',
    tedit_toast_not_found: '作业不存在',
    tedit_toast_deleted_once: '已删除此次',
    tedit_toast_deleted: '已删除',

    tedit_del_once_title: '删除此次?',
    tedit_del_once_content: '只删除当天这次,后续日期照常出现。',
    tedit_del_title: '删除这条作业?',
    tedit_del_content: '历史完成记录保留,但以后不再出现。',
    tedit_del_confirm_color: '#e54545',

    // clear button
    tedit_clear: '清除'
  }
}
