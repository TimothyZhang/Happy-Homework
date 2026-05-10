// Numeric verification for V1 economy rules. Asserts the values in
// V1-VALUES-DESIGN.md match what the store actually implements.
// Run: `node scripts/values-check.js` (no deps).

let storage = {}
global.wx = {
  getStorageSync: (k) => (k in storage ? JSON.parse(storage[k]) : ''),
  setStorageSync: (k, v) => { storage[k] = JSON.stringify(v) },
  cloud: undefined,
  showToast: () => {},
  showModal: () => {}
}

function pad2(n) { return String(n).padStart(2, '0') }
function todayStr() {
  const d = new Date()
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

// Seed N one-shot tasks for today, all 'todo'. The pet is set up so
// finishTask runs the happiness-bump branch too.
function seedNTasksToday(n) {
  const today = todayStr()
  const tasks = []
  for (let i = 1; i <= n; i++) {
    tasks.push({
      id: `t${i}`, notebookId: 'nb_today', subject: '语', content: `task ${i}`,
      estimatedMinutes: 5, order: i, createdAt: i,
      status: 'todo', startedAt: null, currentSegmentStartedAt: null,
      accumulatedMs: 0, completedAt: null, actualMinutes: null
    })
  }
  storage = {}
  storage['homework-pet-v1'] = JSON.stringify({
    schemaVersion: 2, coins: 0, streakDays: 0, perfectDays: [],
    pendingShareCoins: 0,
    // Skip the one-time test grant for value-checks; the seed represents an
    // already-onboarded account.
    testCoinsGranted: true, coinLogs: [],
    editTaskId: null, editNotebookId: null,
    ocrCurrentJob: null, ocrJobs: [], rewardRules: [],
    pet: {
      species: 'cat', emoji: '🐱', name: 'p',
      bornAt: Date.now(), lastDecayAt: Date.now(),
      level: 1, happiness: 80, fullness: 80, cleanliness: 80, health: 80
    },
    shopItems: [],
    notebooks: [{
      id: 'nb_today', name: 'today', mode: 'one-shot',
      startDate: today, endDate: today, recurrence: null,
      createdAt: 1, order: 0
    }],
    tasks,
    profile: { nickname: '' }
  })
}

let pass = 0, fail = 0
function check(label, got, want) {
  const sg = JSON.stringify(got)
  const sw = JSON.stringify(want)
  if (sg === sw) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    fail++
    console.log(`  ✗ ${label}`)
    console.log(`    got:  ${sg}`)
    console.log(`    want: ${sw}`)
  }
}

function freshStore() {
  const path = require('path').resolve(__dirname, '../utils/store.js')
  delete require.cache[require.resolve(path)]
  return require(path)
}

// === Test 1: per-task +10, 7/8 done = 70 coins ===
console.log('\n[reward] per-task and partial-day:')
seedNTasksToday(8)
let store = freshStore()
const today = todayStr()
for (let i = 1; i <= 7; i++) store.finishTask(`t${i}`, today)
check('finish 7 of 8 → coins = 70', store.getStateWithComputed().coins, 70)

// === Test 2: 8th completion triggers daily bonus → 70 + 10 + 80 = 160 ===
console.log('\n[reward] all-done daily bonus:')
store.finishTask('t8', today)
const after8 = store.getStateWithComputed()
check('finish 8/8 → coins = 160', after8.coins, 160)
check('lastReward.dailyBonus = 80', after8.lastReward.dailyBonus, 80)
check('streakDays = 1', after8.streakDays, 1)
check('perfectDays includes today', after8.perfectDays.includes(today), true)

// === Test 3: revert claws back single +10 AND the daily bonus ===
// Picking up from test 2: 8/8 done, coins=160, perfectDays=[today], streak=1.
console.log('\n[revert] all-done revert claws back single + bonus:')
store.revertTask('t8', today)
const afterRevert8 = store.getStateWithComputed()
check('revert breaks all-done → coins = 70 (refund 10 + 80)', afterRevert8.coins, 70)
check('streakDays restored to 0', afterRevert8.streakDays, 0)
check('perfectDays no longer has today', afterRevert8.perfectDays.includes(today), false)

