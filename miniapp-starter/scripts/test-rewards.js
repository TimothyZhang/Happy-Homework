'use strict'

// 奖励 / 金币账本回归测试。29 个断言,覆盖:
//   - finishTask 单题奖、daily-perfect base、early-bird、weekly streak
//   - addTask / importSharedNotebook 触发的 perfectDay 回收(reconcilePerfectDays)
//   - revertTask 同时退单题奖 + 回收当日完美奖
//   - DAILY_COMPLETION_CAP 与回收循环交互
//   - 宠物 buyItem / levelUpPet 走 applyCoinDelta
//   - applyHydratedState 把 pendingCoinEvents 的 delta 加回乐观本地余额
//
// 何时跑:任何 store.js / cloud-sync.js / coin-ledger.js / coinLedger 云函数
// 的改动之后都要跑一遍。Tim 不测试,这步是 claude 的责任:
//
//   node miniapp-starter/scripts/test-rewards.js
//
// 跑不通 → 改完再跑,直到 29/29。失败要在汇报里如实写,不要"应该 OK"糊弄。
//
// 实现细节:stub 了 wx 的 storage 和 cloud 占位,store.js 在 Node 端能跑通
// 整个 updateState 路径。不连真实云数据库,测的是客户端逻辑 + pendingCoinEvents
// 队列内容,服务端账本一致性需要部署联调验证。

global.wx = {
  _store: {},
  getStorageSync(k) { return this._store[k] || null },
  setStorageSync(k, v) { this._store[k] = v },
  removeStorageSync(k) { delete this._store[k] },
  getSystemInfoSync: () => ({}),
  cloud: { init: () => {}, callFunction: () => Promise.resolve({ result: {} }), database: () => null }
}

// Pin "now" to 22:00 so reward assertions don't drift with wall-clock time.
// 22:00 is past 21:00 → earlyBirdBonus = 0, simplifying expected math. Tests
// that need a specific tier (e.g. ≥+20 early-bird) call setNowHour() explicitly.
const _realDateNow = Date.now
function setNowHour(h, m) {
  const d = new Date()
  d.setHours(h, m || 0, 0, 0)
  const fixed = d.getTime()
  Date.now = () => fixed
}
setNowHour(22, 0)

const path = require('path')
const s = require(path.join(__dirname, '..', 'utils', 'store.js'))

let failed = 0
let passed = 0
function assert(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   -', name) }
  else { failed++; console.log('  FAIL -', name, detail ? `(${detail})` : '') }
}

function seed(stateOverride) {
  wx._store = {}
  s.applyHydratedState({
    coins: 0,
    streakDays: 0,
    perfectDays: [],
    bonusByDay: {},
    completionsByDay: {},
    tasks: [],
    notebooks: [],
    pet: null,
    lastReward: null,
    profile: null,
    ...stateOverride
  })
}

function st() { return s.getStateWithComputed() }
function pendingLast(n) {
  const q = (st().pendingCoinEvents || []).slice(-n)
  return q.map((e) => ({ kind: e.kind, delta: e.delta, reason: e.meta && e.meta.reason }))
}

const today = s.todayStr()
const yesterday = s.addDays(today, -1)
const tomorrow = s.addDays(today, 1)

// ===== Scenario 1: legitimate happy path =====
console.log('\n[1] Happy path: 1-shot notebook with 3 tasks, all done in order')
const nb1 = { id: 'nb1', name: today, mode: 'one-shot', startDate: today, endDate: today, recurrence: null, createdAt: 1, order: 0 }
seed({ notebooks: [nb1], coins: 100 })
s.addTask({ notebookId: 'nb1', subject: '语', content: 'a', estimatedMinutes: 5 })
s.addTask({ notebookId: 'nb1', subject: '数', content: 'b', estimatedMinutes: 5 })
s.addTask({ notebookId: 'nb1', subject: '英', content: 'c', estimatedMinutes: 5 })
let tasks = st().tasks
s.finishTask(tasks[0].id, today)
s.finishTask(tasks[1].id, today)
const before3 = st().coins
s.finishTask(tasks[2].id, today)
const after3 = st().coins
assert('all done → perfectDays has today', st().perfectDays.length === 1 && st().perfectDays[0] === today)
assert('streakDays = 1', st().streakDays === 1)
assert('final reward includes daily bonus', after3 - before3 >= 10 + 30) // task + base ≥ 30
assert('all events are task_reward', pendingLast(3).every((e) => e.kind === 'task_reward'))

