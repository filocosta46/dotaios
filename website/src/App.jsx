import {useCallback, useEffect, useState} from 'react'
import {COPY, DEFAULT_LANG, LANG_STORAGE_KEY, dictionary} from './content.js'
import {trackPublicIntent} from './analytics.js'
import ConsultantPackPage from './components/ConsultantPack.jsx'
import Footer from './components/Footer.jsx'
import HomePage from './components/Foundation.jsx'
import Header from './components/Header.jsx'
import {localeUrlsFor, resolveSitePage} from './site-page.js'

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

function updateMeta(copy, page, lang) {
  const meta = copy.meta[page.id]
  const urls = localeUrlsFor(page.id)
  const canonical = document.querySelector('link[rel="canonical"]')

  document.documentElement.lang = lang
  document.title = meta.title
  document.querySelector('meta[name="description"]')?.setAttribute('content', meta.description)
  document.querySelector('meta[property="og:title"]')?.setAttribute('content', meta.title)
  document.querySelector('meta[property="og:description"]')?.setAttribute('content', meta.description)
  document.querySelector('meta[property="og:locale"]')?.setAttribute('content', lang === 'it' ? 'it_IT' : 'en_US')
  canonical?.setAttribute('href', urls[lang] || urls.canonical)
  document.querySelector('link[hreflang="en"]')?.setAttribute('href', urls.en)
  document.querySelector('link[hreflang="it"]')?.setAttribute('href', urls.it)
  document.querySelector('link[hreflang="x-default"]')?.setAttribute('href', urls.canonical)
}

export default function App() {
  const page = resolveSitePage(window.location.pathname)
  const [lang, setLangState] = useState(detectLanguage)
  const [dict, setDict] = useState(dictionary)
  const t = dict[lang] || dict[DEFAULT_LANG]
  const prompt = COPY.installPrompt[lang]
  const onIntent = useCallback((name) => trackPublicIntent(name, lang), [lang])

  function setLang(nextLang) {
    if (nextLang === lang) return

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

  useEffect(() => updateMeta(t, page, lang), [t, page, lang])

  useEffect(() => {
    let cancelled = false
    import('./sanity.js')
      .then((mod) => mod.loadRemoteDictionary(dictionary))
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
    <div className={`site-root site-root--${page.id}`}>
      <a className="skip-link" href={page.id === 'consultantPack' ? '#pack-top' : '#setup'}>{t.skipLink}</a>
      <Header lang={lang} page={page} setLang={setLang} t={t} />
      <main className="site-main">
        {page.id === 'consultantPack'
          ? <ConsultantPackPage lang={lang} t={t} onIntent={onIntent} />
          : <HomePage lang={lang} t={t} prompt={prompt} onIntent={onIntent} />}
      </main>
      <Footer lang={lang} t={t} />
    </div>
  )
}