// === Test 3b: re-finishing the same task re-pays the bonus (back to 160) ===
store.finishTask('t8', today)
const afterRedo = store.getStateWithComputed()
check('redo restores to 160 (single +10 + bonus +80)', afterRedo.coins, 160)
check('streakDays back to 1', afterRedo.streakDays, 1)

// === Test 3c: anti-farm — finish→revert cycled 5× nets zero ===
// Each cycle: finish(+10+80) → revert(-10-80). End coins must equal start.
const beforeFarm = store.getStateWithComputed().coins
for (let i = 0; i < 5; i++) {
  store.revertTask('t8', today)
  store.finishTask('t8', today)
}
const afterFarm = store.getStateWithComputed()
check('5× finish/revert cycle → coins unchanged', afterFarm.coins, beforeFarm)
check('5× cycle → still 1 perfect day on streak', afterFarm.streakDays, 1)

// === Test 3d: revert middle task (not the one that triggered all-done) ===
// Same logic must fire: any revert from a perfect-day state breaks the day.
seedNTasksToday(8)
store = freshStore()
for (let i = 1; i <= 8; i++) store.finishTask(`t${i}`, today)
check('seed: 8/8 → 160', store.getStateWithComputed().coins, 160)
store.revertTask('t3', today)  // middle task, not the 8th
const afterMiddle = store.getStateWithComputed()
check('revert middle → coins = 70 (bonus still clawed)', afterMiddle.coins, 70)
check('revert middle → streakDays back to 0', afterMiddle.streakDays, 0)

// === Test 3e: revert without all-done only refunds the single +10 ===
seedNTasksToday(3)
store = freshStore()
store.finishTask('t1', today)
store.finishTask('t2', today)  // 2/3, not perfect → no bonus credited yet
const before2of3 = store.getStateWithComputed()
check('seed: 2/3 done → coins = 20', before2of3.coins, 20)
store.revertTask('t2', today)
const after2of3 = store.getStateWithComputed()
check('revert non-perfect-day task → coins = 10', after2of3.coins, 10)
check('streakDays untouched', after2of3.streakDays, 0)

// === Test 3f: clip-to-zero — refund larger than current balance ===
seedNTasksToday(1)
store = freshStore()
store.finishTask('t1', today)
const fix = JSON.parse(storage['homework-pet-v1'])
fix.coins = 3  // user spent most of it; only 3 left
storage['homework-pet-v1'] = JSON.stringify(fix)
store = freshStore()
store.revertTask('t1', today)
check('refund > balance → coins clipped to 0', store.getStateWithComputed().coins, 0)

// === Test 4: 12-task day matches design's 12 × 20 = 240 ===
console.log('\n[reward] 12-task perfect day = 240:')
seedNTasksToday(12)
store = freshStore()
for (let i = 1; i <= 12; i++) store.finishTask(`t${i}`, today)
check('12/12 → coins = 240', store.getStateWithComputed().coins, 240)

// === Test 5: level cost table ===
console.log('\n[level] cost curve:')
store = freshStore()
check('getLevelCost(1) = 180', store.getLevelCost(1), 180)
check('getLevelCost(2) = 500', store.getLevelCost(2), 500)
check('getLevelCost(3) = 1000', store.getLevelCost(3), 1000)
check('getLevelCost(4) = 2000', store.getLevelCost(4), 2000)
check('getLevelCost(5) = 2000 (plateau)', store.getLevelCost(5), 2000)
check('getLevelCost(8) = 2000 (plateau)', store.getLevelCost(8), 2000)

// === Test 6: levelUpPet — gates on coins, deducts cost, increments level ===
console.log('\n[level] levelUpPet:')
seedNTasksToday(0)  // re-seed so we have a pet at level 1
store = freshStore()
const r1 = store.levelUpPet()
check('coins=0 → not-enough-coins', r1.ok, false)

// Manually grant 200 coins via finishing... easier to mutate the storage.
const cur = JSON.parse(storage['homework-pet-v1'])
cur.coins = 200
storage['homework-pet-v1'] = JSON.stringify(cur)
store = freshStore()
const r2 = store.levelUpPet()
check('coins=200 ≥ 180 → ok', r2.ok, true)
check('level becomes 2', r2.level, 2)
const afterLvl = store.getStateWithComputed()
check('coins decremented by 180', afterLvl.coins, 20)
check('pet.level = 2', afterLvl.pet.level, 2)

