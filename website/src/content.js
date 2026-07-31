export const LANGUAGES = [
  {id: 'en', label: 'EN'},
  {id: 'it', label: 'IT'},
]

export const DEFAULT_LANG = 'en'
export const LANG_STORAGE_KEY = 'dotaios-lang'
export const CURRENT_COPY_RELEASE = '2026-07-31-v11-two-page-storefront'

export const COPY = {
  installPrompt: {
    en: 'Set up DotAIOS from https://github.com/filocosta46/dotaios: read INSTALL.md, check the prerequisites, then guide me through each step and ask before running commands that change my files.',
    it: 'Configura DotAIOS da https://github.com/filocosta46/dotaios: leggi INSTALL.md, verifica i prerequisiti, poi guidami passo passo e chiedimi conferma prima di eseguire comandi che modificano i miei file.',
  },
}

export const folderViews = [
  {id: 'context', name: 'context', path: '~/aios/context/'},
  {id: 'projects', name: 'projects', path: '~/aios/projects/'},
  {id: 'memory', name: 'memory', path: '~/aios/memory/'},
  {id: 'skills', name: 'skills', path: '~/aios/skills/'},
]

const homeHeroEn = {
  eyebrow: 'Free. Local. Yours.',
  title: 'Give every agent your best setup.',
  intro: 'One folder for your context, projects, memory, and skills.',
  primary: 'Copy setup prompt',
  secondary: 'Explore profession packs',
  note: 'Open source. Human-approved changes.',
  copied: 'Prompt copied',
  copyFailed: 'Copy failed. Select and copy manually.',
}

const homeHeroIt = {
  eyebrow: 'Gratis. Locale. Tuo.',
  title: 'Dai a ogni agente il tuo assetto migliore.',
  intro: 'Una cartella per contesto, progetti, memoria e skill.',
  primary: 'Copia il prompt',
  secondary: 'Scopri i pack professionali',
  note: 'Open source. Modifiche approvate da te.',
  copied: 'Prompt copiato',
  copyFailed: 'Copia non riuscita. Seleziona e copia manualmente.',
}

const enFolder = {
  tabsLabel: 'Folder contents',
  sidebarHeading: 'DotAIOS',
  views: {
    context: {files: [['identity.md', 'How you work'], ['priorities.md', 'What matters']], lead: 'Your agents start with the right context.', body: 'Selected by you.'},
    projects: {files: [['README.md', 'The brief'], ['plans/', 'The next move']], lead: 'Every project keeps its thread.', body: 'Across sessions and agents.'},
    memory: {files: [['sessions/', 'Saved work'], ['daily/', 'Recent signals']], lead: 'Useful history stays findable.', body: 'Plain files you own.'},
    skills: {files: [['skills/', 'Chosen workflows'], ['INDEX.md', 'What is available']], lead: 'Repeat your best way of working.', body: 'Without prompt hunting.'},
  },
}

const itFolder = {
  tabsLabel: 'Contenuto della cartella',
  sidebarHeading: 'DotAIOS',
  views: {
    context: {files: [['identity.md', 'Come lavori'], ['priorities.md', 'Cosa conta']], lead: 'I tuoi agenti partono dal contesto giusto.', body: 'Scelto da te.'},
    projects: {files: [['README.md', 'Il brief'], ['plans/', 'La prossima mossa']], lead: 'Ogni progetto conserva il filo.', body: 'Tra sessioni e agenti.'},
    memory: {files: [['sessions/', 'Lavoro salvato'], ['daily/', 'Segnali recenti']], lead: 'La storia utile resta trovabile.', body: 'File semplici che possiedi.'},
    skills: {files: [['skills/', 'Workflow scelti'], ['INDEX.md', 'Cosa è disponibile']], lead: 'Ripeti il tuo modo migliore di lavorare.', body: 'Senza cercare prompt.'},
  },
}

