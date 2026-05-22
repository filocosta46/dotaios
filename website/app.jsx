// =============================================================
// DotAIOS landing page — composition
// =============================================================

const { useState, useEffect } = React;

const INSTALL_SNIPPET = `Set up DotAIOS for me: read https://github.com/filocosta46/dotaios and follow INSTALL.md step by step.`;
const NPX_SNIPPET = `npx dotaios setup`;

// ---- Tweakable defaults (host can rewrite this JSON on disk) ----
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "accent": "cobalt",
  "accentColor": "#2454e6",
  "bgTone": "white",
  "headlineWeight": 600,
  "headlineText": "Your AI knows |how to code.| It doesn't know *who you are.*",
  "showGraph": true,
  "density": "regular"
} /*EDITMODE-END*/;

// Accent palettes — a curated set, anti-Claude across the board
const ACCENTS = {
  cobalt: { hex: "#2454e6", deep: "#1939a8", tint: "#e6ecff", oklch: "oklch(0.52 0.20 258)", deepOklch: "oklch(0.38 0.20 258)", tintOklch: "oklch(0.94 0.05 258)" },
  magenta: { hex: "#d11d75", deep: "#8d0e4f", tint: "#fde6f2", oklch: "oklch(0.58 0.22 350)", deepOklch: "oklch(0.42 0.22 350)", tintOklch: "oklch(0.94 0.06 350)" },
  forest: { hex: "#0f7a47", deep: "#085030", tint: "#deefe6", oklch: "oklch(0.50 0.14 155)", deepOklch: "oklch(0.36 0.14 155)", tintOklch: "oklch(0.94 0.05 155)" },
  orange: { hex: "#d75a18", deep: "#8f3a0c", tint: "#fbe7d7", oklch: "oklch(0.62 0.18 45)", deepOklch: "oklch(0.46 0.18 45)", tintOklch: "oklch(0.94 0.06 45)" },
  graphite: { hex: "#3a3a3a", deep: "#1a1a1a", tint: "#e8e8e8", oklch: "oklch(0.36 0.01 250)", deepOklch: "oklch(0.20 0.01 250)", tintOklch: "oklch(0.92 0.005 250)" }
};

const BG_TONES = {
  white: { paper: "oklch(1 0 0)", soft: "oklch(0.975 0.004 250)", cool: "oklch(0.95 0.007 250)" },
  cool: { paper: "oklch(0.985 0.006 240)", soft: "oklch(0.965 0.010 240)", cool: "oklch(0.945 0.012 240)" },
  paper: { paper: "oklch(0.985 0.008 80)", soft: "oklch(0.965 0.012 80)", cool: "oklch(0.945 0.016 80)" },
  inkwell: { paper: "oklch(0.98 0.004 250)", soft: "oklch(0.96 0.005 250)", cool: "oklch(0.93 0.008 250)" }
};

const DENSITY = {
  compact: 64,
  regular: 96,
  comfy: 128
};

// Apply tweaks by mutating CSS vars on the document root
function applyTweaks(t) {
  const root = document.documentElement.style;
  const accent = ACCENTS[t.accent] || ACCENTS.cobalt;
  root.setProperty("--cobalt", accent.oklch);
  root.setProperty("--cobalt-deep", accent.deepOklch);
  root.setProperty("--cobalt-tint", accent.tintOklch);
  const bg = BG_TONES[t.bgTone] || BG_TONES.white;
  root.setProperty("--paper", bg.paper);
  root.setProperty("--paper-soft", bg.soft);
  root.setProperty("--paper-cool", bg.cool);
  root.setProperty("--card", bg.paper);
  root.setProperty("--tweak-headline-weight", String(t.headlineWeight));
  root.setProperty("--tweak-section-pad", `${DENSITY[t.density] || 96}px`);
  // body bg may be overridden by inline attribute — sync it too
  document.body.style.backgroundColor = bg.paper;
}

function Nav() {
  return (
    <nav className="nav">
      <div className="brand">
        <span className="brand-mark"></span>
        DotAIOS <span>· a folder for your AI</span>
      </div>
      <div className="nav-links">
        <a href="#how">How it works</a>
        <a href="#marketplace">Skills</a>
        <a href="https://github.com/filocosta46/dotaios" target="_blank" rel="noopener">GitHub</a>
        <a className="nav-cta" href="#install">Get started</a>
      </div>
    </nav>);

}

