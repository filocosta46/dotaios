/* =============================================================
   DotAIOS — app.js  (framework-free, no build step)
   ============================================================= */
(function () {
  "use strict";
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var LANG_KEY = "dotaios-lang";
  var currentLang = "en";
  var copyLabel = "Copied";

  var SANITY = {
    projectId: "h7araeal",
    dataset: "production",
    apiVersion: "2025-06-06",
  };

  function get(obj, path) {
    return path.split(".").reduce(function (o, k) {
      return o && o[k] !== undefined ? o[k] : undefined;
    }, obj);
  }

  function detectLang() {
    var params = new URLSearchParams(window.location.search);
    var fromUrl = params.get("lang");
    if (fromUrl === "en" || fromUrl === "it") return fromUrl;
    try {
      var stored = localStorage.getItem(LANG_KEY);
      if (stored === "en" || stored === "it") return stored;
    } catch (e) {}
    var nav = (navigator.language || "").toLowerCase();
    if (nav.indexOf("it") === 0) return "it";
    return "en";
  }

  function setUrlLang(lang) {
    var url = new URL(window.location.href);
    url.searchParams.set("lang", lang);
    window.history.replaceState({}, "", url.pathname + url.search + url.hash);
  }

  function applyLang(lang) {
    var pack = window.DOTAIOS_I18N && window.DOTAIOS_I18N[lang];
    if (!pack) return;

    currentLang = lang;
    copyLabel = pack.install.copied;

    document.documentElement.lang = lang;

    var meta = pack.meta;
    if (meta) {
      document.title = meta.title;
      var desc = document.querySelector('meta[name="description"]');
      if (desc) desc.setAttribute("content", meta.description);
      var ogTitle = document.querySelector('meta[property="og:title"]');
      if (ogTitle) ogTitle.setAttribute("content", meta.ogTitle);
      var ogDesc = document.querySelector('meta[property="og:description"]');
      if (ogDesc) ogDesc.setAttribute("content", meta.ogDescription);
    }

    document.querySelectorAll("[data-i18n]").forEach(function (el) {
      var val = get(pack, el.getAttribute("data-i18n"));
      if (val !== undefined) el.textContent = val;
    });

    document.querySelectorAll("[data-i18n-html]").forEach(function (el) {
      var val = get(pack, el.getAttribute("data-i18n-html"));
      if (val !== undefined) el.innerHTML = val;
    });

    document.querySelectorAll("[data-i18n-attr]").forEach(function (el) {
      el.getAttribute("data-i18n-attr").split(";").forEach(function (pair) {
        var parts = pair.split(":");
        if (parts.length < 2) return;
        var attr = parts[0].trim();
        var key = parts.slice(1).join(":").trim();
        var val = get(pack, key);
        if (val !== undefined) el.setAttribute(attr, val);
      });
    });

    document.querySelectorAll("[data-copy-key]").forEach(function (el) {
      var key = el.getAttribute("data-copy-key");
      var val = get(pack, key);
      if (val !== undefined) el.setAttribute("data-copy", val);
    });

    document.querySelectorAll(".lang-btn").forEach(function (btn) {
      var on = btn.getAttribute("data-lang") === lang;
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    });

    try { localStorage.setItem(LANG_KEY, lang); } catch (e) {}
    setUrlLang(lang);
  }

  function fetchSanityI18n() {
    var query = encodeURIComponent('*[_type == "landingPage"][0].i18n');
    var url =
      "https://" + SANITY.projectId + ".apicdn.sanity.io/v" + SANITY.apiVersion +
      "/data/query/" + SANITY.dataset + "?query=" + query;
    return fetch(url)
      .then(function (res) { return res.json(); })
      .then(function (data) {
        var i18n = data && data.result;
        if (i18n && i18n.en && i18n.it) {
          window.DOTAIOS_I18N = i18n;
          return true;
        }
        return false;
      })
      .catch(function () { return false; });
  }

  function initI18n() {
    if (!window.DOTAIOS_I18N) return;
    applyLang(detectLang());

    document.querySelectorAll(".lang-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var lang = btn.getAttribute("data-lang");
        if (lang === currentLang) return;
        applyLang(lang);
        document.querySelectorAll(".snippet .copy").forEach(function (b) {
          delete b.dataset.bound;
        });
        bindCopy(document);
      });
    });
  }

  function bindCopy(root) {
    (root || document).querySelectorAll(".snippet .copy").forEach(function (btn) {
      if (btn.dataset.bound) return;
      btn.dataset.bound = "1";
      btn.addEventListener("click", function () {
        var snip = btn.closest(".snippet");
        var text = snip ? snip.getAttribute("data-copy") : "";
        var done = function () {
          var old = btn.textContent;
          btn.textContent = copyLabel;
          btn.classList.add("copied");
          setTimeout(function () { btn.textContent = old; btn.classList.remove("copied"); }, 1600);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done).catch(done);
        } else {
          var ta = document.createElement("textarea");
          ta.value = text; document.body.appendChild(ta); ta.select();
          try { document.execCommand("copy"); } catch (e) {}
          document.body.removeChild(ta); done();
        }
      });
    });
  }

  function initReveal() {
    var els = Array.prototype.slice.call(document.querySelectorAll(".reveal"));
    var stmt = document.querySelector(".statement");
    if (reduceMotion || !("IntersectionObserver" in window)) {
      els.forEach(function (el) { el.classList.add("in"); });
      if (stmt) stmt.classList.add("in");
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); }
      });
    }, { threshold: 0.12, rootMargin: "0px 0px -8% 0px" });
    els.forEach(function (el) { io.observe(el); });

    if (stmt) {
      var io2 = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) { if (en.isIntersecting) { en.target.classList.add("in"); io2.unobserve(en.target); } });
      }, { threshold: 0.4 });
      io2.observe(stmt);
    }
  }

  function initNav() {
    var nav = document.querySelector(".site-nav");
    if (!nav) return;
    var onScroll = function () { nav.classList.toggle("scrolled", window.scrollY > 12); };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
  }

  function initFinder() {
    var tree = document.querySelector(".tree");
    var pathLabel = document.getElementById("path-label");
    if (!tree) return;

    var views = {};
    document.querySelectorAll(".pane-view").forEach(function (v) {
      var id = v.id.replace("view-", "");
      views[id] = v;
    });

    function showView(name, path) {
      Object.keys(views).forEach(function (k) {
        var el = views[k];
        var on = k === name;
        el.hidden = !on;
        el.classList.toggle("active", on);
      });
      tree.querySelectorAll(".tree-item").forEach(function (btn) {
        btn.classList.toggle("active", btn.getAttribute("data-view") === name);
      });
      if (pathLabel && path) pathLabel.textContent = path;
      var pane = document.getElementById("pane");
      if (pane) pane.scrollTop = 0;
    }

    tree.addEventListener("click", function (e) {
      var btn = e.target.closest(".tree-item");
      if (!btn) return;
      showView(btn.getAttribute("data-view"), btn.getAttribute("data-path"));
    });
  }

  function start() {
    initI18n();
    initNav();
    initReveal();
    initFinder();
    bindCopy(document);
  }

  function boot() {
    fetchSanityI18n().finally(start);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
