export const LANGUAGES = [
  {id: 'en', label: 'EN'},
  {id: 'it', label: 'IT'},
]

export const DEFAULT_LANG = 'en'
export const LANG_STORAGE_KEY = 'dotaios-lang'
export const CURRENT_COPY_RELEASE = '2026-07-15-v8-offer'

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
  memory: {
    files: [
      ['sessions/', 'Saved conversations'],
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
      title: 'DotAIOS. Your AI, with context.',
      description:
        'One private folder for the context, projects, and memory you want your connected AI agents to share.',
    },
    nav: {
      folder: 'The folder',
      ask: 'What to ask',
      github: 'GitHub',
      cta: 'Get started',
      language: 'Language',
    },
    hero: {
      eyebrow: 'Your AI, with context.',
      titleLine1: 'Stop starting over',
      titleLine2: 'when you switch AI tools.',
      intro: 'One private folder keeps your context ready across supported local agents. Copy the setup prompt into a local AI tool you already use.',
      primary: 'Copy setup prompt',
      secondary: 'See the folder',
      note: 'Core context connects to detected Claude Code, Codex, and Gemini CLI. Cursor connects per project. Claude Code can auto-save sessions today; other tools use explicit saving or import.',
      copied: 'Prompt copied',
    },
    folder: {
      eyebrow: 'The folder',
      title: 'Everything your AI needs. In one place.',
      desc: 'Context for you. Memory for what happened. Projects for what comes next.',
      tabsLabel: 'Folder contents',
      sidebarHeading: 'Favorites',
      views: {
        context: {
          ...sharedViews.context,
          lead: 'Who you are and what matters now.',
          body: 'Supported local agents can start from the context you connect.',
        },
        projects: {
          ...sharedViews.projects,
          lead: 'Your work, with its own thread.',
          body: 'Keep the next step close to the bigger picture.',
        },
        memory: {
          ...sharedViews.memory,
          lead: 'Sessions and decisions you can find again.',
          body: 'Plain files. Local, searchable, yours.',
        },
        skills: {
          ...sharedViews.skills,
          lead: 'Ask in the words you already use.',
          body: 'DotAIOS finds the right workflow.',
        },
      },
    },
    ask: {
      eyebrow: 'The useful part',
      title: 'Ask naturally. Pick up where you left off.',
      desc: 'The folder helps supported agents start further along.',
      examples: [
        ['Plan my day', 'Uses your priorities.'],
        ['Save this article', 'Keeps a clean copy.'],
        ['What are my goals?', 'Looks in your context.'],
        ['Pick up where we left off', 'Finds the right project.'],
      ],
    },
    packs: {
      eyebrow: 'For the work you want to hand off',
      title: 'Put your AI to work.',
      desc: 'The free folder gives supported local agents the context you connect. These packs will give them better ways to act, with workflows we find, test, and explain.',
      items: [
        {
          name: 'Better ways to work',
          outcome: 'Get better work from the AI you already use.',
          detail: 'Research, design, spreadsheets, writing, and prompts that show you how to ask for the right thing.',
          cta: 'Coming soon',
          href: null,
        },
        {
          name: 'Work you can hand off',
          outcome: 'Hand off the work that takes several steps.',
          detail: 'Job applications, CRM upkeep, content workflows, and follow-through your AI can carry forward.',
          cta: 'Coming soon',
          href: null,
        },
      ],
    },
    footer: {
      tagline: 'Free, open source, yours.',
      docs: 'Docs',
    },
    copy: 'Copy',
  },
  it: {
    meta: {
      title: 'DotAIOS. La tua AI, con contesto.',
      description:
        'Una cartella privata per il contesto, i progetti e la memoria che vuoi condividere tra i tuoi agenti AI collegati.',
    },
    nav: {
      folder: 'La cartella',
      ask: 'Cosa chiedere',
      github: 'GitHub',
      cta: 'Inizia',
      language: 'Lingua',
    },
    hero: {
      eyebrow: 'La tua AI, con contesto.',
      titleLine1: 'Smetti di rispiegarti',
      titleLine2: 'a ogni AI.',
      intro: 'Una cartella tiene pronto il tuo contesto tra gli agenti supportati, in ogni sessione. Copia il prompt e incollalo nell’AI che usi già.',
      primary: 'Copia il prompt',
      secondary: 'Guarda la cartella',
      note: 'Gratis e open source. La memoria resta sul tuo computer.',
      copied: 'Prompt copiato',
    },
    folder: {
      eyebrow: 'La cartella',
      title: 'Tutto quello che serve alla tua AI. In un posto solo.',
      desc: 'Contesto per te. Memoria per ciò che è successo. Progetti per ciò che viene dopo.',
      tabsLabel: 'Contenuto della cartella',
      sidebarHeading: 'Preferiti',
      views: {
        context: {
          files: [
            ['identity.md', 'Chi sei'],
            ['priorities.md', 'Cosa conta ora'],
          ],
          lead: 'Chi sei e cosa conta adesso.',
          body: 'Ogni agente collegato parte dallo stesso punto.',
        },
        projects: {
          files: [
            ['README.md', 'Cos’è questo'],
            ['plans/', 'Cosa viene dopo'],
          ],
          lead: 'Il tuo lavoro, con il suo filo.',
          body: 'Tieni vicino il prossimo passo e il quadro completo.',
        },
        memory: {
          files: [
            ['sessions/', 'Conversazioni salvate'],
            ['daily/', 'Note del giorno'],
          ],
          lead: 'Sessioni e decisioni da ritrovare.',
          body: 'File semplici. Locali, cercabili, tuoi.',
        },
        skills: {
          files: [
            ['plan-today', 'Pianifica la giornata'],
            ['weekly-review', 'Rivedi la settimana'],
          ],
          lead: 'Chiedi con le parole che usi già.',
          body: 'DotAIOS trova il workflow giusto.',
        },
      },
    },
    ask: {
      eyebrow: 'La parte utile',
      title: 'Chiedi normalmente. Riprendi da dove eri.',
      desc: 'La cartella fa partire ogni conversazione un passo più avanti.',
      examples: [
        ['Pianifica la mia giornata', 'Usa le tue priorità.'],
        ['Salva questo articolo', 'Conservane una copia pulita.'],
        ['Quali sono i miei obiettivi?', 'Cerca nel tuo contesto.'],
        ['Riprendi da dove eravamo rimasti', 'Trova il progetto giusto.'],
      ],
    },
    packs: {
      eyebrow: 'Per il lavoro che vuoi affidare',
      title: 'Metti al lavoro la tua AI.',
      desc: 'La cartella gratuita dà a ogni agente collegato il tuo contesto. Questi pack gli daranno modi migliori per agire, con workflow che troviamo, testiamo e spieghiamo.',
      items: [
        {
          name: 'Modi migliori per lavorare',
          outcome: 'Ottieni risultati migliori dall’AI che usi già.',
          detail: 'Ricerca, design, fogli di calcolo, scrittura e prompt per chiedere esattamente ciò che serve.',
          cta: 'In arrivo',
          href: null,
        },
        {
          name: 'Lavoro che puoi affidare',
          outcome: 'Affida all’AI il lavoro che richiede più passaggi.',
          detail: 'Candidature, CRM, contenuti e il seguito delle attività che l’AI può portare avanti.',
          cta: 'In arrivo',
          href: null,
        },
      ],
    },
    footer: {
      tagline: 'Gratis, open source, tuo.',
      docs: 'Documentazione',
    },
    copy: 'Copia',
  },
}
