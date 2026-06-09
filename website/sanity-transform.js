/* Maps Sanity landingPage document → DOTAIOS_I18N shape */
(function () {
  "use strict";

  function ls(field, lang) {
    return field && field[lang] != null ? field[lang] : "";
  }

  function docToI18n(doc) {
    if (!doc) return null;

    if (doc.i18n) {
      var legacy = doc.i18n;
      if (typeof legacy === "string") {
        try { legacy = JSON.parse(legacy); } catch (e) { return null; }
      }
      if (legacy.en && legacy.it) return legacy;
    }

    var skillItems = (doc.explorerSkillItems || []).map(function (row) {
      return { en: ls(row.label, "en"), it: ls(row.label, "it") };
    });

    var askItems = (doc.askItems || []).map(function (row) {
      return {
        en: { title: ls(row.title, "en"), desc: ls(row.desc, "en") },
        it: { title: ls(row.title, "it"), desc: ls(row.desc, "it") },
      };
    });

    function build(lang) {
      return {
        meta: {
          title: ls(doc.metaTitle, lang),
          description: ls(doc.metaDescription, lang),
          ogTitle: ls(doc.metaOgTitle, lang),
          ogDescription: ls(doc.metaOgDescription, lang),
        },
        skipLink: ls(doc.skipLink, lang),
        nav: {
          aria: ls(doc.navAria, lang),
          folder: ls(doc.navFolder, lang),
          ask: ls(doc.navAsk, lang),
          github: ls(doc.navGithub, lang),
          cta: ls(doc.navCta, lang),
          langAria: ls(doc.navLangAria, lang),
        },
        hero: {
          eyebrow: ls(doc.heroEyebrow, lang),
          h1: ls(doc.heroH1, lang),
          sub: ls(doc.heroSub, lang),
          toolsAria: ls(doc.heroToolsAria, lang),
        },
        install: {
          title: ls(doc.installTitle, lang),
          desc: ls(doc.installDesc, lang),
          snippetDisplay: ls(doc.installSnippetDisplay, lang),
          snippetCopy: ls(doc.installSnippetCopy, lang),
          copy: ls(doc.installCopy, lang),
          copied: ls(doc.installCopied, lang),
          terminalSummary: ls(doc.installTerminalSummary, lang),
          terminalCopy: ls(doc.installTerminalCopy, lang),
        },
        explorer: {
          title: ls(doc.explorerTitle, lang),
          desc: ls(doc.explorerDesc, lang),
          aria: ls(doc.explorerAria, lang),
          treeAria: ls(doc.explorerTreeAria, lang),
          start: {
            lead: ls(doc.explorerStartLead, lang),
            body: ls(doc.explorerStartBody, lang),
          },
          agents: {
            lead: ls(doc.explorerAgentsLead, lang),
            pre: ls(doc.explorerAgentsPre, lang),
            preAria: ls(doc.explorerAgentsPreAria, lang),
          },
          context: {
            identity: ls(doc.explorerContextIdentity, lang),
            work: ls(doc.explorerContextWork, lang),
            priorities: ls(doc.explorerContextPriorities, lang),
          },
          memory: {
            daily: ls(doc.explorerMemoryDaily, lang),
            profile: ls(doc.explorerMemoryProfile, lang),
            sessions: ls(doc.explorerMemorySessions, lang),
          },
          vault: {
            raw: ls(doc.explorerVaultRaw, lang),
            assets: ls(doc.explorerVaultAssets, lang),
          },
          skills: {
            lead: ls(doc.explorerSkillsLead, lang),
            items: skillItems.map(function (row) { return row[lang]; }),
          },
        },
        ask: {
          title: ls(doc.askTitle, lang),
          desc: ls(doc.askDesc, lang),
          items: askItems.map(function (row) { return row[lang]; }),
          note: ls(doc.askNote, lang),
        },
        cta: {
          text: ls(doc.ctaText, lang),
          btn: ls(doc.ctaBtn, lang),
        },
        footer: {
          tagline: ls(doc.footerTagline, lang),
          folder: ls(doc.footerFolder, lang),
          ask: ls(doc.footerAsk, lang),
          install: ls(doc.footerInstall, lang),
          docs: ls(doc.footerDocs, lang),
          github: ls(doc.footerGithub, lang),
        },
      };
    }

    return { en: build("en"), it: build("it") };
  }

  window.DOTAIOS_SANITY = { docToI18n: docToI18n };
})();
