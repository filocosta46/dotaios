/**
 * Sanity hydration for the landing page.
 *
 * Loaded as an async chunk after first paint (see App.jsx), so the bundled
 * copy in content.js always renders first and the CMS can never block LCP.
 *
 * Stale-copy guard: the published document is applied ONLY when its
 * `copyRelease` field equals CURRENT_COPY_RELEASE. Inside Studio preview
 * the gate is bypassed so Filippo can edit drafts live. This prevents an
 * outdated CMS document from overwriting newer bundled copy.
 */
import {createClient} from '@sanity/client'
import {CURRENT_COPY_RELEASE} from './content.js'

const PROJECT_ID = 'h7araeal'
const DATASET = 'production'
const STUDIO_URL = 'https://dotaios.sanity.studio'
const QUERY = `*[_type == "landingPage"][0]{
  copyRelease,
  i18n,
  footerTagline,
  footerDocs
}`

const browserWindow = typeof window === 'undefined' ? null : window
const previewParams = new URLSearchParams(browserWindow?.location.search ?? '')
const hasPreviewToken =
  previewParams.has('sanity-preview-perspective') || previewParams.has('sanity-preview-secret')
const isEmbedded = browserWindow ? browserWindow.self !== browserWindow.top : false

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

/** Legacy footer fields retained while Studio transitions to the i18n blob. */
function fromLegacyFields(doc) {
  const build = (lang) => ({
    footer: {
      tagline: ls(doc.footerTagline, lang),
      docs: ls(doc.footerDocs, lang),
    },
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

function editorialPatch(remote, lang) {
  const localized = remote?.[lang]
  if (!localized || typeof localized !== 'object') return {}

  // Price, readiness, evidence, navigation, and conversion copy are code-owned
  // so the claims reviewed in CI are the claims a visitor receives.
  return {
    folder: localized.folder,
    footer: localized.footer,
  }
}

export function buildRemoteDictionary(
  bundled,
  doc,
  {preview = false, currentRelease = CURRENT_COPY_RELEASE} = {},
) {
  if (!doc || (!preview && doc.copyRelease !== currentRelease)) return null

  const remote = fromI18nBlob(doc) || fromLegacyFields(doc)
  if (!remote) return null

  return {
    en: merge(bundled.en, editorialPatch(remote, 'en')),
    it: merge(bundled.it, editorialPatch(remote, 'it')),
  }
}

export async function loadRemoteDictionary(bundled) {
  const doc = await getClient().fetch(QUERY)
  return buildRemoteDictionary(bundled, doc, {preview: isPreview})
}
