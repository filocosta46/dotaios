// =============================================================
// Knowledge Graph — growing canvas animation (light palette)
// Mirrors the real ~/aios/ folder shape from the repo README:
// identity / work / priorities / north-star, then memory,
// vault, and skills.
// =============================================================

const { useEffect, useRef, useState } = React;

// Light-palette categories — cobalt-led, no warm tones
const CATEGORIES = {
  self:     { color: "oklch(0.18 0.020 250)",  label: "you" },
  context:  { color: "oklch(0.52 0.20 258)",   label: "context" },   // cobalt
  memory:   { color: "oklch(0.55 0.14 200)",   label: "memory" },    // teal
  vault:    { color: "oklch(0.58 0.13 290)",   label: "vault" },     // soft violet
  skill:    { color: "oklch(0.60 0.16 115)",   label: "skill" },     // lime-deep
};

// Growth sequence based on ~/aios/ as documented in the README.
// t = seconds after start. id, parent, cat, label.
const SCRIPT = [
  { t: 0.0,  id: "self",       parent: null,        cat: "self",    label: "~/aios/" },

  // context cluster
  { t: 1.0,  id: "identity",   parent: "self",      cat: "context", label: "identity" },
  { t: 1.8,  id: "work",       parent: "self",      cat: "context", label: "work" },
  { t: 2.6,  id: "priorities", parent: "self",      cat: "context", label: "priorities" },
  { t: 3.4,  id: "northstar",  parent: "self",      cat: "context", label: "north star" },
  { t: 4.2,  id: "prefs",      parent: "priorities",cat: "context", label: "preferences" },

  // memory
  { t: 5.4,  id: "memory",     parent: "self",      cat: "memory",  label: "memory" },
  { t: 6.2,  id: "daily",      parent: "memory",    cat: "memory",  label: "daily notes" },
  { t: 7.0,  id: "events",     parent: "memory",    cat: "memory",  label: "events" },
  { t: 7.8,  id: "signals",    parent: "memory",    cat: "memory",  label: "signals" },

  // vault
  { t: 9.0,  id: "vault",      parent: "self",      cat: "vault",   label: "vault" },
  { t: 9.8,  id: "raw",        parent: "vault",     cat: "vault",   label: "raw clippings" },
  { t: 10.6, id: "wiki",       parent: "vault",     cat: "vault",   label: "wiki" },
  { t: 11.4, id: "org",        parent: "vault",     cat: "vault",   label: "people · companies" },
  { t: 12.4, id: "summaries",  parent: "raw",       cat: "vault",   label: "summaries" },

  // skills
  { t: 13.8, id: "skills",     parent: "self",      cat: "skill",   label: "skills" },
  { t: 14.5, id: "today",      parent: "skills",    cat: "skill",   label: "/today" },
  { t: 15.2, id: "closeday",   parent: "skills",    cat: "skill",   label: "/closeday" },
  { t: 15.9, id: "brief",      parent: "skills",    cat: "skill",   label: "/daily-brief" },
  { t: 16.6, id: "ingest",     parent: "skills",    cat: "skill",   label: "/ingest" },
  { t: 17.3, id: "audit",      parent: "skills",    cat: "skill",   label: "/audit" },

  // growth — incoming knowledge
  { t: 19.0, id: "article",    parent: "raw",       cat: "vault",   label: "article saved" },
  { t: 20.0, id: "paper",      parent: "raw",       cat: "vault",   label: "paper saved" },
  { t: 21.0, id: "today-note", parent: "daily",     cat: "memory",  label: "today" },
  { t: 22.0, id: "carryover",  parent: "daily",     cat: "memory",  label: "carry-over" },
  { t: 23.0, id: "wikitopic",  parent: "wiki",      cat: "vault",   label: "topic note" },
  { t: 24.0, id: "person",     parent: "org",       cat: "vault",   label: "colleague" },
  { t: 25.0, id: "company",    parent: "org",       cat: "vault",   label: "company" },
  { t: 26.0, id: "preferences2", parent: "prefs",   cat: "context", label: "plan style" },
  { t: 27.0, id: "weekly",     parent: "skills",    cat: "skill",   label: "/weekly-review" },
  { t: 28.0, id: "summary1",   parent: "summaries", cat: "vault",   label: "summary" },
];

// cross-links — connections forming as context relates
const CROSS_LINKS = [
  { t: 6.5,  from: "work",     to: "priorities" },
  { t: 11.0, from: "daily",    to: "work" },
  { t: 13.0, from: "wiki",     to: "priorities" },
  { t: 18.0, from: "today",    to: "priorities" },
  { t: 19.5, from: "brief",    to: "work" },
  { t: 22.5, from: "today-note", to: "today" },
  { t: 26.5, from: "weekly",   to: "memory" },
  { t: 28.4, from: "summary1", to: "wiki" },
];

