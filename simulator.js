'use strict';

// ─── Constants ───────────────────────────────────────────────
const WAVE_SPEED   = 300;   // м/мкс (скорость ЭМ волны по ВЛ)
const SVG_NS       = 'http://www.w3.org/2000/svg';
const LINE_Y       = 148;   // y главного провода
const SERVER_X     = 500;
const SERVER_Y     = 38;
const SVG_LEFT     = 80;
const SVG_RIGHT    = 920;
const TOTAL_KM     = 7.0;
const PX_PER_KM    = (SVG_RIGHT - SVG_LEFT) / TOTAL_KM; // 120 px/km

// Анимационная скорость волны: весь пролёт 840px за 3.5 с
const ANIM_VEL = (SVG_RIGHT - SVG_LEFT) / 3.5; // ≈ 240 px/s

// ─── Данные сети ──────────────────────────────────────────────
const NODES = [
    { id:'A', label:'ПС-1',  sub:'110/10 кВ', km:0.0, hasSensor:true,  isMain:true  },
    { id:'B', label:'ТП-1',  sub:'10/0.4 кВ', km:1.8, hasSensor:true,  isMain:false },
    { id:'C', label:'ТП-2',  sub:'10/0.4 кВ', km:4.2, hasSensor:false, isMain:false },
    { id:'D', label:'ТП-3',  sub:'10/0.4 кВ', km:5.8, hasSensor:true,  isMain:false },
    { id:'E', label:'ТП-4',  sub:'10/0.4 кВ', km:7.0, hasSensor:true,  isMain:false },
];

const SEGMENTS = [
    { id:0, from:0, to:1, km:1.8 },
    { id:1, from:1, to:2, km:2.4 },
    { id:2, from:2, to:3, km:1.6 },
    { id:3, from:3, to:4, km:1.2 },
];

const STEPS_TEXT = [
    'Нажмите на воздушную линию',
    'Авария! КЗ на ВЛ 10 кВ',
    'Генерация ЭМ импульса',
    'Распространение бегущей волны',
    'Регистрация датчиками СКАТ-ВОМП',
    'Передача осциллограмм на сервер',
    'Расчёт расстояния до повреждения',
    'Место повреждения определено ✓',
];

// ─── Состояние ───────────────────────────────────────────────
let S = {
    phase:        'idle',
    faultSegId:   null,
    faultKm:      null,
    faultX:       null,
    animStart:    null,
    leftNodeIdx:  null,   // индекс ближайшего датчика слева
    rightNodeIdx: null,   // индекс ближайшего датчика справа
    detected:     {},     // nodeId → время μs
    raf:          null,
    stepIdx:      0,
    timers:       [],     // все setTimeout id для отмены при сбросе
};

function later(fn, ms) {
    const id = setTimeout(() => {
        S.timers = S.timers.filter(x => x !== id);
        if (S.phase !== 'idle') fn();
    }, ms);
    S.timers.push(id);
    return id;
}

// ─── DOM ──────────────────────────────────────────────────────
const svg       = document.getElementById('network-svg');
const hintEl    = document.getElementById('diagram-hint');
const stepsEl   = document.getElementById('steps-list');
const sensorsEl = document.getElementById('sensors-list');
const calcPanel = document.getElementById('calc-panel');
const calcEl    = document.getElementById('calc-content');
const btnReset  = document.getElementById('btn-reset');
const btnDemo   = document.getElementById('btn-demo');

// ─── SVG-хелперы ─────────────────────────────────────────────
function mkEl(tag, attrs) {
    const e = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    return e;
}
function mkTxt(str, attrs) {
    const e = mkEl('text', attrs);
    e.textContent = str;
    return e;
}
function kmToX(km) { return SVG_LEFT + km * PX_PER_KM; }

function clientToSVG(evt) {
    const pt = svg.createSVGPoint();
    pt.x = evt.clientX; pt.y = evt.clientY;
    return pt.matrixTransform(svg.getScreenCTM().inverse());
}

// ─── Построение SVG ──────────────────────────────────────────
function buildSVG() {
    svg.innerHTML = '';
    buildDefs();
    buildServer();
    buildSegmentLines();
    buildTowers();
    buildNodes();
    // Слои поверх (волна, авария, пакеты, результат)
    ['trail-g','wave-g','fault-g','packet-g','result-g'].forEach(id => {
        svg.appendChild(mkEl('g', {id}));
    });
}

