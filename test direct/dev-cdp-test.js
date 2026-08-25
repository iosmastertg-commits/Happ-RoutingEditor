// CDP test harness for the GeoIP tint + CIDR expansion + force-copy panel changes.
const port = process.argv[2] || 9333;
let ws;
let id = 0;
const pending = new Map();

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}

async function evalJS(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('Page exception: ' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
  return r.result.value;
}

(async () => {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((p) => p.type === 'page');
  if (!page) { console.error('NO_PAGE'); process.exit(1); }
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const d = JSON.parse(ev.data);
    if (d.id && pending.has(d.id)) {
      pending.get(d.id).resolve(d.result);
      pending.delete(d.id);
    }
  };

  const results = [];
  const ok = (name, cond, extra) => results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);

  // --- Setup: seed two rules so tints have something to latch onto ---
  // Injected straight through addRule (no reload): the reload+restore path
  // races the app's own autosave, which resurrected stale rules mid-test.
  await evalJS(`
    (async () => {
      // start from a clean slate
      for (const r of [...state.rules]) removeRule(r.id);
      document.querySelectorAll('.session-offer .so-close').forEach((b) => b.click());
      // Proxy: geoip:ru
      const proxyTab = [...document.querySelectorAll('#view-editor .section-tab')].find(t => t.dataset.section === 'Proxy');
      proxyTab.click();
      addRule('geoip', 'ru', {});
      // Direct: geosite:category-ads
      const directTab = [...document.querySelectorAll('#view-editor .section-tab')].find(t => t.dataset.section === 'Direct');
      directTab.click();
      addRule('geosite', 'category-ads', {});
      syncMarks();
      return 'seeded';
    })()
  `);
  await new Promise((r) => setTimeout(r, 500));

  // Load geoip.dat and geosite.dat from the default URLs (network fetch in main).
  await evalJS(`document.querySelector('#view-editor').hidden = false; 'editor shown'`);
  await evalJS(`document.querySelector('#geoip-load').click(); 'clicked'`);
  await new Promise((r) => setTimeout(r, 9000));
  await evalJS(`document.querySelector('#geosite-load').click(); 'clicked'`);
  await new Promise((r) => setTimeout(r, 9000));

  const geoStatus = await evalJS(`document.querySelector('#geoip-status').textContent`);
  ok('geoip loaded', /Загружено|Загружен/.test(geoStatus), geoStatus);

  // Rules must be live after the restore click (tints depend on them).
  const ruleCount = await evalJS(`state.rules.length`);
  ok('rules restored', ruleCount === 2, 'count=' + ruleCount);

  // --- Test 1: section tint on the geoip tile matching rule geoip:ru (Proxy -> blue) ---
  const tileTint = await evalJS(`(() => {
    const t = document.querySelector('#geoip-tiles .tile[data-key="geoip:ru"]');
    if (!t) return 'MISSING';
    return t.className;
  })()`);
  ok('tile geoip:ru has in-proxy tint', String(tileTint).includes('in-proxy'), String(tileTint));

  const otherTile = await evalJS(`(() => {
    const t = document.querySelector('#geoip-tiles .tile[data-key="geoip:us"]');
    if (!t) return 'MISSING';
    return t.className;
  })()`);
  ok('tile geoip:us NOT tinted', !/in-(proxy|direct|block)/.test(String(otherTile)), String(otherTile));

  // --- Test 2: expand CIDR list on that tile ---
  const expandResult = await evalJS(`(async () => {
    const t = document.querySelector('#geoip-tiles .tile[data-key="geoip:ru"]');
    if (!t) return 'MISSING';
    const btn = t.querySelector('.tile-expand');
    if (!btn) return 'NO_BTN';
    btn.click();
    await new Promise((r) => setTimeout(r, 1200));
    const body = t.querySelector('.geoip-cidrs');
    if (!body) return 'NO_BODY';
    const rows = body.querySelectorAll('.geoip-cidr-row');
    return 'rows=' + rows.length + ' open=' + t.classList.contains('open') + ' first=' + (rows[0] ? rows[0].textContent : '-');
  })()`);
  ok('expand shows CIDR rows', /^rows=\d+ open=true/.test(String(expandResult)), String(expandResult));

  // --- Test 3: switch to Direct tab; ru must keep blue outline (visible from any tab), category-ads green ---
  await evalJS(`[...document.querySelectorAll('#view-editor .section-tab')].find(t => t.dataset.section === 'Direct').click(); 'ok'`);
  await new Promise((r) => setTimeout(r, 400));
  const crossTab = await evalJS(`(() => {
    const t = document.querySelector('#geoip-tiles .tile[data-key="geoip:ru"]');
    const c = document.querySelector('#geosite-tree .cat[data-code="CATEGORY-ADS"]');
    return JSON.stringify({ ru: t ? t.className : 'MISSING', ads: c ? c.className : 'MISSING' });
  })()`);
  const crossObj = JSON.parse(crossTab);
  ok('ru keeps proxy-blue on Direct tab', String(crossObj.ru).includes('in-proxy'), crossObj.ru);
  ok('category-ads green on Direct tab', String(crossObj.ads).includes('in-direct'), crossObj.ads);

  // --- Test 4: toast dedup ---
  await evalJS(`window.toast('ТЕСТ-ДУПЛИКАТ', 'err', 8000); window.toast('ТЕСТ-ДУПЛИКАТ', 'err', 8000); window.toast('ТЕСТ-ДУПЛИКАТ', 'err', 8000); 'toasted'`);
  await new Promise((r) => setTimeout(r, 300));
  const dupCount = await evalJS(`[...document.querySelectorAll('#toast-wrap .toast')].filter(t => t.textContent === 'ТЕСТ-ДУПЛИКАТ').length`);
  ok('toast dedup (1 copy of 3)', dupCount === 1, 'count=' + dupCount);

  // --- Test 5: force-copy panel appears on blocked export and survives; button works ---
  // Remove geosite meta so validation fails fast? Simpler: call showForceCopyOption directly.
  await evalJS(`showForceCopyOption('happ', 'Happ'); showForceCopyOption('incy', 'Incy'); 'panels'`);
  await new Promise((r) => setTimeout(r, 200));
  const fcCount = await evalJS(`document.querySelectorAll('.force-copy').length`);
  ok('force-copy single instance (not stacked)', fcCount === 1, 'count=' + fcCount);
  const fcLabel = await evalJS(`(document.querySelector('.force-copy .so-msg')||{}).textContent`);
  ok('force-copy label updated by second call', /Incy/.test(String(fcLabel)), String(fcLabel));
  const zPanel = await evalJS(`(() => { const p = document.querySelector('.force-copy'); const cs = getComputedStyle(p); const tw = getComputedStyle(document.querySelector('.toast-wrap')); return JSON.stringify({ pz: cs.zIndex, tz: tw.zIndex }); })()`);
  const zObj = JSON.parse(zPanel);
  ok('force-copy above toasts', Number(zObj.pz) > Number(zObj.tz), zPanel);

  // Click "Всё равно скопировать" — should copy and remove the panel
  await evalJS(`document.querySelector('.force-copy .btn.primary').click(); 'clicked'`);
  await new Promise((r) => setTimeout(r, 500));
  const fcAfter = await evalJS(`document.querySelectorAll('.force-copy').length`);
  ok('panel removed after copy', fcAfter === 0, 'count=' + fcAfter);

  console.log(results.join('\n'));
  const fails = results.filter((r) => r.startsWith('FAIL')).length;
  console.log(fails === 0 ? 'ALL_PASS' : `FAILURES=${fails}`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error('HARNESS_ERROR:', e.message); process.exit(2); });
