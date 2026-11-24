// Informe "antes y después" del consumo de Cloudflare (solo lectura).
// Consulta la API GraphQL de Analytics y genera un HTML con gráficas y un resumen en Markdown.
// No despliega ni modifica nada.
//
// Uso en GitHub Actions: ver .github/workflows/informe-consumo-cloudflare.yml
// Prueba local sin llave: node .github/consumo/informe-consumo.mjs --datos ejemplo.json
import { writeFile, readFile, mkdir } from 'node:fs/promises';

const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID || '71fb53fce0685a83a5b15712414cfc25';
const TOKEN = process.env.CLOUDFLARE_API_TOKEN || '';
const DIAS = Math.min(Math.max(parseInt(process.env.DIAS || '30', 10) || 30, 3), 90);
const CAMBIO = /^\d{4}-\d{2}-\d{2}$/.test(process.env.FECHA_CAMBIO || '') ? process.env.FECHA_CAMBIO : '2026-11-24';
const SALIDA = process.env.SALIDA || 'informe-consumo';
const args = process.argv.slice(2);
const datosLocales = args.includes('--datos') ? args[args.indexOf('--datos') + 1] : null;

// Límites diarios del plan gratuito (se reinician a las 00:00 UTC).
const LIMITES = {
  rowsRead: 5_000_000,
  rowsWritten: 100_000,
  requests: 100_000,
};

const iso = (d) => d.toISOString().slice(0, 10);
function rangoFechas() {
  const hoy = new Date();
  const fin = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), hoy.getUTCDate() - 1)); // ayer (día completo)
  const fechas = [];
  for (let i = DIAS - 1; i >= 0; i--) fechas.push(iso(new Date(fin.getTime() - i * 86400000)));
  return fechas;
}

async function gql(query, variables) {
  const r = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const texto = await r.text();
  let json;
  try { json = JSON.parse(texto); } catch { throw new Error(`Respuesta no válida (${r.status}): ${texto.slice(0, 300)}`); }
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join(' | '));
  return json.data;
}

const Q_D1 = `query($a:String!,$d:Date!){viewer{accounts(filter:{accountTag:$a}){
  d1AnalyticsAdaptiveGroups(limit:1000,filter:{date:$d}){sum{rowsRead rowsWritten readQueries writeQueries}dimensions{databaseId}}
}}}`;
const Q_WORKERS = `query($a:String!,$d:Date!){viewer{accounts(filter:{accountTag:$a}){
  workersInvocationsAdaptive(limit:1000,filter:{date:$d}){sum{requests errors}dimensions{scriptName}}
}}}`;
const Q_TRAFICO = `query($a:String!,$d:Date!){viewer{accounts(filter:{accountTag:$a}){
  httpRequestsOverviewAdaptiveGroups(limit:10,filter:{date:$d}){sum{bytes requests}}
}}}`;

async function consultarDia(fecha, avisos) {
  const dia = { fecha, rowsRead: null, rowsWritten: null, readQueries: null, writeQueries: null, requests: null, errors: null, bytes: null };
  try {
    const d = await gql(Q_D1, { a: ACCOUNT, d: fecha });
    const filas = d.viewer.accounts[0]?.d1AnalyticsAdaptiveGroups || [];
    for (const k of ['rowsRead', 'rowsWritten', 'readQueries', 'writeQueries']) dia[k] = filas.reduce((s, f) => s + (f.sum[k] || 0), 0);
  } catch (e) { avisos.add(`D1 (${fecha}): ${e.message}`); }
  try {
    const d = await gql(Q_WORKERS, { a: ACCOUNT, d: fecha });
    const filas = d.viewer.accounts[0]?.workersInvocationsAdaptive || [];
    dia.requests = filas.reduce((s, f) => s + (f.sum.requests || 0), 0);
    dia.errors = filas.reduce((s, f) => s + (f.sum.errors || 0), 0);
  } catch (e) { avisos.add(`Peticiones a Functions (${fecha}): ${e.message}`); }
  try {
    const d = await gql(Q_TRAFICO, { a: ACCOUNT, d: fecha });
    const filas = d.viewer.accounts[0]?.httpRequestsOverviewAdaptiveGroups || [];
    const bytes = filas.reduce((s, f) => s + (f.sum.bytes || 0), 0);
    dia.bytes = filas.length ? bytes : null;
  } catch { /* opcional: en pages.dev normalmente no hay datos de ancho de banda */ }
  return dia;
}

