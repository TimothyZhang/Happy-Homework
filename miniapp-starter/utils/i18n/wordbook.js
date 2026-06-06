// 单词本详情页 pkg-notebook/word-book
module.exports = {
  en: {
    wbook_navtitle_fallback: 'Word Book',
    // ref banner
    wbook_anon: 'Anonymous',
    wbook_ref_count: 'Referenced {n} times',
    wbook_ref_sub: '🔗 Referenced from public library · Read-only, tap Update to get latest',
    wbook_ref_update: '🔄 Update',

    // add-word inputs
    wbook_cn_placeholder: 'Chinese (e.g. apple)',
    wbook_en_placeholder: 'English (phrase ok)',
    wbook_add_btn: 'Add',

    // tool buttons
    wbook_ocr_btn: '📷 Photo Import',
    wbook_share_btn: '🔗 Share with classmates',
    wbook_rename_btn: '✏️ Rename',
    wbook_copy_btn: '📋 Copy as editable',
    wbook_delete_btn: '🗑 Delete word book',

    // public switch
    wbook_public_label: '🌐 Publish to word library',
    wbook_public_on: 'Visible to others · Referenced {n} times',
    wbook_public_off: 'Others can search and copy (read-only, can\'t edit yours)',

    // count + empty
    wbook_count: '{n} words',
    wbook_empty: 'No words yet — add one above~',

    // word state badges
    wbook_state_mastered: '✓ Mastered',
    wbook_state_learning: 'Reviewing',
    wbook_state_needs_work: 'Needs work',
    wbook_state_new: 'New',

    // word row inline buttons
    wbook_word_edit: 'Edit',
    wbook_word_del: 'Del',

    // edit-word modal
    wbook_edit_title: 'Edit Word',
    wbook_edit_cn_placeholder: 'Chinese',
    wbook_edit_en_placeholder: 'English (phrase ok)',
    wbook_edit_cancel: 'Cancel',
    wbook_edit_save: 'Save',

    // OCR modal
    wbook_ocr_title: 'Found {n} words — import?',
    wbook_ocr_sub: 'Tap ✕ to remove unwanted entries',
    wbook_ocr_cancel: 'Cancel',
    wbook_ocr_import_btn: 'Import {n}',

    // JS toasts / modals
    wbook_toast_no_cloud_publish: 'Publishing unavailable here',
    wbook_toast_empty_publish: 'Can\'t publish an empty book',
    wbook_loading_publishing: 'Publishing…',
    wbook_toast_published: 'Published {n} words',
    wbook_toast_publish_fail: 'Publish failed',
    wbook_toast_publish_fail_retry: 'Publish failed, try again later',
    wbook_loading_unpublishing: 'Unpublishing…',
    wbook_toast_unpublished: 'Unpublished',
    wbook_toast_no_source: 'This book has no source',
    wbook_toast_no_cloud_sync: 'Sync unavailable here',
    wbook_loading_updating: 'Updating…',
    wbook_modal_source_gone_title: 'Original author has removed this',
    wbook_modal_source_gone_content: 'The source of this book has been withdrawn or deleted and can no longer be synced. Your copy still works normally.',
    wbook_modal_source_gone_ok: 'OK',
    wbook_toast_updated: 'Updated · {n} words',
    wbook_toast_update_fail: 'Update failed, try again later',
    wbook_toast_book_full: 'Word book limit reached (max {n})',
    wbook_toast_book_empty: 'This word book is empty',
    wbook_toast_copy_ok: 'Copied as editable',
    wbook_toast_copy_fail: 'Copy failed (may have hit the limit)',
    wbook_toast_both_required: 'Both Chinese and English are required',
    wbook_toast_save_fail: 'Save failed',
    wbook_toast_saved: 'Saved',
    wbook_toast_add_fail: 'Add failed',
    wbook_modal_rename_title: 'Rename Word Book',
    wbook_modal_rename_placeholder: 'New name',
    wbook_modal_delete_title: 'Delete Word Book',
    wbook_modal_delete_content: 'Delete "{name}"? All words will be removed and cannot be recovered.',
    wbook_modal_delete_confirm: 'Delete',
    wbook_modal_ocr_unavail_title: 'Recognition unavailable',
    wbook_modal_ocr_unavail_content: 'Cloud recognition not available here. Add words manually~',
    wbook_loading_uploading: 'Uploading image…',
    wbook_loading_recognizing: 'Recognizing…',
    wbook_modal_ocr_none_title: 'No words recognized',
    wbook_modal_ocr_none_content: 'Try a clearer photo with "Chinese English" pairs.',
    wbook_modal_ocr_fail_title: 'Recognition failed',
    wbook_modal_ocr_fail_content: 'Try again with a clearer image.',
    wbook_toast_imported: 'Imported {n} words',
    wbook_share_empty_title: 'Word challenge — join me!',
    wbook_share_title: '"{name}" word book · Word challenge!'
  },
  zh: {
    wbook_navtitle_fallback: '单词本',
    // ref banner
    wbook_anon: '匿名',
    wbook_ref_count: '被引用 {n} 次',
    wbook_ref_sub: '🔗 引用自公开库 · 只读,点更新拉作者最新内容',
    wbook_ref_update: '🔄 更新',

    // add-word inputs
    wbook_cn_placeholder: '中文(如:苹果)',
    wbook_en_placeholder: '英文(可短语)',
    wbook_add_btn: '添加',

    // tool buttons
    wbook_ocr_btn: '📷 拍照导入',
    wbook_share_btn: '🔗 分享给同学',
    wbook_rename_btn: '✏️ 改名',
    wbook_copy_btn: '📋 复制为可编辑',
    wbook_delete_btn: '🗑 删除单词本',

    // public switch
    wbook_public_label: '🌐 公开到单词库',
    wbook_public_on: '别人能搜到 · 已被引用 {n} 次',
    wbook_public_off: '打开后别人可搜索并添加(只读,改不到你的)',

    // count + empty
    wbook_count: '共 {n} 个',
    wbook_empty: '还没有单词,上面加一个吧~',

    // word state badges
    wbook_state_mastered: '✓ 掌握',
    wbook_state_learning: '复习中',
    wbook_state_needs_work: '需加强',
    wbook_state_new: '未学',

    // word row inline buttons
    wbook_word_edit: '改',
    wbook_word_del: '删',

    // edit-word modal
    wbook_edit_title: '修改单词',
    wbook_edit_cn_placeholder: '中文',
    wbook_edit_en_placeholder: '英文(可短语)',
    wbook_edit_cancel: '取消',
    wbook_edit_save: '保存',

    // OCR modal
    wbook_ocr_title: '识别到 {n} 个,确认导入?',
    wbook_ocr_sub: '点 ✕ 去掉不要的',
    wbook_ocr_cancel: '取消',
    wbook_ocr_import_btn: '导入这 {n} 个',

    // JS toasts / modals
    wbook_toast_no_cloud_publish: '当前环境用不了公开',
    wbook_toast_empty_publish: '空单词本不能公开',
    wbook_loading_publishing: '发布中…',
    wbook_toast_published: '已公开 {n} 词',
    wbook_toast_publish_fail: '发布失败',
    wbook_toast_publish_fail_retry: '发布失败,稍后再试',
    wbook_loading_unpublishing: '撤销中…',
    wbook_toast_unpublished: '已撤销公开',
    wbook_toast_no_source: '这个本没有来源',
    wbook_toast_no_cloud_sync: '当前环境用不了同步',
    wbook_loading_updating: '更新中…',
    wbook_modal_source_gone_title: '原作者已不再公开',
    wbook_modal_source_gone_content: '这个单词本的来源已被撤回或删除,无法再同步更新。你现在这本仍然可以正常使用。',
    wbook_modal_source_gone_ok: '知道了',
    wbook_toast_updated: '已更新 · {n} 词',
    wbook_toast_update_fail: '更新失败,稍后再试',
    wbook_toast_book_full: '自定义单词本已满(上限 {n} 个)',
    wbook_toast_book_empty: '这个单词本是空的',
    wbook_toast_copy_ok: '已复制为可编辑的本',
    wbook_toast_copy_fail: '复制失败(可能已达自定义上限)',
    wbook_toast_both_required: '中文和英文都要填',
    wbook_toast_save_fail: '保存失败',
    wbook_toast_saved: '已保存',
    wbook_toast_add_fail: '添加失败',
    wbook_modal_rename_title: '单词本改名',
    wbook_modal_rename_placeholder: '新名字',
    wbook_modal_delete_title: '删除单词本',
    wbook_modal_delete_content: '确定删除「{name}」?里面的单词会一起删掉,无法恢复。',
    wbook_modal_delete_confirm: '删除',
    wbook_modal_ocr_unavail_title: '识别不可用',
    wbook_modal_ocr_unavail_content: '当前环境用不了云识别,先手动加词吧~',
    wbook_loading_uploading: '上传图片…',
    wbook_loading_recognizing: '识别中…',
    wbook_modal_ocr_none_title: '没识别到单词',
    wbook_modal_ocr_none_content: '试着拍清楚点,保证图里有「中文 英文」成对的词。',
    wbook_modal_ocr_fail_title: '识别失败',
    wbook_modal_ocr_fail_content: '再试一次,或换张清楚点的图。',
    wbook_toast_imported: '已导入 {n} 个',
    wbook_share_empty_title: '一起来单词挑战',
    wbook_share_title: '「{name}」单词本 · 来场单词挑战'
  }
}
