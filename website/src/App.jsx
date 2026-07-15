import React, {useEffect, useMemo, useRef, useState} from 'react'
import {
  COPY,
  DEFAULT_LANG,
  LANG_STORAGE_KEY,
  LANGUAGES,
  dictionary,
  folderViews,
} from './content.js'
import MacWindow from './MacWindow.jsx'
import useScrollNav from './useScrollNav.js'

function detectLanguage() {
  const params = new URLSearchParams(window.location.search)
  const fromUrl = params.get('lang')
  if (dictionary[fromUrl]) return fromUrl

  try {
    const stored = localStorage.getItem(LANG_STORAGE_KEY)
    if (dictionary[stored]) return stored
  } catch {
    /* keep default */
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

/**
 * Reveal-on-scroll: adds .revealed to [data-reveal] elements the first time
 * they enter the viewport. The initial hidden state only applies once the
 * root has .reveal-ready, so content stays visible without JS and under
 * prefers-reduced-motion (handled in CSS).
 */
function useReveal(deps) {
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return undefined

    document.documentElement.classList.add('reveal-ready')
    const targets = document.querySelectorAll('[data-reveal]:not(.revealed)')
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add('revealed')
            observer.unobserve(entry.target)
          }
        }
      },
      {rootMargin: '0px 0px -8% 0px', threshold: 0.1},
    )

    targets.forEach((el) => observer.observe(el))
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}

function Icon({type}) {
  return <span className={`icon icon-${type}`} aria-hidden="true" />
}

function CopySnippet({text, children, label}) {
  const [copied, setCopied] = useState(false)
  const timer = useRef(null)

  async function copyText() {
    setCopied(true)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopied(false), 1600)

    try {
      await navigator.clipboard.writeText(text)
    } catch {
      const area = document.createElement('textarea')
      area.value = text
      document.body.append(area)
      area.select()
      document.execCommand('copy')
      area.remove()
    }
  }

  useEffect(() => () => window.clearTimeout(timer.current), [])

  return (
    <div className="snippet">
      <code>{children}</code>
      <button className={copied ? 'copied' : ''} type="button" onClick={copyText}>
        {copied ? label.copied : label.copy}
      </button>
    </div>
  )
}

function Header({lang, setLang, t, navState}) {
  return (
    <header className={`site-header site-header--${navState}`}>
      <a className="brand" href="#top" aria-label="DotAIOS">
        <span className="brand-mark" aria-hidden="true" />
        <span>DotAIOS</span>
      </a>
      <nav className="nav" aria-label="Primary">
        <a href="#explorer">{t.nav.folder}</a>
        <a href="#ask">{t.nav.ask}</a>
        <a href="#packs">{t.nav.packs}</a>
        <a href="https://github.com/filocosta46/dotaios" target="_blank" rel="noreferrer">
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
        <a className="nav-cta" href="#install">
          {t.nav.cta}
        </a>
      </nav>
    </header>
  )
}

function Hero({t}) {
  return (
    <section className="hero" id="top">
      <div className="hero-copy">
        <h1>{t.hero.title}</h1>
        <p className="hero-intro">{t.hero.intro}</p>
        {t.hero.toolsLine ? <p className="hero-tools">{t.hero.toolsLine}</p> : null}
      </div>

      <aside className="install-panel" id="install" aria-label={t.hero.promptLabel}>
        <div>
          <p className="panel-kicker">{t.hero.promptLabel}</p>
          <p className="panel-help">{t.hero.promptHelp}</p>
        </div>
        <CopySnippet text={COPY.installPrompt} label={t}>
          <span className="prompt" aria-hidden="true">
            ›
          </span>
          <span>{COPY.installPrompt}</span>
        </CopySnippet>
        <details>
          <summary>{t.hero.terminal}</summary>
          <CopySnippet text={COPY.terminalCommand} label={t}>
            <span className="prompt" aria-hidden="true">
              $
            </span>
            <span>{COPY.terminalCommand}</span>
          </CopySnippet>
        </details>
      </aside>
    </section>
  )
}

function SectionIntro({title, desc}) {
  return (
    <div className="section-intro">
      <h2>{title}</h2>
      <p>{desc}</p>
    </div>
  )
}

function FinderToolbar({title}) {
  return (
    <div className="finder-toolbar">
      <div className="finder-nav-pill" aria-hidden="true">
        <span className="finder-nav-btn finder-nav-btn--back" />
        <span className="finder-nav-btn finder-nav-btn--forward" />
      </div>
      <span className="finder-toolbar-title">{title}</span>
      <div className="finder-toolbar-actions" aria-hidden="true">
        <span className="finder-view-pill">
          <span className="finder-view-icon" />
          <span className="finder-view-icon finder-view-icon--active" />
          <span className="finder-view-icon" />
        </span>
        <span className="finder-action-icon" />
        <span className="finder-action-icon finder-action-icon--share" />
        <span className="finder-search-icon" />
      </div>
    </div>
  )
}

