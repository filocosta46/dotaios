import {useEffect, useRef} from 'react'
import {PUBLIC_OFFER} from '../offer.js'
import {siteHref} from '../site-page.js'

function CommerceRail({lang, offer, onIntent}) {
  const canBuy = PUBLIC_OFFER.readiness.state === 'available' && Boolean(offer.action.href)
  const priceAmount = `€${Number(PUBLIC_OFFER.price.amount)}`

  return (
    <aside className="commerce-rail" aria-label={offer.readiness.label}>
      <div className="commerce-price">
        <span className="commerce-price-line"><strong>{priceAmount}</strong><small>{offer.priceState}</small></span>
        <span>{offer.ownership}</span>
      </div>
      {canBuy ? (
        <a className="button button-primary commerce-action" href={offer.action.href}>{offer.action.label}</a>
      ) : (
        <a className="button button-secondary commerce-action" href="#proof">{offer.action.label}</a>
      )}
      <p className="commerce-state">{offer.readiness.detail}</p>
      <p className="commerce-requirements">{offer.specification.requirements}</p>
      <a
        className="commerce-free-link"
        href={siteHref('home', lang)}
        onClick={() => onIntent?.('consultant_pack_free_setup_selected')}
      >
        {offer.freeAction} <span aria-hidden="true">↗</span>
      </a>
    </aside>
  )
}

function MeetingReceipt({offer, onIntent}) {
  const evidence = PUBLIC_OFFER.evidenceSummary

  function handleToggle(event) {
    if (event.currentTarget.open) onIntent?.('consultant_pack_evidence_opened')
  }

  return (
    <section className="pack-proof section-shell" id="proof">
      <div className="pack-section-heading">
        <p className="section-eyebrow">{offer.proof.eyebrow}</p>
        <h2>{offer.proof.title}</h2>
        <p>{offer.proof.intro}</p>
      </div>
      <article className="work-receipt">
        <div className="receipt-source">
          <span>{offer.proof.sourceLabel}</span>
          <strong>{offer.proof.source}</strong>
          <blockquote>{offer.proof.sourceQuote}</blockquote>
        </div>
        <div className="receipt-output">
          <span className="receipt-kicker">DotAIOS / Consultant Pack</span>
          <ul>
            {offer.proof.outputs.map((output) => <li key={output}><span aria-hidden="true">✓</span>{output}</li>)}
          </ul>
        </div>
        <details className="evidence-disclosure" onToggle={handleToggle}>
          <summary><strong>{offer.evidence.state}</strong><span>{offer.specification.open}</span></summary>
          <dl>
            <div><dt>{offer.evidence.level}</dt><dd>{evidence.evidenceLevel}</dd></div>
            <div><dt>{offer.evidence.host}</dt><dd>{offer.evidence.notTested}</dd></div>
            <div><dt>{offer.evidence.result}</dt><dd>{offer.evidence.detail}</dd></div>
            <div><dt>{offer.evidence.permissions}</dt><dd>{offer.evidence.permissionsDetail}</dd></div>
            <div><dt>{offer.evidence.data}</dt><dd>{offer.evidence.dataDetail}</dd></div>
            <div><dt>{offer.evidence.limitations}</dt><dd>{offer.evidence.limitationsDetail}</dd></div>
            <div><dt>{offer.evidence.retest}</dt><dd>{offer.evidence.retestDetail}</dd></div>
          </dl>
        </details>
      </article>
    </section>
  )
}

function IncludedWorkflows({offer}) {
  return (
    <section className="pack-included section-shell" id="included">
      <p className="section-eyebrow">{offer.included.eyebrow}</p>
      <h2>{offer.included.title}</h2>
      <div className="included-list">
        {offer.outcomes.map((outcome) => (
          <article key={outcome.id}>
            <h3>{outcome.title}</h3>
            <p>{outcome.detail}</p>
          </article>
        ))}
      </div>
    </section>
  )
}

function InstallHandoff({offer}) {
  const install = offer.install
  return (
    <section className="pack-install section-shell" id="install">
      <div className="pack-section-heading">
        <p className="section-eyebrow">{install.eyebrow}</p>
        <h2>{install.title}</h2>
        <p>{install.intro}</p>
      </div>
      <ol>
        {install.steps.map((step, index) => <li key={step}><span>{index + 1}</span><h3>{step}</h3></li>)}
      </ol>
      <p className="pack-update-note">{offer.optionalUpdates}</p>
    </section>
  )
}

export default function ConsultantPackPage({lang, t, onIntent}) {
  const offer = t.consultantPack
  const viewed = useRef(false)

  useEffect(() => {
    if (viewed.current) return
    viewed.current = true
    onIntent?.('consultant_pack_viewed')
  }, [onIntent])

  return (
    <>
      <section className="pack-hero section-shell" id="pack-top">
        <div className="pack-hero-copy">
          <p className="hero-eyebrow">{offer.hero.eyebrow}</p>
          <h1>{offer.hero.title}</h1>
          <p>{offer.hero.intro}</p>
        </div>
        <CommerceRail lang={lang} offer={offer} onIntent={onIntent} />
      </section>
      <MeetingReceipt offer={offer} onIntent={onIntent} />
      <IncludedWorkflows offer={offer} />
      <InstallHandoff offer={offer} />
    </>
  )
}