async function obtenerDatos() {
  if (datosLocales) return { dias: JSON.parse(await readFile(datosLocales, 'utf8')), avisos: [] };
  if (!TOKEN) throw new Error('Falta CLOUDFLARE_API_TOKEN.');
  const fechas = rangoFechas();
  const avisos = new Set();
  const dias = [];
  for (let i = 0; i < fechas.length; i += 4) {
    dias.push(...(await Promise.all(fechas.slice(i, i + 4).map((f) => consultarDia(f, avisos)))));
  }
  const fallos = [...avisos];
  if (fallos.some((m) => /auth|permission|not authorized|access/i.test(m))) {
    console.log('::warning::La llave de Cloudflare no tiene permiso para leer la analítica. Añade "Account Analytics: Read" (Analítica de la cuenta: Leer) a la llave.');
  }
  return { dias, avisos: fallos };
}

// ---------- cálculo ----------
const fmt = (n) => (n == null ? '—' : new Intl.NumberFormat('es-ES', { useGrouping: 'always' }).format(Math.round(n)));
const fmtCorto = (n) => {
  if (n == null) return '—';
  if (n >= 1e6) return `${(n / 1e6).toLocaleString('es-ES', { maximumFractionDigits: 1 })} M`;
  if (n >= 1e3) return `${(n / 1e3).toLocaleString('es-ES', { maximumFractionDigits: 1 })} mil`;
  return fmt(n);
};
const fmtBytes = (b) => (b == null ? '—' : b >= 1e9 ? `${(b / 1e9).toLocaleString('es-ES', { maximumFractionDigits: 2 })} GB` : `${(b / 1e6).toLocaleString('es-ES', { maximumFractionDigits: 0 })} MB`);
const media = (xs) => { const v = xs.filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
const fechaBonita = (f) => new Date(f + 'T12:00:00Z').toLocaleDateString('es-ES', { day: 'numeric', month: 'short', timeZone: 'UTC' });

function resumen(dias, clave) {
  const antes = dias.filter((d) => d.fecha < CAMBIO).map((d) => d[clave]);
  const despues = dias.filter((d) => d.fecha > CAMBIO).map((d) => d[clave]);
  const limite = LIMITES[clave];
  const mA = media(antes), mD = media(despues);
  return {
    mediaAntes: mA, mediaDespues: mD,
    maxAntes: antes.filter((x) => x != null).length ? Math.max(...antes.filter((x) => x != null)) : null,
    maxDespues: despues.filter((x) => x != null).length ? Math.max(...despues.filter((x) => x != null)) : null,
    diasAntes: antes.filter((x) => x != null).length, diasDespues: despues.filter((x) => x != null).length,
    excesosAntes: limite ? antes.filter((x) => x != null && x > limite).length : null,
    excesosDespues: limite ? despues.filter((x) => x != null && x > limite).length : null,
    cambio: mA && mD != null ? (mD - mA) / mA : null,
  };
}

// ---------- gráficas SVG ----------
function grafica(dias, clave, { limite, formato = fmtCorto, titulo }) {
  const W = 640, H = 260, M = { t: 18, r: 10, b: 34, l: 52 };
  const iw = W - M.l - M.r, ih = H - M.t - M.b;
  const vals = dias.map((d) => d[clave] ?? 0);
  const bruto = Math.max(...vals, limite || 0, 1) * 1.08;
  const ticks = 4;
  const base = 10 ** Math.floor(Math.log10(bruto / ticks));
  const pasoTick = [1, 2, 2.5, 5, 10].map((m) => m * base).find((m) => m * ticks >= bruto);
  const maxV = pasoTick * ticks;
  const y = (v) => M.t + ih - (v / maxV) * ih;
  const paso = iw / dias.length;
  const bw = Math.max(Math.min(paso - 2, 22), 2);
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${titulo}" class="chart">`;
  for (let i = 0; i <= ticks; i++) {
    const v = (maxV / ticks) * i, yy = y(v);
    s += `<line x1="${M.l}" x2="${W - M.r}" y1="${yy}" y2="${yy}" class="grid"/>`;
    s += `<text x="${M.l - 8}" y="${yy + 4}" class="tick" text-anchor="end">${formato(v)}</text>`;
  }
  dias.forEach((d, i) => {
    const v = d[clave];
    const x = M.l + i * paso + (paso - bw) / 2;
    const fase = d.fecha < CAMBIO ? 'antes' : d.fecha > CAMBIO ? 'despues' : 'cambio';
    const etiqueta = `${fechaBonita(d.fecha)}: ${v == null ? 'sin datos' : fmt(v)}${limite && v != null ? ` (${Math.round((v / limite) * 100)} % del límite)` : ''}`;
    if (v != null && v > 0) {
      const h = Math.max(ih - (y(v) - M.t), 1), r = Math.min(4, bw / 2, h);
      const top = y(v), bot = M.t + ih;
      s += `<path class="bar ${fase}" d="M${x},${bot} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${bot} Z"/>`;
    }
    s += `<rect class="hit" x="${M.l + i * paso}" y="${M.t}" width="${paso}" height="${ih}" data-tip="${etiqueta}"><title>${etiqueta}</title></rect>`;
    const cada = Math.ceil(dias.length / 7);
    if (i % cada === 0 || (i === dias.length - 1 && i % cada >= cada / 2)) {
      s += `<text x="${M.l + i * paso + paso / 2}" y="${H - 12}" class="tick" text-anchor="middle">${fechaBonita(d.fecha)}</text>`;
    }
  });
  const iC = dias.findIndex((d) => d.fecha >= CAMBIO);
  if (iC > 0) {
    const xc = M.l + iC * paso + (dias[iC].fecha === CAMBIO ? paso / 2 : 0);
    s += `<line x1="${xc}" x2="${xc}" y1="${M.t}" y2="${M.t + ih}" class="marca"/><text x="${xc + 6}" y="${M.t + 12}" class="marca-txt">Optimización</text>`;
  }
  if (limite) {
    s += `<line x1="${M.l}" x2="${W - M.r}" y1="${y(limite)}" y2="${y(limite)}" class="limite"/>`;
    s += `<text x="${W - M.r - 4}" y="${y(limite) - 6}" class="limite-txt" text-anchor="end">Límite gratis: ${formato(limite)}/día</text>`;
  }
  s += `<line x1="${M.l}" x2="${W - M.r}" y1="${M.t + ih}" y2="${M.t + ih}" class="eje"/></svg>`;
  return s;
}

function bloque(dias, clave, cfg) {
  const r = resumen(dias, clave);
  const limite = LIMITES[clave];
  const pct = (v) => (v == null || !limite ? '' : `<span class="pct">${Math.round((v / limite) * 100)} % del límite</span>`);
  const cambio = r.cambio == null ? '—' : `${r.cambio < 0 ? '−' : '+'}${Math.abs(Math.round(r.cambio * 100))} %`;
  const sinDatos = dias.every((d) => d[clave] == null);
  return `<section class="card">
  <h2>${cfg.titulo}</h2>
  <p class="explica">${cfg.explica}</p>
  ${sinDatos ? '<p class="aviso">Cloudflare no devolvió datos para esta métrica.</p>' : `
  <div class="tiles">
    <div class="tile"><div class="lbl">Media diaria antes</div><div class="num">${fmtCorto(r.mediaAntes)}</div>${pct(r.mediaAntes)}</div>
    <div class="tile"><div class="lbl">Media diaria después</div><div class="num">${r.diasDespues ? fmtCorto(r.mediaDespues) : 'aún sin días'}</div>${pct(r.mediaDespues)}</div>
    <div class="tile"><div class="lbl">Cambio</div><div class="num">${cambio}</div></div>
    ${limite ? `<div class="tile"><div class="lbl">Días por encima del límite</div><div class="num">${r.excesosAntes} → ${r.diasDespues ? r.excesosDespues : '—'}</div><span class="pct">antes → después</span></div>` : ''}
  </div>
  ${grafica(dias, clave, { limite, titulo: cfg.titulo, formato: cfg.formato })}`}
</section>`;
}

function html(dias, avisos) {
  const metricas = [
    ['rowsRead', { titulo: 'Filas leídas de la base de datos (D1)', explica: 'Cada vez que la web consulta datos (fotos, anuncios, socios…) Cloudflare cuenta las filas que lee. El plan gratuito permite 5 millones al día; al pasarlo, la web deja de responder hasta medianoche (hora UTC).' }],
    ['rowsWritten', { titulo: 'Filas escritas en la base de datos (D1)', explica: 'Cada dato que se guarda (visitas, cambios, anuncios). Límite gratuito: 100.000 al día.' }],
    ['requests', { titulo: 'Peticiones a las funciones de la web', explica: 'Cada vez que una página pide algo "dinámico" al servidor. Límite gratuito: 100.000 al día para toda la cuenta.' }],
  ];
  const conBytes = dias.some((d) => d.bytes != null);
  if (conBytes) metricas.push(['bytes', { titulo: 'Datos transferidos (ancho de banda)', explica: 'Cuánto pesa todo lo que se descarga desde la web. En Cloudflare Pages no tiene límite en el plan gratuito; se muestra solo como referencia.', formato: fmtBytes }]);
  const filas = dias.map((d) => `<tr class="${d.fecha === CAMBIO ? 'dia-cambio' : ''}"><td>${d.fecha}</td><td>${fmt(d.rowsRead)}</td><td>${fmt(d.rowsWritten)}</td><td>${fmt(d.requests)}</td>${conBytes ? `<td>${fmtBytes(d.bytes)}</td>` : ''}</tr>`).join('');
  const rR = resumen(dias, 'rowsRead'), rQ = resumen(dias, 'requests'), rW = resumen(dias, 'rowsWritten');
  const titular = [rR, rW, rQ].every((r) => r.diasDespues === 0)
    ? 'Aún no hay días completos después de la optimización. Vuelve a generar el informe dentro de unos días.'
    : `Después de la optimización, la web lee de media ${fmtCorto(rR.mediaDespues)} filas al día (${Math.round(((rR.mediaDespues || 0) / LIMITES.rowsRead) * 100)} % del límite gratuito) frente a ${fmtCorto(rR.mediaAntes)} antes, y hace ${fmtCorto(rQ.mediaDespues)} peticiones al día frente a ${fmtCorto(rQ.mediaAntes)}.`;
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Consumo de la web</title>
<style>
:root{--surface:#fcfcfb;--card:#ffffff;--ink:#0b0b0b;--ink2:#52514e;--muted:#8a897f;--grid:#e6e5df;--antes:#eb6834;--despues:#2a78d6;--cambio:#b4b3aa;--limite:#c0262d;--border:#e6e5df}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--surface:#1a1a19;--card:#232321;--ink:#f0efec;--ink2:#c3c2b7;--muted:#8f8e86;--grid:#34342f;--antes:#d95926;--despues:#3987e5;--cambio:#6a6962;--limite:#e66767;--border:#34342f}}
:root[data-theme="dark"]{--surface:#1a1a19;--card:#232321;--ink:#f0efec;--ink2:#c3c2b7;--muted:#8f8e86;--grid:#34342f;--antes:#d95926;--despues:#3987e5;--cambio:#6a6962;--limite:#e66767;--border:#34342f}
*{box-sizing:border-box}body{margin:0;background:var(--surface);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:860px;margin:0 auto;padding:24px 16px 48px}h1{font-size:1.7rem;margin:0 0 4px}h2{font-size:1.15rem;margin:0 0 4px}
.sub{color:var(--ink2);margin:0 0 20px}.titular{font-size:1.1rem;background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px;margin-bottom:20px}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px;margin-bottom:20px}.explica{color:var(--ink2);margin:0 0 12px;font-size:.95rem}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:12px}.tile{border:1px solid var(--border);border-radius:10px;padding:10px 12px}
.lbl{font-size:.8rem;color:var(--ink2)}.num{font-size:1.4rem;font-weight:650;font-variant-numeric:tabular-nums}.pct{font-size:.8rem;color:var(--muted)}
.leyenda{display:flex;flex-wrap:wrap;gap:16px;font-size:.85rem;color:var(--ink2);margin:0 0 20px}.leyenda i{display:inline-block;width:12px;height:12px;border-radius:3px;margin-right:6px;vertical-align:-1px}
.chart{width:100%;height:auto;display:block}.grid{stroke:var(--grid);stroke-width:1}.eje{stroke:var(--muted);stroke-width:1}.tick{fill:var(--muted);font-size:11px}
.bar.antes{fill:var(--antes)}.bar.despues{fill:var(--despues)}.bar.cambio{fill:var(--cambio)}.hit{fill:transparent;cursor:default}.hit:hover{fill:var(--grid);fill-opacity:.35}
.limite{stroke:var(--limite);stroke-width:2;stroke-dasharray:6 4}.limite-txt{fill:var(--ink);font-size:12px;font-weight:600}.marca{stroke:var(--ink2);stroke-width:1;stroke-dasharray:2 3}.marca-txt{fill:var(--ink2);font-size:11px}
.aviso{color:var(--ink2);font-style:italic}details{margin-top:8px}table{border-collapse:collapse;width:100%;font-size:.9rem;font-variant-numeric:tabular-nums}th,td{padding:6px 8px;border-bottom:1px solid var(--border);text-align:right}th:first-child,td:first-child{text-align:left}.dia-cambio td{font-weight:650}
.tabla{overflow-x:auto}#tip{position:fixed;pointer-events:none;background:var(--ink);color:var(--surface);padding:4px 8px;border-radius:6px;font-size:.8rem;display:none;z-index:9}
footer{color:var(--muted);font-size:.85rem}
</style></head><body><main>
<h1>Consumo de la web del club</h1>
<p class="sub">Antes y después de la optimización del ${fechaBonita(CAMBIO)}. Datos de Cloudflare del ${fechaBonita(dias[0].fecha)} al ${fechaBonita(dias.at(-1).fecha)} (días en hora UTC). Generado el ${new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' })}.</p>
<div class="titular">${titular}</div>
<div class="leyenda"><span><i style="background:var(--antes)"></i>Antes</span><span><i style="background:var(--cambio)"></i>Día del cambio</span><span><i style="background:var(--despues)"></i>Después</span><span><i style="background:none;border-top:2px dashed var(--limite);border-radius:0;height:0;vertical-align:4px"></i>Límite del plan gratuito</span></div>
${metricas.map(([k, c]) => bloque(dias, k, c)).join('\n')}
<section class="card"><h2>Tabla día a día</h2><div class="tabla"><table><thead><tr><th>Día</th><th>Filas leídas</th><th>Filas escritas</th><th>Peticiones</th>${conBytes ? '<th>Datos</th>' : ''}</tr></thead><tbody>${filas}</tbody></table></div></section>
${conBytes ? '' : '<p class="aviso">El ancho de banda de las webs alojadas en pages.dev no está disponible en la analítica de Cloudflare. En cualquier caso, Cloudflare Pages no limita el ancho de banda en el plan gratuito.</p>'}
${avisos.length ? `<details><summary>Avisos técnicos (${avisos.length})</summary><ul>${avisos.slice(0, 20).map((a) => `<li>${a.replace(/</g, '&lt;')}</li>`).join('')}</ul></details>` : ''}
<footer><p>Los límites diarios de Cloudflare se reinician a las 00:00 UTC (la 1:00 en Madrid en invierno).</p></footer>
</main><div id="tip"></div>
<script>const t=document.getElementById('tip');document.querySelectorAll('.hit').forEach(r=>{r.querySelector('title')?.remove();r.addEventListener('mousemove',e=>{t.textContent=r.dataset.tip;t.style.display='block';t.style.left=Math.min(e.clientX+12,innerWidth-t.offsetWidth-8)+'px';t.style.top=(e.clientY-32)+'px'});r.addEventListener('mouseleave',()=>t.style.display='none')});</script>
</body></html>`;
}

function markdown(dias) {
  const fila = (nombre, clave, f = fmtCorto) => {
    const r = resumen(dias, clave), l = LIMITES[clave];
    const p = (v) => (v == null || !l ? '' : ` (${Math.round((v / l) * 100)} %)`);
    return `| ${nombre} | ${f(r.mediaAntes)}${p(r.mediaAntes)} | ${r.diasDespues ? f(r.mediaDespues) + p(r.mediaDespues) : 'aún sin días'} | ${l ? f(l) : 'sin límite'} | ${l ? `${r.excesosAntes} → ${r.diasDespues ? r.excesosDespues : '—'}` : '—'} |`;
  };
  return `## Consumo de la web: antes y después del ${fechaBonita(CAMBIO)}

| Métrica (media diaria) | Antes | Después | Límite gratis | Días por encima del límite |
|---|---:|---:|---:|---:|
${fila('Filas leídas D1', 'rowsRead')}
${fila('Filas escritas D1', 'rowsWritten')}
${fila('Peticiones a Functions', 'requests')}
${dias.some((d) => d.bytes != null) ? fila('Datos transferidos', 'bytes', fmtBytes) : ''}

El informe completo con gráficas está en el artefacto **informe-consumo-cloudflare** de esta ejecución (descarga el zip y abre \`informe-consumo.html\`).
`;
}

const { dias, avisos } = await obtenerDatos();
await mkdir(SALIDA, { recursive: true });
await writeFile(`${SALIDA}/informe-consumo.html`, html(dias, avisos));
await writeFile(`${SALIDA}/datos.json`, JSON.stringify(dias, null, 2));
const md = markdown(dias);
if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY, md, { flag: 'a' });
console.log(md);
if (avisos.length) console.log('Avisos:\n' + avisos.slice(0, 20).join('\n'));
if (dias.every((d) => d.rowsRead == null && d.requests == null)) {
  console.log('::error::Cloudflare no devolvió ningún dato. Revisa que la llave tenga el permiso "Account Analytics: Read".');
  process.exit(1);
}
