import {createClient} from 'https://esm.sh/@sanity/client@6'

const PROJECT_ID = 'h7araeal'
const DATASET = 'production'
const STUDIO_URL = 'https://dotaios.sanity.studio'

const previewParams = new URLSearchParams(location.search)
const hasPreviewToken =
  previewParams.has('sanity-preview-perspective') ||
  previewParams.has('sanity-preview-secret')
const isEmbedded = window.self !== window.top

// Overlays: Studio iframe. Drafts API: only when Studio passes preview params.
export const isPreview = hasPreviewToken || isEmbedded

export const client = createClient({
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

export {isPreview, STUDIO_URL}
