import {useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react'
import gsap from 'gsap'
import {ScrollTrigger} from 'gsap/ScrollTrigger'
import {
  COPY,
  CURRENT_COPY_RELEASE,
  DEFAULT_LANG,
  LANG_STORAGE_KEY,
  LANGUAGES,
  dictionary,
  folderViews,
} from './content.js'
import MacWindow from './MacWindow.jsx'

gsap.registerPlugin(ScrollTrigger)

function renderHeroLine(text) {
  return text.split(/(\s+)/).map((part, index) =>
    /[-‑]/.test(part) ? (
      <span className="hero-title-word" key={`${part}-${index}`}>
        {part}
      </span>
    ) : (
      part
    ),
  )
}

function detectLanguage() {
  const params = new URLSearchParams(window.location.search)
  const fromUrl = params.get('lang')
  if (dictionary[fromUrl]) return fromUrl

  try {
    const stored = localStorage.getItem(LANG_STORAGE_KEY)
    if (dictionary[stored]) return stored
  } catch {
    /* Keep the default language. */
  }

  return navigator.language?.toLowerCase().startsWith('it') ? 'it' : DEFAULT_LANG
}

function updateMeta(copy, lang) {
  document.documentElement.lang = lang
  document.title = copy.meta.title
  document.querySelector('meta[name="description"]')?.setAttribute('content', copy.meta.description)
  document.querySelector('meta[property="og:title"]')?.setAttribute('content', copy.meta.title)
  document
    .querySelector('meta[property="og:description"]')
    ?.setAttribute('content', copy.meta.description)
}

function useGsapScenes(rootRef, lang, content) {
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return undefined

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const ctx = gsap.context(() => {
      if (reduceMotion) return

      root.querySelectorAll('[data-scale-fade]').forEach((element) => {
        gsap.fromTo(
          element,
          {scale: 0.93, opacity: 0.68},
          {
            scale: 1,
            opacity: 1,
            ease: 'none',
            scrollTrigger: {
              trigger: element,
              start: 'top 92%',
              end: 'bottom 18%',
              scrub: true,
            },
          },
        )
      })

      const pinRoot = root.querySelector('[data-pin-root]')
      const pinCopy = root.querySelector('[data-pin-copy]')
      if (pinRoot && pinCopy && window.matchMedia('(min-width: 900px)').matches) {
        ScrollTrigger.create({
          trigger: pinRoot,
          pin: pinCopy,
          start: 'top top+=112',
          end: 'bottom bottom-=96',
          pinSpacing: false,
          invalidateOnRefresh: true,
        })
      }
    }, root)

    return () => ctx.revert()
  }, [rootRef, lang, content])
}

function CopyButton({text, label, copiedLabel, className = ''}) {
  const [copied, setCopied] = useState(false)
  const timer = useRef(null)

  async function copyText() {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      const area = document.createElement('textarea')
      area.value = text
      area.setAttribute('readonly', '')
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.append(area)
      area.select()
      document.execCommand('copy')
      area.remove()
    }

    setCopied(true)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopied(false), 1800)
  }

  useEffect(() => () => window.clearTimeout(timer.current), [])

  return (
    <button
      className={`button ${className}`.trim()}
      type="button"
      onClick={copyText}
      aria-live="polite"
    >
      <span>{copied ? copiedLabel : label}</span>
      <span className="button-arrow" aria-hidden="true">
        {copied ? '✓' : '↗'}
      </span>
    </button>
  )
}

