import {siteHref} from '../site-page.js'

export default function Footer({lang, t}) {
  return (
    <footer className="site-footer section-shell">
      <a className="brand" href={siteHref('home', lang)} aria-label="DotAIOS">
        <span className="brand-mark" aria-hidden="true" />
        <span className="brand-name">DotAIOS</span>
      </a>
      <p>{t.footer.tagline}</p>
      <nav aria-label={t.footer.label}>
        <a href="https://github.com/filocosta46/dotaios">GitHub</a>
        <a href="https://github.com/filocosta46/dotaios/blob/main/docs/getting-started.md">{t.footer.docs}</a>
        <a href="https://github.com/filocosta46/dotaios/blob/main/docs/security.md">{t.footer.security}</a>
      </nav>
    </footer>
  )
}