// ===== Scenario 2: exploit attempt — add 1 task, complete, add more =====
console.log('\n[2] Exploit attempt: 1 task → complete (perfect+early bird) → add 2 more')
// Pin to 18:00 for this scenario so early-bird tier kicks in (+50). Switch
// back to 22:00 at the end so subsequent scenarios run at the default tier.
setNowHour(18, 0)
seed({ notebooks: [nb1], coins: 100 })
s.addTask({ notebookId: 'nb1', subject: '语', content: 'x', estimatedMinutes: 5 })
let t = st().tasks[0]
s.finishTask(t.id, today)
const exploitFirstCoins = st().coins
const firstBonus = st().bonusByDay[today].dailyBonus
assert('first finish gets perfect + early bird', firstBonus >= 10 + 20 && st().perfectDays[0] === today, `dailyBonus=${firstBonus}`)

s.addTask({ notebookId: 'nb1', subject: '数', content: 'y', estimatedMinutes: 5 })
assert('addTask revokes perfectDays', st().perfectDays.length === 0)
assert('addTask drops streakDays back to 0', st().streakDays === 0)
assert('addTask clears bonusByDay[today]', !st().bonusByDay[today])
assert('coins clawed back via task_refund', st().coins === exploitFirstCoins - firstBonus)
assert('pendingCoinEvents tail = clawback', pendingLast(1)[0].kind === 'task_refund' && pendingLast(1)[0].reason === 'perfect_day_clawback')

// Add a third task; should NOT add a second refund event (already not-perfect).
const refundCountBefore = st().pendingCoinEvents.filter((e) => e.kind === 'task_refund').length
s.addTask({ notebookId: 'nb1', subject: '英', content: 'z', estimatedMinutes: 5 })
const refundCountAfter = st().pendingCoinEvents.filter((e) => e.kind === 'task_refund').length
assert('second addTask is no-op for revoke (not currently perfect)', refundCountAfter === refundCountBefore)

// Complete the remaining 2 → re-award daily bonus with new (3-task) base.
const t2 = st().tasks.find((x) => x.subject === '数')
const t3 = st().tasks.find((x) => x.subject === '英')
s.finishTask(t2.id, today)
const midCoins = st().coins
assert('first re-finish doesn\'t award daily bonus yet (1 of 2 remaining done)', st().perfectDays.length === 0)
s.finishTask(t3.id, today)
assert('after final re-finish, perfectDays restored', st().perfectDays[0] === today)
assert('streakDays back to 1', st().streakDays === 1)
const reCreditedBonus = st().bonusByDay[today].dailyBonus
assert('re-credited base = sum of 3 rewardPaid + early-bird ≥ original', reCreditedBonus >= firstBonus, `re=${reCreditedBonus} orig=${firstBonus}`)
assert('no double-credit: bonus log has only one entry per day', Object.keys(st().bonusByDay).length === 1)
// Restore default 22:00 (no early-bird) for downstream scenarios.
setNowHour(22, 0)

// ===== Scenario 3: future-day task should NOT revoke today =====
console.log('\n[3] Add task scheduled for tomorrow → today\'s perfect day intact')
seed({
  notebooks: [],
  coins: 200,
  perfectDays: [today],
  bonusByDay: { [today]: { dailyBonus: 60, weeklyBonus: 0, prevStreakDays: 0 } },
  streakDays: 1,
  tasks: [{
    id: 'tk_done', subject: '语', organization: '其他', content: 'old', estimatedMinutes: 5,
    mode: 'one-shot', startDate: today, endDate: today, recurrence: null,
    order: 0, createdAt: 1, status: 'done', accumulatedMs: 60000, completedAt: 2,
    actualMinutes: 1, currentSegmentStartedAt: null, rewardPaid: 10, rewardKind: 'today'
  }]
})
const baselineCoins = st().coins
s.addTask({ subject: '数', content: 'future', estimatedMinutes: 5, mode: 'one-shot', startDate: tomorrow, endDate: tomorrow })
assert('today\'s perfect day untouched', st().perfectDays[0] === today)
assert('coins not clawed back', st().coins === baselineCoins)
assert('streakDays stays 1', st().streakDays === 1)

// ===== Scenario 4: revertTask still works through ledger =====
console.log('\n[4] Revert a finished task → refund + revoke if it broke perfect')
seed({ notebooks: [nb1], coins: 100 })
s.addTask({ notebookId: 'nb1', subject: '语', content: 'only', estimatedMinutes: 5 })
const onlyId = st().tasks[0].id
s.finishTask(onlyId, today)
const afterFinish = st().coins
const dailyBonusAfter = st().bonusByDay[today].dailyBonus
s.revertTask(onlyId, today)
assert('revert wiped perfectDays', st().perfectDays.length === 0)
assert('revert clawed back per-task + bonus (net 0)', st().coins === afterFinish - 10 - dailyBonusAfter)
// Two refund events: one for per-task, one for perfect-day clawback.
const refundEvents = st().pendingCoinEvents.filter((e) => e.kind === 'task_refund').slice(-2)
assert('revert emitted task_refund (task_revert + perfect_day_clawback)',
  refundEvents.length === 2 &&
  refundEvents.some((e) => e.meta && e.meta.reason === 'task_revert') &&
  refundEvents.some((e) => e.meta && e.meta.reason === 'perfect_day_clawback'))

