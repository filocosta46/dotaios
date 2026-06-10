/* DotAIOS — app.js (ES module, Sanity + optional visual editing) */
import {stegaClean} from 'https://esm.sh/@sanity/client/stega'
import {client, isPreview} from './sanity-client.js'
import {docToI18n} from './sanity-transform.js'

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
const LANG_KEY = 'dotaios-lang'
let currentLang = 'en'
let copyLabel = 'Copied'
let visualEditingReady = false
let uiStarted = false

const QUERY = '*[_type == "landingPage"][0]'

function sanityHasContent(doc) {
  if (!doc) return false
  const h1 = doc.heroH1?.en ?? doc.heroH1
  if (typeof h1 === 'string' && h1.trim()) return true
  const i18n = docToI18n(doc)
  return Boolean(i18n?.en?.hero?.h1?.trim())
}

function get(obj, path) {
  return path.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), obj)
}

function detectLang() {
  const params = new URLSearchParams(window.location.search)
  const fromUrl = params.get('lang')
  if (fromUrl === 'en' || fromUrl === 'it') return fromUrl
  try {
    const stored = localStorage.getItem(LANG_KEY)
    if (stored === 'en' || stored === 'it') return stored
  } catch {
    /* ignore */
  }
  const nav = (navigator.language || '').toLowerCase()
  if (nav.startsWith('it')) return 'it'
  return 'en'
}

function setUrlLang(lang) {
  const url = new URL(window.location.href)
  url.searchParams.set('lang', lang)
  window.history.replaceState({}, '', url.pathname + url.search + url.hash)
}

function applyTokens(doc) {
  if (!doc) return
  if (doc.fontFamily) {
    document.documentElement.style.setProperty(
      '--sans',
      `"${doc.fontFamily}", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`,
    )
  }
  if (doc.accentColor) {
    document.documentElement.style.setProperty('--accent', doc.accentColor)
  }
}

function applyLang(lang) {
  const pack = window.DOTAIOS_I18N && window.DOTAIOS_I18N[lang]
  if (!pack) return

  currentLang = lang
  copyLabel = pack.install.copied

  document.documentElement.lang = lang

  const meta = pack.meta
  if (meta) {
    document.title = stegaClean(meta.title)
    const desc = document.querySelector('meta[name="description"]')
    if (desc) desc.setAttribute('content', stegaClean(meta.description))
    const ogTitle = document.querySelector('meta[property="og:title"]')
    if (ogTitle) ogTitle.setAttribute('content', stegaClean(meta.ogTitle))
    const ogDesc = document.querySelector('meta[property="og:description"]')
    if (ogDesc) ogDesc.setAttribute('content', stegaClean(meta.ogDescription))
  }

  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const val = get(pack, el.getAttribute('data-i18n'))
    if (val !== undefined) el.textContent = val
  })

  document.querySelectorAll('[data-i18n-html]').forEach((el) => {
    const val = get(pack, el.getAttribute('data-i18n-html'))
    if (val !== undefined) el.innerHTML = val
  })

  document.querySelectorAll('[data-i18n-attr]').forEach((el) => {
    el.getAttribute('data-i18n-attr')
      .split(';')
      .forEach((pair) => {
        const parts = pair.split(':')
        if (parts.length < 2) return
        const attr = parts[0].trim()
        const key = parts.slice(1).join(':').trim()
        const val = get(pack, key)
        if (val !== undefined) el.setAttribute(attr, val)
      })
  })

  document.querySelectorAll('[data-copy-key]').forEach((el) => {
    const key = el.getAttribute('data-copy-key')
    const val = get(pack, key)
    if (val !== undefined) el.setAttribute('data-copy', stegaClean(val))
  })

  document.querySelectorAll('.lang-btn').forEach((btn) => {
    const on = btn.getAttribute('data-lang') === lang
    btn.classList.toggle('active', on)
    btn.setAttribute('aria-pressed', on ? 'true' : 'false')
  })

  try {
    localStorage.setItem(LANG_KEY, lang)
  } catch {
    /* ignore */
  }
  setUrlLang(lang)
}

function applyContent(doc) {
  applyTokens(doc)
  const i18n = docToI18n(doc)
  if (i18n && i18n.en && i18n.it) {
    window.DOTAIOS_I18N = i18n
  }
  applyLang(currentLang || detectLang())
}

function initLangSwitch() {
  document.querySelectorAll('.lang-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const lang = btn.getAttribute('data-lang')
      if (lang === currentLang) return
      applyLang(lang)
      document.querySelectorAll('.snippet .copy').forEach((b) => {
        delete b.dataset.bound
      })
      bindCopy(document)
    })
  })
}