// === Test 7: decay rates — 16h on each stat ===
console.log('\n[decay] 16h drop sanity check:')
const decay = store.PET_DECAY_PER_HOUR
check('fullness rate = 4',    decay.fullness, 4)
check('cleanliness rate = 3', decay.cleanliness, 3)
check('happiness rate = 3',   decay.happiness, 3)
check('health rate = 2.5',    decay.health, 2.5)
// 16h drops: fullness 100→36, cleanliness 100→52, happiness 100→52, health 100→60
// (rates × 16, rounded to int by petWithDecay)
const sixteenHoursAgo = Date.now() - 16 * 3600 * 1000
const cur2 = JSON.parse(storage['homework-pet-v1'])
cur2.pet = {
  species: 'cat', emoji: '🐱', name: 'p',
  bornAt: sixteenHoursAgo, lastDecayAt: sixteenHoursAgo,
  level: 1, happiness: 100, fullness: 100, cleanliness: 100, health: 100
}
storage['homework-pet-v1'] = JSON.stringify(cur2)
store = freshStore()
const decayed = store.getStateWithComputed().pet
check('16h fullness = 36',    decayed.fullness, 36)
check('16h cleanliness = 52', decayed.cleanliness, 52)
check('16h happiness = 52',   decayed.happiness, 52)
check('16h health = 60',      decayed.health, 60)

// === Test 8: shop item shape — every item lifts at least one stat ===
console.log('\n[shop] item sanity:')
// Read shopItems from defaultState (the canonical source) — the seeded
// fixture above intentionally set shopItems: [] to keep test 1 lean.
storage = {}
store = freshStore()
const items = store.defaultState.shopItems
check('8 shop items', items.length, 8)
for (const it of items) {
  const sum = (it.happiness | 0) + (it.fullness | 0) + (it.cleanliness | 0) + (it.health | 0)
  if (sum <= 0) {
    fail++
    console.log(`  ✗ item ${it.id} (${it.name}) has no stat boost`)
  }
}
const carrot = items.find((i) => i.id === 1)
check('carrot price = 16',        carrot.price, 16)
check('carrot fullness = 30',     carrot.fullness, 30)
check('shop totals match design', items.map((i) => i.price), [16, 28, 18, 32, 18, 20, 35, 50])

// Each primary stat needs at least 2 items (cheap + mid tier). The "primary"
// stat is whichever attribute the item lifts the most.
const STAT_KEYS = ['fullness', 'cleanliness', 'happiness', 'health']
const primaryCounts = { fullness: 0, cleanliness: 0, happiness: 0, health: 0 }
for (const it of items) {
  let primary = STAT_KEYS[0]
  for (const k of STAT_KEYS) if ((it[k] | 0) > (it[primary] | 0)) primary = k
  if ((it[primary] | 0) > 0) primaryCounts[primary]++
}
for (const k of STAT_KEYS) {
  check(`stat "${k}" has ≥2 items`, primaryCounts[k] >= 2, true)
}
// Price tiers: cheap 15-25, mid 25-40, high 50-80.
for (const it of items) {
  const inRange =
    (it.price >= 15 && it.price <= 25) ||
    (it.price >= 25 && it.price <= 40) ||
    (it.price >= 50 && it.price <= 80)
  if (!inRange) {
    fail++
    console.log(`  ✗ item ${it.id} (${it.name}) price ${it.price} outside design tiers`)
  }
}

// === Test 9: rewardRules labels reflect new economy ===
console.log('\n[reward] rule labels:')
const rules = store.defaultState.rewardRules
check('rule[0] = 单项 +10', { title: rules[0].title, coins: rules[0].coins }, { title: '完成单项作业', coins: 10 })
check('rule[3] = streak +50', rules[3].coins, 50)

// === Test 10: PET_SPECIES includes parrot ===
console.log('\n[species] roster:')
const species = store.PET_SPECIES
check('PET_SPECIES.length = 9', species.length, 9)
const parrot = species.find((s) => s.id === 'parrot')
check('parrot entry exists', !!parrot, true)
check('parrot emoji = 🦜', parrot && parrot.emoji, '🦜')
check('parrot label = 鹦鹉', parrot && parrot.label, '鹦鹉')