// ===== Scenario 4b: revertTask on an older perfect day → streakDays recomputed =====
// 之前的 bug:revokePerfectDay 直接 state.streakDays = log.prevStreakDays,
// 在用户回退一个非"最近"的 perfect 日时会把 streak 错写成那天被记入前的值。
// 修复后:从剩下的 perfectDays 重新算 trailing consecutive run。
console.log('\n[4b] Revert older perfect day → streakDays recomputed from remaining perfectDays')
const d1 = s.addDays(today, -3)
const d2 = s.addDays(today, -2)
const d3 = s.addDays(today, -1)
// 模拟一个 4 天 streak(d1→d2→d3→today),挑 d1(最早)那天 revert。
// 直接 seed perfectDays + bonusByDay + 一个 done 的 task 在 d1。
seed({
  notebooks: [nb1],
  coins: 1000,
  perfectDays: [d1, d2, d3, today],
  streakDays: 4,
  bonusByDay: {
    [d1]: { dailyBonus: 10, weeklyBonus: 0, prevStreakDays: 0 },
    [d2]: { dailyBonus: 10, weeklyBonus: 0, prevStreakDays: 1 },
    [d3]: { dailyBonus: 10, weeklyBonus: 0, prevStreakDays: 2 },
    [today]: { dailyBonus: 10, weeklyBonus: 0, prevStreakDays: 3 }
  },
  tasks: [{
    id: 'tk_d1', notebookId: 'nb1', subject: '语', content: 'old', estimatedMinutes: 5,
    order: 0, createdAt: 1, status: 'done', accumulatedMs: 60000,
    completedAt: new Date(d1 + 'T20:00:00').getTime(),
    actualMinutes: 1, currentSegmentStartedAt: null, rewardPaid: 10, rewardKind: 'today'
  }]
})
s.revertTask('tk_d1', d1)
// d1 被踢出 perfectDays;剩下 [d2, d3, today],3 个连续 → streakDays = 3
assert('older revert: perfectDays no longer contains d1', !st().perfectDays.includes(d1))
assert('older revert: streakDays recomputed to 3 (d2+d3+today)',
  st().streakDays === 3, `streakDays=${st().streakDays}`)

// ===== Scenario 4c: revert a middle perfect day → streak breaks =====
// 4 天 streak,revert 中间的 d2 → 剩 [d1, d3, today] → 因为 d2 缺失,
// d3+today 连续但 d1 断开 → trailing run = 2(d3+today)
console.log('\n[4c] Revert middle perfect day → streak breaks at gap')
seed({
  notebooks: [nb1],
  coins: 1000,
  perfectDays: [d1, d2, d3, today],
  streakDays: 4,
  bonusByDay: {
    [d1]: { dailyBonus: 10, weeklyBonus: 0, prevStreakDays: 0 },
    [d2]: { dailyBonus: 10, weeklyBonus: 0, prevStreakDays: 1 },
    [d3]: { dailyBonus: 10, weeklyBonus: 0, prevStreakDays: 2 },
    [today]: { dailyBonus: 10, weeklyBonus: 0, prevStreakDays: 3 }
  },
  tasks: [{
    id: 'tk_d2', notebookId: 'nb1', subject: '语', content: 'mid', estimatedMinutes: 5,
    order: 0, createdAt: 1, status: 'done', accumulatedMs: 60000,
    completedAt: new Date(d2 + 'T20:00:00').getTime(),
    actualMinutes: 1, currentSegmentStartedAt: null, rewardPaid: 10, rewardKind: 'today'
  }]
})
s.revertTask('tk_d2', d2)
assert('mid revert: perfectDays no longer contains d2', !st().perfectDays.includes(d2))
assert('mid revert: streakDays = 2 (d3+today, gap at d2)',
  st().streakDays === 2, `streakDays=${st().streakDays}`)

// ===== Scenario 5: DAILY_COMPLETION_CAP holds with reconcile loop =====
console.log('\n[5] 20-task cap + perfect-day revoke + complete still pays bonus exactly once')
seed({ notebooks: [nb1], coins: 0 })
for (let i = 0; i < 5; i++) {
  s.addTask({ notebookId: 'nb1', subject: '语', content: 'x' + i, estimatedMinutes: 1 })
}
const fiveIds = st().tasks.map((t) => t.id)
for (const id of fiveIds) s.finishTask(id, today)
const firstPass = st().coins
assert('5 tasks done → perfectDays has today', st().perfectDays.length === 1)
// Add a 6th task → revoke, complete → re-award with 6-task base.
s.addTask({ notebookId: 'nb1', subject: '语', content: 'x5', estimatedMinutes: 1 })
const sixth = st().tasks.find((t) => t.content === 'x5')
s.finishTask(sixth.id, today)
const sixCoins = st().coins
assert('6th cycle restores perfectDays', st().perfectDays[0] === today)
assert('coins increased', sixCoins > firstPass)

