// Planta de verdade da casa virtual, num canvas pequeno (só existe na demonstração).
//
// Serve para comparar a verdade com a estimativa: mostra as paredes do mundo simulado
// (sim.world), o roteador da casa e a pessoa virtual andando (evento 'sim' da ponte).
//
//   const plan = createMiniPlan(container, { world, floorName });
//   plan.setPerson(simEvent)     posição nova da pessoa ({x, y, floor, heading}) ou null
//   plan.setWorld(world)         trocou de casa virtual
//   plan.redraw()                tema ou tamanho mudou (o tamanho é observado sozinho)
//   plan.destroy()
//
// O canvas ocupa o container inteiro. Com menos de ~200 px de largura os nomes dos cômodos não
// cabem em 12 px e ficam de fora (o desenho continua legível).

import { cssVar } from '../dom.js';

const TRAIL_MAX = 60;
const FLOOR_HEIGHT = 2.8;

/** Caixa que envolve todos os andares do mundo (as plantas ficam alinhadas entre os andares). */
function worldBox(world) {
  const b = world && world.bounds;
  if (b && Number.isFinite(b.minX) && Number.isFinite(b.maxX)) return { minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY };
  return { minX: 0, minY: 0, maxX: 10, maxY: 8 };
}

/** Em que andar um roteador do mundo está (pela altura). */
function apFloor(ap) {
  return Math.max(0, Math.floor((Number.isFinite(ap.z) ? ap.z : 0) / FLOOR_HEIGHT));
}

/**
 * @param {HTMLElement} container
 * @param {{world?:object|null, floorName?:(n:number) => string}} [options]
 */
