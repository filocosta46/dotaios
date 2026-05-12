// =============================================================
// Plugin Marketplace — skills directory + detail sheet
// Reads from window.AIOS_PLUGINS (plugins.js)
// =============================================================

const { useEffect, useMemo, useRef, useState } = React;

function Marketplace() {
  const plugins = window.AIOS_PLUGINS || [];
  const categories = useMemo(() => {
    const set = new Set(plugins.map((p) => p.category));
    return ["All", ...set];
  }, [plugins]);

  const [filter, setFilter] = useState("All");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(null);
  const searchRef = useRef(null);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.key === "/" || e.metaKey && e.key === "k") && document.activeElement !== searchRef.current) {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if (e.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const filtered = plugins.filter((p) => {
    const matchesCat = filter === "All" || p.category === filter;
    const q = query.trim().toLowerCase();
    const matchesQ =
    !q ||
    p.name.toLowerCase().includes(q) ||
    p.tagline.toLowerCase().includes(q) ||
    p.slash.toLowerCase().includes(q) ||
    p.category.toLowerCase().includes(q);
    return matchesCat && matchesQ;
  });

  return (
    <section id="marketplace" className="section" data-screen-label="Skills">
      <div className="market-head">
        <div>
          <span className="section-eyebrow">Skills · {plugins.length} bundled</span>
          <h2 className="section-title">Things you can ask your AI to do, the same way every time.</h2>
          <p className="section-lede">A skill is a plain Markdown recipe in your folder. Every AI tool reads them the same way. Open any skill to see exactly what it does and what it won't.

          </p>
        </div>
      </div>

      <div className="market-filters">
        {categories.map((c) =>
        <button
          key={c}
          className={`chip ${filter === c ? "active" : ""}`}
          onClick={() => setFilter(c)}>
          
            {c}
          </button>
        )}
        <div className="market-search">
          <span style={{ color: "var(--muted-2)" }}>⌕</span>
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search skills" />
          
          <span className="key">⌘K</span>
        </div>
      </div>

      <div className="market-grid">
        {filtered.map((p) =>
        <PluginCard key={p.id} plugin={p} onOpen={() => setSelected(p)} />
        )}
        {filtered.length === 0 &&
        <div style={{
          gridColumn: "1 / -1",
          padding: "60px 20px",
          textAlign: "center",
          fontFamily: "var(--font-body)",
          color: "var(--muted)",
          border: "1px dashed var(--hairline-2)",
          borderRadius: 14
        }}>
            no skills match — try a different filter
          </div>
        }
      </div>

      <PluginSheet plugin={selected} onClose={() => setSelected(null)} />
    </section>);

}

function PluginCard({ plugin, onOpen }) {
  return (
    <button className="plugin-card" onClick={onOpen}>
      <div className="plugin-head">
        <div className="plugin-icon">{plugin.glyph}</div>
        <span className={`price ${plugin.price === "Included" ? "included" : ""}`}>{plugin.price}</span>
      </div>
      <div>
        <h4>{plugin.name}</h4>
        <p className="slash-cmd">{plugin.slash}</p>
        <p className="desc">{plugin.tagline}</p>
      </div>
      <div className="meta">
        <span className="tag">{plugin.category}</span>
        <span className="by">by {plugin.author}</span>
      </div>
    </button>);

}

function PluginSheet({ plugin, onClose }) {
  return (
    <React.Fragment>
      <div className={`sheet-backdrop ${plugin ? "open" : ""}`} onClick={onClose}></div>
      <aside className={`sheet ${plugin ? "open" : ""}`}>
        <div className="sheet-inner">
          <div className="sheet-close">
            <span>skill · {plugin?.id || "—"}</span>
            <button onClick={onClose} aria-label="Close">×</button>
          </div>
          {plugin &&
          <React.Fragment>
              <div className="sheet-hero">
                <div className="plugin-icon">{plugin.glyph}</div>
                <div>
                  <h2>{plugin.name}</h2>
                  <div className="slash-cmd">{plugin.slash}</div>
                  <div className="meta-line">
                    by {plugin.author} · v{plugin.version} · {plugin.category}
                  </div>
                </div>
              </div>

              <div className="sheet-section">
                <h5>What it does</h5>
                <p>{plugin.longDescription || plugin.tagline}</p>
              </div>

              {plugin.does &&
            <div className="sheet-section">
                  <h5>What this does</h5>
                  <ul>
                    {plugin.does.map((f, i) =>
                <li key={i}>{f}</li>
                )}
                  </ul>
                </div>
            }

              {plugin.doesnt &&
            <div className="sheet-section">
                  <h5>What this doesn't do</h5>
                  <ul className="x">
                    {plugin.doesnt.map((f, i) =>
                <li key={i}>{f}</li>
                )}
                  </ul>
                </div>
            }

              {plugin.tryit &&
            <div className="sheet-section">
                  <h5>Try saying</h5>
                  <div className="sheet-tryit">
                    {plugin.tryit.map((line, i) =>
                <div key={i}>
                        <span className="lead">›</span>
                        <span className="q">{line}</span>
                      </div>
                )}
                  </div>
                </div>
            }

              <div className="sheet-cta">
                <a
                href={`https://github.com/filocosta46/dotaios/blob/main/skills/${plugin.id}/SKILL.md`}
                target="_blank"
                rel="noopener"
                className="btn btn-primary btn-grow">
                
                  Read SKILL.md on GitHub →
                </a>
                <button className="btn" onClick={onClose}>Close</button>
              </div>
            </React.Fragment>
          }
        </div>
      </aside>
    </React.Fragment>);

}

Object.assign(window, { Marketplace });