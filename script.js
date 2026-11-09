
"use strict";

const $ = id => document.getElementById(id);
const canvas = $("canvas");
const ctx = canvas.getContext("2d");
const container = $("canvasContainer");

const PI = Math.PI;
const EPS = 0.0001;
const AIR = 1;
const MAX_EVENTS = 25;

let W = 800, H = 500;
let objects = [], selected = null;
let tool = "select", dragging = null;
let nextId = 1;
let history = [], future = [];
let actionBefore = null;

const glassTypes = ["convex", "concave", "block", "prism"];
const sourceTypes = ["source", "white"];

const spectrum = [
  [650, "#ff4242"], [610, "#ff9a38"],
  [580, "#ffe44a"], [530, "#45ed75"],
  [490, "#35d8ff"], [450, "#497cff"],
  [420, "#a36aff"]
];

const names = {
  source: ["Лазер", "Направленный световой пучок"],
  white: ["Белый свет", "Семь спектральных компонентов"],
  mirror: ["Плоское зеркало", "Отражение света"],
  convex: ["Собирающая линза", "Двояковыпуклая линза"],
  concave: ["Рассеивающая линза", "Двояковогнутая линза"],
  block: ["Стеклянный блок", "Плоскопараллельная пластина"],
  prism: ["Призма", "Преломление и дисперсия"],
  ruler: ["Линейка", "Измерение расстояния в пикселях"],
  protractor: ["Транспортир", "Измерение угла"]
};

const rad = a => a * PI / 180;
const deg = a => a * 180 / PI;
const clamp = (v,a,b) => Math.max(a, Math.min(b,v));
const V = (x,y) => ({x,y});
const add = (a,b) => V(a.x+b.x,a.y+b.y);
const sub = (a,b) => V(a.x-b.x,a.y-b.y);
const mul = (a,k) => V(a.x*k,a.y*k);
const dot = (a,b) => a.x*b.x+a.y*b.y;
const cross = (a,b) => a.x*b.y-a.y*b.x;
const len = a => Math.hypot(a.x,a.y);
const norm = a => len(a) ? mul(a,1/len(a)) : V(1,0);
const direction = a => V(Math.cos(rad(a)),Math.sin(rad(a)));

function rotate(p,a) {
  const c=Math.cos(a),s=Math.sin(a);
  return V(p.x*c-p.y*s,p.x*s+p.y*c);
}

function world(o,p) {
  return add(V(o.x,o.y),rotate(p,rad(o.angle)));
}

function glass(o) { return glassTypes.includes(o.type); }
function source(o) { return sourceTypes.includes(o.type); }

function make(type,x,y,extra={}) {
  return {
    id:nextId++,type,x,y,
    angle:type==="mirror"?90:0,
    size:130,index:1.5,
    beams:1,color:"#facc15",
    ...extra
  };
}

function snapshot() {
  return JSON.stringify({objects,nextId});
}

function commit(before) {
  if (before && before!==snapshot()) {
    history.push(before);
    if(history.length>60) history.shift();
    future=[];
  }
  updateHistory();
}

function restore(json) {
  const data=JSON.parse(json);
  objects=data.objects;
  nextId=data.nextId;
  selected=null;
  dragging=null;
  updateProperties();
  draw();
}

function undo() {
  if(!history.length)return;
  future.push(snapshot());
  restore(history.pop());
  updateHistory();
}

function redo() {
  if(!future.length)return;
  history.push(snapshot());
  restore(future.pop());
  updateHistory();
}

function updateHistory() {
  $("undoBtn").disabled=!history.length;
  $("redoBtn").disabled=!future.length;
}

