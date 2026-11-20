// ページを「地層」にして、上の層から順に掘り進めながら読む演出。
// ・地表（ブロックの地形）→ プロフィール（スキル・資格も含む）→ チーム制作 → 個人制作 → 就職作品 の順に重ねている
// ・7割掘ると残りが崩れて下の層が全部見え、その層の画面もまた掘れるようになる（就職作品が最下層）
// ・掘った跡は層の中身に付いていて、層をスクロールすると一緒に動く
// ・掘った穴の上でスクロールすると下の層、残っている部分の上でスクロールすると上の層が動く
// ・本文の HTML は消さずに層ごとの入れ物に入れて重ねているだけなので、検索エンジンや読み上げソフトには普段どおり届く
// ・「普通に読む」で縦に長い普段のページに戻せる（選んだことはこのブラウザに保存する）
// ・JavaScript が動かない環境と「視差効果を減らす」設定の環境では、普段どおりのページのまま
// ・音は Web Audio でその場で合成している（外部の音素材は使っていない）。最初は OFF
(() => {
  "use strict";

  const root = document.documentElement;
  const main = document.getElementById("main");
  const header = document.querySelector(".site-header");
  if (!main || !header || !window.matchMedia) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  if (!document.createElement("canvas").getContext) return;
  if (!window.CSS || !CSS.supports || !CSS.supports("clip-path", 'path(evenodd, "M0 0H1V1Z")')) return;

  /* ---------- 調整用の数値 ---------- */
  const CELL_CSS = 8;     // ブロック1個の大きさ（CSS px）
  const CLEAR_AT = 0.7;   // 1画面分のこれだけのブロックを掘ると、残りが一気に崩れて下の層に進む（長い層でも基準は1画面分）
  const MAX_PARTS = 700;  // 同時に出すパーティクルの上限
  // 採掘レベル：ポイントが貯まるほど、一度に掘れる範囲（ブロック数）が広がる
  const LEVELS = [
    { pt: 0,    area: 3,  trail: 1.3 },
    { pt: 25,   area: 6,  trail: 2.2 },
    { pt: 220,  area: 10, trail: 3.4 },
    { pt: 520,  area: 16, trail: 5.0 },
    { pt: 1250, area: 26, trail: 7.5 },
  ];
  const SOUND_KEY = "dig-sound"; // "on" のときだけ音を出す（最初は OFF）
  const MODE_KEY = "dig-mode";   // "flat" なら普通に読むモードで開く
  // 掘って読むときの層。プロフィールとスキル・資格はひとつの層にまとめる
  const GROUPS = [
    { ids: ["top", "skills"], name: "プロフィール" },
    { ids: ["team"], name: "チーム制作" },
    { ids: ["solo"], name: "個人制作" },
    { ids: ["featured"], name: "就職作品" },
  ];

  /* ---------- ブロックの種類と色 ---------- */
  const TOP = 1, SOIL = 2, STONE = 3, DEEP = 4, AMBER = 5, TEAL = 6, SCREEN = 7; // SCREEN = 層の画面そのもの
  const ORE_PT = { [AMBER]: 8, [TEAL]: 12 };
  const isOre = (t) => t === AMBER || t === TEAL;
  const BASE = {
    [TOP]: [96, 72, 54],      // 表土
    [SOIL]: [138, 100, 70],   // 土
    [STONE]: [125, 130, 141], // 石
    [DEEP]: [84, 90, 104],    // 深い石
    [AMBER]: [226, 140, 48],  // 鉱石（サイトのアクセント色）
    [TEAL]: [44, 168, 152],   // 結晶（サイトのティール色）
  };
  const SHADES = 6;
  const PAL = [];
  for (const t in BASE) {
    PAL[t] = [];
    for (let k = 0; k < SHADES; k++) {
      const f = 0.86 + k * 0.05;
      const [r, g, b] = BASE[t].map((v) => Math.min(255, Math.round(v * f)));
      PAL[t].push(`rgb(${r},${g},${b})`);
    }
  }

  /* ---------- 乱数とノイズ（地層や鉱脈の形に使う） ---------- */
  function hash(x, y, sd) {
    let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(sd, 982451653);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
  function vnoise(x, y, sd) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = hash(xi, yi, sd), b = hash(xi + 1, yi, sd);
    const c = hash(xi, yi + 1, sd), d = hash(xi + 1, yi + 1, sd);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  const newSeed = () => (Math.random() * 1e9) | 0;

  /* ---------- 層（上から順に）を組み立てる ---------- */
  const groups = GROUPS
    .map((g) => ({ name: g.name, secs: g.ids.map((id) => document.getElementById(id)).filter((el) => el && el.parentElement === main) }))
    .filter((g) => g.secs.length);
  if (groups.length < 2) return;

  // 層 = スクロールする入れ物（.dig-layer）＋ 掘られる紙（.dig-sheet）。
  // 入れ物はクリックを素通りさせ、紙だけが当たり判定を持つ。紙に穴をあけると、穴の部分は下の層に当たる。
  // 普通に読むモードでは入れ物も紙も display: contents になり、元のページと同じ並びに戻る
  function makeLayer(extra) {
    const layer = document.createElement("div");
    layer.className = "dig-layer" + extra;
    const sheet = document.createElement("div");
    sheet.className = "dig-sheet";
    layer.appendChild(sheet);
    return { layer, sheet };
  }
  const surf = makeLayer(" dig-surface-layer");
  surf.layer.setAttribute("aria-hidden", "true");
  surf.sheet.classList.add("dig-surface");
  surf.sheet.innerHTML = '<canvas class="dig-blocks"></canvas>';
  const L = [{ ...surf, secs: [], ids: [], name: "地表" }];
  for (const g of groups) {
    const ly = makeLayer("");
    g.secs[0].before(ly.layer);
    for (const sec of g.secs) ly.sheet.appendChild(sec);
    if (g.secs[0].classList.contains("section-alt")) ly.sheet.classList.add("is-alt");
    L.push({ ...ly, secs: g.secs, ids: g.secs.map((sec) => sec.id), name: g.name });
  }
  const LAST = L.length - 1; // 最下層（掘れない）

  /* ---------- 演出用の DOM ---------- */
  const ui = document.createElement("div");
  ui.className = "dig-ui";
  ui.innerHTML = `
    <canvas class="dig-fx" aria-hidden="true"></canvas>
    <div class="dig-hint">
      <p class="dig-hint-title" aria-hidden="true">このページは地層になっています</p>
      <p class="dig-hint-text" aria-hidden="true"><span class="dig-pc">クリックで範囲採掘、ドラッグで掘り進めます。</span><span class="dig-touch">タップで範囲採掘、なぞると掘り進めます。</span>7割掘ると崩れて下の層が現れ、その画面もまた掘れます。</p>
      <ol class="dig-hint-path" aria-hidden="true">${L.map((ly) => `<li>${ly.name}</li>`).join("")}</ol>
      <div class="dig-hint-actions">
        <button type="button" class="dig-btn dig-btn-primary" data-act="clear" aria-label="一気に掘る（演出をスキップ）">一気に掘る</button>
        <button type="button" class="dig-btn" data-act="flat">普通に読む</button>
      </div>
    </div>
    <p class="dig-toast" role="status" aria-live="polite"></p>
    <div class="dig-hud">
      <div class="dig-hud-info" aria-hidden="true">
        <span class="dig-depth"><b class="dig-depth-no">地表</b><span class="dig-depth-name"></span></span>
        <span class="dig-stat"><b class="dig-lv">Lv.1</b><span><span class="dig-pt">0</span> pt</span></span>
        <span class="dig-gauge dig-not-bottom" title="崩れるまで"><i></i></span>
      </div>
      <div class="dig-hud-btns">
        <button type="button" class="dig-btn" data-act="sound" aria-pressed="false">音 OFF</button>
        <button type="button" class="dig-btn dig-after-start dig-not-bottom" data-act="clear" aria-label="一気に掘る（この層を崩す）">一気に掘る</button>
        <button type="button" class="dig-btn dig-only-bottom" data-act="restart">最初から掘る</button>
        <button type="button" class="dig-btn dig-after-start" data-act="flat">普通に読む</button>
      </div>
    </div>`;
  main.prepend(ui);
  ui.after(surf.layer);

  // 穴の影と画面の切り口を描く canvas。いま掘っている層の入れ物に入れて、中身と一緒にスクロールさせる
  const edges = document.createElement("canvas");
  edges.className = "dig-edges";
  edges.setAttribute("aria-hidden", "true");

  const modeBtn = document.createElement("button");
  modeBtn.type = "button";
  modeBtn.className = "dig-btn dig-modebtn";
  modeBtn.textContent = "掘って読む";
  document.body.appendChild(modeBtn);

  const blocks = surf.sheet.querySelector(".dig-blocks");
  const fxc = ui.querySelector(".dig-fx");
  const bctx = blocks.getContext("2d");
  const ectx = edges.getContext("2d");
  const fctx = fxc.getContext("2d");
  const hud = ui.querySelector(".dig-hud");
  const depthNoEl = ui.querySelector(".dig-depth-no");
  const depthNameEl = ui.querySelector(".dig-depth-name");
  const lvEl = ui.querySelector(".dig-lv");
  const ptEl = ui.querySelector(".dig-pt");
  const gaugeEl = ui.querySelector(".dig-gauge i");
  const toastEl = ui.querySelector(".dig-toast");
  const soundBtn = ui.querySelector('[data-act="sound"]');
  const hintClearBtn = ui.querySelector('.dig-hint [data-act="clear"]');
  const hudClearBtn = ui.querySelector('.dig-hud [data-act="clear"]');
  const navLinks = [...document.querySelectorAll('.site-nav a[href^="#"]')];
  const probe = document.createElement("i");
  probe.hidden = true;
  ui.appendChild(probe);

  /* ---------- 状態 ---------- */
  let strata = false;     // 掘って読むモードか
  let cur = 0;            // いま見えているいちばん上の層
  let target = 0;         // 崩れたあとに進む層（ナビで深い層を選んだときは一気に進む）
  let pendingId = "";     // 層に着いたあとにスクロールして見せるセクション
  let phase = "active";   // active（掘れる）→ clearing（崩れている途中）／ bottom（最下層）
  let seed = newSeed();
  let W = 0, H = 0;       // 画面（#main）の大きさ
  let SW = 0, SH = 0;     // いまの層の紙の大きさ（スクロールする中身全体）
  let dpr = 1, cs = 8, s = 8, lw = 1, es = 1, cols = 0, rows = 0;
  let viewY = 0;          // いまの層のスクロール量
  let cells = new Uint8Array(0), shade = new Uint8Array(0);
  let total = 0, remain = 0, points = 0, lv = 0;
  let clearNeed = 0;      // 崩れるまでに掘るブロック数（1画面分 × CLEAR_AT）
  let lastX = 0, lastY = 0; // 最後に掘った場所（紙の座標）
  let clipDirty = false, gridFlash = 0;
  let cutCol = "rgba(0,0,0,.35)", gridCol = "rgba(0,0,0,.2)", ringCol = "#ffe7c4";
  let screenCols = ["#ffffff"];
  const queue = [];  // 時間差で壊すブロック { at, i, fx }
  const parts = [];  // パーティクル（画面の座標）
  const texts = [];  // 浮かぶ文字（+8 や レベルアップ）
  const rings = [];  // 範囲採掘の衝撃波
  const tally = { n: 0, hard: 0, glass: 0, ore: 0 }; // このフレームで壊した数（音の量に使う）

  const readView = () => { viewY = L[cur].layer.scrollTop; };

  /* ---------- 色（サイトの配色から読む。ダークモードにも合わせる） ---------- */
  function rgbOf(value) {
    probe.style.color = value;
    const m = getComputedStyle(probe).color.match(/[\d.]+/g);
    return m ? m.slice(0, 3).join(",") : "128,128,128";
  }
  function readColors() {
    const text = rgbOf("var(--text)");
    cutCol = `rgba(${text},.4)`;
    gridCol = `rgba(${text},.22)`;
    ringCol = cur === 0 ? "#ffe7c4" : `rgb(${rgbOf("var(--accent)")})`;
    const bg = `rgb(${rgbOf(getComputedStyle(L[cur].sheet).backgroundColor)})`;
    screenCols = [bg, bg, bg, `rgb(${rgbOf("var(--surface)")})`, `rgb(${rgbOf("var(--line)")})`,
      `rgb(${rgbOf("var(--accent)")})`, `rgb(${rgbOf("var(--teal)")})`, `rgb(${text})`];
  }

  /* ---------- 地形の生成と描画 ---------- */
  function generate(nc, nr, sd) {
    const g = new Uint8Array(nc * nr), sh = new Uint8Array(nc * nr);
    for (let c = 0; c < nc; c++) {
      const topEnd = 1 + vnoise(c * 0.15, 9.5, sd + 2) * 2.2;
      const soilEnd = nr * 0.16 + (vnoise(c * 0.05, 0.5, sd) - 0.5) * 10;
      const deepStart = nr * 0.66 + (vnoise(c * 0.04, 3.5, sd + 1) - 0.5) * 16;
      for (let r = 0; r < nr; r++) {
        let t;
        if (r < topEnd) t = TOP;
        else if (r < soilEnd) t = SOIL;
        else if (r < deepStart) t = vnoise(c * 0.11, r * 0.11, sd + 3) > 0.78 ? SOIL : STONE;
        else t = DEEP;
        if (t === STONE || t === DEEP) {
          if (vnoise(c * 0.21, r * 0.21, sd + 5) > 0.9) t = AMBER;
          else if (t === DEEP && vnoise(c * 0.24, r * 0.24, sd + 7) > 0.91) t = TEAL;
          else if (hash(c, r, sd + 11) < 0.003) t = AMBER;
        }
        const i = r * nc + c;
        g[i] = t;
        sh[i] = (hash(c, r, sd) * SHADES) | 0;
      }
    }
    return { g, sh };
  }

  // いまの層のブロック配置を作る。地表は地形、途中の層は画面そのもの、最下層は掘れないので空
  function makeGrid(nc, nr) {
    if (cur === 0) return generate(nc, nr, seed);
    const g = new Uint8Array(nc * nr);
    if (phase !== "bottom") g.fill(SCREEN);
    return { g, sh: new Uint8Array(nc * nr) };
  }

  // 範囲外は「埋まっている」扱いにして、紙の端に縁取りが出ないようにする
  const filledAt = (c, r) => c < 0 || r < 0 || c >= cols || r >= rows || cells[r * cols + c] !== 0;

  // 地表のブロックの見た目（上面は明るく、下面は暗く。穴に面した辺は強めにして立体感を出す）
  function drawBlock(i) {
    const c = i % cols, r = (i - c) / cols, x = c * cs, y = r * cs, t = cells[i];
    if (!t) { bctx.clearRect(x, y, cs, cs); return; }
    bctx.fillStyle = PAL[t][shade[i]];
    bctx.fillRect(x, y, cs, cs);
    const up = filledAt(c, r - 1), dn = filledAt(c, r + 1);
    const lf = filledAt(c - 1, r), rt = filledAt(c + 1, r);
    bctx.fillStyle = up ? "rgba(255,255,255,.08)" : "rgba(255,255,255,.24)";
    bctx.fillRect(x, y, cs, up ? lw : lw * 2);
    bctx.fillStyle = dn ? "rgba(0,0,0,.14)" : "rgba(0,0,0,.38)";
    bctx.fillRect(x, y + cs - (dn ? lw : lw * 2), cs, dn ? lw : lw * 2);
    if (!lf) { bctx.fillStyle = "rgba(0,0,0,.22)"; bctx.fillRect(x, y, lw, cs); }
    if (!rt) { bctx.fillStyle = "rgba(0,0,0,.28)"; bctx.fillRect(x + cs - lw, y, lw, cs); }
    if (isOre(t)) { bctx.fillStyle = "rgba(255,255,255,.45)"; bctx.fillRect(x + lw * 2, y + lw * 2, lw * 2, lw * 2); }
  }

  // 穴の影と、画面の切り口（紙の座標・CSS px で描く）
  function drawEdge(i) {
    const c = i % cols, r = (i - c) / cols, x = c * s, y = r * s, t = cells[i];
    ectx.clearRect(x, y, s, s);
    if (!t) {
      // 穴から見える下の層を少し暗くし、上の縁が落とす影を描く
      ectx.fillStyle = "rgba(8,10,16,.07)";
      ectx.fillRect(x, y, s, s);
      if (filledAt(c, r - 1)) { ectx.fillStyle = "rgba(0,0,0,.22)"; ectx.fillRect(x, y, s, 3); }
      if (filledAt(c - 1, r)) { ectx.fillStyle = "rgba(0,0,0,.11)"; ectx.fillRect(x, y, 2, s); }
      return;
    }
    if (t !== SCREEN) return;
    ectx.fillStyle = cutCol;
    if (!filledAt(c, r - 1)) ectx.fillRect(x, y, s, 1);
    if (!filledAt(c, r + 1)) ectx.fillRect(x, y + s - 2, s, 2);
    if (!filledAt(c - 1, r)) ectx.fillRect(x, y, 1, s);
    if (!filledAt(c + 1, r)) ectx.fillRect(x + s - 1, y, 1, s);
  }

  function paint(i) {
    if (cur === 0) drawBlock(i);
    drawEdge(i);
  }
  function redrawAround(i) {
    const c = i % cols;
    paint(i);
    if (c > 0) paint(i - 1);
    if (c < cols - 1) paint(i + 1);
    if (i >= cols) paint(i - cols);
    if (i + cols < cells.length) paint(i + cols);
  }

  // 掘った穴を紙の clip-path にする。行ごとに、続いている穴をひとつの長方形にまとめる
  function applyClip() {
    clipDirty = false;
    const el = L[cur].sheet;
    if (phase === "bottom") { el.style.clipPath = ""; return; }
    const f = (v) => Math.round(v * 100) / 100;
    const out = [`M0 0H${f(cols * s)}V${f(rows * s)}H0Z`];
    for (let r = 0; r < rows; r++) {
      const base = r * cols, y0 = f(r * s), y1 = f((r + 1) * s);
      let c = 0;
      while (c < cols) {
        if (cells[base + c]) { c++; continue; }
        let e = c + 1;
        while (e < cols && !cells[base + e]) e++;
        const x0 = f(c * s), x1 = f(e * s);
        out.push(`M${x0} ${y0}H${x1}V${y1}H${x0}Z`);
        c = e;
      }
    }
    el.style.clipPath = out.length > 1 ? `path(evenodd, "${out.join("")}")` : "";
  }

  function sizeCanvas(cv, w, h, scale) {
    cv.width = Math.max(1, Math.round(w * scale));
    cv.height = Math.max(1, Math.round(h * scale));
    cv.style.width = w + "px";
    cv.style.height = h + "px";
  }

  // いまの層に合わせて、ブロックの並びと canvas を作り直す（keep のときは掘った跡を残す）
  function setup(keep) {
    const ly = L[cur];
    const w = main.clientWidth, h = main.clientHeight;
    const sw = ly.sheet.clientWidth, sh = ly.sheet.offsetHeight;
    const nd = Math.min(window.devicePixelRatio || 1, 2);
    if (keep && w === W && h === H && sw === SW && sh === SH && nd === dpr) return;
    W = w; H = h; SW = sw; SH = sh; dpr = nd;
    // ブロックの大きさを実ピクセルの整数にして、ブロック同士の継ぎ目が出ないようにする
    cs = Math.max(4, Math.round(CELL_CSS * dpr));
    s = cs / dpr;
    lw = Math.max(1, Math.round(dpr));
    sizeCanvas(fxc, W, H, dpr);
    fctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (cur === 0) sizeCanvas(blocks, SW, SH, dpr);
    if (edges.parentNode !== ly.layer) ly.layer.appendChild(edges);
    if (phase === "bottom") {
      sizeCanvas(edges, 1, 1, 1);
    } else {
      // 長い層では canvas が大きくなりすぎないよう、影の解像度を下げる
      es = SW * SH * dpr * dpr > 6e6 ? 1 : dpr;
      sizeCanvas(edges, SW, SH, es);
      ectx.setTransform(es, 0, 0, es, 0, 0);
    }

    const nc = Math.ceil(SW / s), nr = Math.ceil(SH / s);
    const gen = makeGrid(nc, nr);
    if (keep && cells.length) {
      for (let r = 0; r < Math.min(rows, nr); r++) {
        for (let c = 0; c < Math.min(cols, nc); c++) {
          if (cells[r * cols + c] === 0) gen.g[r * nc + c] = 0;
        }
      }
    }
    cols = nc; rows = nr; cells = gen.g; shade = gen.sh;
    total = phase === "bottom" ? 0 : cells.length;
    clearNeed = Math.min(total, Math.ceil(cols * Math.ceil(H / s) * CLEAR_AT));
    remain = 0;
    for (let i = 0; i < cells.length; i++) if (cells[i]) remain++;
    if (cur === 0) bctx.clearRect(0, 0, blocks.width, blocks.height);
    ectx.clearRect(0, 0, SW, SH);
    if (phase !== "bottom") for (let i = 0; i < cells.length; i++) paint(i);
    applyClip();
    updateHud();
  }

  /* ---------- 音 ---------- */
  let soundOn = false;
  try { soundOn = localStorage.getItem(SOUND_KEY) === "on"; } catch (_) { /* 保存できない環境でも動かす */ }
  let actx = null, master = null, noise = null, voices = 0;

  function initAudio() {
    if (!soundOn) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!actx) {
      try {
        actx = new AC();
        const comp = actx.createDynamicsCompressor();
        comp.threshold.value = -18;
        comp.ratio.value = 6;
        master = actx.createGain();
        master.gain.value = 0.5;
        master.connect(comp);
        comp.connect(actx.destination);
        const len = Math.floor(actx.sampleRate * 0.25);
        noise = actx.createBuffer(1, len, actx.sampleRate);
        const d = noise.getChannelData(0);
        for (let k = 0; k < len; k++) d[k] = Math.random() * 2 - 1;
      } catch (_) {
        actx = null;
        return;
      }
    }
    if (actx.state === "suspended") actx.resume();
  }

  // 「ザクッ」：ノイズを帯域フィルタに通して短く鳴らす。土は低め、石は高め、画面（ガラス）はさらに高め
  const CRUNCH_HZ = [650, 1500, 2700];
  function crunch(kind) {
    if (!soundOn || !actx || voices > 24) return;
    const t0 = actx.currentTime;
    const src = actx.createBufferSource();
    src.buffer = noise;
    src.playbackRate.value = 0.7 + Math.random() * 0.6;
    const bp = actx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = CRUNCH_HZ[kind] * (0.75 + Math.random() * 0.6);
    bp.Q.value = kind === 2 ? 1.6 : 1.1;
    const g = actx.createGain();
    const dur = (kind === 2 ? 0.04 : 0.06) + Math.random() * 0.06;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(kind === 0 ? 0.7 : 0.55, t0 + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(bp);
    bp.connect(g);
    g.connect(master);
    voices++;
    src.onended = () => { voices--; };
    src.start(t0, Math.random() * 0.1, dur + 0.02);
  }

  // 「キン」：鉱石やレベルアップのときの音
  function chime(freq, delay, vol) {
    if (!soundOn || !actx) return;
    const t0 = actx.currentTime + delay;
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = "triangle";
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.25);
    o.connect(g);
    g.connect(master);
    o.start(t0);
    o.stop(t0 + 0.3);
  }

  function showSound() {
    soundBtn.setAttribute("aria-pressed", String(soundOn));
    soundBtn.textContent = soundOn ? "音 ON" : "音 OFF";
  }
  function setSound(on) {
    soundOn = on;
    try { localStorage.setItem(SOUND_KEY, on ? "on" : "off"); } catch (_) { /* 無視 */ }
    showSound();
    if (on) initAudio();
  }

  /* ---------- 掘る（座標はいまの層の紙の座標） ---------- */
  function centerOf(i) {
    const c = i % cols, r = (i - c) / cols;
    return { x: (c + 0.5) * s, y: (r + 0.5) * s };
  }

  function spawn(i, t, n) {
    const p = centerOf(i);
    const y = p.y - viewY; // パーティクルは画面の座標で飛ばす
    if (y < -40 || y > H + 40) return;
    for (let k = 0; k < n && parts.length < MAX_PARTS; k++) {
      parts.push({
        x: p.x, y,
        vx: (Math.random() - 0.5) * 3.4,
        vy: -Math.random() * 3.6 - 0.8,
        life: 28 + Math.random() * 26,
        s: 2 + Math.random() * 2.5,
        col: t === SCREEN
          ? screenCols[(Math.random() * screenCols.length) | 0]
          : PAL[t][(Math.random() * SHADES) | 0],
      });
    }
  }

  function addText(x, y, str, big) {
    if (texts.length > 30) texts.shift();
    texts.push({ x, y, s: str, big, life: big ? 70 : 40 });
  }

  function breakCell(i, withFx) {
    const t = cells[i];
    if (!t) return;
    cells[i] = 0;
    remain--;
    clipDirty = true;
    redrawAround(i);
    tally.n++;
    if (t === SCREEN) tally.glass++;
    else if (t >= STONE) tally.hard++;
    if (isOre(t)) tally.ore++;
    if (withFx || isOre(t)) spawn(i, t, isOre(t) ? 7 : 2);
    if (phase === "active") {
      const pt = ORE_PT[t] || 1;
      points += pt;
      if (pt > 1) {
        const p = centerOf(i);
        addText(p.x, p.y - viewY - 6, "+" + pt, false);
      }
    }
  }

  function forCellsIn(x, y, R, fn) {
    const cc = x / s, cr = y / s;
    const r0 = Math.max(0, Math.floor(cr - R)), r1 = Math.min(rows - 1, Math.ceil(cr + R));
    const c0 = Math.max(0, Math.floor(cc - R)), c1 = Math.min(cols - 1, Math.ceil(cc + R));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const i = r * cols + c;
        if (cells[i]) fn(i, Math.hypot(c + 0.5 - cc, r + 0.5 - cr), c, r);
      }
    }
  }

  function markStarted() {
    ui.classList.add("is-started");
  }

  // クリック：範囲採掘。中心から外側へ時間差で崩す
  function areaDig(x, y) {
    if (phase !== "active") return;
    const R = LEVELS[lv].area, now = performance.now();
    const hits = [];
    forCellsIn(x, y, R + 1, (i, d, c, r) => {
      if (d <= R + (hash(c, r, 99) - 0.5) * 1.6) hits.push(i, d);
    });
    const pFx = Math.min(1, 70 / Math.max(1, hits.length / 2));
    for (let k = 0; k < hits.length; k += 2) {
      queue.push({ at: now + hits[k + 1] * 11, i: hits[k], fx: Math.random() < pFx });
    }
    rings.push({ x, y: y - viewY, R: R * s, life: 18 });
    lastX = x; lastY = y;
    markStarted();
    kick();
  }

  // ドラッグ：軌跡に沿ってその場で掘る
  function lineDig(x0, y0, x1, y1) {
    if (phase !== "active") return;
    const R = LEVELS[lv].trail;
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / (s * 0.6)));
    for (let k = 0; k <= n; k++) {
      const x = x0 + ((x1 - x0) * k) / n, y = y0 + ((y1 - y0) * k) / n;
      forCellsIn(x, y, R, (i, d) => { if (d <= R) breakCell(i, Math.random() < 0.3); });
    }
    lastX = x1; lastY = y1;
    markStarted();
    kick();
  }

  // 残りを一気に崩す（7割掘ったとき・「一気に掘る」・ナビやキーボードで下の層へ行くとき）
  function collapse(x, y) {
    if (phase !== "active") return;
    phase = "clearing";
    ui.dataset.phase = phase;
    if (target <= cur) target = cur + 1;
    down = null;
    markStarted();
    const now = performance.now();
    const cc = x / s, cr = y / s, maxD = Math.hypot(cols, Math.min(rows, (H / s) * 1.5)) || 1;
    for (let i = 0; i < cells.length; i++) {
      if (!cells[i]) continue;
      const c = i % cols, r = (i - c) / cols;
      const d = Math.min(maxD, Math.hypot(c + 0.5 - cc, r + 0.5 - cr));
      queue.push({ at: now + (d / maxD) * 700 + Math.random() * 80, i, fx: Math.random() < 0.05 });
    }
    updateHud();
    kick();
  }

  // 層 k をいちばん上にする。how: "down"（崩れて到達）／"up"（上の層へ戻る）／"fill"（地表を埋める）／"init"
  function enter(k, how) {
    queue.length = 0;
    down = null;
    cur = k;
    target = k;
    phase = k === LAST ? "bottom" : "active";
    if (k === 0 && how === "up") seed = newSeed();
    L.forEach((ly, i) => {
      ly.layer.classList.toggle("is-dug", i < k);
      ly.sheet.classList.toggle("is-diggable", i === k && phase === "active");
      ly.sheet.style.clipPath = "";
    });
    ui.dataset.phase = phase;
    readColors();
    setup(false);
    scrollToPending(false);
    readView();
    updateNav();
    if (how === "down") {
      if (phase === "bottom") {
        toast(`最下層「${L[k].name}」に到達！`);
      } else {
        gridFlash = 1; // 画面がブロックでできていることを一瞬見せる
        toast(`地下${k}層「${L[k].name}」に到達。この画面も掘れます`);
      }
    } else if (how === "up") {
      playFill(L[k].layer);
      toast(k === 0 ? "地表から掘り直せます" : `「${L[k].name}」の層まで埋め戻しました`);
    } else if (how === "fill") {
      playFill(L[k].layer);
    }
    kick();
  }

  // 層 k へ移動する（ヘッダーのナビ・ページ内リンク・キーボード操作から）
  function jumpTo(k, x, y) {
    if (!strata) return;
    k = Math.max(0, Math.min(LAST, k));
    if (k === cur) return;
    markStarted();
    if (k > cur) {
      if (phase === "active") {
        target = k;
        collapse(x == null ? SW / 2 : x, y == null ? viewY + H / 2 : y);
      } else if (phase === "clearing") {
        target = Math.max(target, k);
      }
      // 間の層は飛ばして、崩れている穴から行き先の層が見えるようにする
      for (let i = cur + 1; i < target; i++) L[i].layer.classList.add("is-dug");
      return;
    }
    enter(k, "up");
  }

  // セクションの id（#team など）で移動する。同じ層の中なら、その位置までスクロールする
  const indexOfId = (id) => (id ? L.findIndex((ly) => ly.ids.includes(id)) : -1);
  function goToId(id) {
    const k = indexOfId(id);
    if (k < 0) return false;
    pendingId = id;
    if (k === cur) scrollToPending(true);
    else jumpTo(k);
    return true;
  }
  function scrollToPending(smooth) {
    const id = pendingId;
    pendingId = "";
    const ly = L[cur];
    const sec = id && document.getElementById(id);
    if (!sec || !ly.sheet.contains(sec)) return;
    ly.layer.scrollTo({ top: sec === ly.secs[0] ? 0 : sec.offsetTop, behavior: smooth ? "smooth" : "auto" });
  }

  function restart() {
    points = 0;
    lv = 0;
    for (const ly of L) ly.layer.scrollTop = 0;
    enter(0, "up");
  }

  function playFill(el) {
    el.classList.remove("is-filling");
    void el.offsetWidth; // アニメーションを最初から再生させる
    el.classList.add("is-filling");
  }

  let toastTimer = 0;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("is-on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("is-on"), 2800);
  }

  function levelUp() {
    addText(lastX, lastY - viewY - 26, `Lv.${lv + 1}！ 範囲アップ`, true);
    chime(660, 0, 0.1);
    chime(880, 0.08, 0.1);
    chime(1320, 0.16, 0.1);
    hud.classList.remove("is-flash");
    void hud.offsetWidth;
    hud.classList.add("is-flash");
  }

  const setText = (el, str) => { if (el.textContent !== str) el.textContent = str; };
  function updateHud() {
    setText(depthNoEl, cur === 0 ? "地表" : cur === LAST ? "最下層" : `地下${cur}層`);
    setText(depthNameEl, cur === 0 ? "" : L[cur].name);
    setText(lvEl, `Lv.${lv + 1}`);
    setText(ptEl, points.toLocaleString("ja-JP"));
    const prog = phase === "active" && clearNeed ? Math.min(1, (total - remain) / clearNeed) : 1;
    gaugeEl.style.width = prog * 100 + "%";
  }

  // ヘッダーのナビで、いま読んでいるセクションに印をつける
  function updateNav() {
    let id = "";
    if (strata) {
      const ly = L[cur];
      for (const sec of ly.secs) if (!id || sec.offsetTop - viewY <= H * 0.4) id = sec.id;
    }
    for (const a of navLinks) {
      if (id && a.getAttribute("href") === "#" + id) a.setAttribute("aria-current", "location");
      else a.removeAttribute("aria-current");
    }
  }

  // 1フレームで壊した量に応じて音を重ね、レベルと崩落を判定する
  function flush() {
    if (!tally.n) return;
    const count = Math.min(3, Math.ceil(tally.n / 12));
    const kind = tally.glass * 2 > tally.n ? 2 : tally.hard * 2 > tally.n ? 1 : 0;
    for (let k = 0; k < count; k++) crunch(kind);
    if (tally.ore) chime(1700 + Math.random() * 700, 0, 0.06);
    tally.n = tally.hard = tally.glass = tally.ore = 0;
    if (phase === "active") {
      while (lv < LEVELS.length - 1 && points >= LEVELS[lv + 1].pt) {
        lv++;
        levelUp();
      }
      if (total - remain >= clearNeed) collapse(lastX, lastY);
    }
    updateHud();
  }

  /* ---------- 毎フレームの処理 ---------- */
  let raf = 0, last = 0, hover = null, down = null;

  function kick() {
    if (!raf) {
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }
  }

  function frame(now) {
    raf = 0;
    if (!strata) return;
    const dt = Math.min(3, (now - last) / 16.667);
    last = now;
    readView();
    if (queue.length) {
      let keep = 0;
      for (let k = 0; k < queue.length; k++) {
        const q = queue[k];
        if (q.at <= now) breakCell(q.i, q.fx);
        else queue[keep++] = q;
      }
      queue.length = keep;
    }
    flush();
    if (clipDirty) applyClip();
    if (phase === "clearing" && !queue.length) enter(target, "down");
    drawFx(dt);
    if (queue.length || parts.length || texts.length || rings.length || gridFlash > 0) kick();
  }

  function drawFx(dt) {
    fctx.clearRect(0, 0, W, H);

    // 層に着いた直後、画面がブロックでできていることを網目で一瞬見せる
    if (gridFlash > 0) {
      gridFlash = Math.max(0, gridFlash - dt / 40);
      fctx.globalAlpha = gridFlash;
      fctx.strokeStyle = gridCol;
      fctx.lineWidth = 1;
      fctx.beginPath();
      for (let x = s; x < SW; x += s) { fctx.moveTo(Math.round(x) + 0.5, 0); fctx.lineTo(Math.round(x) + 0.5, H); }
      for (let y = s - (viewY % s); y < H; y += s) { fctx.moveTo(0, Math.round(y) + 0.5); fctx.lineTo(SW, Math.round(y) + 0.5); }
      fctx.stroke();
    }

    let keep = 0;
    for (let k = 0; k < parts.length; k++) {
      const p = parts[k];
      p.vy += 0.28 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt;
      if (p.life <= 0 || p.y > H + 10) continue;
      fctx.globalAlpha = Math.min(1, p.life / 12);
      fctx.fillStyle = p.col;
      fctx.fillRect(p.x - p.s / 2, p.y - p.s / 2, p.s, p.s);
      parts[keep++] = p;
    }
    parts.length = keep;

    keep = 0;
    for (let k = 0; k < rings.length; k++) {
      const g = rings[k];
      g.life -= dt;
      if (g.life <= 0) continue;
      const f = 1 - g.life / 18;
      fctx.globalAlpha = (g.life / 18) * 0.7;
      fctx.strokeStyle = ringCol;
      fctx.lineWidth = 2;
      fctx.beginPath();
      fctx.arc(g.x, g.y, g.R * (0.35 + 0.65 * f), 0, Math.PI * 2);
      fctx.stroke();
      rings[keep++] = g;
    }
    rings.length = keep;

    keep = 0;
    fctx.textAlign = "center";
    fctx.lineJoin = "round";
    for (let k = 0; k < texts.length; k++) {
      const t = texts[k];
      t.life -= dt;
      t.y -= (t.big ? 0.35 : 0.6) * dt;
      if (t.life <= 0) continue;
      fctx.globalAlpha = Math.min(1, t.life / 15);
      fctx.font = t.big ? "900 18px 'Noto Sans JP', sans-serif" : "700 13px 'M PLUS 1 Code', monospace";
      fctx.lineWidth = 4;
      fctx.strokeStyle = "rgba(20,24,33,.85)";
      fctx.strokeText(t.s, t.x, t.y);
      fctx.fillStyle = t.big ? "#ffffff" : "#ffd08a";
      fctx.fillText(t.s, t.x, t.y);
      texts[keep++] = t;
    }
    texts.length = keep;
    fctx.globalAlpha = 1;

    // マウスのときだけ、クリックで掘れる範囲を点線で見せる
    if (hover && !down && phase === "active") {
      const R = LEVELS[lv].area * s;
      fctx.setLineDash([4, 4]);
      fctx.lineWidth = 3;
      fctx.strokeStyle = "rgba(0,0,0,.3)";
      fctx.beginPath();
      fctx.arc(hover.x, hover.y, R, 0, Math.PI * 2);
      fctx.stroke();
      fctx.lineWidth = 1.5;
      fctx.strokeStyle = "rgba(255,255,255,.85)";
      fctx.stroke();
      fctx.setLineDash([]);
    }
  }

  /* ---------- 操作 ---------- */
  // ここに当たったときは掘らずに、リンクやボタンとして普通に動かす
  const INTERACTIVE = "a[href], button, input, select, textarea, summary, label, [tabindex], .dig-hint, .dig-hud";

  function stagePos(e) {
    const r = main.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  function sheetPos(e) {
    const r = L[cur].sheet.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  // 横スクロールする部品（コード表示など）のスクロールバーをつかんだときは掘らない
  function onScrollbar(e) {
    const t = e.target;
    if (!(t instanceof Element) || !t.clientWidth) return false;
    if (t.scrollHeight <= t.clientHeight && t.scrollWidth <= t.clientWidth) return false;
    const r = t.getBoundingClientRect();
    return e.clientX - r.left - t.clientLeft >= t.clientWidth || e.clientY - r.top - t.clientTop >= t.clientHeight;
  }
  const canDig = (e) =>
    strata && phase === "active" && e.target instanceof Element && !e.target.closest(INTERACTIVE) && !onScrollbar(e);

  let lastPointer = -1e9;
  document.addEventListener("pointerdown", () => { lastPointer = performance.now(); }, true);

  main.addEventListener("pointerdown", (e) => {
    if (!canDig(e) || (e.pointerType === "mouse" && e.button !== 0)) return;
    initAudio();
    readView();
    const p = sheetPos(e);
    down = { id: e.pointerId, x: p.x, y: p.y, lx: p.x, ly: p.y, moved: false };
    // マウスと、地表をなぞる指は、ドラッグで掘る（文字の選択やスクロールにしない）
    if (e.pointerType === "mouse" || cur === 0) {
      e.preventDefault();
      try { main.setPointerCapture(e.pointerId); } catch (_) { /* 無視 */ }
    }
    kick();
  });

  main.addEventListener("pointermove", (e) => {
    if (!strata) return;
    if (down && e.pointerId === down.id) {
      readView();
      const p = sheetPos(e);
      if (!down.moved && Math.hypot(p.x - down.x, p.y - down.y) > 6) down.moved = true;
      if (down.moved) {
        lineDig(down.lx, down.ly, p.x, p.y);
        down.lx = p.x;
        down.ly = p.y;
      }
    }
    if (e.pointerType === "mouse") hover = down || canDig(e) ? stagePos(e) : null;
    kick();
  });

  main.addEventListener("pointerup", (e) => {
    if (!down || e.pointerId !== down.id) return;
    const d = down;
    down = null;
    if (d.moved || phase !== "active") return;
    readView();
    const p = sheetPos(e);
    areaDig(p.x, p.y);
  });

  main.addEventListener("pointercancel", () => { down = null; }); // スクロールが始まったら掘らない
  main.addEventListener("pointerleave", () => { hover = null; kick(); });
  main.addEventListener("dragstart", (e) => { if (strata && phase === "active") e.preventDefault(); });

  // いまの層をスクロールしたら、ナビの印を合わせる
  for (const ly of L) {
    ly.layer.addEventListener("scroll", () => {
      if (!strata || ly !== L[cur]) return;
      readView();
      updateNav();
      kick();
    }, { passive: true });
  }

  ui.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const act = btn.dataset.act;
    const fromHint = !!btn.closest(".dig-hint");
    if (act === "clear") {
      initAudio();
      readView();
      collapse(SW / 2, viewY + H / 2);
      if (fromHint) hudClearBtn.focus({ preventScroll: true });
    } else if (act === "sound") {
      setSound(!soundOn);
    } else if (act === "restart") {
      restart();
      hudClearBtn.focus({ preventScroll: true });
    } else if (act === "flat") {
      setMode(true, true);
      modeBtn.focus({ preventScroll: true });
    }
  });

  modeBtn.addEventListener("click", () => {
    startStrata(0);
    (ui.classList.contains("is-started") ? hudClearBtn : hintClearBtn).focus({ preventScroll: true });
  });

  // ヘッダーのナビや「就職作品を見る」などのページ内リンクは、その層まで掘り進める
  document.addEventListener("click", (e) => {
    if (!strata || !(e.target instanceof Element)) return;
    const a = e.target.closest('a[href^="#"]');
    if (!a) return;
    if (goToId(decodeURIComponent(a.getAttribute("href").slice(1)))) e.preventDefault();
  });

  // アドレスバーで #team などに変えたときも、その層へ移る
  window.addEventListener("hashchange", () => {
    if (strata) goToId(decodeURIComponent(location.hash.slice(1)));
  });

  // キーボードで別の層のリンクに移ったら、その層まで掘る（上の層なら埋め戻す）
  document.addEventListener("focusin", (e) => {
    if (!strata || performance.now() - lastPointer < 500) return;
    const k = L.findIndex((ly, i) => i > 0 && ly.sheet.contains(e.target));
    if (k < 1 || k === cur) return;
    readView();
    const r = e.target.getBoundingClientRect(), m = main.getBoundingClientRect();
    jumpTo(k, r.left - m.left + r.width / 2, r.top - m.top + r.height / 2 + viewY);
  });

  /* ---------- モードの切り替え ---------- */
  function measureHeader() {
    root.style.setProperty("--dig-top", header.offsetHeight + "px");
  }

  function setMode(flat, save) {
    if (save) {
      try {
        if (flat) localStorage.setItem(MODE_KEY, "flat");
        else localStorage.removeItem(MODE_KEY);
      } catch (_) { /* 無視 */ }
    }
    // 普通に読むモードでは、読んでいたセクションの位置からページを表示する
    let readingId = "";
    if (flat && strata) {
      const cur0 = navLinks.find((a) => a.hasAttribute("aria-current"));
      readingId = cur0 ? cur0.getAttribute("href").slice(1) : "";
    }
    strata = !flat;
    root.classList.toggle("dig-strata", strata);
    root.classList.toggle("dig-flat", flat);
    queue.length = parts.length = texts.length = rings.length = 0;
    down = hover = null;
    gridFlash = 0;
    L.forEach((ly, i) => {
      ly.layer.classList.remove("is-dug", "is-filling");
      ly.sheet.classList.remove("is-diggable");
      ly.sheet.style.clipPath = "";
      ly.layer.style.zIndex = strata ? String(10 + L.length - i) : "";
      if (strata) ly.layer.scrollTop = 0;
    });
    updateNav();
    const behavior = root.style.scrollBehavior;
    root.style.scrollBehavior = "auto";
    const sec = readingId && readingId !== "top" && document.getElementById(readingId);
    if (sec) sec.scrollIntoView({ block: "start" });
    else window.scrollTo(0, 0);
    root.style.scrollBehavior = behavior;
    if (strata) measureHeader();
  }

  function startStrata(k) {
    setMode(false, true);
    if (k > 0) markStarted();
    enter(k, k === 0 ? "fill" : "init");
  }

  /* ---------- 開始 ---------- */
  showSound();
  let preferFlat = false;
  try { preferFlat = localStorage.getItem(MODE_KEY) === "flat"; } catch (_) { /* 無視 */ }
  if (preferFlat) {
    setMode(true, false);
  } else {
    // URL に #team などが付いていたら、その層から始める
    const id = decodeURIComponent(location.hash.slice(1));
    const k = indexOfId(id);
    if (k > 0) pendingId = id;
    startStrata(k > 0 ? k : 0);
  }
  lastX = SW / 2;
  lastY = H / 2;

  // 画面サイズ・ヘッダーの高さ・層の中身の高さ（画像の読み込みなど）が変わったら作り直す（掘った跡は残す）
  let resizeTimer = 0;
  const onResize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!strata || phase === "clearing") return;
      measureHeader();
      setup(true);
    }, 120);
  };
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(onResize);
    ro.observe(header);
    ro.observe(main);
    for (const ly of L) ro.observe(ly.sheet);
  }
  window.addEventListener("resize", onResize);
})();
