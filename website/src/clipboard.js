export async function copyTextToClipboard(
  text,
  {navigatorRef = globalThis.navigator, documentRef = globalThis.document} = {},
) {
  try {
    if (navigatorRef?.clipboard?.writeText) {
      await navigatorRef.clipboard.writeText(text)
      return true
    }
  } catch {
    // Fall back to the legacy selection path below.
  }

  let area

  try {
    area = documentRef.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    documentRef.body.append(area)
    area.select()
    return documentRef.execCommand('copy') === true
  } catch {
    return false
  } finally {
    area?.remove()
  }
}
