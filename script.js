
"use strict";

const $ = id => document.getElementById(id);
const canvas = $("scene");
const ctx = canvas.getContext("2d");
const wrap = $("canvasWrap");

const PI = Math.PI;
const EPS = 0.0001;
const AIR = 1;
const MAX_EVENTS = 30;

let W = 800;
let H = 500;
let objects = [];
let selected = null;
let tool = "select";
let dragging = null;
let nextId = 1;
let history = [];
let future = [];
let pending = null;

const glassTypes = ["convex", "concave", "block", "prism"];
const sourceTypes = ["source", "white"];

const spectrum = [
  [650, "#ff4a4a"],
  [610, "#ff9b39"],
  [580, "#ffe34b"],
  [530, "#45ed75"],
  [490, "#36d9ff"],
  [450, "#537eff"],
  [420, "#b078ff"]
];

const info = {
  source: ["Лазер", "Монохроматический источник", "✦"],
  white: ["Белый свет", "Спектральный источник", "☼"],
  mirror: ["Плоское зеркало", "Закон отражения", "╱"],
  convex: ["Собирающая линза", "Двояковыпуклая линза", "◯"],
  concave: ["Рассеивающая линза", "Двояковогнутая линза", ")("],
  block: ["Стеклянный блок", "Преломление света", "▣"],
  prism: ["Призма", "Дисперсия и преломление", "△"],
  ruler: ["Линейка", "Измерение расстояний", "⌁"],
  protractor: ["Транспортир", "Угловая шкала", "◴"]
};

const rad = a => a * PI / 180;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const V = (x, y) => ({ x, y });
const add = (a, b) => V(a.x + b.x, a.y + b.y);
const sub = (a, b) => V(a.x - b.x, a.y - b.y);
const mul = (a, k) => V(a.x * k, a.y * k);
const dot = (a, b) => a.x * b.x + a.y * b.y;
const cross = (a, b) => a.x * b.y - a.y * b.x;
const len = a => Math.hypot(a.x, a.y);
const norm = a => len(a) ? mul(a, 1 / len(a)) : V(1, 0);
const direction = a => V(Math.cos(rad(a)), Math.sin(rad(a)));

function rotate(p, a) {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return V(p.x * c - p.y * s, p.x * s + p.y * c);
}

function world(o, p) {
  return add(V(o.x, o.y), rotate(p, rad(o.angle)));
}

const isGlass = o => glassTypes.includes(o.type);
const isSource = o => sourceTypes.includes(o.type);

function make(type, x, y, extra = {}) {
  return {
    id: nextId++,
    type,
    x,
    y,
    angle: type === "mirror" ? 90 : 0,
    size: type === "prism" ? 150 : 130,
    index: 1.5,
    beams: 1,
    color: "#facc15",
    ...extra
  };
}

const snapshot = () => JSON.stringify({ objects, nextId });

function historyButtons() {
  $("undo").disabled = !history.length;
  $("redo").disabled = !future.length;
}

function commit(before) {
  if (before && before !== snapshot()) {
    history.push(before);
    if (history.length > 80) history.shift();
    future = [];
  }
  historyButtons();
}

function restore(json) {
  const data = JSON.parse(json);
  objects = data.objects;
  nextId = data.nextId;
  selected = null;
  dragging = null;
  properties();
  draw();
}

function undo() {
  if (!history.length) return;
  future.push(snapshot());
  restore(history.pop());
  historyButtons();
  notify("Действие отменено");
}

function redo() {
  if (!future.length) return;
  history.push(snapshot());
  restore(future.pop());
  historyButtons();
  notify("Действие повторено");
}

function polygon(o) {
  const s = o.size;
  let pts = [];

  if (o.type === "block") {
    pts = [
      V(-s / 2, -s * 0.33),
      V(s / 2, -s * 0.33),
      V(s / 2, s * 0.33),
      V(-s / 2, s * 0.33)
    ];
  } else if (o.type === "prism") {
    const h = s * Math.sqrt(3) / 2;
    pts = [
      V(0, -2 * h / 3),
      V(s / 2, h / 3),
      V(-s / 2, h / 3)
    ];
  } else if (o.type === "convex" || o.type === "concave") {
    const left = [];
    const right = [];
    const steps = 80;

    for (let i = 0; i <= steps; i++) {
      const y = -s / 2 + s * i / steps;
      const u = y / (s / 2);
      const curve = 1 - u * u;

      const t = o.type === "convex"
        ? 5 + 20 * curve
        : 25 - 19 * curve;

      left.push(V(-t, y));
      right.push(V(t, y));
    }

    pts = [...left, ...right.reverse()];
  }

  return pts.map(p => world(o, p));
}