function FolderExplorer({t}) {
  const [active, setActive] = useState(folderViews[0].id)
  const activeItem = folderViews.find((item) => item.id === active) || folderViews[0]
  const view = t.folder.views[activeItem.id]

  return (
    <section className="section section-explorer" id="explorer" data-reveal>
      <SectionIntro title={t.folder.title} desc={t.folder.desc} />
      <MacWindow title="DotAIOS" variant="finder" className="finder-window">
        <FinderToolbar title={activeItem.name} />
        <div className="finder-body">
          <nav className="finder-sidebar" aria-label={t.folder.tabsLabel}>
            <p className="finder-sidebar-heading">{t.folder.sidebarHeading || 'Favorites'}</p>
            {folderViews.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`finder-sidebar-item${active === item.id ? ' active' : ''}`}
                aria-pressed={active === item.id}
                onClick={() => setActive(item.id)}
              >
                <Icon type="folder" />
                <span>{item.name}</span>
              </button>
            ))}
          </nav>
          <article className="finder-content" key={activeItem.id}>
            <header className="finder-content-header">
              <Icon type="folder" />
              <div>
                <h3>{view.title}</h3>
                <p className="finder-path">{activeItem.path}</p>
              </div>
            </header>
            <p className="finder-lead">{view.lead}</p>
            {view.body ? <p className="finder-body-text">{view.body}</p> : null}
            {view.files ? (
              <div className="finder-file-grid">
                {view.files.map(([name, desc]) => (
                  <div className="finder-file-item" key={name}>
                    <Icon type={name.endsWith('/') ? 'folder' : 'doc'} />
                    <strong>{name}</strong>
                    <span>{desc}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </article>
        </div>
      </MacWindow>
    </section>
  )
}

function AskSection({t}) {
  return (
    <section className="section" id="ask" data-reveal>
      <SectionIntro title={t.ask.title} desc={t.ask.desc} />
      <div className="ask-grid">
        {t.ask.examples.map(([title, desc], index) => (
          <article key={title} style={{'--stagger': index}}>
            <p className="ask-bubble">{title}</p>
            <p className="ask-result">{desc}</p>
          </article>
        ))}
      </div>
    </section>
  )
}

function Packs({t}) {
  return (
    <section className="section" id="packs" data-reveal>
      <SectionIntro title={t.packs.title} desc={t.packs.desc} />
      <div className="pack-grid">
        {t.packs.items.map((pack, index) => (
          <a
            className="pack-card"
            key={pack.href}
            href={pack.href}
            target="_blank"
            rel="noreferrer"
            style={{'--stagger': index}}
          >
            <span className="pack-eyebrow">{pack.eyebrow}</span>
            <h3>{pack.title}</h3>
            <p>{pack.desc}</p>
            <div className="pack-foot">
              <strong>{pack.price}</strong>
              <em>{pack.cta}</em>
            </div>
          </a>
        ))}
      </div>
      <p className="section-note">{t.packs.note}</p>
    </section>
  )
}

function Footer({t}) {
  return (
    <footer className="site-footer">
      <div>
        <a className="brand" href="#top">
          <span className="brand-mark" aria-hidden="true" />
          <span>DotAIOS</span>
        </a>
        <p>{t.footer.tagline}</p>
      </div>
      <nav aria-label="Footer">
        <a href="#explorer">{t.nav.folder}</a>
        <a href="#ask">{t.nav.ask}</a>
        <a href="#packs">{t.nav.packs}</a>
        <a href="https://github.com/filocosta46/dotaios/blob/main/docs/getting-started.md">
          {t.footer.docs}
        </a>
        <a href="https://github.com/filocosta46/dotaios">{t.nav.github}</a>
      </nav>
    </footer>
  )
}

export default function App() {
  const [lang, setLangState] = useState(detectLanguage)
  const [dict, setDict] = useState(dictionary)
  const navState = useScrollNav()
  const t = useMemo(() => dict[lang] || dict[DEFAULT_LANG], [dict, lang])

  function setLang(nextLang) {
    setLangState(nextLang)
    const url = new URL(window.location.href)
    url.searchParams.set('lang', nextLang)
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`)
    try {
      localStorage.setItem(LANG_STORAGE_KEY, nextLang)
    } catch {
      /* ignore */
    }
  }

  useEffect(() => updateMeta(t, lang), [t, lang])

  // Copy stays bundled for first paint; Sanity hydrates after mount when the
  // published document targets this release (or inside Studio preview).
  useEffect(() => {
    let cancelled = false
    import('./sanity.js')
      .then((mod) => mod.loadRemoteDictionary(dictionary))
      .then((remote) => {
        if (!cancelled && remote) setDict(remote)
      })
      .catch(() => {
        /* offline or CMS unreachable: bundled copy is the fallback */
      })
    return () => {
      cancelled = true
    }
  }, [])

  useReveal([dict])

  return (
    <>
      <a className="skip-link" href="#install">
        {t.skipLink}
      </a>
      <div className="page-shell">
        <Header lang={lang} setLang={setLang} t={t} navState={navState} />
        <main>
          <Hero t={t} />
          <FolderExplorer t={t} />
          <AskSection t={t} />
          <Packs t={t} />
        </main>
        <Footer t={t} />
      </div>
    </>
  )
}
