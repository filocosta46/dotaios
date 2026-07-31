const SITE_ORIGIN = 'https://dotaios.vercel.app'

const pages = Object.freeze({
  home: Object.freeze({id: 'home', path: '/'}),
  consultantPack: Object.freeze({id: 'consultantPack', path: '/consultant-pack/'}),
})

export const PAGE_IDS = Object.freeze(Object.keys(pages))

function normalizePath(pathname = '/') {
  const normalized = `/${String(pathname).split('?')[0].split('#')[0].replace(/^\/+|\/+$/g, '')}`
  return normalized === '/' ? '/' : `${normalized}/`
}

export function resolveSitePage(pathname) {
  return normalizePath(pathname) === pages.consultantPack.path ? pages.consultantPack : pages.home
}

export function siteHref(pageId, lang) {
  const path = pages[pageId]?.path || pages.home.path
  return lang === 'en' || lang === 'it' ? `${path}?lang=${lang}` : path
}

export function localeUrlsFor(pageId) {
  const path = siteHref(pageId)
  const canonical = `${SITE_ORIGIN}${path}`
  return Object.freeze({
    canonical,
    en: `${canonical}?lang=en`,
    it: `${canonical}?lang=it`,
  })
}