function segmentPoints(o) {
  return [
    world(o, V(-o.size / 2, 0)),
    world(o, V(o.size / 2, 0))
  ];
}

function inside(p, poly) {
  let result = false;

  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];

    if ((a.y > p.y) !== (b.y > p.y)) {
      const x = (b.x - a.x) * (p.y - a.y) /
        (b.y - a.y) + a.x;

      if (p.x < x) result = !result;
    }
  }

  return result;
}

function intersection(origin, d, a, b) {
  const s = sub(b, a);
  const den = cross(d, s);

  if (Math.abs(den) < 1e-10) return null;

  const diff = sub(a, origin);
  const t = cross(diff, s) / den;
  const u = cross(diff, d) / den;

  if (t <= EPS || u < -EPS || u > 1 + EPS) return null;

  return {
    t,
    p: add(origin, mul(d, t)),
    tangent: norm(s)
  };
}

function nearest(origin, d) {
  let best = null;

  for (const o of objects) {
    if (isSource(o) || o.type === "ruler" || o.type === "protractor") {
      continue;
    }

    const pts = o.type === "mirror"
      ? segmentPoints(o)
      : polygon(o);

    const count = o.type === "mirror" ? 1 : pts.length;

    for (let i = 0; i < count; i++) {
      const hit = intersection(
        origin, d, pts[i], pts[(i + 1) % pts.length]
      );

      if (hit && (!best || hit.t < best.t)) {
        best = {
          ...hit,
          o,
          poly: o.type === "mirror" ? null : pts
        };
      }
    }
  }

  return best;
}

function boundary(p, d) {
  const ts = [];

  if (d.x > EPS) ts.push((W - p.x) / d.x);
  if (d.x < -EPS) ts.push(-p.x / d.x);
  if (d.y > EPS) ts.push((H - p.y) / d.y);
  if (d.y < -EPS) ts.push(-p.y / d.y);

  return Math.min(...ts.filter(t => t > EPS), Infinity);
}

function reflect(d, n) {
  return norm(sub(d, mul(n, 2 * dot(d, n))));
}

function refract(d, n, n1, n2) {
  const eta = n1 / n2;
  const ci = clamp(-dot(d, n), 0, 1);
  const k = 1 - eta * eta * (1 - ci * ci);

  if (k < 0) return null;

  return norm(add(
    mul(d, eta),
    mul(n, eta * ci - Math.sqrt(k))
  ));
}

function indexAt(o, w) {
  const dispersion = 0.012 * (o.index - 1) / 0.5;
  return o.index + dispersion * ((550 / w) ** 2 - 1);
}

function trace(origin, initial, wavelength) {
  const points = [origin];
  const hits = [];

  let p = origin;
  let d = norm(initial);

  for (let step = 0; step < MAX_EVENTS; step++) {
    const edge = boundary(p, d);
    const hit = nearest(p, d);

    if (!hit || hit.t >= edge) {
      if (Number.isFinite(edge)) {
        points.push(add(p, mul(d, edge)));
      }
      break;
    }

    points.push(hit.p);

    let n = V(-hit.tangent.y, hit.tangent.x);
    if (dot(d, n) > 0) n = mul(n, -1);

    const incoming = d;
    let outgoing;

    if (hit.o.type === "mirror") {
      outgoing = reflect(d, n);
    } else {
      const before = sub(hit.p, mul(d, 0.05));
      const wasInside = inside(before, hit.poly);
      const ng = indexAt(hit.o, wavelength);

      outgoing = refract(
        d,
        n,
        wasInside ? ng : AIR,
        wasInside ? AIR : ng
      ) || reflect(d, n);
    }

    hits.push({
      p: hit.p,
      n,
      incoming,
      outgoing
    });

    d = outgoing;
    p = add(hit.p, mul(d, 0.05));

    if (step === MAX_EVENTS - 1) points.push(p);
  }

  return { points, hits };
}