function Header({lang, setLang, t}) {
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    if (!menuOpen) return undefined

    function onKeyDown(event) {
      if (event.key === 'Escape') setMenuOpen(false)
    }

    document.body.classList.add('nav-menu-open')
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.classList.remove('nav-menu-open')
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [menuOpen])

  function closeMenu() {
    setMenuOpen(false)
  }

  return (
    <header className={`site-header${menuOpen ? ' site-header--menu-open' : ''}`}>
      <a className="brand" href="#setup" aria-label="DotAIOS" onClick={closeMenu}>
        <span className="brand-mark" aria-hidden="true" />
        <span className="brand-name">DotAIOS</span>
      </a>
      <button
        className="nav-toggle"
        type="button"
        aria-expanded={menuOpen}
        aria-controls="primary-nav"
        onClick={() => setMenuOpen((open) => !open)}
      >
        <span className="nav-toggle-label">{menuOpen ? 'Close' : 'Menu'}</span>
        <span className="nav-toggle-icon" aria-hidden="true" />
      </button>
      <nav className={`nav${menuOpen ? ' nav--open' : ''}`} id="primary-nav" aria-label="Primary">
        <a href="#folder" onClick={closeMenu}>
          {t.nav.folder}
        </a>
        <a href="#how" onClick={closeMenu}>
          {t.nav.how}
        </a>
        <a href="#packs" onClick={closeMenu}>
          {t.nav.packs}
        </a>
        <a href="https://github.com/filocosta46/dotaios" target="_blank" rel="noreferrer" onClick={closeMenu}>
          {t.nav.github}
        </a>
        <div className="language-switch" role="group" aria-label={t.nav.language}>
          {LANGUAGES.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={lang === item.id}
              onClick={() => setLang(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <a className="nav-cta" href="#setup" onClick={closeMenu}>
          {t.nav.cta}
        </a>
      </nav>
      {menuOpen ? (
        <button className="nav-backdrop" type="button" aria-label="Close menu" onClick={closeMenu} />
      ) : null}
    </header>
  )
}

function FinderPreview({t}) {
  const [active, setActive] = useState(folderViews[0].id)
  const activeItem = folderViews.find((item) => item.id === active) || folderViews[0]
  const view = t.folder.views[activeItem.id]

  return (
    <div className="finder-preview">
      <MacWindow title="DotAIOS" variant="finder" className="finder-window finder-window--hero">
        <div className="finder-toolbar">
          <div className="finder-toolbar-left" aria-hidden="true">
            <span className="finder-toolbar-button finder-toolbar-button--back" />
            <span className="finder-toolbar-button finder-toolbar-button--forward" />
          </div>
          <span className="finder-toolbar-title">{activeItem.name}</span>
          <div className="finder-toolbar-right" aria-hidden="true">
            <span className="finder-toolbar-grid" />
            <span className="finder-toolbar-search" />
          </div>
        </div>
        <div className="finder-body">
          <nav className="finder-sidebar" aria-label={t.folder.tabsLabel}>
            <p className="finder-sidebar-heading">{t.folder.sidebarHeading}</p>
            {folderViews.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`finder-sidebar-item${active === item.id ? ' active' : ''}`}
                aria-pressed={active === item.id}
                onClick={() => setActive(item.id)}
              >
                <span className="finder-folder-icon" aria-hidden="true" />
                <span>{item.name}</span>
              </button>
            ))}
          </nav>
          <article className="finder-pane" key={activeItem.id}>
            <div className="finder-pane-heading">
              <span className="finder-folder-icon finder-folder-icon--large" aria-hidden="true" />
              <div>
                <h3>{activeItem.name}</h3>
                <p>{activeItem.path}</p>
              </div>
            </div>
            <p className="finder-pane-lead">{view.lead}</p>
            <p className="finder-pane-body">{view.body}</p>
            <div className="finder-file-list">
              {view.files.map(([name, description]) => (
                <div className="finder-file-row" key={name}>
                  <span className={`finder-file-icon${name.endsWith('/') ? ' finder-file-icon--folder' : ''}`} aria-hidden="true" />
                  <strong>{name}</strong>
                  <span>{description}</span>
                  <span className="finder-row-arrow" aria-hidden="true">›</span>
                </div>
              ))}
            </div>
          </article>
        </div>
      </MacWindow>
    </div>
  )
}

function Hero({t, prompt}) {
  return (
    <section className="hero section-shell" id="setup">
      <div className="hero-copy">
        <p className="hero-eyebrow">{t.hero.eyebrow}</p>
        <h1 className="hero-title">
          <span>{renderHeroLine(t.hero.titleLine1)}</span>
          <span>{t.hero.titleLine2}</span>
        </h1>
        <p className="hero-intro">{t.hero.intro}</p>
        <div className="hero-actions">
          <CopyButton
            text={prompt}
            label={t.hero.primary}
            copiedLabel={t.hero.copied}
            className="button-primary"
          />
          <a className="button button-secondary" href="#folder">
            <span>{t.hero.secondary}</span>
            <span className="button-arrow" aria-hidden="true">↓</span>
          </a>
        </div>
        <p className="hero-note">{t.hero.note}</p>
      </div>
      <div className="hero-stage" data-scale-fade>
        <FinderPreview t={t} />
      </div>
    </section>
  )
}