function polygon(o) {
  const s=o.size;
  let pts=[];

  if(o.type==="block") {
    pts=[
      V(-s/2,-s*.33),V(s/2,-s*.33),
      V(s/2,s*.33),V(-s/2,s*.33)
    ];
  } else if(o.type==="prism") {
    const h=s*Math.sqrt(3)/2;
    pts=[V(0,-2*h/3),V(s/2,h/3),V(-s/2,h/3)];
  } else if(o.type==="convex"||o.type==="concave") {
    const left=[],right=[],steps=80;
    for(let i=0;i<=steps;i++) {
      const y=-s/2+s*i/steps;
      const u=y/(s/2);
      const curve=1-u*u;
      const t=o.type==="convex"
        ? 5+20*curve : 25-19*curve;
      left.push(V(-t,y));
      right.push(V(t,y));
    }
    pts=[...left,...right.reverse()];
  }

  return pts.map(p=>world(o,p));
}

function mirrorPoints(o) {
  return [
    world(o,V(-o.size/2,0)),
    world(o,V(o.size/2,0))
  ];
}

function inside(p,poly) {
  let result=false;
  for(let i=0,j=poly.length-1;i<poly.length;j=i++) {
    const a=poly[i],b=poly[j];
    if((a.y>p.y)!==(b.y>p.y)) {
      const x=(b.x-a.x)*(p.y-a.y)/(b.y-a.y)+a.x;
      if(p.x<x)result=!result;
    }
  }
  return result;
}

function intersect(origin,dir,a,b) {
  const s=sub(b,a);
  const den=cross(dir,s);
  if(Math.abs(den)<1e-10)return null;
  const diff=sub(a,origin);
  const t=cross(diff,s)/den;
  const u=cross(diff,dir)/den;
  if(t<=EPS||u<0||u>1)return null;
  return {t,p:add(origin,mul(dir,t)),tangent:norm(s)};
}

function nearest(origin,dir) {
  let best=null;
  for(const o of objects) {
    if(source(o)||["ruler","protractor"].includes(o.type))continue;
    const pts=o.type==="mirror"?mirrorPoints(o):polygon(o);
    const count=o.type==="mirror"?1:pts.length;
    for(let i=0;i<count;i++) {
      const hit=intersect(origin,dir,pts[i],pts[(i+1)%pts.length]);
      if(hit&&(!best||hit.t<best.t)) {
        best={...hit,o,poly:o.type==="mirror"?null:pts};
      }
    }
  }
  return best;
}

function boundary(p,d) {
  const ts=[];
  if(d.x>EPS)ts.push((W-p.x)/d.x);
  if(d.x< -EPS)ts.push(-p.x/d.x);
  if(d.y>EPS)ts.push((H-p.y)/d.y);
  if(d.y< -EPS)ts.push(-p.y/d.y);
  return Math.min(...ts.filter(t=>t>EPS),Infinity);
}

function reflect(d,n) {
  return norm(sub(d,mul(n,2*dot(d,n))));
}

function refract(d,n,n1,n2) {
  const eta=n1/n2;
  const ci=clamp(-dot(d,n),0,1);
  const k=1-eta*eta*(1-ci*ci);
  if(k<0)return null;
  return norm(add(mul(d,eta),mul(n,eta*ci-Math.sqrt(k))));
}

// Упрощённая зависимость показателя от длины волны.
function indexAt(o,wavelength) {
  const dispersion=.012*(o.index-1)/.5;
  return o.index+dispersion*
    (Math.pow(550/wavelength,2)-1);
}

function trace(origin,initial,wavelength) {
  const points=[origin];
  const hits=[];
  let p=origin,d=norm(initial);

  for(let step=0;step<MAX_EVENTS;step++) {
    const edge=boundary(p,d);
    const hit=nearest(p,d);

    if(!hit||hit.t>=edge) {
      if(Number.isFinite(edge))points.push(add(p,mul(d,edge)));
      break;
    }

    points.push(hit.p);
    let n=V(-hit.tangent.y,hit.tangent.x);
    if(dot(d,n)>0)n=mul(n,-1);

    const incoming=d;
    let outgoing;

    if(hit.o.type==="mirror") {
      outgoing=reflect(d,n);
    } else {
      // Определяем среду до и после границы.
      const before=sub(hit.p,mul(d,.05));
      const wasInside=inside(before,hit.poly);
      const ng=indexAt(hit.o,wavelength);
      const n1=wasInside?ng:AIR;
      const n2=wasInside?AIR:ng;

      outgoing=refract(d,n,n1,n2)||reflect(d,n);
    }

    hits.push({p:hit.p,n,incoming,outgoing});
    d=outgoing;
    p=add(hit.p,mul(d,.05));

    if(step===MAX_EVENTS-1)points.push(p);
  }
  return {points,hits};
}