function rays(o) {
  const result = [];
  const d = direction(o.angle);
  const side = V(-d.y, d.x);

  for (let i = 0; i < o.beams; i++) {
    const offset = (i - (o.beams - 1) / 2) * 9;
    const origin = add(V(o.x, o.y), mul(side, offset));

    if (o.type === "white") {
      for (const [w, color] of spectrum) {
        result.push({ origin, d, w, color });
      }
    } else {
      result.push({
        origin,
        d,
        w: 550,
        color: o.color
      });
    }
  }

  return result;
}

const css = name => getComputedStyle(document.body)
  .getPropertyValue(name).trim();

function line(a, b, color, width = 2, dash = []) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
  ctx.restore();
}

function grid() {
  if (!$("grid").checked) return;

  const color = css("--grid");

  for (let x = 0; x < W; x += 30) {
    line(V(x, 0), V(x, H), color, 1);
  }

  for (let y = 0; y < H; y += 30) {
    line(V(0, y), V(W, y), color, 1);
  }
}

function drawGlass(o) {
  const pts = polygon(o);
  if (!pts.length) return;

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);

  for (let i = 1; i < pts.length; i++) {
    ctx.lineTo(pts[i].x, pts[i].y);
  }

  ctx.closePath();
  ctx.fillStyle = css("--glass");
  ctx.strokeStyle = "#65cfff";
  ctx.lineWidth = 1.8;
  ctx.shadowColor = "#49bdff";
  ctx.shadowBlur = 9;
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawMirror(o) {
  const [a, b] = segmentPoints(o);
  line(a, b, "#526982", 11);
  line(a, b, "#d4f4ff", 4);
}

function drawSource(o) {
  ctx.save();
  ctx.translate(o.x, o.y);
  ctx.rotate(rad(o.angle));

  ctx.shadowColor = "#38bdf8";
  ctx.shadowBlur = 12;
  ctx.fillStyle = "#21658b";
  ctx.strokeStyle = "#b8e9ff";
  ctx.lineWidth = 1.5;

  ctx.beginPath();
  ctx.roundRect(-20, -12, 40, 24, 6);
  ctx.fill();
  ctx.stroke();

  ctx.shadowBlur = 0;
  ctx.fillStyle = "#082f49";
  ctx.fillRect(12, -6, 9, 12);

  ctx.fillStyle = o.type === "white" ? "#fff" : o.color;
  ctx.beginPath();
  ctx.arc(22, 0, 4, 0, 2 * PI);
  ctx.fill();

  ctx.restore();
}

function drawRuler(o) {
  const [a, b] = segmentPoints(o);
  line(a, b, "#f4b65a", 3);

  for (let i = 0; i <= 10; i++) {
    const x = -o.size / 2 + o.size * i / 10;

    line(
      world(o, V(x, 0)),
      world(o, V(x, i % 5 === 0 ? 13 : 7)),
      "#f4b65a",
      1
    );
  }

  ctx.save();
  ctx.font = "11px sans-serif";
  ctx.fillStyle = "#f4b65a";
  ctx.textAlign = "center";
  ctx.fillText(`${o.size} px`, o.x, o.y - 20);
  ctx.restore();
}

function drawProtractor(o) {
  const r = o.size / 2;

  ctx.save();
  ctx.translate(o.x, o.y);
  ctx.rotate(rad(o.angle));
  ctx.strokeStyle = "#b596ff";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(0, 0, r, PI, 2 * PI);
  ctx.stroke();
  ctx.restore();

  line(
    world(o, V(-r, 0)),
    world(o, V(r, 0)),
    "#b596ff",
    2
  );

  for (let a = 0; a <= 180; a += 10) {
    const t = rad(180 + a);
    const inner = r - (a % 30 === 0 ? 13 : 7);

    line(
      world(o, V(Math.cos(t) * inner, Math.sin(t) * inner)),
      world(o, V(Math.cos(t) * r, Math.sin(t) * r)),
      "#b596ff",
      1
    );
  }
}

function selection(o) {
  ctx.save();
  ctx.strokeStyle = "#65d5ff";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 5]);
  ctx.beginPath();
  ctx.arc(o.x, o.y, isSource(o) ? 31 : 12, 0, 2 * PI);
  ctx.stroke();
  ctx.restore();
}