function buildDefs() {
    const defs = mkEl('defs', {});

    // Фильтр свечения для волны
    const fw = mkEl('filter', {id:'fw', x:'-80%', y:'-80%', width:'260%', height:'260%'});
    fw.appendChild(mkEl('feGaussianBlur', {in:'SourceGraphic', stdDeviation:'5', result:'b'}));
    const m1 = mkEl('feMerge', {});
    [mkEl('feMergeNode',{in:'b'}), mkEl('feMergeNode',{in:'SourceGraphic'})].forEach(n=>m1.appendChild(n));
    fw.appendChild(m1);
    defs.appendChild(fw);

    // Фильтр свечения для датчика
    const fs = mkEl('filter', {id:'fs', x:'-100%', y:'-100%', width:'300%', height:'300%'});
    fs.appendChild(mkEl('feGaussianBlur', {in:'SourceGraphic', stdDeviation:'4', result:'b'}));
    const m2 = mkEl('feMerge', {});
    [mkEl('feMergeNode',{in:'b'}), mkEl('feMergeNode',{in:'SourceGraphic'})].forEach(n=>m2.appendChild(n));
    fs.appendChild(m2);
    defs.appendChild(fs);

    // Радиальный градиент волны (оранжевый пульс)
    const rg = mkEl('radialGradient', {id:'wave-grad'});
    [['0%','#ffffff','1'],['35%','#fbbf24','0.9'],['100%','#f97316','0']].forEach(([o,c,op]) => {
        const s = mkEl('stop', {offset:o, 'stop-color':c, 'stop-opacity':op});
        rg.appendChild(s);
    });
    defs.appendChild(rg);

    svg.appendChild(defs);
}

function buildServer() {
    const g = mkEl('g', {id:'server-icon'});
    g.appendChild(mkEl('rect', {
        x: SERVER_X-42, y: SERVER_Y-16, width:84, height:30, rx:5,
        fill:'#0a1f35', stroke:'#38bdf8', 'stroke-width':'1.5'
    }));
    const t1 = mkTxt('СЕРВЕР ОМП', {
        'text-anchor':'middle', x:SERVER_X, y:SERVER_Y-3,
        fill:'#38bdf8', 'font-size':'10', 'font-weight':'700',
        'letter-spacing':'1', 'font-family':'Segoe UI,system-ui,sans-serif'
    });
    const t2 = mkTxt('обработка данных', {
        'text-anchor':'middle', x:SERVER_X, y:SERVER_Y+9,
        fill:'#475569', 'font-size':'8', 'font-family':'Segoe UI,system-ui,sans-serif'
    });
    g.appendChild(t1); g.appendChild(t2);

    // Антенна
    g.appendChild(mkEl('line', {x1:SERVER_X, y1:SERVER_Y-16, x2:SERVER_X, y2:SERVER_Y-28,
        stroke:'#38bdf8', 'stroke-width':'1.5'}));
    g.appendChild(mkEl('circle', {cx:SERVER_X, cy:SERVER_Y-31, r:'3', fill:'#38bdf8'}));

    svg.appendChild(g);
}

function buildSegmentLines() {
    const g = mkEl('g', {id:'seg-group'});

    SEGMENTS.forEach(seg => {
        const x1 = kmToX(NODES[seg.from].km);
        const x2 = kmToX(NODES[seg.to].km);
        const mx = (x1 + x2) / 2;

        // Фоновое свечение линии
        g.appendChild(mkEl('line', {
            x1, y1:LINE_Y, x2, y2:LINE_Y,
            stroke:'rgba(59,130,246,0.12)', 'stroke-width':'14'
        }));

        // Провод
        g.appendChild(mkEl('line', {
            id:`seg-${seg.id}`,
            x1, y1:LINE_Y, x2, y2:LINE_Y,
            stroke:'#3b82f6', 'stroke-width':'2.5', 'stroke-linecap':'round'
        }));

        // Метка длины
        g.appendChild(mkTxt(`${seg.km} км`, {
            'text-anchor':'middle', x:mx, y:LINE_Y-20,
            fill:'#475569', 'font-size':'10', 'font-family':'Segoe UI,system-ui,sans-serif'
        }));

        // Кликабельная область (широкая прозрачная полоса)
        const hit = mkEl('line', {
            x1, y1:LINE_Y, x2, y2:LINE_Y,
            stroke:'transparent', 'stroke-width':'24', cursor:'pointer'
        });
        hit.addEventListener('click', e => handleSegClick(e, seg.id));
        hit.addEventListener('mouseenter', () => {
            if (S.phase === 'idle')
                document.getElementById(`seg-${seg.id}`).setAttribute('stroke','#60a5fa');
        });
        hit.addEventListener('mouseleave', () => {
            if (S.phase === 'idle')
                document.getElementById(`seg-${seg.id}`).setAttribute('stroke','#3b82f6');
        });
        g.appendChild(hit);
    });

    svg.appendChild(g);
}

