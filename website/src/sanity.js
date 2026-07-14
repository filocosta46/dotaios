/**
 * Sanity hydration for the landing page.
 *
 * Loaded as an async chunk after first paint (see App.jsx), so the bundled
 * copy in content.js always renders first and the CMS can never block LCP.
 *
 * Stale-copy guard: the published document is applied ONLY when its
 * footerTagline mentions CURRENT_RELEASE (v1.22.0). Inside Studio preview
 * the gate is bypassed so Filippo can edit drafts live. This mirrors the
 * pre-React app.js behavior and prevents an outdated CMS document from
 * overwriting newer bundled copy.
 */
import {createClient} from '@sanity/client'
import {CURRENT_RELEASE} from './content.js'

const PROJECT_ID = 'h7araeal'
const DATASET = 'production'
const STUDIO_URL = 'https://dotaios.sanity.studio'
const QUERY = '*[_type == "landingPage"][0]'

const previewParams = new URLSearchParams(window.location.search)
const hasPreviewToken =
  previewParams.has('sanity-preview-perspective') || previewParams.has('sanity-preview-secret')
const isEmbedded = window.self !== window.top

// Overlays: Studio iframe. Drafts API: only when Studio passes preview params.
export const isPreview = hasPreviewToken || isEmbedded

function getClient() {
  return createClient({
    projectId: PROJECT_ID,
    dataset: DATASET,
    apiVersion: '2025-06-06',
    useCdn: !hasPreviewToken,
    perspective: hasPreviewToken ? 'drafts' : 'published',
    withCredentials: hasPreviewToken,
    stega: {
      enabled: isPreview,
      studioUrl: STUDIO_URL,
    },
  })
}

function releaseMatches(doc) {
  if (isPreview) return true
  const footer = doc?.footerTagline?.en ?? doc?.footerTagline
  return typeof footer === 'string' && footer.includes(CURRENT_RELEASE)
}

/** Localized string: returns undefined (not '') so merge() keeps the bundled value. */
function ls(field, lang) {
  const value = field && field[lang]
  return typeof value === 'string' && value.trim() ? value : undefined
}

/**
 * Preferred authoring path: a single `i18n` field on the document holding the
 * full dictionary (JSON string or object) in the same shape as content.js.
 */
function fromI18nBlob(doc) {
  if (!doc.i18n) return null
  let blob = doc.i18n
  if (typeof blob === 'string') {
    try {
      blob = JSON.parse(blob)
    } catch {
      return null
    }
  }
  return blob && blob.en && blob.it ? blob : null
}

/** Legacy per-field Studio schema, mapped onto the new dictionary shape. */
function fromLegacyFields(doc) {
  const build = (lang) => ({
    meta: {
      title: ls(doc.metaTitle, lang),
      description: ls(doc.metaDescription, lang),
    },
    skipLink: ls(doc.skipLink, lang),
    nav: {
      folder: ls(doc.navFolder, lang),
      ask: ls(doc.navAsk, lang),
      github: ls(doc.navGithub, lang),
      cta: ls(doc.navCta, lang),
      language: ls(doc.navLangAria, lang),
    },
    hero: {
      eyebrow: ls(doc.heroEyebrow, lang),
      title: ls(doc.heroH1, lang),
      intro: ls(doc.heroSub, lang),
      point: ls(doc.heroPoint, lang),
      promptLabel: ls(doc.installTitle, lang),
      promptHelp: ls(doc.installDesc, lang),
      terminal: ls(doc.installTerminalSummary, lang),
    },
    folder: {
      title: ls(doc.explorerTitle, lang),
      desc: ls(doc.explorerDesc, lang),
    },
    ask: {
      title: ls(doc.askTitle, lang),
      desc: ls(doc.askDesc, lang),
      examples: Array.isArray(doc.askItems)
        ? doc.askItems
            .map((row) => [ls(row.title, lang), ls(row.desc, lang)])
            .filter((pair) => pair[0] && pair[1])
        : undefined,
    },
    cta: {
      text: ls(doc.ctaText, lang),
      button: ls(doc.ctaBtn, lang),
    },
    footer: {
      tagline: ls(doc.footerTagline, lang),
      docs: ls(doc.footerDocs, lang),
    },
    copied: ls(doc.installCopied, lang),
    copy: ls(doc.installCopy, lang),
  })

  return {en: build('en'), it: build('it')}
}

/** Remote wins only where it has real content; everything else keeps bundled copy. */
function merge(base, patch) {
  if (patch === undefined || patch === null) return base
  if (Array.isArray(patch)) return patch.length ? patch : base
  if (typeof patch === 'object') {
    if (typeof base !== 'object' || base === null || Array.isArray(base)) return patch
    const out = {...base}
    for (const key of Object.keys(patch)) {
      out[key] = merge(base[key], patch[key])
    }
    return out
  }
  if (typeof patch === 'string') return patch.trim() ? patch : base
  return patch
}

async function enableStudioOverlays() {
  try {
    const {enableVisualEditing} = await import('@sanity/visual-editing')
    enableVisualEditing()
  } catch {
    /* overlays are a Studio nicety; hydration works without them */
  }
}

export async function loadRemoteDictionary(bundled) {
  const doc = await getClient().fetch(QUERY)
  if (isPreview) enableStudioOverlays()
  if (!doc || !releaseMatches(doc)) return null

  const remote = fromI18nBlob(doc) || fromLegacyFields(doc)
  if (!remote) return null

  return {
    en: merge(bundled.en, remote.en),
    it: merge(bundled.it, remote.it),
  }
}
