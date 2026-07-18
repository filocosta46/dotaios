export const LANGUAGES = [
  {id: 'en', label: 'EN'},
  {id: 'it', label: 'IT'},
]

export const DEFAULT_LANG = 'en'
export const LANG_STORAGE_KEY = 'dotaios-lang'
export const CURRENT_COPY_RELEASE = '2026-07-18-consumer-context-folder'

export const COPY = {
  installPrompt: {
    en: 'Set up DotAIOS from https://github.com/filocosta46/dotaios: read INSTALL.md, check the prerequisites, then guide me through each step and ask before running commands that change my files.',
    it: 'Configura DotAIOS da https://github.com/filocosta46/dotaios: leggi INSTALL.md, verifica i prerequisiti, poi guidami passo passo e chiedimi conferma prima di eseguire comandi che modificano i miei file.',
  },
}

export const folderViews = [
  {id: 'context', name: 'context', path: '~/aios/context/'},
  {id: 'projects', name: 'projects', path: '~/aios/projects/'},
  {id: 'sources', name: 'sources', path: '~/aios/vault/'},
  {id: 'memory', name: 'memory', path: '~/aios/memory/'},
  {id: 'skills', name: 'skills', path: '~/aios/skills/'},
]

const sharedViews = {
  context: {
    files: [
      ['identity.md', 'Who you are'],
      ['priorities.md', 'What matters now'],
    ],
  },
  projects: {
    files: [
      ['README.md', 'What this is'],
      ['plans/', 'What comes next'],
    ],
  },
  sources: {
    files: [
      ['raw/', 'Saved articles and notes'],
      ['assets/', 'Documents and files'],
    ],
  },
  memory: {
    files: [
      ['sessions/', 'Conversations you save'],
      ['daily/', 'Daily notes'],
    ],
  },
  skills: {
    files: [
      ['plan-today', 'Plan my day'],
      ['weekly-review', 'Review my week'],
    ],
  },
}