function Hero({ headlineText, showGraph }) {
  const [copied, setCopied] = useState(false);
  const [copiedNpx, setCopiedNpx] = useState(false);
  const copy = async (text, setter) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();document.execCommand("copy");document.body.removeChild(ta);
    }
    setter(true);
    setTimeout(() => setter(false), 1800);
  };

  // Parse headlineText: |strike| and *accent* segments
  const renderHeadline = () => {
    const parts = [];
    const re = /(\|[^|]+\||\*[^*]+\*|[^|*]+)/g;
    let m;
    let key = 0;
    while ((m = re.exec(headlineText || "")) !== null) {
      const seg = m[0];
      if (seg.startsWith("|") && seg.endsWith("|")) {
        parts.push(<span key={key++} className="strike">{seg.slice(1, -1)}</span>);
      } else if (seg.startsWith("*") && seg.endsWith("*")) {
        parts.push(<span key={key++} className="accent">{seg.slice(1, -1)}</span>);
      } else {
        parts.push(<React.Fragment key={key++}>{seg}</React.Fragment>);
      }
    }
    return parts;
  };

  return (
    <section className="hero" data-screen-label="Hero">
      <div className="hero-left">
        <span className="hero-tag">
          <span className="pill">open source</span>
          local · file-based · no sign-up
        </span>
        <h1>
          {renderHeadline()}
        </h1>
        <p className="hero-lede">
          DotAIOS is one folder on your computer. <code>~/aios/</code> — that holds your context, your memory, and the things you'd like your AI to do for you. Claude Code, Cursor, Gemini, Codex, and any agent that reads <code>AGENTS.md</code> all read from the same place. Write it once, every tool knows.
        </p>

        <div id="install" className="install">
          <div className="install-head">
            <span className="lbl">get started</span>
            <span>2 steps · ~60 seconds</span>
          </div>

          <div className="install-step">
            <span className="install-step-num">1</span>
            <div className="install-step-body">
              <b>Open an AI agent app.</b>
              <p>
                DotAIOS works with any agent that reads <code>AGENTS.md</code> —
                Claude Code, Codex, Cursor, Gemini, Antigravity. Don't have one
                yet? Claude Code is a free and friendly place to start.
              </p>
            </div>
          </div>

          <div className="install-step">
            <span className="install-step-num">2</span>
            <div className="install-step-body">
              <b>Paste this line into it.</b>
              <div className="install-line">
                <code>
                  <span className="prompt">›</span>
                  <span className="quote">{INSTALL_SNIPPET}</span>
                </code>
                <button
                  className={`copy-btn ${copied ? "copied" : ""}`}
                  onClick={() => copy(INSTALL_SNIPPET, setCopied)}
                  style={{ position: "static" }}>
                  {copied ? "✓" : "Copy"}
                </button>
              </div>
            </div>
          </div>

          <div className="install-or">already comfortable in a terminal?</div>

          <div className="install-alt">
            <code><span className="lead">$</span>{NPX_SNIPPET}</code>
            <button
              className={`copy-btn ${copiedNpx ? "copied" : ""}`}
              onClick={() => copy(NPX_SNIPPET, setCopiedNpx)}
              style={{ position: "static" }}>
              {copiedNpx ? "✓" : "Copy"}
            </button>
          </div>
        </div>

        <div className="hero-meta">
          <div className="hero-meta-item">
            <b>One folder</b>
            <span>plain Markdown, on your machine</span>
          </div>
          <div className="hero-meta-item">
            <b>Every agent</b>
            <span>anything that reads AGENTS.md</span>
          </div>
          <div className="hero-meta-item">
            <b>No account</b>
            <span>no server we run; sync is your own GitHub</span>
          </div>
        </div>
      </div>

      {showGraph ? <KnowledgeGraph /> : <div className="hero-right hero-right-empty"><div className="graph-frame"></div></div>}
    </section>);

}

function Metaphor() {
  return (
    <section className="metaphor" data-screen-label="Metaphor">
      <div className="metaphor-inner">
        <div className="row">
          <div className="lhs">
            <code>.gitconfig</code><br />
            Stop switching between chats.
          </div>
          <div className="arrow">→</div>
          <div className="rhs">
            <code>~/aios/</code><br />
            makes every AI know you.
          </div>
        </div>
        <cite>One folder. Every tool. No sign-up.</cite>
      </div>
    </section>);

}

function HowItWorks() {
  return (
    <section id="how" className="howit section" data-screen-label="How it works">
      <span className="section-eyebrow">How it works · no command line required</span>
      <h2 className="section-title">Fully understandable, it's just a Folder</h2>
      <p className="section-lede">DotAIOS is just a folder of Markdown. You don't have to run anything yourself. Your AI does the setup and writes the files. Then it lives in your home folder where you can open it any time.

      </p>

      <div className="steps">
        <div className="step">
          <span className="step-num">Step 01 — Tell an AI to set it up</span>
          <h3>Paste one line into the AI you already use.</h3>
          <p>Claude Code, Cursor, Gemini, Codex pick any of them. It creates the folder, asks you who you are and what you're working on, and saves your answers.</p>
          <div className="step-visual">
            <div className="tree-row"><span className="ico">›</span><span>creating <em>~/aios/</em>…</span></div>
            <div className="tree-row"><span className="ico plus">+</span><span><b>context/identity.md</b></span></div>
            <div className="tree-row"><span className="ico plus">+</span><span><b>context/work.md</b></span></div>
            <div className="tree-row"><span className="ico plus">+</span><span><b>context/priorities.md</b></span></div>
            <div className="tree-row"><span className="ico plus">+</span><span><b>memory/</b></span></div>
            <div className="tree-row"><span className="ico plus">+</span><span><b>vault/</b></span></div>
            <div className="tree-row"><span className="ico check">✓</span><span><em>ready · 3 minutes</em></span></div>
          </div>
        </div>

        <div className="step">
          <span className="step-num">Step 02 — Every AI reads the same folder</span>
          <h3>Your context shows up everywhere you already work.</h3>
          <p>One short rule per tool, written automatically.</p>
          <div className="step-visual beam">
            <div className="beam-row"><span className="tool"><span className="mk">C</span>Claude Code</span><span className="status">connected</span></div>
            <div className="beam-row"><span className="tool"><span className="mk">×</span>Cursor</span><span className="status">connected</span></div>
            <div className="beam-row"><span className="tool"><span className="mk">G</span>Gemini CLI</span><span className="status">connected</span></div>
            <div className="beam-row"><span className="tool"><span className="mk">o</span>Codex</span><span className="status">connected</span></div>
          </div>
        </div>

        <div className="step">
          <span className="step-num">Step 03 — Ask in plain English</span>
          <h3>Skills become things you can just say out loud.</h3>
          <p>"Plan my day." "Save this article." "Close out today." Each one runs the same way in every tool.</p>
          <div className="step-visual slash">
            <span><b>/plan-today</b> <em>build a focused plan</em></span>
            <span><b>/today</b> <em>open today's note</em></span>
            <span><b>/closeday</b> <em>end the day in 3 questions</em></span>
            <span><b>/ingest</b> <em>save an article into your vault</em></span>
            <span><b>/audit</b> <em>health check on your folder</em></span>
          </div>
        </div>
      </div>
    </section>);

}