function buildTowers() {
    const g = mkEl('g', {id:'tower-group'});
    SEGMENTS.forEach(seg => {
        const x1 = kmToX(NODES[seg.from].km);
        const x2 = kmToX(NODES[seg.to].km);
        const span = x2 - x1;
        const n = Math.max(1, Math.round(span / 90));
        for (let i = 1; i <= n; i++) {
            drawTower(g, x1 + span * i / (n + 1));
        }
    });
    svg.appendChild(g);
}

function drawTower(parent, cx) {
    cx = Math.round(cx);
    // Стойка
    parent.appendChild(mkEl('line', {
        x1:cx, y1:LINE_Y, x2:cx, y2:LINE_Y-30,
        stroke:'#2d3f52', 'stroke-width':'2', 'stroke-linecap':'round'
    }));
    // Траверса (поперечина)
    parent.appendChild(mkEl('line', {
        x1:cx-16, y1:LINE_Y-24, x2:cx+16, y2:LINE_Y-24,
        stroke:'#2d3f52', 'stroke-width':'2', 'stroke-linecap':'round'
    }));
    // Изоляторные гирлянды
    [cx-14, cx+14].forEach(ix => {
        parent.appendChild(mkEl('line', {
            x1:ix, y1:LINE_Y-24, x2:ix, y2:LINE_Y,
            stroke:'#3d5166', 'stroke-width':'1.5', 'stroke-dasharray':'2 2'
        }));
    });
}

function buildNodes() {
    const g = mkEl('g', {id:'nodes-group'});

    NODES.forEach((node) => {
        const x  = kmToX(node.km);
        const bw = node.isMain ? 70 : 56;
        const bh = node.isMain ? 66 : 56;
        const by = LINE_Y + 20;
        const ng = mkEl('g', {id:`node-${node.id}`});

        // Соединение с проводом (вертикальная шина)
        ng.appendChild(mkEl('line', {
            x1:x, y1:LINE_Y, x2:x, y2:by,
            stroke:'#3b82f6', 'stroke-width':'2'
        }));

        // Разъединитель (символ)
        ng.appendChild(mkEl('rect', {
            x:x-4, y:LINE_Y+6, width:8, height:4,
            fill:'#0f2033', stroke:'#3b82f6', 'stroke-width':'1.5', rx:'1'
        }));

        // Бейдж СКАТ-ВОМП (только у датчиков, над корпусом)
        if (node.hasSensor) {
            const bgY = by - 14;
            ng.appendChild(mkEl('rect', {
                id:`sbg-${node.id}`,
                x:x-bw/2, y:bgY, width:bw, height:14,
                fill:'#071a0e', stroke:'#1a4a2e', 'stroke-width':'1', rx:'2 2 0 0'
            }));
            const sl = mkTxt('СКАТ-ВОМП', {
                id:`slbl-${node.id}`,
                'text-anchor':'middle', x, y:bgY+10,
                fill:'#1e6b35', 'font-size':'7.5', 'font-weight':'700',
                'letter-spacing':'0.5', 'font-family':'Segoe UI,system-ui,sans-serif'
            });
            ng.appendChild(sl);
        }

        // Корпус подстанции
        ng.appendChild(mkEl('rect', {
            x:x-bw/2, y:by, width:bw, height:bh,
            rx:'4', fill:'#08192a', stroke:'#1e3a5f', 'stroke-width':'1.5'
        }));

        // Символ трансформатора (две окружности)
        const ty = by + bh/2 - 4;
        ng.appendChild(mkEl('circle', {cx:x, cy:ty-7, r:'9',  fill:'none', stroke:'#2563eb', 'stroke-width':'1.5'}));
        ng.appendChild(mkEl('circle', {cx:x, cy:ty+7, r:'9',  fill:'none', stroke:'#2563eb', 'stroke-width':'1.5'}));

        // Название подстанции
        ng.appendChild(mkTxt(node.label, {
            'text-anchor':'middle', x, y:by+bh+13,
            fill:'#cbd5e1', 'font-size':'11', 'font-weight':'700',
            'font-family':'Segoe UI,system-ui,sans-serif'
        }));

        // Класс напряжения
        ng.appendChild(mkTxt(node.sub, {
            'text-anchor':'middle', x, y:by+bh+24,
            fill:'#4a5568', 'font-size':'8.5', 'font-family':'Segoe UI,system-ui,sans-serif'
        }));

        // Километровая метка
        ng.appendChild(mkTxt(`${node.km.toFixed(1)} км`, {
            'text-anchor':'middle', x, y:by+bh+35,
            fill:'#334155', 'font-size':'8', 'font-family':'Segoe UI,system-ui,sans-serif'
        }));

        g.appendChild(ng);
    });

    svg.appendChild(g);
}

