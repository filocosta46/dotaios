export const LANGUAGES = [
  {id: 'en', label: 'EN'},
  {id: 'it', label: 'IT'},
]

export const DEFAULT_LANG = 'en'
export const LANG_STORAGE_KEY = 'dotaios-lang'

export const COPY = {
  installPrompt:
    'Set up DotAIOS for me: read https://github.com/filocosta46/dotaios and follow INSTALL.md step by step.',
  terminalCommand: 'npx dotaios setup',
}

export const folderViews = [
  {
    id: 'start',
    path: '~/aios/FIRST_SESSION.md',
    icon: 'doc',
    name: 'FIRST_SESSION.md',
  },
  {
    id: 'agents',
    path: '~/aios/AGENTS.md',
    icon: 'doc',
    name: 'AGENTS.md',
  },
  {
    id: 'context',
    path: '~/aios/context/',
    icon: 'folder',
    name: 'context/',
  },
  {
    id: 'memory',
    path: '~/aios/memory/',
    icon: 'folder',
    name: 'memory/',
  },
  {
    id: 'vault',
    path: '~/aios/vault/',
    icon: 'folder',
    name: 'vault/',
  },
  {
    id: 'skills',
    path: '~/aios/skills/',
    icon: 'folder',
    name: 'skills/',
  },
]