const consultantEn = {
  name: 'Consultant Pack',
  hero: {
    eyebrow: 'Consultant Pack',
    title: 'Leave every meeting with work moving.',
    intro: 'Selected workflows that turn client context into clear next steps.',
  },
  price: '€35 planned',
  priceState: 'planned',
  ownership: 'One edition. Yours permanently.',
  optionalUpdates: 'A future €4 monthly update plan would be optional.',
  outcomes: [
    {id: 'contact-to-client-workspace', title: 'Keep every client in context', detail: 'A usable thread across sessions.'},
    {id: 'meeting-to-actions-and-follow-up', title: 'Turn meetings into momentum', detail: 'Decisions, owners, dates, and follow-up.'},
    {id: 'request-to-proposal-or-deliverable', title: 'Start the right client output', detail: 'Proposal or deliverable, ready for review.'},
  ],
  proof: {
    eyebrow: 'First workflow',
    title: 'One meeting. Four usable outputs.',
    intro: 'Review everything before it changes a client record.',
    sourceLabel: 'From',
    source: 'Meeting notes',
    sourceQuote: 'Confirm scope Friday. Marta owns the data review.',
    outputs: ['Decisions', 'Owners and dates', 'Follow-up draft', 'Project update'],
  },
  included: {eyebrow: 'Inside', title: 'Three workflows. No prompt hunting.'},
  install: {
    eyebrow: 'After launch',
    title: 'Buy anywhere. Install at your desk.',
    intro: 'Open your DotAIOS folder and let your local agent guide the install.',
    steps: ['Download the edition', 'Open your DotAIOS folder', 'Paste the install prompt'],
  },
  specification: {
    open: 'Requirements and evidence',
    requirements: 'Requires free DotAIOS, Node.js 22+, macOS, and Codex or Claude Code.',
  },
  evidence: {
    state: 'Candidate. Not approved.',
    level: 'Evidence',
    host: 'Host test',
    result: 'Result',
    permissions: 'Before changes',
    data: 'Data',
    limitations: 'Limits',
    retest: 'Next gate',
    notTested: 'Not tested',
    detail: 'No approved Pack outcome yet.',
    permissionsDetail: 'Human review is required.',
    dataDetail: 'Your AI provider processes what you send.',
    limitationsDetail: 'Delivery and recovery remain under test.',
    retestDetail: 'Verify both supported hosts.',
  },
  hostStates: [
    {id: 'codex', label: 'Codex', state: 'Foundation outcome produced', detail: 'Pack not tested.'},
    {id: 'claude-code', label: 'Claude Code', state: 'Foundation probe: no outcome', detail: 'Pack not tested.'},
  ],
  browserFallback: 'ChatGPT in a browser cannot read your local folder.',
  readiness: {
    state: 'unavailable',
    label: 'Not available yet',
    detail: 'Checkout stays closed until delivery, recovery, and professional outcome checks pass.',
    commerceNotice: 'Purchase terms will appear before launch.',
  },
  action: {label: 'See proof and requirements', href: null},
  freeAction: 'Start with free DotAIOS',
}

const consultantIt = {
  name: 'Consultant Pack',
  hero: {
    eyebrow: 'Consultant Pack',
    title: 'Chiudi ogni riunione con il lavoro in moto.',
    intro: 'Workflow selezionati che trasformano il contesto del cliente in prossimi passi chiari.',
  },
  price: '€35 previsti',
  priceState: 'previsti',
  ownership: 'Un’edizione. Tua per sempre.',
  optionalUpdates: 'Un futuro piano di aggiornamenti da €4 al mese sarebbe facoltativo.',
  outcomes: [
    {id: 'contact-to-client-workspace', title: 'Mantieni ogni cliente nel contesto', detail: 'Un filo utile tra le sessioni.'},
    {id: 'meeting-to-actions-and-follow-up', title: 'Trasforma le riunioni in slancio', detail: 'Decisioni, responsabili, date e follow-up.'},
    {id: 'request-to-proposal-or-deliverable', title: 'Avvia il risultato giusto', detail: 'Proposta o consegna, pronta da rivedere.'},
  ],
  proof: {
    eyebrow: 'Primo workflow',
    title: 'Una riunione. Quattro risultati utili.',
    intro: 'Controlla tutto prima che cambi il progetto del cliente.',
    sourceLabel: 'Da',
    source: 'Appunti della riunione',
    sourceQuote: 'Confermare il perimetro venerdì. Marta rivede i dati.',
    outputs: ['Decisioni', 'Responsabili e date', 'Bozza di follow-up', 'Aggiornamento progetto'],
  },
  included: {eyebrow: 'Dentro', title: 'Tre workflow. Nessuna caccia ai prompt.'},
  install: {
    eyebrow: 'Dopo il lancio',
    title: 'Acquista ovunque. Installa alla scrivania.',
    intro: 'Apri la cartella DotAIOS e lascia che il tuo agente locale guidi l’installazione.',
    steps: ['Scarica l’edizione', 'Apri la cartella DotAIOS', 'Incolla il prompt di installazione'],
  },
  specification: {
    open: 'Requisiti e prove',
    requirements: 'Richiede DotAIOS gratuito, Node.js 22+, macOS e Codex o Claude Code.',
  },
  evidence: {
    state: 'Candidato. Non approvato.',
    level: 'Prova',
    host: 'Test host',
    result: 'Risultato',
    permissions: 'Prima delle modifiche',
    data: 'Dati',
    limitations: 'Limiti',
    retest: 'Prossimo controllo',
    notTested: 'Non testato',
    detail: 'Nessun risultato approvato.',
    permissionsDetail: 'Serve una revisione umana.',
    dataDetail: 'Il provider AI elabora ciò che invii.',
    limitationsDetail: 'Consegna e recupero restano in test.',
    retestDetail: 'Verificare entrambi gli host.',
  },
  hostStates: [
    {id: 'codex', label: 'Codex', state: 'Risultato della base prodotto', detail: 'Pack non testato.'},
    {id: 'claude-code', label: 'Claude Code', state: 'Probe della base: nessun risultato', detail: 'Pack non testato.'},
  ],
  browserFallback: 'ChatGPT nel browser non può leggere la cartella locale.',
  readiness: {
    state: 'unavailable',
    label: 'Non ancora disponibile',
    detail: 'Il checkout resta chiuso finché i controlli su consegna, recupero e risultati professionali non saranno completati.',
    commerceNotice: 'I termini di acquisto appariranno prima del lancio.',
  },
  action: {label: 'Vedi prove e requisiti', href: null},
  freeAction: 'Inizia con DotAIOS gratis',
}