// ─── UI-панели ────────────────────────────────────────────────
function buildStepsUI() {
    stepsEl.innerHTML = '';
    STEPS_TEXT.forEach((text, i) => {
        const div = document.createElement('div');
        div.className = 'step-item' + (i === 0 ? ' active' : '');
        div.id = `step-${i}`;
        div.innerHTML = `<div class="step-num">${i === 0 ? '→' : i}</div>
                         <div class="step-text">${text}</div>`;
        stepsEl.appendChild(div);
    });
}

function buildSensorsUI() {
    sensorsEl.innerHTML = '';
    NODES.filter(n => n.hasSensor).forEach(node => {
        const div = document.createElement('div');
        div.className = 'sensor-card';
        div.id = `sc-${node.id}`;
        div.innerHTML = `
          <div class="sensor-hdr">
            <div class="sensor-dot" id="sd-${node.id}"></div>
            <div>
              <div class="sensor-name">Датчик ${node.id} <span style="color:#64748b">· ${node.label}</span></div>
              <div class="sensor-loc">${node.km.toFixed(1)} км от ПС-1</div>
            </div>
          </div>
          <div class="sensor-time" id="st-${node.id}">— ожидание сигнала —</div>`;
        sensorsEl.appendChild(div);
    });
}

function setStep(idx) {
    S.stepIdx = idx;
    STEPS_TEXT.forEach((_, i) => {
        const el = document.getElementById(`step-${i}`);
        if (!el) return;
        el.className = 'step-item' + (i < idx ? ' done' : i === idx ? ' active' : '');
        if (i < idx) el.querySelector('.step-num').textContent = '✓';
        else if (i > 0) el.querySelector('.step-num').textContent = i;
        else el.querySelector('.step-num').textContent = '→';
    });
}

function triggerSensorUI(nodeId, timeUs) {
    const card = document.getElementById(`sc-${nodeId}`);
    const timeEl = document.getElementById(`st-${nodeId}`);
    if (card)  card.classList.add('triggered');
    if (timeEl) {
        timeEl.className = 'sensor-time registered';
        timeEl.textContent = `Сигнал: t = ${timeUs.toFixed(2)} мкс`;
    }
    // SVG: датчик зажигается зелёным
    const sbg  = document.getElementById(`sbg-${nodeId}`);
    const slbl = document.getElementById(`slbl-${nodeId}`);
    if (sbg)  { sbg.setAttribute('fill','#0b3320'); sbg.setAttribute('stroke','#00ff9d'); }
    if (slbl) { slbl.setAttribute('fill','#00ff9d'); }

    // Вспышка-кольцо на SVG
    const nodeKm = NODES.find(n => n.id === nodeId).km;
    const nx = kmToX(nodeKm);
    const ring = mkEl('circle', {
        cx:nx, cy:LINE_Y, r:'10', fill:'none',
        stroke:'#00ff9d', 'stroke-width':'2', opacity:'0.9'
    });
    document.getElementById('wave-g').appendChild(ring);
    animateRing(ring);
}