function rays(o) {
  const result=[];
  const d=direction(o.angle);
  const side=V(-d.y,d.x);

  for(let i=0;i<o.beams;i++) {
    const offset=(i-(o.beams-1)/2)*9;
    const origin=add(V(o.x,o.y),mul(side,offset));
    if(o.type==="white") {
      for(const [w,color] of spectrum)
        result.push({origin,d,w,color});
    } else {
      result.push({origin,d,w:550,color:o.color});
    }
  }
  return result;
}

function css(name) {
  return getComputedStyle(document.body)
    .getPropertyValue(name).trim();
}

function line(a,b,color,width=2,dash=[]) {
  ctx.save();
  ctx.strokeStyle=color;
  ctx.lineWidth=width;
  ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.moveTo(a.x,a.y);
  ctx.lineTo(b.x,b.y);
  ctx.stroke();
  ctx.restore();
}

function drawGrid() {
  if(!$("gridToggle").checked)return;
  const color=css("--grid");
  for(let x=0;x<W;x+=30)line(V(x,0),V(x,H),color,1);
  for(let y=0;y<H;y+=30)line(V(0,y),V(W,y),color,1);
}

function drawPolygon(o) {
  const pts=polygon(o);
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(pts[0].x,pts[0].y);
  pts.slice(1).forEach(p=>ctx.lineTo(p.x,p.y));
  ctx.closePath();
  ctx.fillStyle=css("--glass");
  ctx.strokeStyle="#38bdf8";
  ctx.lineWidth=2;
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawMirror(o) {
  const [a,b]=mirrorPoints(o);
  line(a,b,"#64748b",10);
  line(a,b,"#bae6fd",4);
}

function drawSource(o) {
  ctx.save();
  ctx.translate(o.x,o.y);
  ctx.rotate(rad(o.angle));
  ctx.fillStyle="#38bdf8";
  ctx.strokeStyle="#e0f2fe";
  ctx.beginPath();
  ctx.roundRect(-20,-12,40,24,6);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle=o.type==="white"?"white":o.color;
  ctx.beginPath();
  ctx.arc(22,0,4,0,Math.PI*2);
  ctx.fill();
  ctx.restore();
}

function drawNormal(hit) {
  line(
    add(hit.p,mul(hit.n,-28)),
    add(hit.p,mul(hit.n,28)),
    "#a78bfa",1,[4,4]
  );
}

function drawRuler(o) {
  const a=world(o,V(-o.size/2,0));
  const b=world(o,V(o.size/2,0));
  line(a,b,"#f59e0b",3);

  ctx.save();
  ctx.strokeStyle="#f59e0b";
  ctx.fillStyle="#f59e0b";
  ctx.font="11px sans-serif";
  ctx.textAlign="center";

  for(let i=0;i<=10;i++) {
    const x=-o.size/2+o.size*i/10;
    const p=world(o,V(x,0));
    const q=world(o,V(x,i%5===0?12:6));
    line(p,q,"#f59e0b",1);
  }

  ctx.fillText(`${o.size} px`,o.x,o.y-20);
  ctx.restore();
}

function drawProtractor(o) {
  const r=o.size/2;
  ctx.save();
  ctx.translate(o.x,o.y);
  ctx.rotate(rad(o.angle));
  ctx.strokeStyle="#a78bfa";
  ctx.fillStyle="#a78bfa";
  ctx.lineWidth=2;
  ctx.font="10px sans-serif";

  ctx.beginPath();
  ctx.arc(0,0,r,PI,2*PI);
  ctx.stroke();
  line(V(-r,0),V(r,0),"#a78bfa",2);

  for(let a=0;a<=180;a+=10) {
    const t=rad(180+a);
    const inner=r-(a%30===0?13:7);
    line(
      V(Math.cos(t)*inner,Math.sin(t)*inner),
      V(Math.cos(t)*r,Math.sin(t)*r),
      "#a78bfa",1
    );
  }

  ctx.restore();
}

function drawSelection(o) {
  ctx.save();
  ctx.strokeStyle="#38bdf8";
  ctx.setLineDash([5,5]);
  ctx.beginPath();
  ctx.arc(o.x,o.y,source(o)?30:10,0,PI*2);
  ctx.stroke();
  ctx.restore();
}

function draw() {
  ctx.clearRect(0,0,W,H);
  drawGrid();

  for(const o of objects)if(glass(o))drawPolygon(o);

  let count=0;
  let normalCount=0;

  for(const o of objects) {
    if(!source(o))continue;
    for(const ray of rays(o)) {
      const result=trace(ray.origin,ray.d,ray.w);
      count++;

      ctx.save();
      ctx.strokeStyle=ray.color;
      ctx.lineWidth=2;
      ctx.lineCap="round";
      ctx.lineJoin="round";
      ctx.shadowColor=ray.color;
      ctx.shadowBlur=9;
      ctx.beginPath();

      result.points.forEach((p,i)=>{
        if(i===0)ctx.moveTo(p.x,p.y);
        else ctx.lineTo(p.x,p.y);
      });

      ctx.stroke();
      ctx.restore();

      if($("normalToggle").checked&&normalCount<100) {
        for(const hit of result.hits) {
          if(normalCount++>=100)break;
          drawNormal(hit);
        }
      }
    }
  }

  for(const o of objects) {
    if(o.type==="mirror")drawMirror(o);
    if(source(o))drawSource(o);
    if(o.type==="ruler")drawRuler(o);
    if(o.type==="protractor")drawProtractor(o);
  }

  if(selected)drawSelection(selected);

  $("objectCount").textContent=`Объектов: ${objects.length}`;
  $("rayCount").textContent=`Лучей: ${count}`;
}

function distanceSegment(p,a,b) {
  const v=sub(b,a);
  const t=clamp(dot(sub(p,a),v)/(dot(v,v)||1),0,1);
  return len(sub(p,add(a,mul(v,t))));
}

function hitTest(p) {
  for(let i=objects.length-1;i>=0;i--) {
    const o=objects[i];

    if(source(o)) {
      if(len(sub(p,o))<26)return o;
    } else if(o.type==="mirror"||o.type==="ruler") {
      const [a,b]=mirrorPoints(o);
      if(distanceSegment(p,a,b)<14)return o;
    } else if(o.type==="protractor") {
      if(len(sub(p,o))<o.size/2+10)return o;
    } else if(inside(p,polygon(o)))return o;
  }
  return null;
}

function pointer(event) {
  const r=canvas.getBoundingClientRect();
  return V(event.clientX-r.left,event.clientY-r.top);
}

function selectTool(value) {
  tool=value;
  document.querySelectorAll(".tool").forEach(b=>
    b.classList.toggle("active",b.dataset.tool===value)
  );
}

function updateProperties() {
  const o=selected;
  $("emptyProperties").hidden=!!o;
  $("objectProperties").hidden=!o;
  if(!o)return;

  $("objectTitle").textContent=names[o.type][0];
  $("objectDescription").textContent=names[o.type][1];

  $("angleField").hidden=false;
  $("sizeField").hidden=source(o);
  $("indexField").hidden=!glass(o);
  $("beamField").hidden=!source(o);
  $("colorField").hidden=o.type!=="source";
  $("measureField").hidden=o.type!=="ruler";

  $("angleRange").value=o.angle;
  $("angleValue").textContent=o.angle+"°";
  $("sizeRange").value=o.size;
  $("sizeValue").textContent=o.size+" px";
  $("indexRange").value=o.index;
  $("indexValue").textContent=o.index.toFixed(2);
  $("beamRange").value=o.beams;
  $("beamValue").textContent=o.beams;
  $("colorInput").value=o.color;
  $("measureValue").textContent=o.size+" px";
}

function addAt(type,x,y) {
  const before=snapshot();
  selected=make(type,x,y);
  objects.push(selected);
  commit(before);
  updateProperties();
  draw();
}

canvas.addEventListener("pointerdown",e=>{
  const p=pointer(e);
  if(tool!=="select") {
    addAt(tool,p.x,p.y);
    selectTool("select");
    return;
  }

  selected=hitTest(p);
  updateProperties();

  if(selected) {
    actionBefore=snapshot();
    dragging={
      id:e.pointerId,
      dx:p.x-selected.x,
      dy:p.y-selected.y
    };
    canvas.setPointerCapture(e.pointerId);
  }
  draw();
});

canvas.addEventListener("pointermove",e=>{
  const p=pointer(e);

  if(dragging&&selected&&dragging.id===e.pointerId) {
    selected.x=clamp(p.x-dragging.dx,0,W);
    selected.y=clamp(p.y-dragging.dy,0,H);
    draw();
  } else {
    canvas.style.cursor=tool!=="select"?"crosshair":
      hitTest(p)?"grab":"default";
  }
});

function stopDrag(e) {
  if(!dragging||dragging.id!==e.pointerId)return;
  dragging=null;
  commit(actionBefore);
  actionBefore=null;
  if(canvas.hasPointerCapture(e.pointerId))
    canvas.releasePointerCapture(e.pointerId);
}

canvas.addEventListener("pointerup",stopDrag);
canvas.addEventListener("pointercancel",stopDrag);

document.querySelectorAll(".tool").forEach(b=>{
  b.addEventListener("click",()=>selectTool(b.dataset.tool));
});

function bindRange(id,property,formatter) {
  const el=$(id);
  let before=null;

  el.addEventListener("pointerdown",()=>{
    before=snapshot();
  });

  el.addEventListener("input",()=>{
    if(!selected)return;
    if(before===null)before=snapshot();
    selected[property]=Number(el.value);
    $(id.replace("Range","Value")).textContent=
      formatter(selected[property]);
    if(property==="size"&&selected.type==="ruler")
      $("measureValue").textContent=selected.size+" px";
    draw();
  });

  el.addEventListener("change",()=>{
    commit(before);
    before=null;
  });
}

bindRange("angleRange","angle",v=>v+"°");
bindRange("sizeRange","size",v=>v+" px");
bindRange("indexRange","index",v=>v.toFixed(2));
bindRange("beamRange","beams",v=>String(v));

let colorBefore=null;
$("colorInput").addEventListener("input",e=>{
  if(!selected)return;
  if(colorBefore===null)colorBefore=snapshot();
  selected.color=e.target.value;
  draw();
});
$("colorInput").addEventListener("change",()=>{
  commit(colorBefore);
  colorBefore=null;
});

function removeSelected() {
  if(!selected)return;
  const before=snapshot();
  objects=objects.filter(o=>o!==selected);
  selected=null;
  commit(before);
  updateProperties();
  draw();
}

$("deleteBtn").addEventListener("click",removeSelected);
$("undoBtn").addEventListener("click",undo);
$("redoBtn").addEventListener("click",redo);

$("gridToggle").addEventListener("change",draw);
$("normalToggle").addEventListener("change",draw);

$("themeBtn").addEventListener("click",()=>{
  const dark=document.body.dataset.theme==="dark";
  document.body.dataset.theme=dark?"light":"dark";
  $("themeBtn").textContent=dark?"☾ Тема":"☀ Тема";
  draw();
});

function preset(name) {
  const before=snapshot();
  objects=[];
  selected=null;

  const x=W*.18,y=H*.5;
  const place=(type,px,py,extra={})=>{
    objects.push(make(type,px,py,extra));
  };

  if(name==="reflection") {
    place("source",x,y);
    place("mirror",W*.62,y,{angle:60});
  }
  if(name==="refraction") {
    place("source",x,y-45,{angle:15});
    place("block",W*.58,y,{angle:20,index:1.5});
  }
  if(name==="lens") {
    place("source",x,y,{beams:9});
    place("convex",W*.55,y,{size:170});
  }
  if(name==="spectrum") {
    place("white",x,y-40,{angle:12});
    place("prism",W*.55,y,{size:160,index:1.6});
  }

  commit(before);
  updateProperties();
  draw();
  $("statusText").textContent="Эксперимент: "+name;
}

document.querySelectorAll("[data-preset]").forEach(b=>{
  b.addEventListener("click",()=>preset(b.dataset.preset));
});

$("resetBtn").addEventListener("click",()=>{
  preset("lens");
});

$("saveBtn").addEventListener("click",()=>{
  const data={
    version:3,
    objects,
    nextId
  };

  const blob=new Blob(
    [JSON.stringify(data,null,2)],
    {type:"application/json"}
  );

  const url=URL.createObjectURL(blob);
  const a=document.createElement("a");
  a.href=url;
  a.download="optical-experiment.json";
  a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
});

$("loadBtn").addEventListener("click",()=>{
  $("fileInput").click();
});

$("fileInput").addEventListener("change",async e=>{
  const file=e.target.files[0];
  if(!file)return;

  try {
    if(file.size>1024*1024)
      throw new Error("Файл слишком большой");

    const data=JSON.parse(await file.text());

    if(!Array.isArray(data.objects)||
       data.objects.length>200)
      throw new Error("Некорректный список объектов");

    const allowed=[...glassTypes,...sourceTypes,
      "mirror","ruler","protractor"];

    for(const o of data.objects) {
      if(!o||!allowed.includes(o.type)||
         !Number.isFinite(o.x)||
         !Number.isFinite(o.y)||
         !Number.isFinite(o.angle)||
         !Number.isFinite(o.size)||
         !Number.isFinite(o.index)||
         !Number.isFinite(o.beams)||
         o.size<40||o.size>260||
         o.index<1.05||o.index>2||
         o.beams<1||o.beams>15||
         !Number.isInteger(o.beams)||
         !Number.isInteger(o.id)||
         o.id<1||
         typeof o.color!=="string"||
         !/^#[0-9a-fA-F]{6}$/.test(o.color))
        throw new Error("Некорректные параметры объекта");
    }

    const ids=data.objects.map(o=>o.id);
    if(new Set(ids).size!==ids.length)
      throw new Error("Повторяющиеся ID");

    const before=snapshot();
    objects=data.objects;
    nextId=Math.max(0,...ids)+1;
    selected=null;
    commit(before);
    updateProperties();
    draw();
    $("statusText").textContent="Эксперимент загружен";
  } catch(error) {
    alert("Ошибка загрузки: "+error.message);
  }

  e.target.value="";
});

document.addEventListener("keydown",e=>{
  const tag=document.activeElement.tagName;
  if(["INPUT","TEXTAREA"].includes(tag))return;

  if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="z") {
    e.preventDefault();
    if(e.shiftKey)redo();else undo();
  } else if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="y") {
    e.preventDefault();
    redo();
  } else if(e.key==="Delete"||e.key==="Backspace") {
    removeSelected();
  } else if(e.key==="Escape") {
    selected=null;
    selectTool("select");
    updateProperties();
    draw();
  }
});

function resize() {
  const rect=container.getBoundingClientRect();
  const dpr=window.devicePixelRatio||1;
  W=Math.max(1,rect.width);
  H=Math.max(1,rect.height);
  canvas.width=Math.round(W*dpr);
  canvas.height=Math.round(H*dpr);
  ctx.setTransform(dpr,0,0,dpr,0,0);
  draw();
}

new ResizeObserver(resize).observe(container);
resize();
preset("lens");
history=[];
future=[];
updateHistory();
