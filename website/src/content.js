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
export const CURRENT_COPY_RELEASE = '2026-07-14-consumer'

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
        'One folder on your computer that every AI reads: who you are, what you are working on, what you saved. Free, no account, no cloud memory.',
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
      intro:
        'One folder on your computer. Who you are, what you are working on, what you saved. Every AI reads the same files. No account. No cloud memory.',
      point: 'Ask in plain words. Your AI picks the right workflow automatically.',
      promptLabel: 'Paste this into your AI',
      promptHelp:
        'Your AI reads the guide, creates the folder, and asks you a few questions. That is the whole setup.',
      terminal: 'Prefer the Terminal?',
      toolsLabel: 'Works with',
      tools: ['Claude Code', 'Cursor', 'Codex', 'Gemini'],
    },
    demo: {
      label: 'Setup preview',
      windowTitle: 'DotAIOS setup',
      promptLabel: 'You',
      terminalLabel: 'Terminal',
      questionsLabel: 'Onboarding',
      initCommand: 'npx dotaios init',
    },
    folder: {
      title: 'One folder. Everything your AI should know.',
      desc: 'Every AI starts from the same page. Plain files you can open, edit, and move whenever you want.',
      tabsLabel: 'Folder contents',
      views: {
        context: {
          title: 'context',
          lead: 'Who you are and what you are working on.',
          body: 'Your AI reads this first, so you never start from zero.',
          files: [
            ['identity.md', 'Who you are'],
            ['work.md', 'What you are working on'],
            ['priorities.md', 'What matters right now'],
          ],
        },
        memory: {
          title: 'memory',
          lead: 'What happened recently. Sessions, notes, decisions.',
          body: 'Your AI picks up where you left off, without bloating its memory.',
          files: [
            ['sessions/', 'Saved conversations'],
            ['daily/', 'Day plans and notes'],
            ['decisions.md', 'Choices you already made'],
          ],
        },
        vault: {
          title: 'vault',
          lead: 'Articles, PDFs, and files you saved.',
          body: 'Ask for them later in your own words. They stay on your computer.',
          files: [
            ['raw/', 'Pages and articles you saved'],
            ['wiki/', 'Clean summaries'],
            ['assets/', 'PDFs and documents'],
          ],
        },
        skills: {
          title: 'skills',
          lead: 'Things you can ask for in plain words.',
          body: 'You never name these. Say what you want and the right one runs.',
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
      desc: 'No commands to learn. No setup words. These work on day one.',
      examples: [
        ['Plan my day', 'Builds a plan from your priorities and what you did yesterday.'],
        ['Save this article', 'Stores it as clean text you can search later.'],
        ['What did I decide about the trip?', 'Finds the answer in your saved notes and sessions.'],
        ['Is everything connected?', 'Runs a quick connection check and tells you what needs attention.'],
      ],
    },
    packs: {
      title: 'The folder is free. The packs are the shortcut.',
      desc: 'Everything in the packs exists somewhere on the internet, free. We find it, test it, package it, and keep it updated every week, so you never have to.',
      items: [
        {
          eyebrow: 'Skills',
          title: 'The best skills, picked for you.',
          desc: 'The skills that actually matter for knowledge workers, curated from the whole internet and refreshed every week.',
          price: '€12.99',
          cta: 'Get Skills',
          href: 'https://filocosta.gumroad.com/l/tgaeui',
        },
        {
          eyebrow: 'Automations',
          title: 'Real systems. Your AI works like a pro.',
          desc: 'Everything in Skills, plus complete working setups for research, transcripts, and memory. Full packaging, not pieces.',
          price: '€35',
          cta: 'Get Automations',
          href: 'https://filocosta.gumroad.com/l/baglw',
        },
      ],
      note: 'Each pack is one prompt. Paste it into your AI once: it installs everything, wires it into your folder, and keeps it updated.',
    },
    cta: {
      text: 'Stop rebuilding context by hand.',
      button: 'Get started',
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
        'Una cartella sul tuo computer che ogni AI legge: chi sei, a cosa stai lavorando, cosa hai salvato. Gratis, senza account, senza memoria nel cloud.',
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
      intro:
        'Una cartella sul tuo computer. Chi sei, a cosa stai lavorando, cosa hai salvato. Ogni AI legge gli stessi file. Nessun account. Nessuna memoria nel cloud.',
      point: 'Chiedi con parole normali. La tua AI sceglie da sola il workflow giusto.',
      promptLabel: 'Incolla questo nella tua AI',
      promptHelp:
        'La tua AI legge la guida, crea la cartella e ti fa qualche domanda. Il setup è tutto qui.',
      terminal: 'Preferisci il Terminale?',
      toolsLabel: 'Funziona con',
      tools: ['Claude Code', 'Cursor', 'Codex', 'Gemini'],
    },
    demo: {
      label: 'Anteprima setup',
      windowTitle: 'Setup DotAIOS',
      promptLabel: 'Tu',
      terminalLabel: 'Terminale',
      questionsLabel: 'Onboarding',
      initCommand: 'npx dotaios init',
    },
    folder: {
      title: 'Una cartella. Tutto quello che la tua AI deve sapere.',
      desc: 'Ogni AI parte dalla stessa pagina. File semplici che puoi aprire, modificare e spostare quando vuoi.',
      tabsLabel: 'Contenuto della cartella',
      views: {
        context: {
          title: 'context',
          lead: 'Chi sei e a cosa stai lavorando.',
          body: 'La tua AI legge questo per primo, così non ricominci mai da zero.',
          files: [
            ['identity.md', 'Chi sei'],
            ['work.md', 'A cosa stai lavorando'],
            ['priorities.md', 'Cosa conta adesso'],
          ],
        },
        memory: {
          title: 'memory',
          lead: 'Cosa è successo di recente. Sessioni, note, decisioni.',
          body: 'La tua AI riprende da dove avevi lasciato, senza appesantire la memoria.',
          files: [
            ['sessions/', 'Conversazioni salvate'],
            ['daily/', 'Piani e note del giorno'],
            ['decisions.md', 'Scelte già fatte'],
          ],
        },
        vault: {
          title: 'vault',
          lead: 'Articoli, PDF e file che hai salvato.',
          body: 'Chiedili più tardi con parole tue. Restano sul tuo computer.',
          files: [
            ['raw/', 'Pagine e articoli salvati'],
            ['wiki/', 'Sintesi pulite'],
            ['assets/', 'PDF e documenti'],
          ],
        },
        skills: {
          title: 'skills',
          lead: 'Cose che puoi chiedere con parole normali.',
          body: 'Non devi mai nominarle. Dici cosa vuoi e parte quella giusta.',
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
      desc: 'Nessun comando da imparare. Nessuna parola tecnica. Funzionano dal primo giorno.',
      examples: [
        ['Pianifica la mia giornata', 'Crea un piano dalle tue priorità e da quello che hai fatto ieri.'],
        ['Salva questo articolo', 'Lo archivia come testo pulito che puoi cercare dopo.'],
        ['Cosa avevo deciso per il viaggio?', 'Trova la risposta nelle tue note e sessioni salvate.'],
        ['È tutto collegato?', 'Fa un controllo rapido dei collegamenti e ti dice cosa sistemare.'],
      ],
    },
    packs: {
      title: 'La cartella è gratis. I pacchetti sono la scorciatoia.',
      desc: 'Tutto quello che c\'è nei pacchetti esiste da qualche parte su internet, gratis. Noi lo troviamo, lo testiamo, lo impacchettiamo e lo aggiorniamo ogni settimana, così non devi farlo tu.',
      items: [
        {
          eyebrow: 'Skills',
          title: 'Le skill migliori, scelte per te.',
          desc: 'Le skill che contano davvero per chi lavora con la testa, selezionate da tutto internet e aggiornate ogni settimana.',
          price: '€12,99',
          cta: 'Prendi Skills',
          href: 'https://filocosta.gumroad.com/l/tgaeui',
        },
        {
          eyebrow: 'Automazioni',
          title: 'Sistemi veri. La tua AI lavora da pro.',
          desc: 'Tutto il pacchetto Skills, più setup completi e funzionanti per ricerca, trascrizioni e memoria. Pacchetti interi, non pezzi.',
          price: '€35',
          cta: 'Prendi Automazioni',
          href: 'https://filocosta.gumroad.com/l/baglw',
        },
      ],
      note: 'Ogni pacchetto è un prompt. Lo incolli nella tua AI una volta: installa tutto, lo collega alla tua cartella e lo tiene aggiornato.',
    },
    cta: {
      text: 'Smetti di ricostruire il contesto a mano.',
      button: 'Inizia',
    },
    footer: {
      tagline: 'Gratuito e open source. File semplici che possiedi.',
      docs: 'Documentazione',
    },
    copied: 'Copiato',
    copy: 'Copia',
  },
}