// ===== Scenario 6: pet purchase / level-up / skin switch all queue events =====
console.log('\n[6] Pet purchases queue pet_purchase / level_upgrade / pet_skin_switch events')
seed({ coins: 5000, pet: { species: 'sheep', name: '阿羊', level: 1, growth: 0, happiness: 50, fullness: 50, cleanliness: 50, health: 100, createdAt: Date.now(), lastUpdatedAt: Date.now() } })
const shopItems = st().shopItems
if (Array.isArray(shopItems) && shopItems.length > 0) {
  const affordable = shopItems.find((it) => it.price <= 50)
  if (affordable) {
    s.buyItem(affordable.id)
    const last = pendingLast(1)[0]
    assert('buyItem → pet_purchase event', last.kind === 'pet_purchase' && last.delta === -affordable.price)
  }
}
// 升级改成"四项数值同时 > 80 累 exp 自动升",levelUpPet 不再发 coin event。
// 这里只确认调用不抛、不产生 coin event。 真升级路径在 Scenario 6d 单测。
const coinEventsBefore = (st().pendingCoinEvents || []).length
s.levelUpPet()
const coinEventsAfter = (st().pendingCoinEvents || []).length
assert('levelUpPet emits no coin event under new exp model',
  coinEventsAfter === coinEventsBefore,
  `before=${coinEventsBefore} after=${coinEventsAfter}`)

// switchPetSpecies: 不同物种 + 余额够 → 扣 PET_SWITCH_COST(100) 并发 pet_skin_switch 事件。
const before = st().coins
const r = s.switchPetSpecies(st().pet.species === 'sheep' ? 'cat' : 'sheep')
assert('switchPetSpecies returns ok', r && r.ok)
assert('switchPetSpecies deducts 100 locally', st().coins === before - 100)
const lastSwitch = pendingLast(1)[0]
assert('switchPetSpecies → pet_skin_switch event delta=-100',
  lastSwitch.kind === 'pet_skin_switch' && lastSwitch.delta === -100)

// ===== Scenario 6b: happiness only flows through finishTask =====
// 道具不再加 happiness、levelUp 不加 happiness、单项 finish +5、当日全完成
// 直接拉到 100、revert 把 happiness 退回。
console.log('\n[6b] Happiness flows through finishTask only (not shop / not levelUp)')
const nb6 = { id: 'nbH', name: today, mode: 'one-shot', startDate: today, endDate: today, recurrence: null, createdAt: 1, order: 0 }
seed({
  notebooks: [nb6], coins: 5000,
  pet: { species: 'cat', emoji: '🐱', name: 'Q', level: 1, happiness: 50, fullness: 50, cleanliness: 50, health: 100, bornAt: Date.now(), lastDecayAt: Date.now() }
})
// 道具:happiness 不再涨。
const itemsH = st().shopItems
const anyItem = itemsH.find((it) => it.price <= 50)
const beforeBuyHappy = st().pet.happiness
s.buyItem(anyItem.id)
assert('shop item does not bump happiness', st().pet.happiness === beforeBuyHappy)
// LevelUp:happiness 不再涨。
const beforeLvlHappy = st().pet.happiness
s.levelUpPet()
assert('levelUpPet does not bump happiness', st().pet.happiness === beforeLvlHappy)

// Finish 单项: +5 happiness, lastReward.taskHappiness = 5
s.addTask({ notebookId: 'nbH', subject: '语', content: 'h1', estimatedMinutes: 5 })
s.addTask({ notebookId: 'nbH', subject: '数', content: 'h2', estimatedMinutes: 5 })
const happyTasks = st().tasks
const happyBefore1 = st().pet.happiness
s.finishTask(happyTasks[0].id, today)
const afterOne = st().pet.happiness
assert('finish 1 task bumps happiness by 5', afterOne - happyBefore1 === 5,
  `before=${happyBefore1} after=${afterOne}`)
assert('lastReward.taskHappiness = 5 on single finish', st().lastReward.taskHappiness === 5)
assert('lastReward.allDoneHappiness = 0 when not all done', st().lastReward.allDoneHappiness === 0)
// Finish 第二项 → 全完成 → happiness 拉到 100
// 第一项 finish 后 happiness=55,第二项 finish 时 单项 +5 (55→60),然后
// 全完成 topup 把 60 拉到 100 (+40)。allDoneHappiness = 40。
s.finishTask(happyTasks[1].id, today)
assert('finish all tasks pulls happiness to 100', st().pet.happiness === 100,
  `actual=${st().pet.happiness}`)