const CYCLE = 34;

function KnowledgeGraph() {
  const canvasRef = useRef(null);
  const stateRef = useRef({ nodes: new Map(), edges: [], birth: new Map(), edgeBirth: [], start: 0 });
  const [readout, setReadout] = useState({ nodes: 1, edges: 0, last: "~/aios/" });

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    let raf = 0;
    let mounted = true;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);

    const angleFor = (id) => {
      let h = 0;
      for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
      return (h % 3600) / 3600 * Math.PI * 2;
    };
    const radiusFor = (cat, depth) => {
      const base = { self: 0, context: 110, memory: 140, vault: 150, skill: 130 }[cat] || 130;
      return base + depth * 22 + (Math.random() - 0.5) * 10;
    };

    const reset = (t) => {
      stateRef.current.nodes = new Map();
      stateRef.current.edges = [];
      stateRef.current.birth = new Map();
      stateRef.current.edgeBirth = [];
      stateRef.current.start = t;
    };

    const spawn = (entry, now) => {
      const { id, parent, cat, label } = entry;
      const rect = canvas.getBoundingClientRect();
      const cx = rect.width / 2;
      const cy = rect.height / 2;
      let x, y;
      if (!parent) {
        x = cx; y = cy;
      } else {
        const p = stateRef.current.nodes.get(parent);
        const baseA = angleFor(id) + (Math.random() - 0.5) * 0.35;
        const r = radiusFor(cat, p?.depth || 0);
        x = (p?.x ?? cx) + Math.cos(baseA) * r;
        y = (p?.y ?? cy) + Math.sin(baseA) * r * 0.88;
      }
      const rect2 = canvas.getBoundingClientRect();
      const pad = 36;
      x = Math.max(pad, Math.min(rect2.width - pad, x));
      y = Math.max(pad, Math.min(rect2.height - pad, y));

      stateRef.current.nodes.set(id, {
        id, x, y, vx: 0, vy: 0,
        cat, label,
        depth: parent ? (stateRef.current.nodes.get(parent)?.depth || 0) + 1 : 0,
      });
      stateRef.current.birth.set(id, now);
      if (parent) {
        stateRef.current.edges.push({ from: parent, to: id });
        stateRef.current.edgeBirth.push(now);
      }
      setReadout(() => ({
        nodes: stateRef.current.nodes.size,
        edges: stateRef.current.edges.length,
        last: label,
      }));
    };

    const addCross = (link, now) => {
      if (!stateRef.current.nodes.has(link.from) || !stateRef.current.nodes.has(link.to)) return;
      stateRef.current.edges.push({ from: link.from, to: link.to, cross: true });
      stateRef.current.edgeBirth.push(now);
      setReadout((r) => ({
        nodes: stateRef.current.nodes.size,
        edges: stateRef.current.edges.length,
        last: r.last,
      }));
    };

    const tick = (dt) => {
      const nodes = [...stateRef.current.nodes.values()];
      const rect = canvas.getBoundingClientRect();
      const cx = rect.width / 2, cy = rect.height / 2;
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        if (a.id === "self") continue;
        for (let j = 0; j < nodes.length; j++) {
          if (i === j) continue;
          const b = nodes[j];
          const dx = a.x - b.x, dy = a.y - b.y;
          const d2 = dx*dx + dy*dy + 0.001;
          if (d2 < 70*70) {
            const f = 460 / d2;
            a.vx += dx * f * dt;
            a.vy += dy * f * dt;
          }
        }
        a.vx += (cx - a.x) * 0.0008;
        a.vy += (cy - a.y) * 0.0008;
        a.vx *= 0.86;
        a.vy *= 0.86;
        a.x += a.vx;
        a.y += a.vy;
      }
      const self = stateRef.current.nodes.get("self");
      if (self) {
        self.x += (cx - self.x) * 0.08;
        self.y += (cy - self.y) * 0.08;
      }
    };

    const draw = (now) => {
      const rect = canvas.getBoundingClientRect();
      const W = rect.width, H = rect.height;
      ctx.clearRect(0, 0, W, H);

      // edges
      const edges = stateRef.current.edges;
      for (let i = 0; i < edges.length; i++) {
        const e = edges[i];
        const a = stateRef.current.nodes.get(e.from);
        const b = stateRef.current.nodes.get(e.to);
        if (!a || !b) continue;
        const t0 = stateRef.current.edgeBirth[i];
        const age = (now - t0) / 1000;
        const tracer = Math.min(1, age / 0.9);
        const fade = e.cross
          ? Math.min(0.32, age * 0.32)
          : Math.min(0.42, age * 0.5);

        const x2 = a.x + (b.x - a.x) * tracer;
        const y2 = a.y + (b.y - a.y) * tracer;

        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(x2, y2);
        ctx.strokeStyle = e.cross
          ? `oklch(0.52 0.20 258 / ${fade.toFixed(3)})`
          : `oklch(0.34 0.014 250 / ${fade.toFixed(3)})`;
        ctx.lineWidth = e.cross ? 1.0 : 1.1;
        ctx.stroke();
      }

      // nodes
      const nodes = [...stateRef.current.nodes.values()];
      for (const n of nodes) {
        const t0 = stateRef.current.birth.get(n.id) || now;
        const age = (now - t0) / 1000;
        const pop = Math.min(1, age / 0.5);
        const isSelf = n.id === "self";
        const r = isSelf ? 8 : 4;
        const cat = CATEGORIES[n.cat];

        // soft halo on newly-born nodes
        const haloT = Math.max(0, 1 - age / 1.6);
        if (haloT > 0 || isSelf) {
          const haloR = Math.max(1, r + (isSelf ? 14 : 9) * (isSelf ? 1 + Math.sin(now/500)*0.06 : haloT));
          ctx.beginPath();
          ctx.arc(n.x, n.y, haloR, 0, Math.PI*2);
          ctx.fillStyle = isSelf
            ? `oklch(0.52 0.20 258 / 0.12)`
            : (cat.color.replace(")", ` / ${(0.18 * haloT).toFixed(3)})`));
          ctx.fill();
        }

        // dot
        ctx.beginPath();
        ctx.arc(n.x, n.y, Math.max(0.1, r * pop), 0, Math.PI*2);
        ctx.fillStyle = isSelf ? "oklch(0.18 0.020 250)" : cat.color;
        ctx.fill();

        // ring on self
        if (isSelf) {
          ctx.beginPath();
          ctx.arc(n.x, n.y, r + 4, 0, Math.PI*2);
          ctx.strokeStyle = "oklch(0.52 0.20 258 / 0.65)";
          ctx.lineWidth = 1.3;
          ctx.stroke();
        }

        // label
        if (!isSelf && pop > 0.4) {
          const labelAlpha = Math.min(0.85, (age - 0.3) * 1.2);
          if (labelAlpha > 0) {
            ctx.font = "500 11.5px 'Poppins', system-ui, sans-serif";
            ctx.fillStyle = `oklch(0.32 0.016 250 / ${labelAlpha.toFixed(3)})`;
            ctx.textBaseline = "middle";
            ctx.textAlign = "left";
            ctx.fillText(n.label, n.x + 9, n.y);
          }
        } else if (isSelf) {
          ctx.font = "600 12px 'JetBrains Mono', ui-monospace, monospace";
          ctx.fillStyle = "oklch(0.18 0.020 250)";
          ctx.textBaseline = "middle";
          ctx.textAlign = "left";
          ctx.fillText("~/aios/", n.x + 14, n.y);
        }
      }
    };

    reset(performance.now());
    spawn(SCRIPT[0], performance.now());

    let scriptIdx = 1;
    let crossIdx = 0;

    const loop = (now) => {
      if (!mounted) return;
      const elapsed = (now - stateRef.current.start) / 1000;

      while (scriptIdx < SCRIPT.length && SCRIPT[scriptIdx].t <= elapsed) {
        spawn(SCRIPT[scriptIdx], now);
        scriptIdx++;
      }
      while (crossIdx < CROSS_LINKS.length && CROSS_LINKS[crossIdx].t <= elapsed) {
        addCross(CROSS_LINKS[crossIdx], now);
        crossIdx++;
      }

      tick(0.4);
      draw(now);

      if (elapsed > CYCLE) {
        ctx.fillStyle = "oklch(1 0 0 / 0.22)";
        ctx.fillRect(0, 0, canvas.getBoundingClientRect().width, canvas.getBoundingClientRect().height);
        if (elapsed > CYCLE + 1.5) {
          reset(now);
          spawn(SCRIPT[0], now);
          scriptIdx = 1;
          crossIdx = 0;
        }
      }

      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      mounted = false;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return (
    <div className="hero-right">
      <div className="graph-frame"></div>
      <canvas ref={canvasRef} className="graph-canvas"></canvas>
      <div className="graph-readout">
        <div>files <b>{readout.nodes.toString().padStart(2, "0")}</b></div>
        <div>links <b>{readout.edges.toString().padStart(2, "0")}</b></div>
        <div>last + <b>{readout.last}</b></div>
      </div>
      <div className="graph-legend">
        <span><i style={{background: "oklch(0.52 0.20 258)"}}></i>context — who you are</span>
        <span><i style={{background: "oklch(0.55 0.14 200)"}}></i>memory — what's recent</span>
        <span><i style={{background: "oklch(0.58 0.13 290)"}}></i>vault — what you've read</span>
        <span><i style={{background: "oklch(0.60 0.16 115)"}}></i>skills — what AI can do</span>
      </div>
    </div>
  );
}

Object.assign(window, { KnowledgeGraph });