function animateRing(circle) {
    let r = 10, op = 0.9;
    const tick = () => {
        r += 0.9; op -= 0.03;
        circle.setAttribute('r', r);
        circle.setAttribute('opacity', Math.max(0, op));
        if (op > 0) requestAnimationFrame(tick);
        else circle.remove();
    };
    requestAnimationFrame(tick);
}

function markFaultSegment(segId, faultX) {
    const seg = SEGMENTS[segId];
    const x1  = kmToX(NODES[seg.from].km);
    const x2  = kmToX(NODES[seg.to].km);

    // Окрашиваем часть линии (левый участок до аварии, правый — после)
    const segEl = document.getElementById(`seg-${segId}`);
    if (segEl) segEl.setAttribute('stroke','#ef4444');

    // Молния-маркер аварии
    const fg = document.getElementById('fault-g');
    fg.innerHTML = '';

    // Пульсирующее кольцо
    const pulse = mkEl('circle', {
        id:'fault-pulse', cx:faultX, cy:LINE_Y, r:'10',
        fill:'none', stroke:'#ef4444', 'stroke-width':'2', opacity:'0.7'
    });
    fg.appendChild(pulse);
    animateFaultPulse(pulse);

    // Молния (символ ⚡)
    const lightningPath =
        `M ${faultX+1},${LINE_Y-16} L ${faultX-5},${LINE_Y-2} L ${faultX+1},${LINE_Y-2} L ${faultX-2},${LINE_Y+12} L ${faultX+7},${LINE_Y-2} L ${faultX+2},${LINE_Y-2} Z`;
    fg.appendChild(mkEl('path', {
        d: lightningPath,
        fill:'#fca5a5', stroke:'#ef4444', 'stroke-width':'1'
    }));

    // Текст «КЗ»
    fg.appendChild(mkTxt('КЗ', {
        'text-anchor':'middle', x:faultX, y:LINE_Y+24,
        fill:'#ef4444', 'font-size':'9', 'font-weight':'700',
        'font-family':'Segoe UI,system-ui,sans-serif'
    }));
}