assert('lastReward.taskHappiness = 5 on perfect finish', st().lastReward.taskHappiness === 5)
assert('lastReward.allDoneHappiness = topup to 100', st().lastReward.allDoneHappiness === 40,
  `actual=${st().lastReward.allDoneHappiness}`)

// Revert 拉满那项: happiness 应该退回拉满前的总贡献(5+40=45)→ 100-45=55
s.revertTask(happyTasks[1].id, today)
assert('revert all-done finish refunds happiness', st().pet.happiness === 55,
  `actual=${st().pet.happiness}`)

// ===== Scenario 6c: happiness freezes through end-of-today after perfect day =====
// 全完成 → happinessLastDecayAt 推到当日 23:59:59;再加新 task / revert 都
// 让 happinessLastDecayAt 回到 now,decay 立即恢复。
console.log('\n[6c] Perfect-day freeze pins happinessLastDecayAt at end-of-today')
const nb6c = { id: 'nbF', name: today, mode: 'one-shot', startDate: today, endDate: today, recurrence: null, createdAt: 1, order: 0 }
seed({
  notebooks: [nb6c], coins: 0,
  pet: { species: 'cat', emoji: '🐱', name: 'F', level: 1, happiness: 50, fullness: 50, cleanliness: 50, health: 100, bornAt: Date.now(), lastDecayAt: Date.now() }
})
s.addTask({ notebookId: 'nbF', subject: '语', content: 'f1', estimatedMinutes: 5 })
const ftk = st().tasks[0]
const beforeFreezeClock = st().pet.happinessLastDecayAt
assert('before perfect day: happinessLastDecayAt is null or ≤ now',
  beforeFreezeClock == null || beforeFreezeClock <= Date.now() + 1)
const finishAtMs = Date.now()
s.finishTask(ftk.id, today)
const freezeUntil = finishAtMs + 12 * 3600 * 1000
assert('after all-done: happinessLastDecayAt pushed 12h from finish',
  st().pet.happinessLastDecayAt === freezeUntil,
  `actual=${st().pet.happinessLastDecayAt} expected=${freezeUntil}`)
// petWithDecay 应不再衰减 happiness(即使 lastDecayAt 在过去也不动)
const decayedAfter = s.getStateWithComputed().pet
assert('happiness stays at 100 under decay read while frozen',
  decayedAfter.happiness === 100,
  `actual=${decayedAfter.happiness}`)
// 加新 task → reconcile → revoke today perfect → 解冻
s.addTask({ notebookId: 'nbF', subject: '数', content: 'f2', estimatedMinutes: 5 })
const afterAddClock = st().pet.happinessLastDecayAt
assert('addTask revokes perfect → happinessLastDecayAt drops to ≤ now',
  afterAddClock != null && afterAddClock <= Date.now() + 1,
  `actual=${afterAddClock}`)

// ===== Scenario 6d: exp accrues only when 4 stats > 60; auto-levels =====
console.log('\n[6d] Exp accrues when all four stats > 60; commit auto-levels')
const HOUR = 3600000
// 启动:四项都 100, lastDecayAt = 5 小时前。 fullness 5h 跌到 80 (仍 >60),
// 整 5h 窗口都在阈值之上 → 5h × 10 = 50 exp。
const seed6dNow = Date.now()
seed({
  coins: 0,
  pet: {
    species: 'cat', emoji: '🐱', name: 'E', level: 1, exp: 0,
    happiness: 100, fullness: 100, cleanliness: 100, health: 100,
    bornAt: seed6dNow - 5 * HOUR, lastDecayAt: seed6dNow - 5 * HOUR
  }
})
s.levelUpPet()
let pet = st().pet
assert('5h window starting at 100 → 50 exp', pet.exp === 50, `actual=${pet.exp}`)

// 再过 6 小时:fullness 现 80 (commit 后落地值),衰 4/h,80→60 用 5h。
// statHoursOverThreshold(80, 4, 6h, 60) = min(6, 5) = 5h → 5h × 10 = 50 exp
// 累计 50 + 50 = 100 exp。BASE=200 Lv1→2 需 200,不升,残 100 at Lv1。
const seed6dNext = seed6dNow + 6 * HOUR
Date.now = () => seed6dNext
s.levelUpPet()
pet = st().pet
assert('fullness 80→60 over 6h → +50 exp (capped at 5h)', pet.exp === 100, `actual=${pet.exp}`)
assert('still Lv1 (100 < 200 Lv1→2 target)', pet.level === 1, `actual=${pet.level}`)
Date.now = () => seed6dNow