function bindCopy(root) {
  ;(root || document).querySelectorAll('.snippet .copy').forEach((btn) => {
    if (btn.dataset.bound) return
    btn.dataset.bound = '1'
    btn.addEventListener('click', () => {
      const snip = btn.closest('.snippet')
      const text = snip ? snip.getAttribute('data-copy') : ''
      const done = () => {
        const old = btn.textContent
        btn.textContent = copyLabel
        btn.classList.add('copied')
        setTimeout(() => {
          btn.textContent = old
          btn.classList.remove('copied')
        }, 1600)
      }
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(done)
      } else {
        const ta = document.createElement('textarea')
        ta.value = text
        document.body.appendChild(ta)
        ta.select()
        try {
          document.execCommand('copy')
        } catch {
          /* ignore */
        }
        document.body.removeChild(ta)
        done()
      }
    })
  })
}

function initReveal() {
  const els = [...document.querySelectorAll('.reveal')]
  const stmt = document.querySelector('.statement')
  if (reduceMotion || !('IntersectionObserver' in window)) {
    els.forEach((el) => el.classList.add('in'))
    if (stmt) stmt.classList.add('in')
    return
  }
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((en) => {
        if (en.isIntersecting) {
          en.target.classList.add('in')
          io.unobserve(en.target)
        }
      })
    },
    {threshold: 0.12, rootMargin: '0px 0px -8% 0px'},
  )
  els.forEach((el) => io.observe(el))

  if (stmt) {
    const io2 = new IntersectionObserver(
      (entries) => {
        entries.forEach((en) => {
          if (en.isIntersecting) {
            en.target.classList.add('in')
            io2.unobserve(en.target)
          }
        })
      },
      {threshold: 0.4},
    )
    io2.observe(stmt)
  }
}

function initNav() {
  const nav = document.querySelector('.site-nav')
  if (!nav) return
  const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 12)
  onScroll()
  window.addEventListener('scroll', onScroll, {passive: true})
}

function initFinder() {
  const tree = document.querySelector('.tree')
  const pathLabel = document.getElementById('path-label')
  if (!tree) return

  const views = {}
  document.querySelectorAll('.pane-view').forEach((v) => {
    views[v.id.replace('view-', '')] = v
  })

  function showView(name, path) {
    Object.keys(views).forEach((k) => {
      const el = views[k]
      const on = k === name
      el.hidden = !on
      el.classList.toggle('active', on)
    })
    tree.querySelectorAll('.tree-item').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-view') === name)
    })
    if (pathLabel && path) pathLabel.textContent = path
    const pane = document.getElementById('pane')
    if (pane) pane.scrollTop = 0
  }

  tree.addEventListener('click', (e) => {
    const btn = e.target.closest('.tree-item')
    if (!btn) return
    showView(btn.getAttribute('data-view'), btn.getAttribute('data-path'))
  })
}

function startUi() {
  if (uiStarted) return
  uiStarted = true
  currentLang = detectLang()
  initLangSwitch()
  initNav()
  initReveal()
  initFinder()
  bindCopy(document)
}

async function bootVisualEditing() {
  if (!isPreview || visualEditingReady) return
  visualEditingReady = true
  try {
    const {enableVisualEditing} = await import('./visual-editing.js')
    enableVisualEditing({
    refresh: async (payload) => {
      if (payload.source === 'mutation' || payload.source === 'manual') {
        const fresh = await client.fetch(QUERY)
        applyContent(fresh)
        return
      }
      return false
    },
    history: {
      subscribe: (navigate) => {
        const handler = () => navigate({type: 'pop', url: location.href})
        addEventListener('popstate', handler)
        return () => removeEventListener('popstate', handler)
      },
      update: (update) => {
        if (update.type === 'push') history.pushState(null, '', update.url)
        if (update.type === 'replace') history.replaceState(null, '', update.url)
      },
    },
  })
  } catch (err) {
    console.error('[DotAIOS] Visual editing failed to start:', err)
  }
}

async function loadContent() {
  currentLang = detectLang()

  // Never flash blank: bundled i18n.js is the default until Sanity has real copy.
  if (window.DOTAIOS_I18N) applyLang(currentLang)

  try {
    const doc = await client.fetch(QUERY)
    if (sanityHasContent(doc)) applyContent(doc)
  } catch {
    /* keep bundled i18n.js */
  }

  startUi()
  await bootVisualEditing()
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', loadContent)
} else {
  loadContent()
}