function draw() {
  ctx.clearRect(0, 0, W, H);
  grid();

  for (const o of objects) {
    if (isGlass(o)) drawGlass(o);
  }

  let rayCount = 0;
  let eventCount = 0;
  let normalCount = 0;

  for (const o of objects) {
    if (!isSource(o)) continue;

    for (const ray of rays(o)) {
      const result = trace(ray.origin, ray.d, ray.w);

      rayCount++;
      eventCount += result.hits.length;

      ctx.save();
      ctx.strokeStyle = ray.color;
      ctx.lineWidth = 2.2;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.shadowColor = ray.color;
      ctx.shadowBlur = 12;
      ctx.beginPath();

      result.points.forEach((p, i) => {
        if (i) ctx.lineTo(p.x, p.y);
        else ctx.moveTo(p.x, p.y);
      });

      ctx.stroke();
      ctx.restore();

      if ($("normals").checked) {
        for (const hit of result.hits) {
          if (normalCount++ >= 80) break;

          line(
            add(hit.p, mul(hit.n, -26)),
            add(hit.p, mul(hit.n, 26)),
            "#b596ff",
            1,
            [4, 4]
          );
        }
      }
    }
  }

  for (const o of objects) {
    if (o.type === "mirror") drawMirror(o);
    else if (isSource(o)) drawSource(o);
    else if (o.type === "ruler") drawRuler(o);
    else if (o.type === "protractor") drawProtractor(o);
  }

  if (selected && objects.includes(selected)) {
    selection(selected);
  }

  $("objects").textContent = `${objects.length} объектов`;
  $("rays").textContent = `${rayCount} лучей`;
  $("events").textContent = `${eventCount} взаимодействий`;
}

function distanceSegment(p, a, b) {
  const v = sub(b, a);
  const t = clamp(
    dot(sub(p, a), v) / (dot(v, v) || 1),
    0,
    1
  );

  return len(sub(p, add(a, mul(v, t))));
}

function hitTest(p) {
  for (let i = objects.length - 1; i >= 0; i--) {
    const o = objects[i];

    if (isSource(o)) {
      if (len(sub(p, o)) < 26) return o;
    } else if (o.type === "mirror" || o.type === "ruler") {
      const [a, b] = segmentPoints(o);
      if (distanceSegment(p, a, b) < 14) return o;
    } else if (o.type === "protractor") {
      if (len(sub(p, o)) < o.size / 2 + 10) return o;
    } else if (inside(p, polygon(o))) {
      return o;
    }
  }

  return null;
}

function pointer(e) {
  const r = canvas.getBoundingClientRect();
  return V(e.clientX - r.left, e.clientY - r.top);
}

function selectTool(value) {
  tool = value;

  document.querySelectorAll(".tool").forEach(b => {
    b.classList.toggle("active", b.dataset.tool === value);
  });

  $("tip").textContent = value === "select"
    ? "Перетащите объект или выберите инструмент"
    : `Нажмите на сцену, чтобы добавить: ${info[value][0]}`;
}

function properties() {
  const o = selected && objects.includes(selected)
    ? selected
    : null;

  $("empty").hidden = !!o;
  $("properties").hidden = !o;

  if (!o) return;

  $("objectName").textContent = info[o.type][0];
  $("objectDesc").textContent = info[o.type][1];
  $("objectIcon").textContent = info[o.type][2];

  $("angleField").hidden = false;
  $("sizeField").hidden = isSource(o);
  $("indexField").hidden = !isGlass(o);
  $("beamsField").hidden = !isSource(o);
  $("colorField").hidden = o.type !== "source";
  $("measureField").hidden = o.type !== "ruler";

  for (const [id, key] of [
    ["angle", "angle"],
    ["size", "size"],
    ["index", "index"],
    ["beams", "beams"],
    ["color", "color"]
  ]) {
    $(id).value = o[key];
  }

  $("angleValue").textContent = o.angle + "°";
  $("sizeValue").textContent = o.size + " px";
  $("indexValue").textContent = o.index.toFixed(2);
  $("beamsValue").textContent = o.beams;
  $("measureValue").textContent = o.size + " px";
}

function notify(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("show");

  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => {
    el.classList.remove("show");
  }, 2400);
}