// 经验跨档自动升级:塞 220 exp,Lv1→Lv2 用掉 200 → 残 20 at Lv2
seed({
  coins: 0,
  pet: {
    species: 'cat', emoji: '🐱', name: 'A', level: 1, exp: 220,
    happiness: 100, fullness: 100, cleanliness: 100, health: 100,
    bornAt: Date.now(), lastDecayAt: Date.now()
  }
})
s.levelUpPet()
pet = st().pet
assert('220 exp → Lv 2', pet.level === 2)
assert('220 exp Lv1→Lv2 residual = 20', pet.exp === 20)
assert('lastLeveledAt stamped on auto-levelup', pet.lastLeveledAt != null)

// 连升:2000 exp → Lv1(200) → Lv2(400) → Lv3(400) → Lv4(600) → 留 400 不够升 Lv5(600)
// 200+400+400+600 = 1600 用掉, 残 400 at Lv5
seed({
  coins: 0,
  pet: {
    species: 'cat', emoji: '🐱', name: 'B', level: 1, exp: 2000,
    happiness: 100, fullness: 100, cleanliness: 100, health: 100,
    bornAt: Date.now(), lastDecayAt: Date.now()
  }
})
s.levelUpPet()
pet = st().pet
assert('2000 exp → Lv 5', pet.level === 5, `actual=${pet.level}`)
assert('2000 exp residual at Lv5 = 400', pet.exp === 400, `actual=${pet.exp}`)

// 满级 cap: 灌 300000 exp 远超满级累计需求(931 × 200 = 186200) → 一次性升到 Lv.100, exp 清零。
seed({
  coins: 0,
  pet: {
    species: 'cat', emoji: '🐱', name: 'M', level: 1, exp: 300000,
    happiness: 100, fullness: 100, cleanliness: 100, health: 100,
    bornAt: Date.now(), lastDecayAt: Date.now()
  }
})
s.levelUpPet()
pet = st().pet
assert('huge exp caps at LEVEL_MAX=100', pet.level === 100, `actual=${pet.level}`)
assert('exp wiped to 0 at max level', pet.exp === 0, `actual=${pet.exp}`)
// 满级后即使再 commit,exp 也不增长
const beforeMaxCommit = pet.exp
s.levelUpPet()
assert('no further exp accrual after max level', st().pet.exp === beforeMaxCommit)

// ===== Scenario 7: pendingCoinEvents survive hydrate; coins re-applied =====
console.log('\n[7] Hydrate with stale server coins re-applies pending delta')
seed({ coins: 100 })
s.addTask({ notebookId: undefined, subject: '语', content: 'one', estimatedMinutes: 5 })
const taskId7 = st().tasks[0].id
s.finishTask(taskId7, today)
const localCoinsAfter = st().coins
const pendingDelta = st().pendingCoinEvents.reduce((a, e) => a + e.delta, 0)
// Simulate hydrate from a server that's behind by pendingDelta.
const serverCoins = localCoinsAfter - pendingDelta
s.applyHydratedState({
  coins: serverCoins
}, Date.now())
assert('hydrate keeps local optimistic coins (server + pending re-applied)', st().coins === localCoinsAfter,
  `coins=${st().coins} expected=${localCoinsAfter}`)
assert('pendingCoinEvents preserved through hydrate', st().pendingCoinEvents.length > 0)

// ===== Scenario 8: detachOccurrence — recurring 实例 detach 成独立 one-shot =====
console.log('\n[8] detachOccurrence: recurring 实例拆成独立 task,原任务 excludedDates 加这天')
seed({
  notebooks: [],
  coins: 0,
  tasks: [{
    id: 'tk_rec', subject: '数学', organization: '校内', content: '每日口算',
    estimatedMinutes: 10, mode: 'recurring', startDate: today, endDate: null,
    recurrence: { type: 'daily', weekdays: [] },
    excludedDates: [],
    order: 0, createdAt: 1, occurrences: {}
  }]
})
// case 1: 在干净状态(occurrence 没数据)detach 今天
let newId = s.detachOccurrence('tk_rec', today)
assert('detach 返回新 task id', !!newId)
let allTasks = st().tasks
let originalRec = allTasks.find((t) => t.id === 'tk_rec')
let detachedTask = allTasks.find((t) => t.id === newId)
assert('原 recurring task 的 excludedDates 包含 today', originalRec.excludedDates.indexOf(today) >= 0)
assert('新 task 是 one-shot', detachedTask.mode === 'one-shot')
assert('新 task startDate = today', detachedTask.startDate === today)
assert('新 task endDate = today', detachedTask.endDate === today)
assert('新 task 继承 content', detachedTask.content === '每日口算')
assert('新 task 继承 subject', detachedTask.subject === '数学')
assert('新 task 继承 organization', detachedTask.organization === '校内')
assert('新 task detachedFrom 标记', detachedTask.detachedFrom === 'tk_rec')
assert('新 task 默认 status=todo', (detachedTask.status || 'todo') === 'todo')

