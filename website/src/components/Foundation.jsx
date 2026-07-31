import {useState} from 'react'
import {folderViews} from '../content.js'
import {siteHref} from '../site-page.js'
import MacWindow from '../MacWindow.jsx'
import CopyButton from './CopyButton.jsx'

function FinderPreview({t}) {
  const [active, setActive] = useState(folderViews[0].id)
  const item = folderViews.find((view) => view.id === active) || folderViews[0]
  const view = t.folder.views[item.id]

  return (
    <div className="finder-preview" aria-label={t.folder.tabsLabel}>
      <MacWindow title="DotAIOS" variant="finder" className="finder-window finder-window--hero">
        <div className="finder-toolbar">
          <span className="finder-toolbar-title">~/aios/</span>
        </div>
        <div className="finder-body">
          <nav className="finder-sidebar" aria-label={t.folder.tabsLabel}>
            <p className="finder-sidebar-heading">{t.folder.sidebarHeading}</p>
            {folderViews.map((viewItem) => (
              <button
                key={viewItem.id}
                type="button"
                className={`finder-sidebar-item${active === viewItem.id ? ' active' : ''}`}
                aria-pressed={active === viewItem.id}
                onClick={() => setActive(viewItem.id)}
              >
                <span className="finder-folder-icon" aria-hidden="true" />
                <span>{viewItem.name}</span>
              </button>
            ))}
          </nav>
          <article className="finder-pane" aria-live="polite">
            <div className="finder-pane-heading">
              <span className="finder-folder-icon finder-folder-icon--large" aria-hidden="true" />
              <div><h3>{item.name}</h3><p>{item.path}</p></div>
            </div>
            <p className="finder-pane-lead">{view.lead}</p>
            <p className="finder-pane-body">{view.body}</p>
            <div className="finder-file-list">
              {view.files.map(([name, description]) => (
                <div className="finder-file-row" key={name}>
                  <span className="finder-file-icon" aria-hidden="true" />
                  <strong>{name}</strong>
                  <span>{description}</span>
                </div>
              ))}
            </div>
          </article>
        </div>
      </MacWindow>
    </div>
  )
}

function FoundationStory({copy}) {
  return (
    <section className="foundation-story section-shell" id="foundation">
      <div>
        <p className="section-eyebrow">{copy.eyebrow}</p>
        <h2>{copy.title}</h2>
        <p>{copy.intro}</p>
      </div>
      <ul>
        {copy.points.map((point) => <li key={point}>{point}</li>)}
      </ul>
    </section>
  )
}

function PackDoorway({copy, lang}) {
  return (
    <section className="pack-doorway section-shell" id="packs">
      <p className="section-eyebrow">{copy.eyebrow}</p>
      <h2>{copy.title}</h2>
      <p>{copy.intro}</p>
      <a className="pack-link" href={siteHref('consultantPack', lang)}>
        <span><strong>{copy.name}</strong><small>{copy.meta}</small></span>
        <span>{copy.action} <span aria-hidden="true">↗</span></span>
      </a>
    </section>
  )
}

export default function HomePage({lang, t, prompt, onIntent}) {
  const hero = t.home.hero

  return (
    <>
      <section className="hero section-shell" id="setup">
        <div className="hero-copy">
          <p className="hero-eyebrow">{hero.eyebrow}</p>
          <h1 className="hero-title">{hero.title}</h1>
          <p className="hero-intro">{hero.intro}</p>
          <div className="hero-actions">
            <CopyButton
              text={prompt}
              label={hero.primary}
              copiedLabel={hero.copied}
              failedLabel={hero.copyFailed}
              className="button-primary"
              eventName="free_setup_prompt_copied"
              onIntent={onIntent}
            />
            <a className="button button-secondary" href={siteHref('consultantPack', lang)}>{hero.secondary}</a>
          </div>
          <p className="hero-note">{hero.note}</p>
        </div>
        <div className="hero-stage"><FinderPreview t={t} /></div>
      </section>
      <FoundationStory copy={t.home.foundation} />
      <PackDoorway copy={t.home.pack} lang={lang} />
    </>
  )
}
