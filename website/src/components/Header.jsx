import {useEffect, useState} from 'react'
import {LANGUAGES} from '../content.js'
import {siteHref} from '../site-page.js'

export default function Header({lang, page, setLang, t}) {
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
      <a className="brand" href={siteHref('home', lang)} aria-label="DotAIOS" onClick={closeMenu}>
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
        <span className="nav-toggle-label">{menuOpen ? t.nav.close : t.nav.menu}</span>
        <span className="nav-toggle-icon" aria-hidden="true" />
      </button>
      <nav className={`nav${menuOpen ? ' nav--open' : ''}`} id="primary-nav" aria-label={t.nav.primaryLabel}>
        {page.id === 'consultantPack' ? (
          <>
            <a href={siteHref('home', lang)} onClick={closeMenu}>{t.nav.back}</a>
            <a href="#proof" onClick={closeMenu}>{t.nav.proof}</a>
            <a href="#included" onClick={closeMenu}>{t.nav.included}</a>
            <a href="#install" onClick={closeMenu}>{t.nav.install}</a>
          </>
        ) : (
          <>
            <a href="#foundation" onClick={closeMenu}>{t.nav.home}</a>
            <a href={siteHref('consultantPack', lang)} onClick={closeMenu}>{t.nav.pack}</a>
          </>
        )}
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
        {page.id === 'home' ? <a className="nav-cta" href="#setup" onClick={closeMenu}>{t.nav.cta}</a> : null}
      </nav>
      {menuOpen ? (
        <button className="nav-backdrop" type="button" aria-label={t.nav.close} onClick={closeMenu} />
      ) : null}
    </header>
  )
}