// case 2: tasksForDate(today) 看不到原 recurring,只看到新 detached
const todayItems = s.tasksForDate(st(), today)
const todayTaskIds = todayItems.map((it) => it.task.id)
assert('tasksForDate today 不含原 tk_rec', todayTaskIds.indexOf('tk_rec') < 0)
assert('tasksForDate today 含新 detached task', todayTaskIds.indexOf(newId) >= 0)

// case 3: 已经 doing 的 occurrence detach — 进度/accumulatedMs 转移
seed({
  notebooks: [],
  coins: 0,
  tasks: [{
    id: 'tk_rec2', subject: '语文', organization: '校外', content: '听写',
    estimatedMinutes: 15, mode: 'recurring', startDate: yesterday, endDate: null,
    recurrence: { type: 'daily', weekdays: [] },
    excludedDates: [],
    order: 0, createdAt: 1,
    occurrences: {
      [today]: {
        status: 'doing',
        startedAt: 1234567890,
        currentSegmentStartedAt: 1234567899,
        accumulatedMs: 60000,
        completedAt: null,
        actualMinutes: null
      }
    }
  }]
})
const doingDetachId = s.detachOccurrence('tk_rec2', today)
const doingDetached = st().tasks.find((t) => t.id === doingDetachId)
assert('doing detach: 新 task 继续 doing', doingDetached.status === 'doing')
assert('doing detach: accumulatedMs 完整搬', doingDetached.accumulatedMs === 60000)
assert('doing detach: currentSegmentStartedAt 保留', doingDetached.currentSegmentStartedAt === 1234567899)
const origRec2 = st().tasks.find((t) => t.id === 'tk_rec2')
assert('原 task occurrences[today] 已清', !origRec2.occurrences[today])

// case 4: 已 done 的 occurrence detach — reward 不重复发
seed({
  notebooks: [],
  coins: 100,
  perfectDays: [],
  bonusByDay: {},
  tasks: [{
    id: 'tk_rec3', subject: '英语', organization: '校内', content: '背单词',
    estimatedMinutes: 10, mode: 'recurring', startDate: yesterday, endDate: null,
    recurrence: { type: 'daily', weekdays: [] },
    excludedDates: [],
    order: 0, createdAt: 1,
    occurrences: {
      [today]: {
        status: 'done',
        startedAt: 1, currentSegmentStartedAt: null,
        accumulatedMs: 120000, completedAt: Date.now(), actualMinutes: 2,
        rewardPaid: 10, rewardKind: 'today', happinessPaid: 5
      }
    }
  }]
})
const coinsBeforeDetach = st().coins
const doneDetachId = s.detachOccurrence('tk_rec3', today)
const doneDetached = st().tasks.find((t) => t.id === doneDetachId)
assert('done detach: 新 task 仍是 done', doneDetached.status === 'done')
assert('done detach: rewardPaid 保留', doneDetached.rewardPaid === 10)
assert('done detach: coins 不变(reward 不重发)', st().coins === coinsBeforeDetach)

// case 5: excludeOccurrence 只标记不新建
seed({
  notebooks: [],
  coins: 0,
  tasks: [{
    id: 'tk_rec4', subject: '语', organization: '其他', content: '抄写',
    estimatedMinutes: 5, mode: 'recurring', startDate: today, endDate: null,
    recurrence: { type: 'daily', weekdays: [] },
    excludedDates: [],
    order: 0, createdAt: 1,
    occurrences: { [today]: { status: 'todo' } }
  }]
})
const taskCountBefore = st().tasks.length
const okExclude = s.excludeOccurrence('tk_rec4', today)
assert('excludeOccurrence 返回 true', okExclude === true)
assert('excludeOccurrence 不新建 task', st().tasks.length === taskCountBefore)
const excludedRec = st().tasks.find((t) => t.id === 'tk_rec4')
assert('excludeOccurrence 加 excludedDates', excludedRec.excludedDates.indexOf(today) >= 0)
assert('excludeOccurrence 清掉 occurrences[date]', !excludedRec.occurrences[today])
// tasksForDate 看不到这个 task 在 today
const itemsAfterExclude = s.tasksForDate(st(), today)
assert('exclude 后 today 看不到这个 task',
  itemsAfterExclude.every((it) => it.task.id !== 'tk_rec4'))

// case 6: detach 非 recurring task → 返回 null
seed({
  notebooks: [],
  tasks: [{
    id: 'tk_one', subject: '语', organization: '其他', content: 'oneshot',
    mode: 'one-shot', startDate: today, endDate: today, recurrence: null,
    excludedDates: [], order: 0, createdAt: 1, status: 'todo'
  }]
})
const nullDetach = s.detachOccurrence('tk_one', today)
assert('detach 一次性 task 返回 null', nullDetach === null)

