export const LANGUAGES = [
  {id: 'en', label: 'EN'},
  {id: 'it', label: 'IT'},
]

export const DEFAULT_LANG = 'en'
export const LANG_STORAGE_KEY = 'dotaios-lang'

// Sanity hydration gate: the CMS document is applied only when its
// `copyRelease` field equals this value (or inside Studio preview), so a
// stale document can never overwrite newer bundled copy. Bump it whenever
// the copy structure changes and regenerate the Studio patch.
export const CURRENT_COPY_RELEASE = '2026-07-15-v3'

export const COPY = {
  installPrompt:
    'Set up DotAIOS for me: read https://github.com/filocosta46/dotaios and follow INSTALL.md step by step.',
  terminalCommand: 'npx dotaios setup',
}

export const folderViews = [
  {id: 'context', path: '~/aios/context/', icon: 'folder', name: 'context'},
  {id: 'memory', path: '~/aios/memory/', icon: 'folder', name: 'memory'},
  {id: 'vault', path: '~/aios/vault/', icon: 'folder', name: 'vault'},
  {id: 'skills', path: '~/aios/skills/', icon: 'folder', name: 'skills'},
]

export const dictionary = {
  en: {
    meta: {
      title: 'DotAIOS - stop re-explaining yourself to every AI',
      description:
        'One folder on your Mac that every AI reads. Free, no account, no cloud memory.',
    },
    skipLink: 'Skip to install',
    nav: {
      folder: 'The folder',
      ask: 'What to ask',
      packs: 'Packs',
      github: 'GitHub',
      cta: 'Get started',
      language: 'Language',
    },
    hero: {
      title: 'Stop re-explaining yourself to every AI.',
      intro: 'One folder on your Mac. Every AI reads the same files.',
      promptLabel: 'Paste this into your AI',
      promptHelp: 'Your AI reads the guide and sets up the folder.',
      terminal: 'Prefer the Terminal?',
      toolsLine: 'Claude Code, Cursor, Codex, Gemini',
    },
    folder: {
      title: 'One folder. Everything your AI should know.',
      desc: 'Plain files you open, edit, and own.',
      tabsLabel: 'Folder contents',
      sidebarHeading: 'Favorites',
      views: {
        context: {
          title: 'context',
          lead: 'Who you are and what you are working on.',
          body: 'Your AI reads this first.',
          files: [
            ['identity.md', 'Who you are'],
            ['work.md', 'What you are working on'],
            ['priorities.md', 'What matters right now'],
          ],
        },
        memory: {
          title: 'memory',
          lead: 'What happened recently.',
          body: 'Sessions, notes, and decisions on your machine.',
          files: [
            ['sessions/', 'Saved conversations'],
            ['daily/', 'Day plans and notes'],
            ['decisions.md', 'Choices you already made'],
          ],
        },
        vault: {
          title: 'vault',
          lead: 'Articles, PDFs, and files you saved.',
          body: 'Ask for them later in your own words.',
          files: [
            ['raw/', 'Pages and articles you saved'],
            ['wiki/', 'Clean summaries'],
            ['assets/', 'PDFs and documents'],
          ],
        },
        skills: {
          title: 'skills',
          lead: 'Things you can ask for in plain words.',
          body: 'Say what you want. The right skill runs.',
          files: [
            ['plan-today', '"Plan my day"'],
            ['ingest', '"Save this article"'],
            ['weekly-review', '"How did this week go?"'],
          ],
        },
      },
    },
    ask: {
      title: 'Ask like you would ask a person',
      desc: 'No commands to learn. These work on day one.',
      examples: [
        ['Plan my day', 'Builds a plan from your priorities and yesterday.'],
        ['Save this article', 'Stores it as clean text you can search later.'],
        ['What did I decide about the trip?', 'Finds the answer in your saved notes.'],
        ['Is everything connected?', 'Checks connections and flags what needs attention.'],
      ],
    },
    packs: {
      title: 'The folder is free. The packs are the shortcut.',
      desc: 'Curated skills and automations, tested and updated weekly.',
      items: [
        {
          eyebrow: 'Skills',
          title: 'The best skills, picked for you.',
          desc: 'Skills that matter for knowledge workers, refreshed every week.',
          price: '€12.99',
          cta: 'Get Skills',
          href: 'https://filocosta.gumroad.com/l/tgaeui',
        },
        {
          eyebrow: 'Automations',
          title: 'Real systems. Your AI works like a pro.',
          desc: 'Skills plus working setups for research, transcripts, and memory.',
          price: '€35',
          cta: 'Get Automations',
          href: 'https://filocosta.gumroad.com/l/baglw',
        },
      ],
      note: 'One prompt per pack. Paste once; it installs and wires everything in.',
    },
    footer: {
      tagline: 'Free and open source. Plain files you own.',
      docs: 'Docs',
    },
    copied: 'Copied',
    copy: 'Copy',
  },
  it: {
    meta: {
      title: 'DotAIOS - smetti di rispiegarti a ogni AI',
      description:
        'Una cartella sul Mac che ogni AI legge. Gratis, senza account, senza memoria nel cloud.',
    },
    skipLink: "Vai all'installazione",
    nav: {
      folder: 'La cartella',
      ask: 'Cosa chiedere',
      packs: 'Pacchetti',
      github: 'GitHub',
      cta: 'Inizia',
      language: 'Lingua',
    },
    hero: {
      title: 'Smetti di rispiegarti a ogni AI.',
      intro: 'Una cartella sul Mac. Ogni AI legge gli stessi file.',
      promptLabel: 'Incolla questo nella tua AI',
      promptHelp: 'La tua AI legge la guida e configura la cartella.',
      terminal: 'Preferisci il Terminale?',
      toolsLine: 'Claude Code, Cursor, Codex, Gemini',
    },
    folder: {
      title: 'Una cartella. Tutto quello che la tua AI deve sapere.',
      desc: 'File semplici che apri, modifichi e possiedi.',
      tabsLabel: 'Contenuto della cartella',
      sidebarHeading: 'Preferiti',
      views: {
        context: {
          title: 'context',
          lead: 'Chi sei e a cosa stai lavorando.',
          body: 'La tua AI legge questo per primo.',
          files: [
            ['identity.md', 'Chi sei'],
            ['work.md', 'A cosa stai lavorando'],
            ['priorities.md', 'Cosa conta adesso'],
          ],
        },
        memory: {
          title: 'memory',
          lead: 'Cosa è successo di recente.',
          body: 'Sessioni, note e decisioni sul tuo computer.',
          files: [
            ['sessions/', 'Conversazioni salvate'],
            ['daily/', 'Piani e note del giorno'],
            ['decisions.md', 'Scelte già fatte'],
          ],
        },
        vault: {
          title: 'vault',
          lead: 'Articoli, PDF e file che hai salvato.',
          body: 'Chiedili più tardi con parole tue.',
          files: [
            ['raw/', 'Pagine e articoli salvati'],
            ['wiki/', 'Sintesi pulite'],
            ['assets/', 'PDF e documenti'],
          ],
        },
        skills: {
          title: 'skills',
          lead: 'Cose che puoi chiedere con parole normali.',
          body: 'Dici cosa vuoi. Parte la skill giusta.',
          files: [
            ['plan-today', '"Pianifica la mia giornata"'],
            ['ingest', '"Salva questo articolo"'],
            ['weekly-review', '"Com\'è andata la settimana?"'],
          ],
        },
      },
    },
    ask: {
      title: 'Chiedi come chiederesti a una persona',
      desc: 'Nessun comando da imparare. Funzionano dal primo giorno.',
      examples: [
        ['Pianifica la mia giornata', 'Crea un piano dalle priorità e da ieri.'],
        ['Salva questo articolo', 'Lo archivia come testo pulito e cercabile.'],
        ['Cosa avevo deciso per il viaggio?', 'Trova la risposta nelle note salvate.'],
        ['È tutto collegato?', 'Controlla i collegamenti e segnala cosa sistemare.'],
      ],
    },
    packs: {
      title: 'La cartella è gratis. I pacchetti sono la scorciatoia.',
      desc: 'Skill e automazioni curate, testate e aggiornate ogni settimana.',
      items: [
        {
          eyebrow: 'Skills',
          title: 'Le skill migliori, scelte per te.',
          desc: 'Skill utili per chi lavora con la testa, aggiornate ogni settimana.',
          price: '€12,99',
          cta: 'Prendi Skills',
          href: 'https://filocosta.gumroad.com/l/tgaeui',
        },
        {
          eyebrow: 'Automations',
          title: 'Sistemi veri. La tua AI lavora da pro.',
          desc: 'Skills più setup completi per ricerca, trascrizioni e memoria.',
          price: '€35',
          cta: 'Prendi Automazioni',
          href: 'https://filocosta.gumroad.com/l/baglw',
        },
      ],
      note: 'Un prompt per pacchetto. Lo incolli una volta: installa e collega tutto.',
    },
    footer: {
      tagline: 'Gratuito e open source. File semplici che possiedi.',
      docs: 'Documentazione',
    },
    copied: 'Copiato',
    copy: 'Copia',
  },
}
