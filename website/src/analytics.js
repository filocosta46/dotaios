import {PUBLIC_EVENT_NAMES} from './offer.js'

const allowed = new Set(PUBLIC_EVENT_NAMES)

export function trackPublicIntent(name, language) {
  if (!allowed.has(name)) {
    throw new Error(`Unknown public intent event: ${name}`)
  }

  // Public adapter surface only. A host can listen without coupling this
  // local-first page to a tracking vendor or persisting visitor activity.
  const detail = {
    name,
    language: language === 'it' ? 'it' : 'en',
  }

  window.dispatchEvent(new CustomEvent('dotaios:interaction', {detail}))
  return detail
}