export const dictionary = {
  en: {
    meta: {
      title: 'DotAIOS | A local AI context folder for your work',
      description:
        'Keep projects, documents, memory, and AI workflows in one private local folder. Your chosen AI provider processes the context you send.',
    },
    nav: {
      folder: 'The folder',
      how: 'How it works',
      packs: 'Consultant pack',
      github: 'GitHub',
      cta: 'Set up free',
      language: 'Language',
    },
    hero: {
      eyebrow: 'Your work, ready for AI.',
      titleLine1: 'Stop starting from scratch',
      titleLine2: 'with every AI.',
      intro: 'DotAIOS keeps your projects, notes, sources, decisions, and reusable workflows in one private folder. Supported desktop AI tools can use the same files.',
      primary: 'Copy free setup prompt',
      secondary: 'See the folder',
      note: 'Free and open source. Files stay local. Your AI provider processes the context you choose to send.',
      copied: 'Prompt copied',
    },
    folder: {
      eyebrow: 'The folder is the product',
      title: 'Your work stays simple. Your AI gets the context.',
      desc: 'Plain files hold what matters: who you are, active projects, selected documents, saved decisions, and the workflows you use often.',
      tabsLabel: 'Folder contents',
      sidebarHeading: 'DotAIOS',
      views: {
        context: {
          ...sharedViews.context,
          lead: 'Who you are and what matters now.',
          body: 'Keep a small, reviewed starting point for supported AI tools.',
        },
        projects: {
          ...sharedViews.projects,
          lead: 'Each piece of work keeps its own thread.',
          body: 'Goals, decisions, sources, and next actions stay together.',
        },
        sources: {
          ...sharedViews.sources,
          lead: 'Bring the documents worth using again.',
          body: 'Save selected articles, notes, PDFs, and files with their origin intact.',
        },
        memory: {
          ...sharedViews.memory,
          lead: 'Keep the outcomes you choose to remember.',
          body: 'Save useful sessions and decisions explicitly. Raw chats are not mirrored by default.',
        },
        skills: {
          ...sharedViews.skills,
          lead: 'Turn repeated work into a reusable method.',
          body: 'Skills tell a supported AI tool how to carry out a workflow with clear review gates.',
        },
      },
    },
    how: {
      eyebrow: 'How it works',
      title: 'Set it up once. Keep using the AI you already have.',
      desc: 'DotAIOS does not replace your AI app or subscription. It gives supported desktop tools an owned place to find the context you choose to keep.',
      steps: [
        ['01', 'Answer three questions', 'Add who you are, what you do, and what matters now. You can review every file.'],
        ['02', 'Add the work you choose', 'Route selected projects, notes, and documents into one predictable folder.'],
        ['03', 'Ask from a supported tool', 'Use Codex, Claude Code, Cursor, Gemini CLI, or another supported desktop client with the same local source of truth.'],
      ],
      proofLabel: 'Your first check',
      proofPrompt: 'What am I working on?',
      proofResult: 'The answer should reflect the projects and priorities you just reviewed.',
    },
    ask: {
      eyebrow: 'What changes day to day',
      title: 'Ask normally. Keep the thread.',
      desc: 'Once a supported tool is configured, it can work from the files you own instead of a blank chat.',
      examples: [
        ['Plan my day', 'Uses your reviewed priorities.'],
        ['Save this article', 'Keeps a clean copy and its source.'],
        ['What did we decide?', 'Searches the project and saved memory.'],
        ['Pick up this client project', 'Finds its goals, sources, and next actions.'],
      ],
    },
    compatibility: {
      eyebrow: 'Compatibility and privacy',
      title: 'Local files, honest limits.',
      desc: 'DotAIOS configures files and bridges for supported desktop clients. The client version and its runtime decide what is actually read in a session.',
      cards: [
        ['Best fit today', 'People already using Codex, Claude Code, Cursor, Gemini CLI, or another supported local agent on a desktop.'],
        ['Browser chats', 'A browser chat cannot open your local folder directly. Attach a reviewed brief or selected files when you use one.'],
        ['What stays local', 'The DotAIOS folder stays on your computer unless you enable an optional sync or connection.'],
        ['What leaves the folder', 'Your chosen AI provider processes the context you send to it. DotAIOS does not hide that relationship.'],
      ],
      matrixCta: 'Read the client support matrix',
    },
    packs: {
      eyebrow: 'The first role pack',
      title: 'Run client work without rebuilding the process every time.',
      desc: 'The Independent Consultant Pack adds six reviewed workflows to the free DotAIOS folder. It is for solo consultants and small studios managing calls, research, proposals, deliverables, and follow-up.',
      name: 'Independent Consultant Pack',
      price: '€35 once',
      priceNote: 'Your AI app and subscription are separate.',
      status: 'In final review',
      gate: 'Checkout stays closed until install, removal, update, rollback, and recovery tests pass.',
      cta: 'Start with free DotAIOS',
      includedLabel: 'Six client workflows',
      items: [
        {
          name: 'Start a client project',
          outcome: 'Turn a brief, notes, and source files into one clear client record.',
          detail: 'Goals, scope, stakeholders, open questions, sources, and next actions stay together.',
          cta: 'Included',
          href: null,
        },
        {
          name: 'Prepare for a client call',
          outcome: 'Build an agenda from recent decisions, open actions, and selected documents.',
          detail: 'Missing context is flagged instead of guessed.',
          cta: 'Included',
          href: null,
        },
        {
          name: 'Turn notes into follow-up',
          outcome: 'Extract decisions, owners, dates, and next steps, then draft the email.',
          detail: 'Nothing is sent without your review.',
          cta: 'Included',
          href: null,
        },
        {
          name: 'Research a client question',
          outcome: 'Create a bounded recommendation memo with sources and assumptions.',
          detail: 'Evidence, uncertainty, and recommendations stay separate.',
          cta: 'Included',
          href: null,
        },
        {
          name: 'Draft a proposal',
          outcome: 'Turn a confirmed brief into deliverables, exclusions, and milestones.',
          detail: 'You keep control of pricing, commitments, and sending.',
          cta: 'Included',
          href: null,
        },
        {
          name: 'Review every active client',
          outcome: 'See commitments, waiting items, risks, and next actions in one weekly pass.',
          detail: 'Draft status updates remain behind a human approval gate.',
          cta: 'Included',
          href: null,
        },
      ],
    },
    footer: {
      tagline: 'Free core. Local files. Your AI plan.',
      docs: 'Docs',
      support: 'Client support',
      security: 'Security',
    },
    copy: 'Copy',
  },
  it: {
    meta: {
      title: 'DotAIOS | Una cartella locale per il contesto della tua AI',
      description:
        'Tieni progetti, documenti, memoria e workflow AI in una cartella locale e privata. Il provider AI che scegli elabora il contesto che invii.',
    },
    nav: {
      folder: 'La cartella',
      how: 'Come funziona',
      packs: 'Pack consulenti',
      github: 'GitHub',
      cta: 'Configura gratis',
      language: 'Lingua',
    },
    hero: {
      eyebrow: 'Il tuo lavoro, pronto per l’AI.',
      titleLine1: 'Smetti di ripartire da zero',
      titleLine2: 'con ogni AI.',
      intro: 'DotAIOS tiene progetti, note, fonti, decisioni e workflow riutilizzabili in una cartella privata. Gli strumenti AI desktop supportati possono usare gli stessi file.',
      primary: 'Copia il prompt gratuito',
      secondary: 'Guarda la cartella',
      note: 'Gratis e open source. I file restano in locale. Il provider AI elabora il contesto che scegli di inviare.',
      copied: 'Prompt copiato',
    },
    folder: {
      eyebrow: 'La cartella è il prodotto',
      title: 'Il tuo lavoro resta semplice. La tua AI riceve il contesto.',
      desc: 'File semplici conservano ciò che conta: chi sei, i progetti attivi, i documenti selezionati, le decisioni salvate e i workflow che usi spesso.',
      tabsLabel: 'Contenuto della cartella',
      sidebarHeading: 'DotAIOS',
      views: {
        context: {
          files: [
            ['identity.md', 'Chi sei'],
            ['priorities.md', 'Cosa conta ora'],
          ],
          lead: 'Chi sei e cosa conta adesso.',
          body: 'Mantieni un punto di partenza piccolo e verificato per gli strumenti AI supportati.',
        },
        projects: {
          files: [
            ['README.md', 'Cos’è questo'],
            ['plans/', 'Cosa viene dopo'],
          ],
          lead: 'Ogni lavoro mantiene il proprio filo.',
          body: 'Obiettivi, decisioni, fonti e prossime azioni restano insieme.',
        },
        sources: {
          files: [
            ['raw/', 'Articoli e note salvati'],
            ['assets/', 'Documenti e file'],
          ],
          lead: 'Porta con te i documenti che vale la pena riutilizzare.',
          body: 'Salva articoli, note, PDF e file selezionati mantenendo la loro origine.',
        },
        memory: {
          files: [
            ['sessions/', 'Conversazioni che salvi'],
            ['daily/', 'Note del giorno'],
          ],
          lead: 'Conserva i risultati che scegli di ricordare.',
          body: 'Salva sessioni e decisioni utili in modo esplicito. Le chat grezze non vengono copiate in automatico.',
        },
        skills: {
          files: [
            ['plan-today', 'Pianifica la giornata'],
            ['weekly-review', 'Rivedi la settimana'],
          ],
          lead: 'Trasforma il lavoro ripetuto in un metodo riutilizzabile.',
          body: 'Le skill spiegano a uno strumento AI supportato come svolgere un workflow con passaggi di verifica chiari.',
        },
      },
    },
    how: {
      eyebrow: 'Come funziona',
      title: 'Configuralo una volta. Continua a usare l’AI che hai già.',
      desc: 'DotAIOS non sostituisce la tua app AI o il tuo abbonamento. Offre agli strumenti desktop supportati un posto di tua proprietà dove trovare il contesto che scegli di conservare.',
      steps: [
        ['01', 'Rispondi a tre domande', 'Aggiungi chi sei, cosa fai e cosa conta ora. Puoi controllare ogni file.'],
        ['02', 'Aggiungi il lavoro che scegli', 'Porta progetti, note e documenti selezionati in una cartella prevedibile.'],
        ['03', 'Chiedi da uno strumento supportato', 'Usa Codex, Claude Code, Cursor, Gemini CLI o un altro client desktop supportato con la stessa fonte locale.'],
      ],
      proofLabel: 'La prima verifica',
      proofPrompt: 'Su cosa sto lavorando?',
      proofResult: 'La risposta dovrebbe riflettere i progetti e le priorità che hai appena controllato.',
    },
    ask: {
      eyebrow: 'Cosa cambia ogni giorno',
      title: 'Chiedi normalmente. Mantieni il filo.',
      desc: 'Una volta configurato, uno strumento supportato può lavorare dai file che possiedi invece di partire da una chat vuota.',
      examples: [
        ['Pianifica la mia giornata', 'Usa le tue priorità verificate.'],
        ['Salva questo articolo', 'Conserva una copia pulita e la sua fonte.'],
        ['Cosa abbiamo deciso?', 'Cerca nel progetto e nella memoria salvata.'],
        ['Riprendi questo progetto cliente', 'Trova obiettivi, fonti e prossime azioni.'],
      ],
    },
    compatibility: {
      eyebrow: 'Compatibilità e privacy',
      title: 'File locali, limiti chiari.',
      desc: 'DotAIOS configura file e collegamenti per i client desktop supportati. La versione del client e il suo runtime decidono cosa viene letto davvero in una sessione.',
      cards: [
        ['Per chi funziona meglio oggi', 'Persone che usano già Codex, Claude Code, Cursor, Gemini CLI o un altro agente locale supportato su desktop.'],
        ['Chat nel browser', 'Una chat nel browser non può aprire direttamente la cartella locale. Puoi allegare un riepilogo verificato o i file selezionati.'],
        ['Cosa resta in locale', 'La cartella DotAIOS resta sul tuo computer, a meno che tu non abiliti una sincronizzazione o una connessione opzionale.'],
        ['Cosa lascia la cartella', 'Il provider AI che scegli elabora il contesto che gli invii. DotAIOS non nasconde questo rapporto.'],
      ],
      matrixCta: 'Leggi la matrice di supporto',
    },
    packs: {
      eyebrow: 'Il primo pack professionale',
      title: 'Gestisci il lavoro dei clienti senza ricostruire ogni volta il processo.',
      desc: 'L’Independent Consultant Pack aggiunge sei workflow verificati alla cartella DotAIOS gratuita. È pensato per consulenti indipendenti e piccoli studi che gestiscono call, ricerca, proposte, consegne e follow-up.',
      name: 'Independent Consultant Pack',
      price: '€35 una volta',
      priceNote: 'L’app AI e il relativo abbonamento sono separati.',
      status: 'In verifica finale',
      gate: 'Il checkout resta chiuso finché i test di installazione, rimozione, aggiornamento, rollback e recupero non saranno superati.',
      cta: 'Inizia con DotAIOS gratis',
      includedLabel: 'Sei workflow per i clienti',
      items: [
        {
          name: 'Avvia un progetto cliente',
          outcome: 'Trasforma brief, note e file sorgente in una scheda cliente chiara.',
          detail: 'Obiettivi, perimetro, stakeholder, domande aperte, fonti e prossime azioni restano insieme.',
          cta: 'Incluso',
          href: null,
        },
        {
          name: 'Prepara una call con il cliente',
          outcome: 'Crea un’agenda da decisioni recenti, azioni aperte e documenti selezionati.',
          detail: 'Il contesto mancante viene segnalato, non inventato.',
          cta: 'Incluso',
          href: null,
        },
        {
          name: 'Trasforma le note in follow-up',
          outcome: 'Estrai decisioni, responsabili, date e prossimi passi, poi prepara l’email.',
          detail: 'Nulla viene inviato senza la tua verifica.',
          cta: 'Incluso',
          href: null,
        },
        {
          name: 'Ricerca una domanda del cliente',
          outcome: 'Crea un memo delimitato con fonti, ipotesi e raccomandazioni.',
          detail: 'Evidenze, incertezza e raccomandazioni restano separate.',
          cta: 'Incluso',
          href: null,
        },
        {
          name: 'Prepara una proposta',
          outcome: 'Trasforma un brief confermato in deliverable, esclusioni e milestone.',
          detail: 'Mantieni il controllo su prezzo, impegni e invio.',
          cta: 'Incluso',
          href: null,
        },
        {
          name: 'Rivedi tutti i clienti attivi',
          outcome: 'Controlla impegni, attese, rischi e prossime azioni in una revisione settimanale.',
          detail: 'Le bozze di aggiornamento restano soggette alla tua approvazione.',
          cta: 'Incluso',
          href: null,
        },
      ],
    },
    footer: {
      tagline: 'Base gratuita. File locali. Il tuo piano AI.',
      docs: 'Documentazione',
      support: 'Supporto client',
      security: 'Sicurezza',
    },
    copy: 'Copia',
  },
}