function ShelfPreview({active, view, tabId}) {
  return (
    <div
      className="shelf-preview"
      id="folder-preview"
      role="tabpanel"
      aria-labelledby={tabId}
      tabIndex={0}
      data-scale-fade
    >
      <div className="shelf-preview-top">
        <span className="shelf-preview-path">~/aios/{active}/</span>
        <span className="shelf-preview-dot" aria-hidden="true" />
      </div>
      <div className="shelf-preview-center">
        <span className="finder-folder-icon finder-folder-icon--hero" aria-hidden="true" />
        <strong>{active}</strong>
        <span>{view.lead}</span>
      </div>
      <div className="shelf-preview-files">
        {view.files.map(([name]) => (
          <span key={name}>{name}</span>
        ))}
      </div>
    </div>
  )
}

function FolderSection({t}) {
  const [active, setActive] = useState(folderViews[0].id)
  const view = t.folder.views[active]

  function handleTabKeyDown(event, index) {
    let nextIndex = index
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (index + 1) % folderViews.length
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = (index - 1 + folderViews.length) % folderViews.length
    if (event.key === 'Home') nextIndex = 0
    if (event.key === 'End') nextIndex = folderViews.length - 1
    if (nextIndex === index) return

    event.preventDefault()
    const next = folderViews[nextIndex]
    setActive(next.id)
    window.requestAnimationFrame(() => document.getElementById(`folder-tab-${next.id}`)?.focus())
  }

  return (
    <section className="continuity section-shell" id="folder" data-pin-root>
      <div className="continuity-copy" data-pin-copy>
        <p className="section-eyebrow">{t.folder.eyebrow}</p>
        <h2>{t.folder.title}</h2>
        <p>{t.folder.desc}</p>
      </div>
      <div className="continuity-content">
        <div className="shelf-accordion" role="tablist" aria-label={t.folder.tabsLabel}>
          {folderViews.map((item, index) => {
            const itemView = t.folder.views[item.id]
            return (
              <button
                key={item.id}
                id={`folder-tab-${item.id}`}
                className={`shelf-row${active === item.id ? ' active' : ''}`}
                type="button"
                role="tab"
                aria-selected={active === item.id}
                aria-controls="folder-preview"
                tabIndex={active === item.id ? 0 : -1}
                onClick={() => setActive(item.id)}
                onKeyDown={(event) => handleTabKeyDown(event, index)}
              >
                <span className="shelf-row-name">{item.name}</span>
                <span className="shelf-row-copy">{itemView.lead}</span>
                <span className="shelf-row-arrow" aria-hidden="true">↗</span>
              </button>
            )
          })}
        </div>
        <ShelfPreview active={active} view={view} tabId={`folder-tab-${active}`} />
      </div>
    </section>
  )
}

function HowSection({t}) {
  return (
    <section className="how-section section-shell" id="how">
      <div className="how-heading">
        <p className="section-eyebrow">{t.how.eyebrow}</p>
        <h2>{t.how.title}</h2>
        <p>{t.how.desc}</p>
      </div>
      <div className="how-grid" role="list">
        {t.how.steps.map(([number, title, detail]) => (
          <article className="how-step" key={number} role="listitem">
            <span className="how-step-number">{number}</span>
            <h3>{title}</h3>
            <p>{detail}</p>
          </article>
        ))}
      </div>
      <div className="activation-proof" data-scale-fade>
        <div>
          <span className="activation-proof-label">{t.how.proofLabel}</span>
          <p className="activation-proof-prompt">“{t.how.proofPrompt}”</p>
        </div>
        <p>{t.how.proofResult}</p>
      </div>
    </section>
  )
}

function AskSection({t}) {
  return (
    <section className="ask-section section-shell" id="ask">
      <div className="ask-heading">
        <p className="section-eyebrow">{t.ask.eyebrow}</p>
        <h2>
          {t.ask.title.split('. ')[0]}.{' '}
          <span className="inline-folder-glyph" aria-hidden="true" />
          {t.ask.title.split('. ')[1]}
        </h2>
        <p>{t.ask.desc}</p>
      </div>
      <div className="ask-grid" role="list">
        {t.ask.examples.map(([prompt, result]) => (
          <article className="ask-card" key={prompt} role="listitem">
            <span className="ask-card-dot" aria-hidden="true" />
            <p className="ask-card-prompt">{prompt}</p>
            <p className="ask-card-result">{result}</p>
          </article>
        ))}
      </div>
    </section>
  )
}