function animateFaultPulse(circle) {
    let r = 10, op = 0.7, growing = true;
    const tick = () => {
        if (growing) { r += 0.4; if (r >= 22) growing = false; }
        else { r -= 0.4; if (r <= 10) growing = true; }
        op = 0.3 + 0.4 * (r - 10) / 12;
        circle.setAttribute('r', r);
        circle.setAttribute('opacity', op);
        if (S.phase !== 'idle') requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
}

// ─── Обработчик клика на линию ────────────────────────────────
function handleSegClick(evt, segId) {
    if (S.phase !== 'idle') return;

    const pt = clientToSVG(evt);
    const seg = SEGMENTS[segId];
    const x1  = kmToX(NODES[seg.from].km);
    const x2  = kmToX(NODES[seg.to].km);

    // Ограничиваем точку аварии внутри сегмента (с отступом 15px)
    const faultX = Math.max(x1 + 15, Math.min(x2 - 15, pt.x));
    const faultKm = (faultX - SVG_LEFT) / PX_PER_KM;

    startSimulation(segId, faultX, faultKm);
}

// ─── Запуск симуляции ─────────────────────────────────────────
function startSimulation(segId, faultX, faultKm) {
    S.phase      = 'fault';
    S.faultSegId = segId;
    S.faultX     = faultX;
    S.faultKm    = faultKm;
    S.detected   = {};
    S.animStart  = null;

    // Найти ближайшие датчики с каждой стороны
    S.leftNodeIdx  = null;
    S.rightNodeIdx = null;
    NODES.forEach((node, i) => {
        if (!node.hasSensor) return;
        if (node.km <= faultKm && (S.leftNodeIdx === null || node.km > NODES[S.leftNodeIdx].km)) S.leftNodeIdx = i;
        if (node.km >= faultKm && (S.rightNodeIdx === null || node.km < NODES[S.rightNodeIdx].km)) S.rightNodeIdx = i;
    });

    hintEl.classList.add('hidden');
    btnDemo.disabled = true;
    setStep(1);

    markFaultSegment(segId, faultX);

    // Шаг 2 через 0.8 с
    later(() => {
        setStep(2);
        // Шаг 3 — волна через 0.8 с
        later(() => {
            setStep(3);
            S.phase = 'wave';
            S.animStart = performance.now();
            createWaveElements();
            S.raf = requestAnimationFrame(animTick);
        }, 800);
    }, 600);
}

// ─── Создание SVG-элементов волны ────────────────────────────
function createWaveElements() {
    const wg = document.getElementById('wave-g');

    // Хвост (след) волны — две линии от точки аварии
    wg.appendChild(mkEl('line', {
        id:'trail-L',
        x1:S.faultX, y1:LINE_Y, x2:S.faultX, y2:LINE_Y,
        stroke:'#f97316', 'stroke-width':'4', opacity:'0.6', 'stroke-linecap':'round'
    }));
    wg.appendChild(mkEl('line', {
        id:'trail-R',
        x1:S.faultX, y1:LINE_Y, x2:S.faultX, y2:LINE_Y,
        stroke:'#f97316', 'stroke-width':'4', opacity:'0.6', 'stroke-linecap':'round'
    }));

    // Головная часть волны (левая)
    wg.appendChild(mkEl('circle', {
        id:'wave-L', cx:S.faultX, cy:LINE_Y, r:'12',
        fill:'url(#wave-grad)', filter:'url(#fw)'
    }));

    // Головная часть волны (правая)
    wg.appendChild(mkEl('circle', {
        id:'wave-R', cx:S.faultX, cy:LINE_Y, r:'12',
        fill:'url(#wave-grad)', filter:'url(#fw)'
    }));
}

// ─── Цикл анимации ────────────────────────────────────────────
function animTick(now) {
    if (S.phase !== 'wave') return;

    const elapsed = (now - S.animStart) / 1000; // секунды
    const leftX   = Math.max(SVG_LEFT,  S.faultX - ANIM_VEL * elapsed);
    const rightX  = Math.min(SVG_RIGHT, S.faultX + ANIM_VEL * elapsed);

    // Обновить позиции волн
    const wL = document.getElementById('wave-L');
    const wR = document.getElementById('wave-R');
    const tL = document.getElementById('trail-L');
    const tR = document.getElementById('trail-R');

    if (wL) wL.setAttribute('cx', leftX);
    if (wR) wR.setAttribute('cx', rightX);
    if (tL) { tL.setAttribute('x1', S.faultX); tL.setAttribute('x2', leftX); }
    if (tR) { tR.setAttribute('x1', S.faultX); tR.setAttribute('x2', rightX); }

    // Проверить срабатывание датчиков
    NODES.forEach((node, i) => {
        if (!node.hasSensor || S.detected[node.id]) return;
        const nx = kmToX(node.km);
        const isLeft  = node.km < S.faultKm - 0.01;
        const isRight = node.km > S.faultKm + 0.01;
        if ((isLeft && leftX <= nx + 2) || (isRight && rightX >= nx - 2)) {
            const distM = Math.abs(node.km - S.faultKm) * 1000;
            const timeUs = distM / WAVE_SPEED;
            S.detected[node.id] = timeUs;
            triggerSensorUI(node.id, timeUs);

            // Шаг 4 при первом срабатывании
            if (Object.keys(S.detected).length === 1) setStep(4);
        }
    });

    // Волны дошли до концов линии
    if (leftX <= SVG_LEFT + 1 && rightX >= SVG_RIGHT - 1) {
        stopAnim();
        later(startDataTransfer, 600);
        return;
    }

    S.raf = requestAnimationFrame(animTick);
}

function stopAnim() {
    if (S.raf) { cancelAnimationFrame(S.raf); S.raf = null; }
    // Убрать волны
    ['wave-L','wave-R','trail-L','trail-R'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.remove();
    });
}

// ─── Передача данных на сервер ────────────────────────────────
function startDataTransfer() {
    S.phase = 'transfer';
    setStep(5);

    // Для каждого сработавшего датчика — анимируем пакет к серверу
    const sensorIds = Object.keys(S.detected);
    let delay = 0;
    sensorIds.forEach(nid => {
        later(() => sendPacket(nid), delay);
        delay += 300;
    });

    later(showCalculation, delay + 1800);
}