function addAt(type, x, y) {
  const before = snapshot();

  selected = make(type, x, y);
  objects.push(selected);

  commit(before);
  properties();
  draw();
  notify(`${info[type][0]} добавлен`);
}

canvas.addEventListener("pointerdown", e => {
  const p = pointer(e);

  if (tool !== "select") {
    addAt(tool, p.x, p.y);
    selectTool("select");
    return;
  }

  selected = hitTest(p);
  properties();

  if (selected) {
    pending = snapshot();

    dragging = {
      id: e.pointerId,
      dx: p.x - selected.x,
      dy: p.y - selected.y
    };

    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = "grabbing";
  }

  draw();
});

canvas.addEventListener("pointermove", e => {
  const p = pointer(e);

  if (dragging && selected && dragging.id === e.pointerId) {
    selected.x = clamp(p.x - dragging.dx, 0, W);
    selected.y = clamp(p.y - dragging.dy, 0, H);
    draw();
  } else {
    canvas.style.cursor = tool !== "select"
      ? "crosshair"
      : hitTest(p) ? "grab" : "default";
  }
});

function stopDrag(e) {
  if (!dragging || dragging.id !== e.pointerId) return;

  dragging = null;
  commit(pending);
  pending = null;

  if (canvas.hasPointerCapture(e.pointerId)) {
    canvas.releasePointerCapture(e.pointerId);
  }

  canvas.style.cursor = "default";
}

canvas.addEventListener("pointerup", stopDrag);
canvas.addEventListener("pointercancel", stopDrag);

document.querySelectorAll(".tool").forEach(b => {
  b.addEventListener("click", () => selectTool(b.dataset.tool));
});

for (const [id, key, fmt] of [
  ["angle", "angle", v => v + "°"],
  ["size", "size", v => v + " px"],
  ["index", "index", v => v.toFixed(2)],
  ["beams", "beams", v => String(v)]
]) {
  let before = null;

  $(id).addEventListener("pointerdown", () => {
    before = snapshot();
  });

  $(id).addEventListener("input", e => {
    if (!selected) return;
    if (before === null) before = snapshot();

    selected[key] = Number(e.target.value);
    $(id + "Value").textContent = fmt(selected[key]);

    if (key === "size") {
      $("measureValue").textContent = selected.size + " px";
    }

    draw();
  });

  $(id).addEventListener("change", () => {
    commit(before);
    before = null;
  });
}

let colorBefore = null;

$("color").addEventListener("input", e => {
  if (!selected) return;
  if (colorBefore === null) colorBefore = snapshot();

  selected.color = e.target.value;
  draw();
});

$("color").addEventListener("change", () => {
  commit(colorBefore);
  colorBefore = null;
});

function removeSelected() {
  if (!selected) return;

  const before = snapshot();
  objects = objects.filter(o => o !== selected);
  selected = null;

  commit(before);
  properties();
  draw();
  notify("Объект удалён");
}

$("delete").addEventListener("click", removeSelected);
$("undo").addEventListener("click", undo);
$("redo").addEventListener("click", redo);
$("grid").addEventListener("change", draw);
$("normals").addEventListener("change", draw);

$("theme").addEventListener("click", () => {
  const dark = document.body.dataset.theme === "dark";

  document.body.dataset.theme = dark ? "light" : "dark";

  $("theme").innerHTML = dark
    ? "☾ <span>Тема</span>"
    : "☀ <span>Тема</span>";

  draw();
});

function preset(name) {
  const before = snapshot();

  objects = [];
  selected = null;

  const x = W * 0.17;
  const y = H * 0.5;

  const place = (type, px, py, extra = {}) => {
    objects.push(make(type, px, py, extra));
  };

  if (name === "reflection") {
    place("source", x, y, { beams: 1 });
    place("mirror", W * 0.62, y, { angle: 60 });
  } else if (name === "refraction") {
    place("source", x, y - 50, {
      angle: 15,
      beams: 1
    });

    place("block", W * 0.57, y, {
      angle: 20,
      index: 1.5
    });
  } else if (name === "lens") {
    // При первом запуске и при выборе этого опыта
    // создаётся только ОДИН световой луч.
    place("source", x, y, {
      beams: 1,
      angle: 0
    });

    place("convex", W * 0.54, y, {
      size: 170
    });
  } else if (name === "spectrum") {
    place("white", x, y - 35, {
      beams: 1,
      angle: 12
    });

    place("prism", W * 0.56, y, {
      size: 160,
      index: 1.6
    });
  }

  commit(before);
  properties();
  selectTool("select");
  draw();
  notify("Эксперимент загружен");
}