function CompatibilitySection({t}) {
  return (
    <section className="compatibility-section section-shell" id="compatibility">
      <div className="compatibility-heading">
        <p className="section-eyebrow">{t.compatibility.eyebrow}</p>
        <h2>{t.compatibility.title}</h2>
        <p>{t.compatibility.desc}</p>
      </div>
      <div className="compatibility-grid" role="list">
        {t.compatibility.cards.map(([title, detail], index) => (
          <article className="compatibility-card" key={title} role="listitem">
            <span>{String(index + 1).padStart(2, '0')}</span>
            <h3>{title}</h3>
            <p>{detail}</p>
          </article>
        ))}
      </div>
      <a
        className="compatibility-link"
        href="https://github.com/filocosta46/dotaios/blob/main/docs/client-support.md"
        target="_blank"
        rel="noreferrer"
      >
        {t.compatibility.matrixCta} <span aria-hidden="true">↗</span>
      </a>
    </section>
  )
}

function PacksSection({t}) {
  return (
    <section className="offer-section section-shell" id="packs">
      <div className="offer-intro">
        <div className="offer-heading">
          <p className="section-eyebrow">{t.packs.eyebrow}</p>
          <h2>{t.packs.title}</h2>
          <p>{t.packs.desc}</p>
        </div>
        <aside className="offer-summary" aria-label={t.packs.name}>
          <span className="offer-status">{t.packs.status}</span>
          <strong>{t.packs.name}</strong>
          <span className="offer-price">{t.packs.price}</span>
          <p>{t.packs.priceNote}</p>
          <a className="button button-offer" href="#setup">
            <span>{t.packs.cta}</span>
            <span className="button-arrow" aria-hidden="true">↑</span>
          </a>
          <small>{t.packs.gate}</small>
        </aside>
      </div>
      <p className="shortcut-label">{t.packs.includedLabel}</p>
      <div className="shortcut-list">
        {t.packs.items.map((item) => (
          <article className="shortcut-row" key={item.name}>
            <span className="shortcut-name">{item.name}</span>
            <span className="shortcut-copy">
              <span className="shortcut-outcome">{item.outcome}</span>
              <span className="shortcut-detail">{item.detail}</span>
            </span>
            <span className="shortcut-status">{item.cta}</span>
          </article>
        ))}
      </div>
    </section>
  )
}

function Footer({t}) {
  return (
    <footer className="site-footer section-shell">
      <a className="brand" href="#setup" aria-label="DotAIOS">
        <span className="brand-mark" aria-hidden="true" />
        <span className="brand-name">DotAIOS</span>
      </a>
      <p>{t.footer.tagline}</p>
      <nav aria-label="Footer">
        <a href="https://github.com/filocosta46/dotaios">GitHub</a>
        <a href="https://github.com/filocosta46/dotaios/blob/main/docs/getting-started.md">{t.footer.docs}</a>
        <a href="https://github.com/filocosta46/dotaios/blob/main/docs/client-support.md">{t.footer.support}</a>
        <a href="https://github.com/filocosta46/dotaios/blob/main/SECURITY.md">{t.footer.security}</a>
        <a href="https://github.com/filocosta46/dotaios/blob/main/docs/privacy.md">{t.footer.privacy}</a>
      </nav>
    </footer>
  )
}

export default function App() {
  const pageRef = useRef(null)
  const [lang, setLangState] = useState(detectLanguage)
  const [dict, setDict] = useState(dictionary)
  const t = useMemo(() => dict[lang] || dict[DEFAULT_LANG], [dict, lang])

  useGsapScenes(pageRef, lang, dict)

  function setLang(nextLang) {
    setLangState(nextLang)
    const url = new URL(window.location.href)
    url.searchParams.set('lang', nextLang)
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`)
    try {
      localStorage.setItem(LANG_STORAGE_KEY, nextLang)
    } catch {
      /* Keep language selection in memory. */
    }
  }

  useEffect(() => updateMeta(t, lang), [t, lang])

  useEffect(() => {
    let cancelled = false
    import('./sanity.js')
      .then((mod) => mod.loadRemoteDictionary(dictionary, CURRENT_COPY_RELEASE))
      .then((remote) => {
        if (!cancelled && remote) setDict(remote)
      })
      .catch(() => {
        /* Bundled copy remains the source of truth when Sanity is unavailable. */
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="site-root" ref={pageRef}>
      <a className="skip-link" href="#setup">Skip to setup</a>
      <Header lang={lang} setLang={setLang} t={t} />
      <main className="site-main">
        <Hero t={t} prompt={COPY.installPrompt[lang]} />
        <FolderSection t={t} />
        <HowSection t={t} />
        <AskSection t={t} />
        <CompatibilitySection t={t} />
        <PacksSection t={t} />
      </main>
      <Footer t={t} />
    </div>
  )
}