export const dictionary = {
  en: {
    meta: {
      title: 'DotAIOS - one folder every AI reads',
      description:
        'DotAIOS creates ~/aios, a local context folder for Claude, Cursor, Codex, Gemini, and other AI tools.',
    },
    skipLink: 'Skip to install',
    nav: {
      folder: 'Folder',
      ask: 'What to ask',
      packs: 'Packs',
      github: 'GitHub',
      cta: 'Get started',
      language: 'Language',
    },
    hero: {
      eyebrow: 'local-first / open source / agent-agnostic',
      title: 'One folder. Every AI reads it.',
      intro:
        'Stop re-explaining yourself to every AI tool. DotAIOS creates a local context folder with who you are, what you are building, what you saved, and the workflows you want agents to follow.',
      promptLabel: 'Paste into your AI',
      promptHelp:
        'Your AI reads the guide, creates the folder, asks a few questions, and connects your tools.',
      terminal: 'Prefer Terminal?',
      tools: ['Claude Code', 'Cursor', 'Codex', 'Gemini CLI', 'Hermes'],
    },
    folder: {
      title: 'The folder',
      desc: 'Plain Markdown you own. Open it, edit it, move it, or sync it however you like.',
      tabsLabel: 'Folder tree',
      views: {
        start: {
          title: 'FIRST_SESSION.md',
          lead: 'A calm first-run guide for the agent helping you set things up.',
          body:
            'It explains what DotAIOS created, how to check the connection, and what to ask next.',
        },
        agents: {
          title: 'AGENTS.md',
          lead: 'The shared entrypoint for connected AI tools.',
          body:
            'Codex, Gemini, and generic agents can start here, then route into context, memory, vault, and skills.',
          code:
            '# AGENTS\n\nRead context/ for who I am.\nRead memory/ for recent work.\nRead vault/ for saved knowledge.\nRead skills/ for workflows I can ask you to run.\n\nStart with context/identity.md.',
        },
        context: {
          title: 'context/',
          lead: 'Stable information your agents should know before helping.',
          files: [
            ['identity.md', 'Who you are'],
            ['work.md', 'What you are building'],
            ['priorities.md', 'What matters now'],
            ['north-star.md', 'The direction to preserve'],
          ],
        },
        memory: {
          title: 'memory/',
          lead: 'Recent signals, daily notes, sessions, and decisions.',
          files: [
            ['daily/', 'Briefs and day plans'],
            ['signals/', 'Quick captured notes'],
            ['sessions/', 'Saved AI conversations'],
            ['events.jsonl', 'Append-only activity log'],
          ],
        },
        vault: {
          title: 'vault/',
          lead: 'Longer-lived knowledge that agents can search when needed.',
          files: [
            ['raw/', 'Imported pages and rough sources'],
            ['wiki/', 'Clean durable summaries'],
            ['assets/', 'PDFs, documents, and files'],
            ['org/', 'People, companies, and projects'],
          ],
        },
        skills: {
          title: 'skills/',
          lead: 'Portable workflows written as plain instructions.',
          files: [
            ['plan-today', 'Plan from priorities and recent work'],
            ['ingest', 'Save a URL, PDF, or file'],
            ['closeday', 'Close out the day cleanly'],
            ['weekly-review', 'Refresh context and open loops'],
          ],
        },
      },
    },
    ask: {
      title: 'What you can ask',
      desc: 'Once setup is complete, connected agents use the same local context.',
      examples: [
        ['What am I working on?', 'A quick check that the bridge and context are connected.'],
        ['Plan my day.', 'Builds a plan from priorities, memory, and active work.'],
        ['Save this article for me.', 'Stores a page or PDF in your local vault.'],
        ['What did I decide about this project?', 'Searches saved notes and sessions.'],
      ],
    },
    principles: {
      title: 'Why it works',
      items: [
        ['Local first', 'Your context is files on your machine, not a vendor account.'],
        ['Tool neutral', 'Claude, Cursor, Codex, Gemini, and others can read the same source.'],
        ['Human editable', 'Markdown stays understandable even if the CLI changes.'],
      ],
    },
    packs: {
      title: 'Get the packs',
      desc: 'DotAIOS is free and open source. Packs add curated skills and automation recipes.',
      items: [
        {
          eyebrow: 'Starter',
          title: 'Skip the setup. Start today.',
          desc: 'A curated first set of skills for daily planning, capture, and review.',
          price: '€12.99',
          cta: 'Get Starter',
          href: 'https://filocosta.gumroad.com/l/tgaeui',
        },
        {
          eyebrow: 'Automations',
          title: 'Add the engines. No wiring.',
          desc: 'Research, transcripts, memory workflows, and ready-made automation patterns.',
          price: '€35',
          cta: 'Get Automations',
          href: 'https://filocosta.gumroad.com/l/baglw',
        },
      ],
      note: 'Plain files you own forever. No subscription, no account, no lock-in.',
    },
    cta: {
      text: 'Stop rebuilding context by hand.',
      button: 'Copy setup prompt',
    },
    footer: {
      tagline: 'MIT / open source / local-first',
      docs: 'Docs',
    },
    copied: 'Copied',
    copy: 'Copy',
  },
  it: {
    meta: {
      title: 'DotAIOS - una cartella che ogni AI legge',
      description:
        'DotAIOS crea ~/aios, una cartella locale di contesto per Claude, Cursor, Codex, Gemini e altri strumenti AI.',
    },
    skipLink: "Vai all'installazione",
    nav: {
      folder: 'Cartella',
      ask: 'Cosa chiedere',
      packs: 'Pacchetti',
      github: 'GitHub',
      cta: 'Inizia',
      language: 'Lingua',
    },
    hero: {
      eyebrow: 'locale / open source / agnostico agli agenti',
      title: 'Una cartella. Ogni AI la legge.',
      intro:
        'Smetti di rispiegarti a ogni strumento AI. DotAIOS crea una cartella locale con chi sei, cosa stai costruendo, cosa hai salvato e i workflow che vuoi far seguire agli agenti.',
      promptLabel: 'Incolla nella tua AI',
      promptHelp:
        'La tua AI legge la guida, crea la cartella, fa qualche domanda e collega i tuoi strumenti.',
      terminal: 'Preferisci il Terminale?',
      tools: ['Claude Code', 'Cursor', 'Codex', 'Gemini CLI', 'Hermes'],
    },
    folder: {
      title: 'La cartella',
      desc: 'Markdown semplice che possiedi. Puoi aprirlo, modificarlo, spostarlo o sincronizzarlo come vuoi.',
      tabsLabel: 'Albero cartelle',
      views: {
        start: {
          title: 'FIRST_SESSION.md',
          lead: "Una guida tranquilla per l'agente che ti aiuta nella prima configurazione.",
          body:
            'Spiega cosa ha creato DotAIOS, come verificare la connessione e cosa chiedere dopo.',
        },
        agents: {
          title: 'AGENTS.md',
          lead: 'Il punto di ingresso condiviso per gli strumenti AI collegati.',
          body:
            'Codex, Gemini e agenti generici possono partire da qui e poi leggere context, memory, vault e skills.',
          code:
            '# AGENTS\n\nLeggi context/ per sapere chi sono.\nLeggi memory/ per il lavoro recente.\nLeggi vault/ per la conoscenza salvata.\nLeggi skills/ per i workflow che posso chiederti.\n\nInizia da context/identity.md.',
        },
        context: {
          title: 'context/',
          lead: 'Informazioni stabili che gli agenti devono conoscere prima di aiutarti.',
          files: [
            ['identity.md', 'Chi sei'],
            ['work.md', 'Cosa stai costruendo'],
            ['priorities.md', 'Cosa conta ora'],
            ['north-star.md', 'La direzione da mantenere'],
          ],
        },
        memory: {
          title: 'memory/',
          lead: 'Segnali recenti, note giornaliere, sessioni e decisioni.',
          files: [
            ['daily/', 'Brief e piani del giorno'],
            ['signals/', 'Note rapide salvate'],
            ['sessions/', 'Conversazioni AI salvate'],
            ['events.jsonl', 'Log append-only delle attività'],
          ],
        },
        vault: {
          title: 'vault/',
          lead: 'Conoscenza più duratura che gli agenti possono cercare quando serve.',
          files: [
            ['raw/', 'Pagine importate e fonti grezze'],
            ['wiki/', 'Sintesi pulite e durevoli'],
            ['assets/', 'PDF, documenti e file'],
            ['org/', 'Persone, aziende e progetti'],
          ],
        },
        skills: {
          title: 'skills/',
          lead: 'Workflow portabili scritti come istruzioni semplici.',
          files: [
            ['plan-today', 'Pianifica da priorità e lavoro recente'],
            ['ingest', 'Salva URL, PDF o file'],
            ['closeday', 'Chiudi la giornata in modo pulito'],
            ['weekly-review', 'Aggiorna contesto e loop aperti'],
          ],
        },
      },
    },
    ask: {
      title: 'Cosa puoi chiedere',
      desc: 'Dopo il setup, gli agenti collegati usano lo stesso contesto locale.',
      examples: [
        ['Su cosa sto lavorando?', 'Controllo rapido che ponte e contesto siano collegati.'],
        ['Pianifica la mia giornata.', 'Crea un piano da priorità, memoria e lavoro attivo.'],
        ['Salva questo articolo per me.', 'Archivia una pagina o un PDF nel tuo vault locale.'],
        ['Cosa ho deciso su questo progetto?', 'Cerca nelle note e sessioni salvate.'],
      ],
    },
    principles: {
      title: 'Perché funziona',
      items: [
        ['Locale prima di tutto', 'Il contesto è in file sul tuo computer, non in un account vendor.'],
        ['Neutrale sugli strumenti', 'Claude, Cursor, Codex, Gemini e altri leggono la stessa fonte.'],
        ['Modificabile da umani', 'Il Markdown resta comprensibile anche se cambia la CLI.'],
      ],
    },
    packs: {
      title: 'I pacchetti',
      desc: 'DotAIOS è gratuito e open source. I pacchetti aggiungono skill curate e ricette di automazione.',
      items: [
        {
          eyebrow: 'Starter',
          title: 'Salta il setup. Inizia oggi.',
          desc: 'Un primo set curato di skill per pianificazione, cattura e review.',
          price: '€12.99',
          cta: 'Prendi Starter',
          href: 'https://filocosta.gumroad.com/l/tgaeui',
        },
        {
          eyebrow: 'Automazioni',
          title: 'Aggiungi i motori. Senza cablaggio.',
          desc: 'Ricerca, trascrizioni, memoria e pattern di automazione pronti.',
          price: '€35',
          cta: 'Prendi Automazioni',
          href: 'https://filocosta.gumroad.com/l/baglw',
        },
      ],
      note: 'File che possiedi per sempre. Nessun abbonamento, nessun account, nessun lock-in.',
    },
    cta: {
      text: 'Smetti di ricostruire il contesto a mano.',
      button: 'Copia il prompt',
    },
    footer: {
      tagline: 'MIT / open source / locale',
      docs: 'Documentazione',
    },
    copied: 'Copiato',
    copy: 'Copia',
  },
}
