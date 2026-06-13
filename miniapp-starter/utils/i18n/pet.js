// 宠物页 pages/pet
module.exports = {
  en: {
    // nav
    pet_navtitle: 'My Pet',

    // setup screen
    pet_setup_title: 'Choose a pet to raise',
    pet_setup_sub: 'It will keep you company while you do homework every day',
    pet_setup_name_label: 'Give it a name',
    pet_setup_name_placeholder: 'e.g. Buddy',
    pet_setup_confirm: 'Yes, this one!',

    // room poster
    pet_poster_line1: 'Study Hard',
    pet_poster_line2: 'Every Day',

    // desk hint
    pet_desk_hint: '📖 Study',

    // top HUD
    pet_hud_coins: 'Coins {n}',
    pet_hud_shop: '⚙️ Settings',
    pet_hud_levelup: '⬆️ Level Up',

    // status HUD
    pet_age_days: '{n} days old',
    pet_vocab: '📚 Vocab {n}',
    pet_stat_happiness: 'Happy',
    pet_stat_fullness: 'Full',
    pet_stat_cleanliness: 'Clean',
    pet_stat_health: 'Health',
    pet_stat_effort: 'Effort',

    // switch species panel
    pet_switch_title: 'Choose a new pet',
    pet_switch_sub: '{cost} coins · you have {coins}',
    pet_switch_current_tag: 'Current',
    pet_switch_cancel: 'Cancel',

    // desk (study) menu
    pet_desk_menu_title: '📚 Study Corner',
    pet_desk_recite: 'Word Challenge',
    pet_desk_dictation: 'Dictation',
    pet_desk_no_recite: "Today's challenges are done, come back tomorrow~",
    pet_desk_wordbooks: 'My Word Books',

    // shop panel
    pet_shop_panel_title: '⚙️ Settings',
    pet_shop_panel_coins: 'Coins {n}',
    pet_shop_section_care: 'Spend coins to care for it',
    pet_shop_section_manage: 'Manage',
    pet_shop_buy_btn: '{price} coins',
    pet_shop_close: 'Close',

    // shop manage items
    pet_manage_rename_title: 'Rename Pet',
    pet_manage_rename_sub: '{cost} coins to rename, old name will be cleared',
    pet_manage_switch_title: 'Change Pet',
    pet_manage_switch_sub: '{cost} coins to change species, stats and name are kept',
    pet_manage_room_title: 'Change Room',
    pet_manage_room_sub_castle: 'Current: Castle · free',
    pet_manage_room_sub_cozy: 'Current: Cozy Home · free',

    // room picker
    pet_room_picker_title: 'Choose a background',
    pet_room_cozy: 'Cozy Home',
    pet_room_castle: 'Castle',
    pet_room_tag_current: 'Current',
    pet_room_tag_select: 'Select',
    pet_room_picker_close: 'Close',

    // toasts & modals — setup
    pet_toast_pick_species: 'Choose a pet first',
    pet_toast_enter_name: 'Give it a name',
    pet_toast_hello: 'Hello, {name}!',

    // toasts — room
    pet_toast_room_castle: 'Switched to Castle',
    pet_toast_room_cozy: 'Switched to Cozy Home',

    // toasts — shop/buy
    pet_toast_not_enough_coins: 'Not enough coins',
    pet_toast_bought: '{name} purchased',

    // toasts — level up
    pet_toast_xp_needed: 'Need {n} more XP',
    pet_toast_max_level: 'Already max level!',

    // rename modal
    pet_rename_modal_title: 'Rename ({cost} coins)',
    pet_rename_placeholder: 'Enter a new name for your pet',
    pet_rename_confirm: 'OK',
    pet_rename_cancel: 'Cancel',
    pet_toast_rename_empty: 'Name cannot be empty',
    pet_toast_rename_success: 'Renamed to {name}!',
    pet_toast_rename_too_long: 'Name cannot exceed {max} characters',
    pet_toast_rename_no_coins: 'Not enough coins, need {cost}',
    pet_toast_no_pet: 'No pet yet',

    // switch modal
    pet_switch_modal_title: 'Change Pet',
    pet_switch_modal_content: 'Spend {cost} coins to switch to {emoji} {label}? Stats, level, and name are all kept.',
    pet_switch_modal_confirm: 'Confirm',
    pet_switch_modal_cancel: 'Cancel',
    pet_toast_switch_success: 'Switched to {emoji} {label}!',
    pet_toast_switch_no_coins: 'Not enough coins, need {cost}',

    // speaking lines
    pet_speak_hungry_1: "I'm hungry…",
    pet_speak_hungry_2: 'My tummy is empty…',
    pet_speak_dirty_1: 'I want a bath~',
    pet_speak_dirty_2: 'Give me some bubbles!',
    pet_speak_sick_1: "Not feeling great… need medicine",
    pet_speak_sick_2: "I'm a little dizzy…",
    pet_speak_sad_1: 'Keep me company?',
    pet_speak_sad_2: "Feeling a bit blue today",
    pet_speak_happy_1: 'I love you so much!',
    pet_speak_happy_2: 'What a beautiful day!',
    pet_speak_happy_3: 'Hehe~',
    pet_speak_idle_1: "How's your day going?",
    pet_speak_idle_2: 'Miss me?',
    pet_speak_idle_3: "Let's keep it up~",

    // shown when today's homework isn't done yet (pet stays put, won't play)
    pet_busy_homework: 'Finish your homework first, then come play~',

    // furniture interaction lines (tap a furniture → pet walks over & says this)
    pet_furni_tv: 'Cartoon time~ 📺',
    pet_furni_sofa: 'So comfy on the sofa~',
    pet_furni_bed: 'So sleepy… just a little nap 💤',
    pet_furni_table: 'Yum, dinner time!',
    pet_furni_bath: 'Bath time — splashy bubbles~',
    pet_furni_toilet: 'Be right back…',
    pet_furni_cooldown: 'Just used this — come back in {t}',
    pet_furni_cd_h: '{n}h',
    pet_furni_cd_min: '{n}min',
    pet_furni_free: '✨ Free use',
    pet_furni_menu_shop: 'Buy items (instant, bigger boost)',
    pet_furni_freeitem_tv: '✨ Watch a bit',
    pet_furni_freeitem_sofa: '✨ Lounge a bit',
    pet_furni_freeitem_playground: '✨ Play a bit',
    pet_furni_freeitem_bed: '✨ Take a nap',
    pet_furni_freeitem_table: '✨ Home meal',
    pet_furni_freeitem_bath: '✨ Quick rinse',
    pet_furni_freeitem_toilet: '✨ Quick break',
    pet_furni_act_tv: 'Watch TV',
    pet_furni_act_sofa: 'Relax',
    pet_furni_act_playground: 'Play',
    pet_furni_act_bed: 'Sleep',
    pet_furni_act_table: 'Feed',
    pet_furni_act_bath: 'Bath',
    pet_furni_act_toilet: 'Toilet',

    // species labels (data-defined in store.js, translated here)
    pet_species_cat: 'Cat',
    pet_species_dog: 'Dog',
    pet_species_chicken: 'Chick',
    pet_species_parrot: 'Parrot',
    pet_species_pig: 'Pig',
    pet_species_cow: 'Cow',
    pet_species_rabbit: 'Rabbit',
    pet_species_sheep: 'Sheep',
    pet_species_alpaca: 'Alpaca',

    // shop item names (data-defined in store.js, translated here)
    pet_item_name_1: 'Carrot',
    pet_item_name_2: 'Bento Box',
    pet_item_name_3: 'Soap',
    pet_item_name_4: 'Bubble Bath',
    pet_item_name_5: 'Toy Ball',
    pet_item_name_6: 'Vitamins',
    pet_item_name_7: 'Gym Session',
    pet_item_name_8: 'Gift Box',

    // shop item effects (data-defined in store.js, translated here)
    pet_item_effect_1: 'Fullness +30',
    pet_item_effect_2: 'Fullness +50',
    pet_item_effect_3: 'Cleanliness +30',
    pet_item_effect_4: 'Cleanliness +60',
    pet_item_effect_5: 'Happiness +30',
    pet_item_effect_6: 'Health +25',
    pet_item_effect_7: 'Health +55',
    pet_item_effect_8: 'Happiness +50'
  },
  zh: {
    // nav
    pet_navtitle: '电子宠物',

    // setup screen
    pet_setup_title: '选一只想养的宠物吧',
    pet_setup_sub: '陪你一起完成作业，每天都会和你互动哦',
    pet_setup_name_label: '取个名字',
    pet_setup_name_placeholder: '比如：豆豆',
    pet_setup_confirm: '确定，就是它！',

    // room poster
    pet_poster_line1: '好好学习',
    pet_poster_line2: '天天向上',

    // desk hint
    pet_desk_hint: '📖 背单词',

    // top HUD
    pet_hud_coins: '金币 {n}',
    pet_hud_shop: '⚙️ 设置',
    pet_hud_levelup: '⬆️ 可升级',

    // status HUD
    pet_age_days: '{n} 天大',
    pet_vocab: '📚 词汇量 {n}',
    pet_stat_happiness: '开心',
    pet_stat_fullness: '饱腹',
    pet_stat_cleanliness: '清洁',
    pet_stat_health: '健康',
    pet_stat_effort: '努力',

    // switch species panel
    pet_switch_title: '选一只想换的',
    pet_switch_sub: '花 {cost} 金币 · 当前 {coins}',
    pet_switch_current_tag: '当前',
    pet_switch_cancel: '取消',

    // desk (study) menu
    pet_desk_menu_title: '📚 学习角',
    pet_desk_recite: '单词挑战',
    pet_desk_dictation: '听写单词',
    pet_desk_no_recite: '今天挑战 / 听写次数用完啦,明天再来~',
    pet_desk_wordbooks: '我的单词本',

    // shop panel
    pet_shop_panel_title: '⚙️ 设置',
    pet_shop_panel_coins: '金币 {n}',
    pet_shop_section_care: '用金币照顾它',
    pet_shop_section_manage: '管理',
    pet_shop_buy_btn: '{price} 金币',
    pet_shop_close: '关闭',

    // shop manage items
    pet_manage_rename_title: '改宠物名字',
    pet_manage_rename_sub: '{cost} 金币更改名字，旧名字会被清空',
    pet_manage_switch_title: '换宠物',
    pet_manage_switch_sub: '{cost} 金币更换种类，属性和名字都保留',
    pet_manage_room_title: '换房间背景',
    pet_manage_room_sub_castle: '当前:城堡 · 免费切换',
    pet_manage_room_sub_cozy: '当前:温馨小屋 · 免费切换',

    // room picker
    pet_room_picker_title: '选个房间背景',
    pet_room_cozy: '温馨小屋',
    pet_room_castle: '城堡',
    pet_room_tag_current: '当前',
    pet_room_tag_select: '选它',
    pet_room_picker_close: '关闭',

    // toasts & modals — setup
    pet_toast_pick_species: '选一只想养的吧',
    pet_toast_enter_name: '给它起个名字吧',
    pet_toast_hello: '你好，{name}！',

    // toasts — room
    pet_toast_room_castle: '已换成城堡',
    pet_toast_room_cozy: '已换成温馨小屋',

    // toasts — shop/buy
    pet_toast_not_enough_coins: '金币不够',
    pet_toast_bought: '{name} 已购买',

    // toasts — level up
    pet_toast_xp_needed: '还差 {n} XP',
    pet_toast_max_level: '已经满级啦',

    // rename modal
    pet_rename_modal_title: '改名（{cost} 金币）',
    pet_rename_placeholder: '给宠物起个新名字',
    pet_rename_confirm: '确定',
    pet_rename_cancel: '取消',
    pet_toast_rename_empty: '名字不能为空',
    pet_toast_rename_success: '改名成功！现在叫 {name} 啦~',
    pet_toast_rename_too_long: '名字不能超过 {max} 个字',
    pet_toast_rename_no_coins: '金币不足，需要 {cost}',
    pet_toast_no_pet: '还没有宠物',

    // switch modal
    pet_switch_modal_title: '换宠物',
    pet_switch_modal_content: '花 {cost} 金币换成 {emoji} {label} 吗？属性、等级和名字都会保留。',
    pet_switch_modal_confirm: '确认',
    pet_switch_modal_cancel: '取消',
    pet_toast_switch_success: '换成 {emoji} {label} 啦！',
    pet_toast_switch_no_coins: '金币不足，需要 {cost}',

    // speaking lines
    pet_speak_hungry_1: '我饿了…要吃东西啦',
    pet_speak_hungry_2: '咕噜咕噜，肚子空空的',
    pet_speak_dirty_1: '我想洗澡澡了～',
    pet_speak_dirty_2: '快帮我搓个泡泡浴',
    pet_speak_sick_1: '不太舒服…想吃药',
    pet_speak_sick_2: '我有点头晕…',
    pet_speak_sad_1: '陪陪我嘛',
    pet_speak_sad_2: '今天有点闷闷的',
    pet_speak_happy_1: '好喜欢你呀！',
    pet_speak_happy_2: '今天天气真好！',
    pet_speak_happy_3: '嘻嘻嘻～',
    pet_speak_idle_1: '今天过得怎么样呀？',
    pet_speak_idle_2: '想我了吗？',
    pet_speak_idle_3: '一起加油哦～',

    // 今天作业还没做完时(宠物待在原地、不玩)
    pet_busy_homework: '做完作业再来玩哦~',

    // furniture interaction lines
    pet_furni_tv: '看会儿动画~ 📺',
    pet_furni_sofa: '瘫在沙发上好舒服~',
    pet_furni_bed: '好困…眯一会儿 💤',
    pet_furni_table: '开饭啦,好香!',
    pet_furni_bath: '泡澡咯,搓搓泡泡~',
    pet_furni_toilet: '我去趟厕所…',
    pet_furni_cooldown: '刚用过~ {t}后再来',
    pet_furni_cd_h: '{n} 小时',
    pet_furni_cd_min: '{n} 分钟',
    pet_furni_free: '✨ 免费用一下',
    pet_furni_menu_shop: '买道具(即时回更多)',
    pet_furni_freeitem_tv: '✨ 看会儿电视',
    pet_furni_freeitem_sofa: '✨ 瘫一会儿',
    pet_furni_freeitem_playground: '✨ 玩会儿滑梯',
    pet_furni_freeitem_bed: '✨ 睡个午觉',
    pet_furni_freeitem_table: '✨ 吃口家常饭',
    pet_furni_freeitem_bath: '✨ 冲个凉',
    pet_furni_freeitem_toilet: '✨ 方便一下',
    pet_furni_act_tv: '看电视',
    pet_furni_act_sofa: '休息一下',
    pet_furni_act_playground: '玩耍',
    pet_furni_act_bed: '睡觉',
    pet_furni_act_table: '喂饭',
    pet_furni_act_bath: '洗澡',
    pet_furni_act_toilet: '上厕所',

    // species labels (data-defined in store.js, translated here)
    pet_species_cat: '猫',
    pet_species_dog: '狗',
    pet_species_chicken: '鸡',
    pet_species_parrot: '鹦鹉',
    pet_species_pig: '猪',
    pet_species_cow: '牛',
    pet_species_rabbit: '兔子',
    pet_species_sheep: '羊',
    pet_species_alpaca: '羊驼',

    // shop item names (data-defined in store.js, translated here)
    pet_item_name_1: '营养胡萝卜',
    pet_item_name_2: '丰盛便当',
    pet_item_name_3: '香皂',
    pet_item_name_4: '泡泡浴',
    pet_item_name_5: '玩具球',
    pet_item_name_6: '维生素',
    pet_item_name_7: '健身房一次',
    pet_item_name_8: '礼物盒',

    // shop item effects (data-defined in store.js, translated here)
    pet_item_effect_1: '饱腹+30',
    pet_item_effect_2: '饱腹+50',
    pet_item_effect_3: '清洁+30',
    pet_item_effect_4: '清洁+60',
    pet_item_effect_5: '开心+30',
    pet_item_effect_6: '健康+25',
    pet_item_effect_7: '健康+55',
    pet_item_effect_8: '开心+50'
  }
}