function sendPacket(nodeId) {
    const node = NODES.find(n => n.id === nodeId);
    if (!node) return;
    const startX = kmToX(node.km);
    const startY = LINE_Y;
    const pg = document.getElementById('packet-g');

    const pkt = mkEl('circle', {
        cx:startX, cy:startY, r:'5',
        fill:'#a78bfa', opacity:'0.9', filter:'url(#fw)'
    });
    pg.appendChild(pkt);

    const totalFrames = 50;
    let frame = 0;
    const tick = () => {
        frame++;
        const t = frame / totalFrames;
        const ease = t < 0.5 ? 2*t*t : -1+(4-2*t)*t;
        const cx = startX + (SERVER_X - startX) * ease;
        const cy = startY + (SERVER_Y - startY) * ease;
        pkt.setAttribute('cx', cx);
        pkt.setAttribute('cy', cy);
        pkt.setAttribute('opacity', 1 - t * 0.3);
        if (frame < totalFrames) requestAnimationFrame(tick);
        else pkt.remove();
    };
    requestAnimationFrame(tick);
}

// ─── Расчёт ОМП и отображение ────────────────────────────────
function showCalculation() {
    S.phase = 'calc';
    setStep(6);
    calcPanel.style.display = 'block';
    calcPanel.classList.add('anim-fadein');

    const L  = NODES[S.leftNodeIdx];
    const R  = NODES[S.rightNodeIdx];
    const Lm  = (R.km - L.km) * 1000;          // расстояние между датчиками, м
    const tL  = S.detected[L.id] ?? 0;          // мкс
    const tR  = S.detected[R.id] ?? 0;          // мкс
    const dt  = tL - tR;                        // Δt мкс
    const xFromL = (Lm + WAVE_SPEED * dt) / 2; // м от левого датчика
    const resultKm = L.km + xFromL / 1000;      // км от ПС-1

    calcEl.innerHTML = `
      <div class="calc-box">
        <div class="calc-formula">x = (L + v · Δt) / 2</div>
        <div class="calc-row">
          <span class="calc-label">Датчики расчёта:</span>
          <span class="calc-val">${L.id} (${L.label}) ↔ ${R.id} (${R.label})</span>
        </div>
        <div class="calc-row">
          <span class="calc-label">L (расстояние):</span>
          <span class="calc-val">${Lm.toFixed(0)} м</span>
        </div>
        <div class="calc-row">
          <span class="calc-label">v (скорость волны):</span>
          <span class="calc-val">300 м/мкс</span>
        </div>
        <div class="calc-row">
          <span class="calc-label">t<sub>${L.id}</sub> (датчик ${L.id}):</span>
          <span class="calc-val">${tL.toFixed(2)} мкс</span>
        </div>
        <div class="calc-row">
          <span class="calc-label">t<sub>${R.id}</sub> (датчик ${R.id}):</span>
          <span class="calc-val">${tR.toFixed(2)} мкс</span>
        </div>
        <div class="calc-row">
          <span class="calc-label">Δt = t${L.id} − t${R.id}:</span>
          <span class="calc-val">${dt.toFixed(2)} мкс</span>
        </div>
      </div>
      <div class="calc-box">
        <div class="calc-steps">
          x = (${Lm.toFixed(0)} + 300 · ${dt.toFixed(2)}) / 2<br>
          x = (${Lm.toFixed(0)} + ${(300*dt).toFixed(0)}) / 2<br>
          x = ${((Lm + 300*dt)/2).toFixed(0)} / 2<br>
          <span class="hi">x = <b>${xFromL.toFixed(0)} м</b> от ${L.label}</span>
        </div>
      </div>`;

    later(() => showResult(resultKm, xFromL, L, R), 1600);
}

