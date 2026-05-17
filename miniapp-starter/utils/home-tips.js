// Pet-bubble tip helpers for pages/home. Pulled into its own module so the
// pure formatters can be exercised by scripts/values-check.js without having
// to mock the Page() shell.

const store = require('./store')

// Internal helper: "1 小时 20 分" / "30 分" / "1 小时" / "不到 1 分".
// 不写 "0 小时 30 分" — 1 小时以下只写分。totalMinutes 0/负数走"不到 1 分"
// 兜底,理论上不会触发(actualMinutes 都 ≥ 1)但保留分支以防数据异常。
function formatSpentTime(totalMinutes) {
  if (!totalMinutes || totalMinutes < 1) return '不到 1 分'
  if (totalMinutes < 60) return `${totalMinutes} 分`
  const h = Math.floor(totalMinutes / 60)
  const m = totalMinutes % 60
  if (m === 0) return `${h} 小时`
  return `${h} 小时 ${m} 分`
}

// Used by the home page to format "still N tasks left" / "all done!" copy.
// remainingMinutes is the sum of estimatedMinutes for undone items; we use
// the existing "X 小时" / "Xh Ym" format the page already shipped with.
function formatDuration(minutes) {
  if (!minutes || minutes < 0) return '—'
  if (minutes < 60) return `${minutes} 分钟`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (m === 0) return `${h} 小时`
  return `${h}h${m}m`
}

function buildPetMessage(ctx) {
  const { isToday, totalCount, pendingCount, remainingMinutes, coinsToday, totalDoneMinutes } = ctx
  const timeStr = remainingMinutes > 0 ? formatDuration(remainingMinutes) : ''

  if (isToday) {
    if (totalCount === 0) return '今天还没有作业安排，可以陪我玩一会儿～'
    if (pendingCount === 0) {
      // All-done celebration — fold time + coins into the one line so the
      // bubble doesn't need a separate stats tip. totalDoneMinutes < 1 / 没金币
      // 时回落到更简单的版本,避免"共耗时 不到 1 分，获得 0 金币 🎉"那种尬话。
      if (totalDoneMinutes >= 1 && coinsToday > 0) {
        return `太棒了，今天的作业全部完成啦！共耗时 ${formatSpentTime(totalDoneMinutes)}，获得 ${coinsToday} 金币 🎉`
      }
      if (coinsToday > 0) {
        return `太棒了，今天的作业全部完成啦！获得 ${coinsToday} 金币 🎉`
      }
      return '太棒了，今天的作业全部完成啦！🎉'
    }
    if (pendingCount === 1) {
      return timeStr
        ? `就剩最后 1 项啦，预计 ${timeStr}，冲呀～`
        : '就剩最后 1 项啦，冲呀～'
    }
    if (timeStr) {
      return `今天还有 ${pendingCount} 项作业，预计还需 ${timeStr}，加油哦～`
    }
    return `今天还有 ${pendingCount} 项作业，加油哦～`
  }

  if (totalCount === 0) return '这一天没有安排作业'
  if (pendingCount === 0) return `这天的 ${totalCount} 项作业都完成啦`
  return `这天还有 ${pendingCount} 项作业没完成`
}

// Rotating pet-bubble tip list. First entry is always the contextual progress
// message (`buildPetMessage`). All-done 分支不再 push 第二条 stats tip —— 时长
// + 金币的信息已经被 buildPetMessage 合进 celebration 那一行。Pending 分支照旧
// 追加 early-bird projection + 开心度提示。
function buildPetTips(ctx) {
  const tips = [buildPetMessage(ctx)]
  if (!ctx.isToday || ctx.pendingCount === 0) return tips
  const b = store.earlyBirdBonus()
  if (b >= 50 && ctx.projected19 > 0) tips.push(`🏆 19:00 前完成所有作业，可获得 ${ctx.projected19} 金币`)
  if (b >= 30 && ctx.projected20 > 0) tips.push(`⏱ 20:00 前完成所有作业，可获得 ${ctx.projected20} 金币`)
  if (b >= 20 && ctx.projected21 > 0) tips.push(`⏰ 21:00 前完成所有作业，可获得 ${ctx.projected21} 金币`)
  tips.push('💖 想加开心度？去宠物商店买玩具球 / 礼物盒')
  return tips
}

module.exports = {
  formatSpentTime,
  formatDuration,
  buildPetMessage,
  buildPetTips
}
