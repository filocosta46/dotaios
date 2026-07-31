import {useEffect, useRef, useState} from 'react'
import {copyTextToClipboard} from '../clipboard.js'

export default function CopyButton({
  text,
  label,
  copiedLabel,
  failedLabel,
  className = '',
  eventName,
  onIntent,
}) {
  const [status, setStatus] = useState('idle')
  const timer = useRef(null)
  const fallback = useRef(null)

  async function copyText() {
    const copied = await copyTextToClipboard(text)

    setStatus(copied ? 'copied' : 'failed')
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setStatus('idle'), 1800)

    if (copied && eventName) onIntent?.(eventName)
  }

  useEffect(() => () => window.clearTimeout(timer.current), [])

  useEffect(() => {
    if (status !== 'failed') return
    fallback.current?.focus()
    fallback.current?.select()
  }, [status])

  let feedbackLabel = label
  let feedbackIcon = '↗'
  if (status === 'copied') {
    feedbackLabel = copiedLabel
    feedbackIcon = '✓'
  } else if (status === 'failed') {
    feedbackLabel = failedLabel
    feedbackIcon = '!'
  }

  return (
    <div className="copy-control">
      <button
        className={`button ${className}`.trim()}
        type="button"
        onClick={copyText}
        data-intent={eventName || undefined}
      >
        <span aria-live="polite">{feedbackLabel}</span>
        <span className="button-arrow" aria-hidden="true">
          {feedbackIcon}
        </span>
      </button>
      {status === 'failed' ? (
        <textarea
          ref={fallback}
          className="copy-fallback"
          aria-label={failedLabel}
          readOnly
          value={text}
          onFocus={(event) => event.currentTarget.select()}
        />
      ) : null}
    </div>
  )
}
