Component({
  options: { addGlobalClass: true },
  properties: {
    // 'task' (small, ~1.2s) or 'allDone' (big, ~3.2s).
    kind: { type: String, value: 'task' },
    // Reward coins to display. For 'task' this is the per-task reward (5/10/15).
    // For 'allDone' this is the daily-perfect bonus (N×10 + early-bird) shown as
    // the big TOTAL.
    coins: { type: Number, value: 0 },
    // Pet emoji to put center stage. Falls back to 🐾 if state has no species yet.
    petEmoji: { type: String, value: '🐾' },
    // Optional caption shown under the coin number. For 'task' this is the
    // tier hint ('提前完成 +5', '补做', '今日已达 20 项上限'). For 'allDone' it's
    // the headline (e.g. '今日全部完成!').
    subtitle: { type: String, value: '' },
    // Toggles the overlay.
    visible: { type: Boolean, value: false }
  },
  methods: {
    // Tap-anywhere-to-dismiss. The page also auto-hides on a timer; this just
    // lets the user skip the rest of the animation.
    handleSkip() {
      if (!this.data.visible) return
      this.triggerEvent('skip')
    },
    // Stop bubbling so taps inside the card don't dismiss prematurely while
    // we still want the timer to play out (used for the allDone card body).
    noop() {}
  }
})
