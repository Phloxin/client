const calm = matchMedia('(prefers-reduced-motion: reduce)').matches

// Screenshot tabs. Panels are all in the DOM; [hidden] does the hiding.
const tabs = [...document.querySelectorAll('.tabs [role="tab"]')]

function select(tab) {
  // Slide in from whichever side we came from, so going back feels like back.
  const forward = tabs.indexOf(tab) > current()
  for (const t of tabs) {
    const on = t === tab
    const panel = document.getElementById(t.getAttribute('aria-controls'))
    t.setAttribute('aria-selected', String(on))
    panel.hidden = !on
    if (on) panel.style.setProperty('--from', forward ? '2.5rem' : '-2.5rem')
  }
}

// Cycles on its own until someone takes over, then stops for good — nothing
// worse than a panel swapping out mid-sentence.
let cycle = calm ? 0 : setInterval(() => select(tabs[(current() + 1) % tabs.length]), 7000)

function current() {
  return tabs.findIndex((t) => t.getAttribute('aria-selected') === 'true')
}

function take(tab) {
  clearInterval(cycle)
  select(tab)
}

tabs.forEach((tab, i) => {
  tab.addEventListener('click', () => take(tab))
  // Left/right arrows move between tabs, as a tablist is expected to.
  tab.addEventListener('keydown', (e) => {
    const step = { ArrowLeft: -1, ArrowRight: 1 }[e.key]
    if (!step) return
    const next = tabs[(i + step + tabs.length) % tabs.length]
    take(next)
    next.focus()
  })
})

// Fade sections in as they scroll into view. The class is added from JS so a
// no-JS visitor gets the page fully visible instead of a blank column.
if (!calm) {
  const seen = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue
        e.target.classList.add('in')
        seen.unobserve(e.target)
      }
    },
    { rootMargin: '0px 0px -10% 0px' }
  )

  for (const el of document.querySelectorAll('.showcase, .card')) {
    el.classList.add('reveal')
    seen.observe(el)
  }
}