function showResult(resultKm, xFromL, L, R) {
    S.phase = 'result';
    setStep(7);

    // Дописать результат в панель
    const resDiv = document.createElement('div');
    resDiv.className = 'calc-result-box anim-fadein';
    resDiv.innerHTML = `
      <div class="calc-result-label">Место повреждения</div>
      <div class="calc-result-value">${resultKm.toFixed(3)} км от ПС-1</div>
      <div class="calc-result-sub">${xFromL.toFixed(0)} м от ${L.label} · погрешность ±150 м</div>`;
    calcEl.appendChild(resDiv);

    // Маркер результата на схеме
    const rx = kmToX(resultKm);
    const rg = document.getElementById('result-g');
    rg.innerHTML = '';

    // Скобка / стрелка к точке на линии
    rg.appendChild(mkEl('line', {
        x1:rx, y1:LINE_Y-40, x2:rx, y2:LINE_Y-18,
        stroke:'#00d4aa', 'stroke-width':'2', 'marker-end':'none', 'stroke-dasharray':'3 2'
    }));
    rg.appendChild(mkEl('polygon', {
        points:`${rx-4},${LINE_Y-18} ${rx+4},${LINE_Y-18} ${rx},${LINE_Y-6}`,
        fill:'#00d4aa'
    }));
    rg.appendChild(mkTxt(`${resultKm.toFixed(2)} км`, {
        'text-anchor':'middle', x:rx, y:LINE_Y-44,
        fill:'#00d4aa', 'font-size':'10', 'font-weight':'700',
        'font-family':'Segoe UI,system-ui,sans-serif'
    }));
    rg.appendChild(mkTxt('ОМП', {
        'text-anchor':'middle', x:rx, y:LINE_Y-55,
        fill:'#00d4aa', 'font-size':'8',
        'font-family':'Segoe UI,system-ui,sans-serif'
    }));

    // Диапазон погрешности на линии (±150 м)
    const errPx = 0.15 * PX_PER_KM; // 150м → пикселей
    rg.appendChild(mkEl('line', {
        x1:rx-errPx, y1:LINE_Y, x2:rx+errPx, y2:LINE_Y,
        stroke:'#00d4aa', 'stroke-width':'4', opacity:'0.4', 'stroke-linecap':'round'
    }));
}

// ─── Сброс ────────────────────────────────────────────────────
function reset() {
    if (S.raf) cancelAnimationFrame(S.raf);
    (S.timers || []).forEach(clearTimeout);

    S = {
        phase:'idle', faultSegId:null, faultKm:null, faultX:null,
        animStart:null, leftNodeIdx:null, rightNodeIdx:null,
        detected:{}, raf:null, stepIdx:0, timers:[]
    };

    // Восстановить цвет сегментов
    SEGMENTS.forEach(seg => {
        const el = document.getElementById(`seg-${seg.id}`);
        if (el) el.setAttribute('stroke','#3b82f6');
    });

    // Сбросить датчики SVG
    NODES.filter(n => n.hasSensor).forEach(node => {
        const sbg  = document.getElementById(`sbg-${node.id}`);
        const slbl = document.getElementById(`slbl-${node.id}`);
        if (sbg)  { sbg.setAttribute('fill','#071a0e'); sbg.setAttribute('stroke','#1a4a2e'); }
        if (slbl) { slbl.setAttribute('fill','#1e6b35'); }
    });

    // Очистить динамические слои
    ['trail-g','wave-g','fault-g','packet-g','result-g'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = '';
    });

    hintEl.classList.remove('hidden');
    calcPanel.style.display = 'none';
    calcEl.innerHTML = '';
    btnDemo.disabled = false;

    buildStepsUI();
    buildSensorsUI();
}

// ─── Авто-демо ────────────────────────────────────────────────
function runDemo() {
    if (S.phase !== 'idle') reset();
    // Авария на участке ТП-1 → ТП-2, в 40% от ТП-1
    const seg   = SEGMENTS[1];
    const x1    = kmToX(NODES[seg.from].km);
    const x2    = kmToX(NODES[seg.to].km);
    const faultX  = x1 + (x2 - x1) * 0.42;
    const faultKm = (faultX - SVG_LEFT) / PX_PER_KM;
    startSimulation(1, faultX, faultKm);
}

// ─── Инициализация ────────────────────────────────────────────
function init() {
    buildSVG();
    buildStepsUI();
    buildSensorsUI();
    btnReset.addEventListener('click', reset);
    btnDemo.addEventListener('click', runDemo);
}

init();