export const dictionary = {
  en: {
    skipLink: 'Skip to the main content',
    meta: {
      home: {title: 'DotAIOS. Give every agent your best setup.', description: 'One free local folder for the context, memory, projects, and skills your AI agents need.'},
      consultantPack: {title: 'Consultant Pack for DotAIOS', description: 'Three selected consultant workflows. €35 once. Permanent edition. Currently under test.'},
    },
    nav: {
      home: 'DotAIOS', pack: 'Consultant Pack', proof: 'Proof', included: 'Inside', install: 'How it installs', github: 'GitHub', cta: 'Set up free', back: 'Back to DotAIOS', language: 'Language', primaryLabel: 'Primary navigation', menu: 'Menu', close: 'Close menu',
    },
    hero: homeHeroEn,
    home: {
      hero: homeHeroEn,
      foundation: {eyebrow: 'Your AIOS', title: 'One folder. Better work everywhere.', intro: 'Context, memory, projects, and selected skills stay together.', points: ['Context that travels', 'Memory you own', 'Skills you choose']},
      pack: {eyebrow: 'Profession packs', title: 'Skip the AI noise.', intro: 'Selected workflows for the work you repeat.', name: 'Consultant Pack', meta: 'Three workflows. €35 once.', action: 'View the Pack'},
    },
    folder: enFolder,
    consultantPack: consultantEn,
    footer: {tagline: 'Your context. Your workflows. Your agents.', docs: 'Docs', security: 'Security', label: 'Footer'},
  },
  it: {
    skipLink: 'Vai al contenuto principale',
    meta: {
      home: {title: 'DotAIOS. Dai a ogni agente il tuo assetto migliore.', description: 'Una cartella locale gratuita per contesto, memoria, progetti e skill dei tuoi agenti AI.'},
      consultantPack: {title: 'Consultant Pack per DotAIOS', description: 'Tre workflow selezionati per consulenti. €35 una volta. Edizione permanente. Ora in fase di test.'},
    },
    nav: {
      home: 'DotAIOS', pack: 'Consultant Pack', proof: 'Prova', included: 'Dentro', install: 'Come si installa', github: 'GitHub', cta: 'Configura gratis', back: 'Torna a DotAIOS', language: 'Lingua', primaryLabel: 'Navigazione principale', menu: 'Menu', close: 'Chiudi menu',
    },
    hero: homeHeroIt,
    home: {
      hero: homeHeroIt,
      foundation: {eyebrow: 'Il tuo AIOS', title: 'Una cartella. Lavoro migliore ovunque.', intro: 'Contesto, memoria, progetti e skill selezionate restano insieme.', points: ['Contesto che ti segue', 'Memoria che possiedi', 'Skill che scegli']},
      pack: {eyebrow: 'Pack professionali', title: 'Taglia il rumore AI.', intro: 'Workflow selezionati per il lavoro che ripeti.', name: 'Consultant Pack', meta: 'Tre workflow. €35 una volta.', action: 'Guarda il Pack'},
    },
    folder: itFolder,
    consultantPack: consultantIt,
    footer: {tagline: 'Il tuo contesto. I tuoi workflow. I tuoi agenti.', docs: 'Documentazione', security: 'Sicurezza', label: 'Piè di pagina'},
  },
}
