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
export const CURRENT_COPY_RELEASE = '2026-07-15-v5'

export const COPY = {
  installPrompt:
    'Set up DotAIOS for me: read https://github.com/filocosta46/dotaios and follow INSTALL.md step by step.',
  terminalCommand: 'npx dotaios setup',
}

export const folderViews = [
  {id: 'context', path: '~/aios/context/', icon: 'folder', name: 'context'},
  {id: 'projects', path: '~/aios/projects/', icon: 'folder', name: 'projects'},
  {id: 'memory', path: '~/aios/memory/', icon: 'folder', name: 'memory'},
  {id: 'vault', path: '~/aios/vault/', icon: 'folder', name: 'vault'},
  {id: 'skills', path: '~/aios/skills/', icon: 'folder', name: 'skills'},
]

export const dictionary = {
  en: {
    meta: {
      title: 'DotAIOS - stop re-explaining yourself to every AI',
      description:
        'One local Mac folder for durable context across supported agents. Free, local-first, and yours.',
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
      titleLine1: 'Stop re-explaining yourself',
      titleLine2: 'to every AI.',
      intro: 'One Mac folder. Supported local agents can use it.',
      promptLabel: 'Paste this into your AI',
      promptHelp: 'Your AI reads the guide and sets up the folder.',
      terminal: 'Prefer the Terminal?',
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
          body: 'Your connected local agent can read this first.',
          files: [
            ['identity.md', 'Who you are'],
            ['work.md', 'What you are working on'],
            ['priorities.md', 'What matters right now'],
          ],
        },
        projects: {
          title: 'projects',
          lead: 'Every project you own, reachable from one place.',
          body: 'Context and repository links travel with you. Each project keeps its own Git history.',
          files: [
            ['personal-site/', 'What matters and where the code lives'],
            ['job-search/', 'Status, decisions, and next steps'],
            ['new-idea/', 'A clean starting point for any agent'],
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
      title: 'The folder is free. The packs help you do more with it.',
      desc: 'Outcome-led agent setups for people who do not want to research prompts or plugins.',
      items: [
        {
          eyebrow: 'Guided work',
          title: 'Get better work from your agent.',
          desc: 'Clearer writing, research, applications, CRM work, and design without hunting for the right setup.',
          price: '€12.99',
          cta: 'Coming soon',
          href: null,
        },
        {
          eyebrow: 'Done-for-you systems',
          title: 'Hand repeatable work to your agent.',
          desc: 'Guided systems for recurring work, with setup, verification, and instructions you can actually follow.',
          price: '€35',
          cta: 'Coming soon',
          href: null,
        },
      ],
      note: 'In preparation. Checkout opens only when installation and updates are ready.',
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
        'Una cartella locale sul Mac per il contesto degli agenti supportati. Gratis, locale e tua.',
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
      titleLine1: 'Smetti di rispiegarti',
      titleLine2: 'a ogni AI.',
      intro: 'Una cartella sul Mac. Gli agenti locali supportati possono usarla.',
      promptLabel: 'Incolla questo nella tua AI',
      promptHelp: 'La tua AI legge la guida e configura la cartella.',
      terminal: 'Preferisci il Terminale?',
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
          body: 'Il tuo agente locale collegato può leggere prima questo.',
          files: [
            ['identity.md', 'Chi sei'],
            ['work.md', 'A cosa stai lavorando'],
            ['priorities.md', 'Cosa conta adesso'],
          ],
        },
        projects: {
          title: 'projects',
          lead: 'Ogni tuo progetto, raggiungibile da un solo posto.',
          body: 'Contesto e link al repository viaggiano con te. Ogni progetto mantiene la propria cronologia Git.',
          files: [
            ['sito-personale/', 'Cosa conta e dove si trova il codice'],
            ['ricerca-lavoro/', 'Stato, decisioni e prossimi passi'],
            ['nuova-idea/', 'Un punto di partenza pulito per ogni agente'],
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
      title: 'La cartella è gratis. I pacchetti ti aiutano a fare di più.',
      desc: 'Setup orientati ai risultati per chi non vuole cercare prompt o plugin.',
      items: [
        {
          eyebrow: 'Lavoro guidato',
          title: 'Ottieni un lavoro migliore dal tuo agente.',
          desc: 'Scrittura, ricerca, candidature, CRM e design senza dover cercare il setup giusto.',
          price: '€12,99',
          cta: 'In arrivo',
          href: null,
        },
        {
          eyebrow: 'Sistemi pronti',
          title: 'Affida il lavoro ripetitivo al tuo agente.',
          desc: 'Sistemi guidati per attività ricorrenti, con configurazione, verifica e istruzioni chiare.',
          price: '€35',
          cta: 'In arrivo',
          href: null,
        },
      ],
      note: "In preparazione. Il checkout apre solo quando installazione e aggiornamenti sono pronti.",
    },
    footer: {
      tagline: 'Gratuito e open source. File semplici che possiedi.',
      docs: 'Documentazione',
    },
    copied: 'Copiato',
    copy: 'Copia',
  },
}
