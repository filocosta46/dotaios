import React, {useEffect, useMemo, useState} from 'react'
import {
  COPY,
  DEFAULT_LANG,
  LANG_STORAGE_KEY,
  LANGUAGES,
  dictionary,
  folderViews,
} from './content.js'

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

function updateMeta(copy) {
  document.documentElement.lang = copy === dictionary.it ? 'it' : 'en'
  document.title = copy.meta.title
  document.querySelector('meta[name="description"]')?.setAttribute('content', copy.meta.description)
  document.querySelector('meta[property="og:title"]')?.setAttribute('content', copy.meta.title)
  document
    .querySelector('meta[property="og:description"]')
    ?.setAttribute('content', copy.meta.description)
}

function Icon({type}) {
  return <span className={`icon icon-${type}`} aria-hidden="true" />
}

function CopySnippet({text, children, label}) {
  const [copied, setCopied] = useState(false)

  async function copyText() {
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

    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="snippet">
      <code>{children}</code>
      <button className={copied ? 'copied' : ''} type="button" onClick={copyText}>
        {copied ? label.copied : label.copy}
      </button>
    </div>
  )
}

function Header({lang, setLang, t}) {
  return (
    <header className="site-header">
      <a className="brand" href="#top" aria-label="DotAIOS">
        <span className="brand-mark" aria-hidden="true" />
        <span>DotAIOS</span>
      </a>
      <nav className="nav" aria-label="Primary">
        <a href="#folder">{t.nav.folder}</a>
        <a href="#ask">{t.nav.ask}</a>
        <a href="#packs">{t.nav.packs}</a>
        <a href="https://github.com/filocosta46/dotaios" target="_blank" rel="noreferrer">
          {t.nav.github}
        </a>
        <div className="language-switch" aria-label={t.nav.language}>
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
        <p className="eyebrow">{t.hero.eyebrow}</p>
        <h1>{t.hero.title}</h1>
        <p className="hero-intro">{t.hero.intro}</p>
        <ul className="tool-strip" aria-label="Supported tools">
          {t.hero.tools.map((tool) => (
            <li key={tool}>{tool}</li>
          ))}
        </ul>
      </div>

      <aside className="install-panel" id="install" aria-label={t.hero.promptLabel}>
        <div>
          <p className="panel-kicker">{t.hero.promptLabel}</p>
          <h2>{t.nav.cta}</h2>
          <p>{t.hero.promptHelp}</p>
        </div>
        <CopySnippet text={COPY.installPrompt} label={t}>
          <span className="prompt">›</span>
          <span>{COPY.installPrompt.replace('https://', '')}</span>
        </CopySnippet>
        <details>
          <summary>{t.hero.terminal}</summary>
          <CopySnippet text={COPY.terminalCommand} label={t}>
            <span className="prompt">$</span>
            <span>{COPY.terminalCommand}</span>
          </CopySnippet>
        </details>
      </aside>
    </section>
  )
}

function FolderPreview({t}) {
  const [active, setActive] = useState(folderViews[0].id)
  const activeItem = folderViews.find((item) => item.id === active) || folderViews[0]
  const view = t.folder.views[activeItem.id]

  return (
    <section className="section" id="folder">
      <SectionIntro title={t.folder.title} desc={t.folder.desc} />
      <div className="folder-preview">
        <div className="preview-topbar">
          <div className="window-dots" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <code>{activeItem.path}</code>
        </div>
        <div className="preview-body">
          <aside className="file-tree" aria-label={t.folder.tabsLabel}>
            {folderViews.map((item) => (
              <button
                key={item.id}
                type="button"
                className={active === item.id ? 'active' : ''}
                onClick={() => setActive(item.id)}
              >
                <Icon type={item.icon} />
                <span>{item.name}</span>
              </button>
            ))}
          </aside>
          <article className="document-pane">
            <header>
              <h3>{view.title}</h3>
            </header>
            <p className="lead">{view.lead}</p>
            {view.body ? <p>{view.body}</p> : null}
            {view.code ? <pre>{view.code}</pre> : null}
            {view.files ? (
              <div className="file-list">
                {view.files.map(([name, desc]) => (
                  <div className="file-row" key={name}>
                    <Icon type={name.endsWith('/') ? 'folder' : 'doc'} />
                    <div>
                      <strong>{name}</strong>
                      <span>{desc}</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </article>
        </div>
      </div>
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

function AskSection({t}) {
  return (
    <section className="section section-muted" id="ask">
      <SectionIntro title={t.ask.title} desc={t.ask.desc} />
      <div className="ask-grid">
        {t.ask.examples.map(([title, desc]) => (
          <article key={title}>
            <h3>{title}</h3>
            <p>{desc}</p>
          </article>
        ))}
      </div>
    </section>
  )
}

function Principles({t}) {
  return (
    <section className="section principles">
      <h2>{t.principles.title}</h2>
      <div className="principle-grid">
        {t.principles.items.map(([title, desc]) => (
          <article key={title}>
            <span aria-hidden="true" />
            <h3>{title}</h3>
            <p>{desc}</p>
          </article>
        ))}
      </div>
    </section>
  )
}

function Packs({t}) {
  return (
    <section className="section" id="packs">
      <SectionIntro title={t.packs.title} desc={t.packs.desc} />
      <div className="pack-grid">
        {t.packs.items.map((pack) => (
          <a className="pack-card" key={pack.href} href={pack.href} target="_blank" rel="noreferrer">
            <span>{pack.eyebrow}</span>
            <h3>{pack.title}</h3>
            <p>{pack.desc}</p>
            <div>
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

function BottomCta({t}) {
  return (
    <section className="bottom-cta">
      <p>{t.cta.text}</p>
      <CopySnippet text={COPY.installPrompt} label={t}>
        <span className="prompt">›</span>
        <span>{t.cta.button}</span>
      </CopySnippet>
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
      <nav>
        <a href="#folder">{t.nav.folder}</a>
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
  const t = useMemo(() => dictionary[lang] || dictionary[DEFAULT_LANG], [lang])

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

  useEffect(() => updateMeta(t), [t])

  return (
    <>
      <a className="skip-link" href="#install">
        {t.skipLink}
      </a>
      <div className="page-shell">
        <Header lang={lang} setLang={setLang} t={t} />
        <main>
          <Hero t={t} />
          <FolderPreview t={t} />
          <AskSection t={t} />
          <Principles t={t} />
          <Packs t={t} />
          <BottomCta t={t} />
        </main>
        <Footer t={t} />
      </div>
    </>
  )
}