export function createMiniPlan(container, { world = null, floorName = (n) => String(n) } = {}) {
  const doc = container.ownerDocument;
  const win = doc.defaultView;
  const canvas = doc.createElement('canvas');
  canvas.className = 'mini-plan__canvas';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'Planta de verdade da casa virtual, com a pessoa virtual');
  container.appendChild(canvas);

  let person = null;
  let floor = 0;
  let trail = []; // {x, y, floor}
  let width = 0;
  let height = 0;
  let raf = 0;
  let destroyed = false;

  function measure() {
    const r = container.getBoundingClientRect();
    const w = Math.max(0, Math.round(r.width));
    const hgt = Math.max(0, Math.round(r.height));
    const dpr = Math.min(3, win.devicePixelRatio || 1);
    if (w !== width || hgt !== height || canvas.width !== Math.round(w * dpr)) {
      width = w;
      height = hgt;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(hgt * dpr));
      canvas.style.width = `${w}px`;
      canvas.style.height = `${hgt}px`;
    }
    return dpr;
  }

  function draw() {
    raf = 0;
    if (destroyed) return;
    const dpr = measure();
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, width, height);
    if (!world || width < 24 || height < 24) return;

    const colors = {
      fill: cssVar('--surface') || '#121a2b',
      wall: cssVar('--text') || '#e8eef9',
      soft: cssVar('--muted') || '#93a0b8',
      line: cssVar('--line-strong') || '#3a4966',
      accent: cssVar('--accent') || '#38bdf8',
      person: cssVar('--warning') || '#fbbf24',
    };

    const box = worldBox(world);
    const pad = 8;
    const spanX = Math.max(0.5, box.maxX - box.minX);
    const spanY = Math.max(0.5, box.maxY - box.minY);
    const k = Math.min((width - pad * 2) / spanX, (height - pad * 2) / spanY);
    const ox = (width - spanX * k) / 2;
    const oy = (height - spanY * k) / 2;
    // y do mundo cresce para cima; o do canvas, para baixo
    const X = (x) => ox + (x - box.minX) * k;
    const Y = (y) => height - oy - (y - box.minY) * k;

    const poly = (points) => {
      g.beginPath();
      points.forEach((p, i) => (i ? g.lineTo(X(p[0]), Y(p[1])) : g.moveTo(X(p[0]), Y(p[1]))));
      g.closePath();
    };

    // piso
    const outline = typeof world.outline === 'function' ? world.outline(floor) : null;
    if (outline && outline.length >= 3) {
      poly(outline);
      g.fillStyle = colors.fill;
      g.fill();
    }

    // nomes dos cômodos (só quando cabem em 12 px)
    const rooms = typeof world.roomsOn === 'function' ? world.roomsOn(floor) : [];
    if (width >= 200) {
      g.font = '500 12px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillStyle = colors.soft;
      for (const room of rooms) {
        const name = String(room.name || '');
        if (!name || !room.centroid) continue;
        // só escreve o nome que cabe dentro do cômodo
        let minX = Infinity;
        let maxX = -Infinity;
        for (const p of room.polygon || []) {
          if (p[0] < minX) minX = p[0];
          if (p[0] > maxX) maxX = p[0];
        }
        if (g.measureText(name).width <= (maxX - minX) * k - 6) g.fillText(name, X(room.centroid.x), Y(room.centroid.y));
      }
    }

    // paredes: as portas (dá para atravessar) ficam mais claras e finas
    const walls = typeof world.wallsOn === 'function' ? world.wallsOn(floor) : [];
    g.lineCap = 'round';
    for (const pass of [true, false]) {
      g.beginPath();
      for (const w of walls) {
        if (!!w.passable !== pass) continue;
        g.moveTo(X(w.x1), Y(w.y1));
        g.lineTo(X(w.x2), Y(w.y2));
      }
      g.strokeStyle = pass ? colors.line : colors.wall;
      g.globalAlpha = pass ? 0.9 : 0.75;
      g.lineWidth = pass ? 1 : 1.5;
      g.stroke();
    }
    g.globalAlpha = 1;
    if (outline && outline.length >= 3) {
      poly(outline);
      g.strokeStyle = colors.wall;
      g.globalAlpha = 0.9;
      g.lineWidth = 1.75;
      g.stroke();
      g.globalAlpha = 1;
    }

    // roteadores da casa neste andar (um por aparelho)
    const seen = new Set();
    for (const ap of world.aps || []) {
      if (!ap.own || apFloor(ap) !== floor || seen.has(ap.device)) continue;
      seen.add(ap.device);
      const x = X(ap.x);
      const y = Y(ap.y);
      g.beginPath();
      g.arc(x, y, 6.5, 0, Math.PI * 2);
      g.strokeStyle = colors.accent;
      g.globalAlpha = 0.45;
      g.lineWidth = 1.25;
      g.stroke();
      g.globalAlpha = 1;
      g.beginPath();
      g.arc(x, y, 3, 0, Math.PI * 2);
      g.fillStyle = colors.accent;
      g.fill();
    }

    // rastro e pessoa
    const here = trail.filter((p) => p.floor === floor);
    if (here.length > 1) {
      g.lineWidth = 1.5;
      g.lineJoin = 'round';
      g.strokeStyle = colors.person;
      for (let i = 1; i < here.length; i++) {
        g.globalAlpha = 0.08 + 0.45 * (i / here.length);
        g.beginPath();
        g.moveTo(X(here[i - 1].x), Y(here[i - 1].y));
        g.lineTo(X(here[i].x), Y(here[i].y));
        g.stroke();
      }
      g.globalAlpha = 1;
    }
    if (person && person.floor === floor) {
      const x = X(person.x);
      const y = Y(person.y);
      if (Number.isFinite(person.heading)) {
        // para onde a pessoa está virada (o y do canvas é invertido)
        const a = -person.heading;
        g.beginPath();
        g.moveTo(x + Math.cos(a) * 10, y + Math.sin(a) * 10);
        g.lineTo(x + Math.cos(a + 2.5) * 5, y + Math.sin(a + 2.5) * 5);
        g.lineTo(x + Math.cos(a - 2.5) * 5, y + Math.sin(a - 2.5) * 5);
        g.closePath();
        g.fillStyle = colors.person;
        g.globalAlpha = 0.55;
        g.fill();
        g.globalAlpha = 1;
      }
      g.beginPath();
      g.arc(x, y, 4.5, 0, Math.PI * 2);
      g.fillStyle = colors.person;
      g.fill();
      g.lineWidth = 1.5;
      g.strokeStyle = colors.fill;
      g.stroke();
    }

    // andar (quando a casa tem mais de um)
    if ((world.floors || 1) > 1 && width >= 110) {
      g.font = '600 12px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
      g.textAlign = 'left';
      g.textBaseline = 'top';
      g.fillStyle = colors.soft;
      g.fillText(floorName(floor), 6, 5);
    }
  }

  function schedule() {
    if (!raf && !destroyed) raf = win.requestAnimationFrame(draw);
  }

  let observer = null;
  if (typeof win.ResizeObserver === 'function') {
    observer = new win.ResizeObserver(schedule);
    observer.observe(container);
  }
  schedule();

  return {
    el: canvas,
    setWorld(next) {
      world = next || null;
      trail = [];
      schedule();
    },
    setPerson(ev) {
      if (!ev || !Number.isFinite(ev.x) || !Number.isFinite(ev.y)) {
        person = null;
        schedule();
        return;
      }
      person = { x: ev.x, y: ev.y, floor: Number.isFinite(ev.floor) ? ev.floor : 0, heading: ev.heading };
      floor = person.floor;
      const last = trail[trail.length - 1];
      if (!last || last.floor !== person.floor || Math.hypot(last.x - person.x, last.y - person.y) > 0.25) {
        trail.push({ x: person.x, y: person.y, floor: person.floor });
        if (trail.length > TRAIL_MAX) trail.shift();
      }
      schedule();
    },
    redraw: schedule,
    destroy() {
      destroyed = true;
      if (raf) win.cancelAnimationFrame(raf);
      if (observer) observer.disconnect();
      canvas.remove();
    },
  };
}
