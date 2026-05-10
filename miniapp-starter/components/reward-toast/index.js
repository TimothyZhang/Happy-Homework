Component({
  options: { addGlobalClass: true },
  properties: {
    // 'task' (small, ~1.2s) or 'allDone' (big, ~2.5s).
    kind: { type: String, value: 'task' },
    // Reward coins to display ("+10" / "+80").
    coins: { type: Number, value: 0 },
    // Pet emoji to put center stage. Falls back to 🐾 if state has no species yet.
    petEmoji: { type: String, value: '🐾' },
    // Bonus subtitle line for allDone, e.g. "今日全部完成!"
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
