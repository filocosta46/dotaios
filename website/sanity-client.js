import {createClient} from 'https://esm.sh/@sanity/client@6'

const PROJECT_ID = 'h7araeal'
const DATASET = 'production'
const STUDIO_URL = 'https://dotaios.sanity.studio'

const isPreview =
  new URLSearchParams(location.search).has('sanity-preview-perspective') ||
  new URLSearchParams(location.search).has('sanity-preview-secret') ||
  window.self !== window.top

export const client = createClient({
  projectId: PROJECT_ID,
  dataset: DATASET,
  apiVersion: '2025-06-06',
  useCdn: !isPreview,
  perspective: isPreview ? 'drafts' : 'published',
  withCredentials: isPreview,
  stega: {
    enabled: isPreview,
    studioUrl: STUDIO_URL,
  },
})

export {isPreview, STUDIO_URL}