document.querySelectorAll("[data-preset]").forEach(b => {
  b.addEventListener("click", () => preset(b.dataset.preset));
});

$("clear").addEventListener("click", () => {
  if (!objects.length) return;

  const before = snapshot();

  objects = [];
  selected = null;

  commit(before);
  properties();
  draw();
  notify("Сцена очищена");
});

$("export").addEventListener("click", () => {
  const blob = new Blob(
    [JSON.stringify({
      version: 4,
      objects,
      nextId
    }, null, 2)],
    { type: "application/json" }
  );

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");

  a.href = url;
  a.download = "optical-lab-experiment.json";
  a.click();

  setTimeout(() => URL.revokeObjectURL(url), 1000);
  notify("Эксперимент сохранён");
});

$("import").addEventListener("click", () => $("file").click());

$("file").addEventListener("change", async e => {
  const file = e.target.files[0];
  if (!file) return;

  try {
    if (file.size > 1024 * 1024) {
      throw Error("Файл превышает 1 МБ");
    }

    const data = JSON.parse(await file.text());

    if (!Array.isArray(data.objects) || data.objects.length > 100) {
      throw Error("Неверный список объектов");
    }

    const ids = new Set();

    for (const o of data.objects) {
      if (!o || !info[o.type] ||
          !Number.isInteger(o.id) ||
          o.id < 1 || ids.has(o.id)) {
        throw Error("Неверный идентификатор");
      }

      ids.add(o.id);

      for (const k of [
        "x", "y", "angle", "size", "index", "beams"
      ]) {
        if (!Number.isFinite(o[k])) {
          throw Error("Неверные числовые данные");
        }
      }

      if (
        Math.abs(o.x) > 10000 ||
        Math.abs(o.y) > 10000 ||
        o.angle < 0 || o.angle > 359 ||
        o.size < 40 || o.size > 260 ||
        o.index < 1.05 || o.index > 2 ||
        !Number.isInteger(o.beams) ||
        o.beams < 1 || o.beams > 15 ||
        o.beams % 2 !== 1 ||
        typeof o.color !== "string" ||
        !/^#[0-9a-f]{6}$/i.test(o.color)
      ) {
        throw Error("Параметры вне допустимых значений");
      }
    }

    const before = snapshot();

    objects = data.objects.map(o => ({
      id: o.id,
      type: o.type,
      x: o.x,
      y: o.y,
      angle: o.angle,
      size: o.size,
      index: o.index,
      beams: o.beams,
      color: o.color
    }));

    nextId = Math.max(0, ...ids) + 1;
    selected = null;

    commit(before);
    properties();
    draw();
    notify("Эксперимент загружен");
  } catch (error) {
    notify("Ошибка: " + error.message);
  }

  e.target.value = "";
});

document.addEventListener("keydown", e => {
  const tag = document.activeElement.tagName;

  if (["INPUT", "TEXTAREA", "SELECT"].includes(tag)) return;

  if ((e.ctrlKey || e.metaKey) &&
      e.key.toLowerCase() === "z") {
    e.preventDefault();
    e.shiftKey ? redo() : undo();
  } else if ((e.ctrlKey || e.metaKey) &&
             e.key.toLowerCase() === "y") {
    e.preventDefault();
    redo();
  } else if (e.key === "Delete" || e.key === "Backspace") {
    removeSelected();
  } else if (e.key === "Escape") {
    selected = null;
    selectTool("select");
    properties();
    draw();
  } else if (
    e.key.toLowerCase() === "v" &&
    !e.ctrlKey && !e.metaKey
  ) {
    selectTool("select");
  }
});

function resize() {
  const r = wrap.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;

  W = Math.max(1, r.width);
  H = Math.max(1, r.height);

  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw();
}

new ResizeObserver(resize).observe(wrap);

resize();

// Начальный эксперимент: один источник,
// одна собирающая линза и ОДИН луч.
preset("lens");

history = [];
future = [];
historyButtons();