// case 7: detach 已 done 的 perfect-day 占位实例 → perfectDays 仍包含今天
// (新 task 继承 done 状态, tasksForDate(today) 仍 all-done, 不需要 reconcile)
// startDate 锚 today 不留 backlog 干扰;这是一个"今天才开始的 daily recurring"。
seed({
  notebooks: [],
  coins: 100,
  perfectDays: [today],
  bonusByDay: { [today]: { dailyBonus: 10, weeklyBonus: 0, prevStreakDays: 0 } },
  streakDays: 1,
  tasks: [{
    id: 'tk_perfect_rec',
    subject: '数学', organization: '校内', content: '每日 perfect 占位',
    mode: 'recurring', startDate: today, endDate: null,
    recurrence: { type: 'daily', weekdays: [] },
    excludedDates: [],
    order: 0, createdAt: 1,
    occurrences: {
      [today]: {
        status: 'done',
        startedAt: 1, currentSegmentStartedAt: null,
        accumulatedMs: 60000, completedAt: Date.now(), actualMinutes: 1,
        rewardPaid: 10, rewardKind: 'today', happinessPaid: 5
      }
    }
  }]
})
const coinsBeforePerfectDetach = st().coins
const perfectDetachId = s.detachOccurrence('tk_perfect_rec', today)
assert('detach perfect-day 占位:返回新 task id', !!perfectDetachId)
assert('detach perfect-day 占位:perfectDays 仍包含 today',
  st().perfectDays.indexOf(today) >= 0)
assert('detach perfect-day 占位:streakDays 不变', st().streakDays === 1)
assert('detach perfect-day 占位:bonusByDay 不变', !!st().bonusByDay[today])
assert('detach perfect-day 占位:coins 不变', st().coins === coinsBeforePerfectDetach)
// tasksForDate(today) 现在应该看到的是新的 detached one-shot, 而不是原 recurring
const itemsAfterPerfectDetach = s.tasksForDate(st(), today)
const todayTaskIds2 = itemsAfterPerfectDetach.map((it) => it.task.id)
assert('detach perfect-day 占位:today 只看到新 task,看不到原 recurring',
  todayTaskIds2.indexOf(perfectDetachId) >= 0 &&
  todayTaskIds2.indexOf('tk_perfect_rec') < 0)
assert('detach perfect-day 占位:今天的 task 仍是 done (perfect 状态完整)',
  itemsAfterPerfectDetach.every((it) => it.occurrence.status === 'done'))

// ===== Scenario 9: v2→v3 migration flag (lazy backup trigger) =====
console.log('\n[9] consumeV2V3MigrationFlag 在 v2→v3 migrate 时设 true, 重复消费返回 false')
// 模拟"刚升级"场景: storage 里写了 v2 schema 数据 → 触发 v3 client migrate。
// wx mock 直接存 object(loadState 期待 raw 是对象,不是 JSON 字符串)。
wx._store = {}
wx._store['homework-pet-v1'] = {
  schemaVersion: 2, coins: 0, streakDays: 0, perfectDays: [], bonusByDay: {},
  completionsByDay: {}, pendingShareCoins: 0, editTaskId: null, editNotebookId: null,
  ocrCurrentJob: null, ocrJobs: [], pet: {}, shopItems: [],
  notebooks: [{
    id: 'nb_v2', name: 'v2 本', mode: 'one-shot',
    startDate: today, endDate: today, recurrence: null, createdAt: 1, order: 0
  }],
  tasks: [{
    id: 'tk_v2', notebookId: 'nb_v2', subject: '语', content: 'v2 task',
    estimatedMinutes: 5, order: 0, createdAt: 1, status: 'todo'
  }],
  profile: { nickname: '' }
}
// 重新 require 触发 fresh loadState → migrate v2→v3
delete require.cache[require.resolve(require('path').join(__dirname, '..', 'utils', 'store.js'))]
const sFresh = require(require('path').join(__dirname, '..', 'utils', 'store.js'))
sFresh.getStateWithComputed()  // 触发 loadState

assert('v2→v3 migrate 后 consumeV2V3MigrationFlag 返回 true',
  sFresh.consumeV2V3MigrationFlag() === true)
assert('重复消费 flag 返回 false', sFresh.consumeV2V3MigrationFlag() === false)
// 第二次 loadState 不会重跑 migrate(已经是 v3),flag 不再触发
sFresh.getStateWithComputed()
assert('v3 状态再次读取不再设 flag', sFresh.consumeV2V3MigrationFlag() === false)

// ===== Summary =====
console.log(`\n=== ${passed} passed, ${failed} failed ===`)
process.exit(failed === 0 ? 0 : 1)