function Footer() {
  return (
    <footer className="footer">
      <div className="footer-col">
        <p className="lede">A folder for the AI that already runs in your life.</p>
        <span className="muted-note">DotAIOS · MIT · 2026<br />your folder. your rules.</span>
      </div>
      <div className="footer-col">
        <b>Product</b>
        <a href="#how">How it works</a>
        <a href="#marketplace">Skills</a>
        <a href="https://github.com/filocosta46/dotaios#install-in-60-seconds" target="_blank" rel="noopener">Install</a>
      </div>
      <div className="footer-col">
        <b>Docs</b>
        <a href="https://github.com/filocosta46/dotaios/blob/main/docs/getting-started.md" target="_blank" rel="noopener">Getting started</a>
        <a href="https://github.com/filocosta46/dotaios/blob/main/docs/architecture.md" target="_blank" rel="noopener">Architecture</a>
        <a href="https://github.com/filocosta46/dotaios/blob/main/docs/security.md" target="_blank" rel="noopener">Security</a>
        <a href="https://github.com/filocosta46/dotaios/blob/main/docs/plugin-development.md" target="_blank" rel="noopener">Plugin dev</a>
      </div>
      <div className="footer-col">
        <b>Project</b>
        <a href="https://github.com/filocosta46/dotaios" target="_blank" rel="noopener">GitHub</a>
        <a href="https://github.com/filocosta46/dotaios/blob/main/CHANGELOG.md" target="_blank" rel="noopener">Changelog</a>
        <a href="https://github.com/filocosta46/dotaios/blob/main/CONTRIBUTING.md" target="_blank" rel="noopener">Contributing</a>
      </div>
    </footer>);

}

function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);

  useEffect(() => {applyTweaks(t);}, [t]);

  return (
    <React.Fragment>
      <Nav />
      <Hero headlineText={t.headlineText} showGraph={t.showGraph} />
      <Metaphor />
      <HowItWorks />
      <Marketplace />
      <Footer />
      <TweaksPanel title="Tweaks">
        <TweakSection label="Color" />
        <TweakColor label="Accent" value={t.accent}
        options={[
        { value: "cobalt", color: ACCENTS.cobalt.hex },
        { value: "magenta", color: ACCENTS.magenta.hex },
        { value: "forest", color: ACCENTS.forest.hex },
        { value: "orange", color: ACCENTS.orange.hex },
        { value: "graphite", color: ACCENTS.graphite.hex }]
        }
        onChange={(v) => setTweak("accent", v)} />
        <TweakSelect label="Background" value={t.bgTone}
        options={[
        { value: "white", label: "Pure white" },
        { value: "cool", label: "Cool wash" },
        { value: "paper", label: "Warm paper" },
        { value: "inkwell", label: "Inkwell" }]
        }
        onChange={(v) => setTweak("bgTone", v)} />

        <TweakSection label="Typography" />
        <TweakSlider label="Headline weight" value={t.headlineWeight}
        min={400} max={800} step={100}
        onChange={(v) => setTweak("headlineWeight", v)} />
        <TweakText label="Headline" value={t.headlineText}
        onChange={(v) => setTweak("headlineText", v)}
        help="|text| = strike-through, *text* = accent color" />

        <TweakSection label="Layout" />
        <TweakRadio label="Density" value={t.density}
        options={["compact", "regular", "comfy"]}
        onChange={(v) => setTweak("density", v)} />
        <TweakToggle label="Animate graph" value={t.showGraph}
        onChange={(v) => setTweak("showGraph", v)} />
      </TweaksPanel>
    </React.Fragment>);

}

ReactDOM.createRoot(document.getElementById("app")).render(<App />);