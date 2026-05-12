// Tiny first-paint instrumentation. Two timing channels:
//   - tap → onShow start    (WeChat-internal page-create cost — out of our hands)
//   - onShow → setData done (our JS work, the lever we can pull)
//
// Module singleton, so the timestamp stamped from custom-tab-bar survives
// across the switchTab boundary into the new page's onShow.

let _tabTapAt = 0
let _tabTapTarget = ''

function markTabTap(target) {
  _tabTapAt = Date.now()
  _tabTapTarget = target || ''
}

// Call at the very top of onShow. Returns a stamp to pass into markPaint.
function markPageShow(name) {
  const now = Date.now()
  if (_tabTapAt) {
    console.log(`[perf] ${name} onShow (+${now - _tabTapAt}ms tap→show)`)
  } else {
    console.log(`[perf] ${name} onShow (cold launch / re-show)`)
  }
  return { name, showAt: now, tapAt: _tabTapAt }
}

// Call from the setData callback after the first paint-blocking setData.
function markPaint(stamp) {
  if (!stamp) return
  const now = Date.now()
  const inJs = now - stamp.showAt
  const sinceTap = stamp.tapAt ? now - stamp.tapAt : null
  if (sinceTap != null) {
    console.log(`[perf] ${stamp.name} paint (+${inJs}ms JS, +${sinceTap}ms total since tap)`)
    // Reset so the next tab tap measures cleanly.
    if (stamp.tapAt === _tabTapAt) _tabTapAt = 0
  } else {
    console.log(`[perf] ${stamp.name} paint (+${inJs}ms JS, cold launch)`)
  }
}

module.exports = { markTabTap, markPageShow, markPaint }