// === Test 11: switchPetSpecies — gate, deduct, preserve attrs ===
console.log('\n[switch] switchPetSpecies:')
seedNTasksToday(0)
store = freshStore()
// Set up pet at level 3 with custom name + middling stats, plus 50 coins (not enough)
let cur3 = JSON.parse(storage['homework-pet-v1'])
cur3.coins = 50
cur3.pet = {
  species: 'cat', emoji: '🐱', name: '豆豆',
  bornAt: Date.now() - 86400000, lastDecayAt: Date.now(),
  level: 3, happiness: 70, fullness: 65, cleanliness: 80, health: 88
}
storage['homework-pet-v1'] = JSON.stringify(cur3)
store = freshStore()
check('PET_SWITCH_COST = 100', store.PET_SWITCH_COST, 100)
const sw1 = store.switchPetSpecies('parrot')
check('coins=50 → not-enough-coins', sw1.ok, false)
check('reason = not-enough-coins', sw1.reason, 'not-enough-coins')
check('pet.species unchanged after rejected switch', store.getStateWithComputed().pet.species, 'cat')
check('coins unchanged after rejected switch', store.getStateWithComputed().coins, 50)

// Top up to 150 and switch — should succeed and preserve everything
const cur4 = JSON.parse(storage['homework-pet-v1'])
cur4.coins = 150
storage['homework-pet-v1'] = JSON.stringify(cur4)
store = freshStore()
const sw2 = store.switchPetSpecies('parrot')
check('coins=150 ≥ 100 → ok', sw2.ok, true)
check('returned species = parrot', sw2.species, 'parrot')
const afterSwitch = store.getStateWithComputed()
check('coins decremented by 100', afterSwitch.coins, 50)
check('pet.species = parrot', afterSwitch.pet.species, 'parrot')
check('pet.emoji = 🦜', afterSwitch.pet.emoji, '🦜')
check('pet.name preserved', afterSwitch.pet.name, '豆豆')
check('pet.level preserved', afterSwitch.pet.level, 3)
// Stats: decay-commit may shave them slightly (see commitPetDecay), so just
// verify they're close to original — this proves the switch isn't a reset.
check('pet.cleanliness still ≥ 70 (preserved, not reset to 100)',
  afterSwitch.pet.cleanliness >= 70 && afterSwitch.pet.cleanliness <= 80, true)
check('pet.health still ≥ 80 (preserved, not reset to 100)',
  afterSwitch.pet.health >= 80 && afterSwitch.pet.health <= 88, true)

// Switching to same species → rejected
const sw3 = store.switchPetSpecies('parrot')
check('same-species switch rejected', sw3.ok, false)
check('reason = same-species', sw3.reason, 'same-species')

// Unknown species → rejected
const sw4 = store.switchPetSpecies('dragon')
check('unknown species rejected', sw4.ok, false)

// === Test: one-time test coin grant on first load ===
console.log('\n[test-grant] +1000 once on first load:')
// Pre-existing storage WITHOUT testCoinsGranted: simulates a user upgrading
// to this build. Migration backfills the flag as false → grant fires.
storage = {}
storage['homework-pet-v1'] = JSON.stringify({
  schemaVersion: 2, coins: 25, streakDays: 0, perfectDays: [],
  pendingShareCoins: 0,
  editTaskId: null, editNotebookId: null,
  ocrCurrentJob: null, ocrJobs: [], rewardRules: [],
  pet: {}, shopItems: [], notebooks: [], tasks: [],
  profile: { nickname: '' }
})
store = freshStore()
const grant1 = store.getStateWithComputed()
check('first load grants +1000 (25 → 1025)', grant1.coins, 1025)
check('testCoinsGranted set to true', grant1.testCoinsGranted, true)
check('coinLogs has one test-grant entry', grant1.coinLogs.length, 1)
check('coinLogs[0].reason = test-grant', grant1.coinLogs[0].reason, 'test-grant')
check('coinLogs[0].delta = 1000', grant1.coinLogs[0].delta, 1000)

// Re-load: storage already has testCoinsGranted=true → grant must NOT fire.
store = freshStore()
const grant2 = store.getStateWithComputed()
check('repeated load does not regrant (still 1025)', grant2.coins, 1025)
check('coinLogs still length 1', grant2.coinLogs.length, 1)

console.log(`\n  ${pass} passed, ${fail} failed.\n`)
process.exit(fail === 0 ? 0 : 1)
