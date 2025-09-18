/* ===== Trackr — Budget & Expense Tracker =====
   Local-first; Google Sheets sync hooks included for later.
   Author: You + ChatGPT
*/

(function(){
  // ---------- Constants & Storage ----------
  const LS = {
    STATE: 'bet_state_v1',
    LEDGER: 'bet_ledger_v1',
    LAST_MONTH: 'bet_last_month_v1'
  };

  // ---------- IndexedDB helper (simple key/value store) ----------
  const DB = {
    name: 'trackr-db', version: 1, store: 'kv', db: null,
    init(){
      if (this.db) return Promise.resolve();
      return new Promise((resolve, reject)=>{
        const req = indexedDB.open(this.name, this.version);
        req.onupgradeneeded = (e)=>{
          const d = e.target.result;
          if (!d.objectStoreNames.contains(this.store)) d.createObjectStore(this.store);
        };
        req.onsuccess = (e)=>{ this.db = e.target.result; resolve(); };
        req.onerror = ()=> reject(req.error);
      });
    },
    async get(key){ await this.init(); return new Promise((res, rej)=>{ const tx = this.db.transaction(this.store,'readonly'); const os = tx.objectStore(this.store); const r = os.get(key); r.onsuccess = ()=> res(r.result); r.onerror = ()=> rej(r.error); }); },
    async set(key, val){ await this.init(); return new Promise((res, rej)=>{ const tx = this.db.transaction(this.store,'readwrite'); const os = tx.objectStore(this.store); const r = os.put(val, key); r.onsuccess = ()=> res(); r.onerror = ()=> rej(r.error); }); },
    async del(key){ await this.init(); return new Promise((res, rej)=>{ const tx = this.db.transaction(this.store,'readwrite'); const os = tx.objectStore(this.store); const r = os.delete(key); r.onsuccess = ()=> res(); r.onerror = ()=> rej(r.error); }); }
  };

  // Try to restore state/ledger from IndexedDB into localStorage at startup.
  (async function restoreFromIndexedDB(){
    try{
      await DB.init();
      const s = await DB.get(LS.STATE);
      if (s !== undefined && s !== null) localStorage.setItem(LS.STATE, JSON.stringify(s));
      const l = await DB.get(LS.LEDGER);
      if (l !== undefined && l !== null) localStorage.setItem(LS.LEDGER, JSON.stringify(l));
    }catch(_){ /* ignore */ }
  })();

  // ----- Cloud sync (Google Apps Script Web App) -----
  const Cloud = (() => {
    const api = () => (localStorage.getItem(LS.BACKUP_WEBHOOK) || '').trim();
    const enabled = () => !!api();

    const normalize = (r) => ({
      id: r.id || uid('tx'),
      date: r.date || (r.ts ? String(r.ts).slice(0,10) : todayStr()),
      kind: r.kind || (r.categoryId ? 'expense' : 'contribution'),
      personId: r.personId ?? (r.userId ?? r.user ?? null),
      categoryId: r.categoryId ?? (r.category ?? null),
      amountCents: typeof r.amountCents === 'number' ? r.amountCents : parseAmountToCents(r.amount ?? 0),
      notes: r.notes || '',
      createdAt: r.createdAt || r.updatedAt || new Date().toISOString()
    });

    async function fetchAll() {
      if (!enabled()) return [];
      const res = await fetch(api(), { method: 'GET', mode: 'cors' });
      const json = await res.json().catch(() => ({}));
      const data = Array.isArray(json.data) ? json.data : [];
      return data.map(normalize);
    }

    async function pushEntry(entry) {
      if (!enabled()) return;
      await fetch(api(), {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' }, // simple request (no preflight)
        mode: 'no-cors',
        body: JSON.stringify({ type: 'entry', entry })
      }).catch(()=>{ /* ignore network errors for offline */ });
    }

    async function pushBackup() {
      if (!enabled()) return;
      await fetch(api(), {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        mode: 'no-cors',
        body: JSON.stringify({ state: getState(), ledger: getLedger() })
      }).catch(()=>{});
    }

    let poller = null;
    async function syncFromCloudOnce() {
      try {
        if (!enabled()) return;
        const base = api();
        const url = base + (base.includes('?') ? '&' : '?') + 'full=1';

        // Ask the webhook for the latest full snapshot (state + ledger)
        const res = await fetch(url, { method: 'GET', mode: 'cors' });
        const json = await res.json().catch(() => ({}));

        const remoteState = json && json.state ? json.state : null;
        const remoteLedger = Array.isArray(json && json.ledger) ? json.ledger.map(normalize) : [];

        // 1) Apply people/categories/budgets from the cloud (overwrites local)
        if (remoteState) setState(remoteState);

        // 2) Merge in any entries we don't have yet
        const local = getLedger();
        const have = new Set(local.map(e => e.id));
        let changed = false;
        for (const r of remoteLedger) {
          if (!have.has(r.id)) { local.push(r); changed = true; }
        }
        if (changed) setLedger(local);

        // 3) Re-render if anything changed
        if (remoteState || changed) refreshApp();
      } catch (_err) { /* ignore network errors */ }
    }
    function startPolling() {
      if (!enabled()) return stopPolling();
      if (poller) return;
      poller = setInterval(syncFromCloudOnce, 5000);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') syncFromCloudOnce();
      });
    }
    function stopPolling(){ if (poller){ clearInterval(poller); poller = null; } }

    // ===== Cloud pull via JSONP: incremental entries feed (CORS-free) =====
    const CLOUD_TS_KEY = 'bet_entries_since_v2';
    function getSinceTs() { try { return localStorage.getItem(CLOUD_TS_KEY) || ''; } catch(_) { return ''; } }
    function setSinceTs(ts) { try { if (ts) localStorage.setItem(CLOUD_TS_KEY, ts); } catch(_) {} }

    function jsonp(urlBase) {
      return new Promise(resolve => {
        const cb = 'bet_cb_' + Math.random().toString(36).slice(2);
        const s = document.createElement('script');
        window[cb] = (data) => {
          try { delete window[cb]; } catch(_) {}
          s.remove();
          resolve(data);
        };
        const sep = urlBase.includes('?') ? '&' : '?';
        s.src = urlBase + sep + 'cb=' + cb;
        s.async = true;
        document.head.appendChild(s);
      });
    }

    async function syncEntriesFromCloudJSONP() {
      try {
        if (!enabled()) return;
        const base = api();
        const since = getSinceTs();
        let url = base + (base.includes('?') ? '&' : '?') + 'entries=1';
        if (since) url += '&since=' + encodeURIComponent(since);

        const res = await jsonp(url);
        const incoming = Array.isArray(res && res.data) ? res.data.map(normalize) : [];
        if (incoming.length) {
          const local = getLedger();
          const have = new Set(local.map(e => e.id));
          let changed = false;
          for (const r of incoming) {
            if (r && r.id && !have.has(r.id)) { local.push(r); changed = true; }
          }
          if (changed) { setLedger(local); refreshApp(); }
        }
        if (res && res.ts) setSinceTs(res.ts); // advance watermark using server time
      } catch (_){ }
    }

    // boot: immediate + every 8s + when tab refocuses
    setTimeout(() => { try { syncEntriesFromCloudJSONP(); } catch(e){} }, 1500);
    setInterval(() => { try { syncEntriesFromCloudJSONP(); } catch(e){} }, 8000);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) { try { syncEntriesFromCloudJSONP(); } catch(e){} }
    });

    return { enabled, pushEntry, pushBackup, syncFromCloudOnce, startPolling, stopPolling };
  })();

  // --- Daily backup keys ---
  // LS.BACKUP_LAST    = 'bet_backup_last_v1';
  // LS.BACKUP_PREF    = 'bet_backup_pref_v1';     // "1" = on, "0"/missing = off
  // LS.BACKUP_WEBHOOK = 'bet_backup_webhook_v1';  // optional URL for Option B

  // function getBackupPayload(){
  //   return JSON.stringify({ state: getState(), ledger: getLedger() }, null, 2);
  // }
  // function doLocalDownload(filename, text){
  //   const blob = new Blob([text], {type:'application/json'});
  //   const url = URL.createObjectURL(blob);
  //   const a = document.createElement('a');
  //   a.href = url; a.download = filename; a.click();
  //   URL.revokeObjectURL(url);
  // }
  // function todayKey(){ return new Date().toISOString().slice(0,10); }
  //
  // async function maybeRunDailyBackups(){
  //   try{
  //     const pref = localStorage.getItem(LS.BACKUP_PREF) === '1';
  //     const last = localStorage.getItem(LS.BACKUP_LAST);
  //     const today = todayKey();
  //     if (last === today) return;
  //
  //     const payload = getBackupPayload();
  //
  //     // 1) Local file auto-download (if enabled)
  //     if (pref){
  //       doLocalDownload(`BET-backup-${today}.json`, payload);
  //     }
  //
  //     // 2) Optional cloud webhook (Option B)
  //     const url = localStorage.getItem(LS.BACKUP_WEBHOOK) || '';
  //     if (url){
  //       await fetch(url, {
  //         method: 'POST',
  //         headers: { 'Content-Type': 'text/plain' },
  //         mode: 'no-cors',
  //         body: payload
  //       }).catch(()=>{ /* ignore */ });
  //     }
  //
  //     localStorage.setItem(LS.BACKUP_LAST, today);
  //   }catch(_){ /* ignore */ }
  // }

  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));

  // ---------- Utilities ----------
  const todayStr = () => {
    const d = new Date();
    const mm = String(d.getMonth()+1).padStart(2,'0');
    const dd = String(d.getDate()).padStart(2,'0');
    return `${d.getFullYear()}-${mm}-${dd}`;
  };

  const monthKeyFromDate = dateStr => dateStr.slice(0,7); // YYYY-MM
  const monthKeyToday = () => monthKeyFromDate(todayStr());

  const parseAmountToCents = (val) => {
    if (typeof val === 'number') return Math.round(val * 100);
    const n = String(val).replace(/[^0-9.]/g,'');
    return Math.round((parseFloat(n || '0')) * 100);
  };

  const formatPHP = cents => (cents/100).toLocaleString('en-PH', {style:'currency', currency:'PHP'});

  // Set Cash on Hand display (expects cents)
  function setCashOnHand(cashCents){
    const el = document.getElementById('cardCashOnHand');
    if (!el) return;
    el.textContent = formatPHP(cashCents);
    el.classList.remove('balance-pos','balance-neg');
    el.classList.add(cashCents >= 0 ? 'balance-pos' : 'balance-neg');
  }

  const uid = (prefix='id') => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,7)}`;

  const clone = obj => JSON.parse(JSON.stringify(obj));

  const monthsBetween = (startYYYYMM, endYYYYMM) => {
    const out = [];
    let [ys, ms] = startYYYYMM.split('-').map(x=>parseInt(x,10));
    const [ye, me] = endYYYYMM.split('-').map(x=>parseInt(x,10));
    while (ys < ye || (ys===ye && ms <= me)) {
      out.push(`${ys}-${String(ms).padStart(2,'0')}`);
      ms++;
      if (ms>12){ ms=1; ys++; }
    }
    return out;
  };

  const splitEvenCents = (totalCents, n) => {
    const base = Math.floor(totalCents / n);
    const remainder = totalCents - base * n;
    const arr = Array.from({length:n}, (_,i)=> base + (i < remainder ? 1 : 0));
    return arr;
  };

  // ---------- State ----------
  const getState = () => {
    const s = localStorage.getItem(LS.STATE);
    return s ? JSON.parse(s) : null;
  };
  const setState = (state) => {
    try{ localStorage.setItem(LS.STATE, JSON.stringify(state)); }catch(_){ }
    // async mirror to IndexedDB
    DB.set(LS.STATE, state).catch(()=>{});
  };

  const getLedger = () => {
    const s = localStorage.getItem(LS.LEDGER);
    return s ? JSON.parse(s) : [];
  };
  const setLedger = (arr) => {
    try{ localStorage.setItem(LS.LEDGER, JSON.stringify(arr)); }catch(_){ }
    DB.set(LS.LEDGER, arr).catch(()=>{});
  };

  const setLastMonth = (m) => localStorage.setItem(LS.LAST_MONTH, m);
  const getLastMonth = () => localStorage.getItem(LS.LAST_MONTH);

  // Currently editing entry id (null = creating new)
  let editingEntryId = null;

  function openEditEntry(id){
    const entry = getLedger().find(x=> x.id === id);
    if (!entry) return;
    // Prefill modal
    $('#entryDate').value = entry.date || todayStr();
    populateEntryTargetSelect();
    $('#entryTarget').value = entry.personId || entry.categoryId || '';
    // show positive amount in input
    $('#entryAmount').value = (Math.abs(entry.amountCents)/100).toFixed(2);
    $('#entryNotes').value = entry.notes || '';
    editingEntryId = id;
    document.body.classList.add('noscroll');
    $('#entryModal').classList.remove('hidden');
  }

  // ---------- Initial Boot ----------
  const state = getState();
  if (!state) {
    // Show setup
    $('#setupView').classList.remove('hidden');
    $('#appView').classList.add('hidden');
  } else {
    // Show app
    $('#setupView').classList.add('hidden');
    $('#appView').classList.remove('hidden');
  }

  // ---------- Setup View Logic ----------
  function renderSetupLists(){
    const st = getState(); // might be null during first run
    const people = st?.people ?? [];
    const cats = st?.categories ?? [];

    // People list
    const peopleList = $('#peopleList');
    peopleList.innerHTML = '';
    (people.length ? people : []).forEach(p=>{
      const div = document.createElement('div');
      div.className = 'item';
      div.innerHTML = `
        <input data-id="${p.id}" class="person-name" type="text" value="${p.name}" />
        <div class="actions">
          <button class="icon-btn del-person" data-id="${p.id}" title="Remove">🗑</button>
        </div>
      `;
      peopleList.appendChild(div);
    });

    // Categories
    const catList = $('#categoryList');
    catList.innerHTML = '';
    (cats.length ? cats : []).forEach(c=>{
      const div = document.createElement('div');
      div.className = 'item';
      div.innerHTML = `
        <div class="row">
          <input data-id="${c.id}" class="cat-name" type="text" value="${c.name}" />
        </div>
        <div class="row">
          <input data-id="${c.id}" class="cat-budget" type="number" step="0.01" min="0" value="${(c.budgetCents/100).toFixed(2)}" />
          <button class="icon-btn del-cat" data-id="${c.id}" title="Remove">🗑</button>
        </div>
      `;
      catList.appendChild(div);
    });

    // Total budget
    const total = (cats || []).reduce((sum,c)=> sum + (c.budgetCents||0), 0);
    $('#setupTotalBudget').textContent = formatPHP(total);
  }

  // Empty temp state for setup screen (before first save)
  if (!state){
    setState({
      people: [],
      categories: [],
      createdAt: new Date().toISOString(),
      version: 1
    });
    setLedger([]);
  }
  renderSetupLists();

  // Add person
  $('#btnAddPerson').addEventListener('click', ()=>{
    const name = $('#newPersonName').value.trim();
    if (!name) return;
    const st = getState();
    // prevent duplicate name (case-insensitive)
    if (st.people.some(p=> p.name.toLowerCase() === name.toLowerCase())) {
      alert('That person already exists.');
      return;
    }
    st.people.push({ id: `p:${uid()}`, name });
    setState(st);
    $('#newPersonName').value = '';
    renderSetupLists();
  });

  // Add category
  $('#btnAddCategory').addEventListener('click', ()=>{
    const name = $('#newCategoryName').value.trim();
    const amt = parseAmountToCents($('#newCategoryBudget').value);
    if (!name) return;
    const st = getState();
    if (st.categories.some(c=> c.name.toLowerCase() === name.toLowerCase())) {
      alert('That category already exists.');
      return;
    }
    st.categories.push({ id: `c:${uid()}`, name, budgetCents: amt });
    setState(st);
    $('#newCategoryName').value = '';
    $('#newCategoryBudget').value = '';
    renderSetupLists();
  });

  // Inline edits + deletes in setup lists
  $('#peopleList').addEventListener('input', (e)=>{
    if (e.target.classList.contains('person-name')) {
      const id = e.target.dataset.id;
      const st = getState();
      const p = st.people.find(x=>x.id===id);
      if (p) { p.name = e.target.value; setState(st); }
    }
  });
  $('#peopleList').addEventListener('click', (e)=>{
    if (e.target.classList.contains('del-person')){
      const id = e.target.dataset.id;
      const st = getState();
      st.people = st.people.filter(x=>x.id!==id);
      setState(st); renderSetupLists();
    }
  });

  $('#categoryList').addEventListener('input', (e)=>{
    const st = getState();
    if (e.target.classList.contains('cat-name')){
      const id = e.target.dataset.id;
      const c = st.categories.find(x=>x.id===id);
      if (c){ c.name = e.target.value; setState(st); }
    }
    if (e.target.classList.contains('cat-budget')){
      const id = e.target.dataset.id;
      const c = st.categories.find(x=>x.id===id);
      if (c){ c.budgetCents = parseAmountToCents(e.target.value); setState(st); }
      // update total
      const total = st.categories.reduce((s,c)=> s + (c.budgetCents||0), 0);
      $('#setupTotalBudget').textContent = formatPHP(total);
    }
  });
  $('#categoryList').addEventListener('click', (e)=>{
    if (e.target.classList.contains('del-cat')){
      const id = e.target.dataset.id;
      const st = getState();
      st.categories = st.categories.filter(x=>x.id!==id);
      setState(st); renderSetupLists();
    }
  });

  $('#btnStart').addEventListener('click', ()=>{
    const st = getState();
    if (st.people.length < 1){ alert('Add at least one person.'); return; }
    if (st.categories.length < 1){ alert('Add at least one expense category.'); return; }
    // finalize createdAt on first start
    st.createdAt = new Date().toISOString();
    setState(st);
    // switch to app
    $('#setupView').classList.add('hidden');
    $('#appView').classList.remove('hidden');
    initApp();
  });

  $('#btnResetAll').addEventListener('click', ()=>{
    if (!confirm('This will clear all data saved locally. Continue?')) return;
    localStorage.removeItem(LS.STATE);
    localStorage.removeItem(LS.LEDGER);
    localStorage.removeItem(LS.LAST_MONTH);
    location.reload();
  });

  // ---------- App View Logic ----------
  function updateSummaryCards(){
    const st = getState();
    const ledger = getLedger();
    const month = $('#monthPicker').value || monthKeyToday();
    setLastMonth(month);

    // Cards
    const totalBudget = st.categories.reduce((s,c)=> s + (c.budgetCents||0), 0);
    $('#cardTotalBudget').textContent = formatPHP(totalBudget);

    const monthEntries = ledger.filter(e=> monthKeyFromDate(e.date) === month);
    const actualSpend = monthEntries
      .filter(e=> e.kind==='expense')
      .reduce((s,e)=> s + Math.abs(e.amountCents), 0);
    $('#cardActualSpend').textContent = formatPHP(actualSpend);

    const contributions = monthEntries
      .filter(e=> e.kind==='contribution')
      .reduce((s,e)=> s + e.amountCents, 0);
    $('#cardContributions').textContent = formatPHP(contributions);

    // Compute and display Cash on Hand = Contributions - Actual Spend (in cents)
    const cashCents = contributions - actualSpend;
    setCashOnHand(cashCents);
  }

  function initApp(){
    // Month picker
    const last = getLastMonth() || monthKeyToday();
    $('#monthPicker').value = last;
    refreshApp();
    // Backups and cloud sync removed
  }

  // ensure cash updates whenever core totals change
  const origRefreshApp = refreshApp;
  refreshApp = function(){ origRefreshApp(); };

  if (state){ initApp(); }

  // Recalc + render everything
  function refreshApp(){
    const st = getState();
    const ledger = getLedger();
    const month = $('#monthPicker').value || monthKeyToday();
    setLastMonth(month);

    // Cards
    const totalBudget = st.categories.reduce((s,c)=> s + (c.budgetCents||0), 0);
    $('#cardTotalBudget').textContent = formatPHP(totalBudget);

    const monthEntries = ledger.filter(e=> monthKeyFromDate(e.date) === month);
    const actualSpend = monthEntries
      .filter(e=> e.kind==='expense')
      .reduce((s,e)=> s + Math.abs(e.amountCents), 0);
    $('#cardActualSpend').textContent = formatPHP(actualSpend);

    const contributions = monthEntries
      .filter(e=> e.kind==='contribution')
      .reduce((s,e)=> s + e.amountCents, 0);
    $('#cardContributions').textContent = formatPHP(contributions);

    // Compute and display Cash on Hand = Contributions - Actual Spend (in cents)
    const cashCents = contributions - actualSpend;
    setCashOnHand(cashCents);

    // People summary (with carryover)
    renderPeopleSummary(month);
    renderCategorySummary(month);

    // Ledger table
    renderLedgerTable(month);
    populateEntryTargetSelect();
  }

  $('#monthPicker').addEventListener('change', refreshApp);

  // ---------- Computation (carryover-aware) ----------
  function computePerPersonSummaryForMonth(targetMonth){
    const st = getState();
    const ledger = getLedger();
    const people = st.people;
    const N = Math.max(people.length, 1);

    // Base monthly budget from categories (current settings)
    const baseBudget = st.categories.reduce((s,c)=> s + (c.budgetCents||0), 0);

    // Figure out the first month to account from (app start or earliest ledger month)
    const createdMonth = st.createdAt.slice(0,7);
    const earliestLedgerMonth = ledger.length
      ? ledger.map(e=> monthKeyFromDate(e.date)).sort()[0]
      : createdMonth;
    const startMonth = (earliestLedgerMonth < createdMonth) ? earliestLedgerMonth : createdMonth;

    // Carryovers per person across months
    const months = monthsBetween(startMonth, targetMonth);
    const carry = Object.fromEntries(people.map(p => [p.id, 0]));

    months.forEach((m)=>{
      // 1) Compute actual spend for month m
      const actualSpent = ledger.reduce((sum,e)=>{
        if (monthKeyFromDate(e.date) !== m) return sum;
        return e.kind === 'expense' ? sum + Math.abs(e.amountCents) : sum;
      }, 0);

      // 2) Monthly base owed = max(Budget, Actual)
      const monthlyBase = Math.max(baseBudget, actualSpent);

      // 3) Equal split for this month (in centavos; re-split every month)
      const shares = splitEvenCents(monthlyBase, N);

      // 4) Contributions per person for month m
      const contr = Object.fromEntries(people.map(p=> [p.id, 0]));
      ledger.forEach(e=>{
        if (monthKeyFromDate(e.date) !== m) return;
        if (e.kind === 'contribution'){
          contr[e.personId] = (contr[e.personId]||0) + e.amountCents;
        }
      });

      // 5) Compute owed/balance/carryover person-by-person
      people.forEach((p, idx)=>{
        const owedThisMonth = shares[idx] + (carry[p.id] || 0);
        const contributed = contr[p.id] || 0;
        const balance = contributed - owedThisMonth;   // +ahead, -owes
        const nextCarry = -balance;                    // carry to next month
        carry[p.id] = nextCarry;

        if (m === targetMonth){
          carry[`_snap_${p.id}`] = {
            owedThisMonth,
            contributedThisMonth: contributed,
            balanceThisMonth: balance,
            carryoverToNext: nextCarry,
            monthlyBase
          };
        }
      });
    });

    // Build rows for target month snapshot
    const rows = people.map((p, idx)=>{
      const snap = carry[`_snap_${p.id}`];
      // Fallbacks are defensive; target month should always have a snapshot
      const monthlyBase = snap?.monthlyBase ?? baseBudget;
      const splitShare = splitEvenCents(monthlyBase, N)[idx];
      const owed = snap?.owedThisMonth ?? splitShare + (carry[p.id]||0);
      const contributed = snap?.contributedThisMonth ?? 0;
      const balance = snap?.balanceThisMonth ?? (contributed - owed);
      const carryNext = snap?.carryoverToNext ?? (-balance);
      return {
        personId: p.id,
        name: p.name,
        owedCents: owed,
        contributedCents: contributed,
        balanceCents: balance,
        carryoverNextCents: carryNext,
        splitShareCents: splitShare
      };
    });

    // Let callers know whether we settled to actuals this month
    const targetActual = ledger.reduce((s,e)=> (
      monthKeyFromDate(e.date)===targetMonth && e.kind==='expense'
    ) ? s + Math.abs(e.amountCents) : s, 0);
    const usedActuals = targetActual > baseBudget;

    return {
      totalBudgetCents: baseBudget,
      rows,
      usedActuals,
      monthlyBaseCents: usedActuals ? targetActual : baseBudget
    };
  }

  function renderPeopleSummary(month){
    const st = getState();
    const summ = computePerPersonSummaryForMonth(month);
    const wrap = $('#peopleSummary');
    wrap.innerHTML = '';
    summ.rows.forEach(r=>{
      const card = document.createElement('div');
      card.className = 'person-card';
      const status = r.balanceCents >= 0 ? 'ok' : 'warn';
      const pillText = r.balanceCents >= 0 ? 'Ahead' : 'Owes';
      const balClass = r.balanceCents > 0 ? 'balance-pos' : (r.balanceCents < 0 ? 'balance-neg' : '');

      card.innerHTML = `
        <div class="row">
          <div class="name">${escapeHtml(r.name)}</div>
          <div class="pill ${status}">${pillText}</div>
        </div>
        <div class="kv">
          <div>Should contribute</div><div><strong>${formatPHP(r.owedCents)}</strong></div>
          <div>Contributed</div><div>${formatPHP(r.contributedCents)}</div>
          <div>Balance</div><div class="${balClass}">${formatPHP(r.balanceCents)}</div>
          <div>Carryover → next</div><div>${formatPHP(r.carryoverNextCents)}</div>
        </div>
      `;
      wrap.appendChild(card);
    });
  }

  function computeCategorySummaryForMonth(month){
    const st = getState();
    const ledger = getLedger();

    // Start with all categories so rows appear even with zero spend
    const map = new Map();
    st.categories.forEach(c=>{
      map.set(c.id, {
        categoryId: c.id,
        name: c.name,
        budgetCents: c.budgetCents || 0,
        actualCents: 0
      });
    });

    // Sum actual expenses for the selected month
    ledger.forEach(e=>{
      if (monthKeyFromDate(e.date) !== month) return;
      if (e.kind !== 'expense') return;
      const id = e.categoryId || '__unknown__';
      if (!map.has(id)){
        map.set(id, { categoryId:id, name:'(Unknown)', budgetCents:0, actualCents:0 });
      }
      map.get(id).actualCents += Math.abs(e.amountCents);
    });

    const rows = Array.from(map.values())
      .map(r => ({ ...r, varianceCents: r.actualCents - r.budgetCents }))
      .sort((a,b)=> a.name.localeCompare(b.name));

    const totals = rows.reduce((acc,r)=> {
      acc.budget += r.budgetCents;
      acc.actual += r.actualCents;
      return acc;
    }, {budget:0, actual:0});
    const totalVariance = totals.actual - totals.budget;

    return {
      rows,
      totalBudgetCents: totals.budget,
      totalActualCents: totals.actual,
      totalVarianceCents: totalVariance
    };
  }

  function renderCategorySummary(month){
    const { rows, totalBudgetCents, totalActualCents, totalVarianceCents } = computeCategorySummaryForMonth(month);
    const tbody = document.getElementById('categorySummaryBody');
    const hint = document.getElementById('catSummaryHint');

    tbody.innerHTML = '';

    rows.forEach(r=>{
      const vClass = r.varianceCents > 0 ? 'variance-over'
                   : r.varianceCents < 0 ? 'variance-under' : '';
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escapeHtml(r.name)}</td>
        <td class="right">${formatPHP(r.budgetCents)}</td>
        <td class="right">${formatPHP(r.actualCents)}</td>
        <td class="right ${vClass}">${formatPHP(r.varianceCents)}</td>
      `;
      tbody.appendChild(tr);
    });

    // Totals row
    const vClassTot = totalVarianceCents > 0 ? 'variance-over'
                     : totalVarianceCents < 0 ? 'variance-under' : '';
    const trTot = document.createElement('tr');
    trTot.innerHTML = `
      <td><strong>Total</strong></td>
      <td class="right"><strong>${formatPHP(totalBudgetCents)}</strong></td>
      <td class="right"><strong>${formatPHP(totalActualCents)}</strong></td>
      <td class="right ${vClassTot}"><strong>${formatPHP(totalVarianceCents)}</strong></td>
    `;
    tbody.appendChild(trTot);

    // Hint text
    if (hint){
      hint.textContent = totalActualCents > totalBudgetCents
        ? 'Overspending detected: actual spend exceeds this month’s budget.'
        : 'Within budget so far this month.';
    }
  }

  // ---------- Ledger ----------
  function renderLedgerTable(month){
    const st = getState();
    const ledger = getLedger()
      .filter(e=> monthKeyFromDate(e.date) === month)
      .sort((a,b)=> a.date.localeCompare(b.date));

    const body = $('#ledgerBody');
    body.innerHTML = '';
    if (!ledger.length){
      $('#emptyLedger').classList.remove('hidden');
      return;
    }
    $('#emptyLedger').classList.add('hidden');

    ledger.forEach(e=>{
      const tr = document.createElement('tr');
      const typeLabel = e.kind === 'contribution' ? 'Contribution' : 'Expense';
      const targetLabel = e.kind === 'contribution'
        ? st.people.find(p=>p.id===e.personId)?.name || 'Unknown'
        : st.categories.find(c=>c.id===e.categoryId)?.name || 'Unknown';

      tr.innerHTML = `
        <td>${e.date}</td>
        <td>${typeLabel}</td>
        <td>${escapeHtml(targetLabel)}</td>
        <td class="right">${formatPHP(e.amountCents)}</td>
        <td>${escapeHtml(e.notes||'')}</td>
        <td class="right">
          <button class="icon-btn edit-btn" data-id="${e.id}" title="Edit">✎</button>
          <button class="icon-btn del-btn" data-id="${e.id}" title="Delete">🗑</button>
        </td>
      `;
      body.appendChild(tr);
    });

    // wire edit buttons
    body.querySelectorAll('.edit-btn').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const id = btn.dataset.id;
        openEditEntry(id);
      });
    });

    body.querySelectorAll('.del-btn').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        if (!confirm('Delete this entry?')) return;
        const id = btn.dataset.id;
        const arr = getLedger().filter(x=> x.id !== id);
        setLedger(arr);
        refreshApp();
      });
    });
  }

  // ---------- Entry Modal ----------
  function populateEntryTargetSelect(){
    const st = getState();
    const sel = $('#entryTarget');
    sel.innerHTML = '';

    // People group
    if (st.people.length){
      const optg = document.createElement('optgroup');
      optg.label = 'People (contribution)';
      st.people.forEach(p=>{
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name;
        optg.appendChild(opt);
      });
      sel.appendChild(optg);
    }
    // Categories group
    if (st.categories.length){
      const optg2 = document.createElement('optgroup');
      optg2.label = 'Expense categories';
      st.categories.forEach(c=>{
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = c.name;
        optg2.appendChild(opt);
      });
      sel.appendChild(optg2);
    }
  }

  $('#btnAddEntry').addEventListener('click', ()=>{
    editingEntryId = null; // ensure create mode
    $('#entryDate').value = todayStr();
    populateEntryTargetSelect();
    $('#entryAmount').value = '';
    $('#entryNotes').value = '';
    document.body.classList.add('noscroll');
    $('#entryModal').classList.remove('hidden');
  });
  $('#closeEntryModal').addEventListener('click', ()=>{
    // clear editing state when closing
    editingEntryId = null;
    $('#entryModal').classList.add('hidden');
    document.body.classList.remove('noscroll');
  });

  $('#btnSaveEntry').addEventListener('click', ()=>{
    const date = $('#entryDate').value || todayStr();
    const target = $('#entryTarget').value;
    const amount = parseAmountToCents($('#entryAmount').value);
    const notes = $('#entryNotes').value.trim();

    if (!target){ alert('Pick a person or a category.'); return; }
    if (!amount || amount <= 0){ alert('Enter a positive amount.'); return; }

    const kind = target.startsWith('p:') ? 'contribution' : 'expense';
    // If editing an existing entry, update it; otherwise create new
    const arr = getLedger();
    if (editingEntryId){
      const idx = arr.findIndex(x=> x.id === editingEntryId);
      if (idx !== -1){
        arr[idx].date = date;
        arr[idx].notes = notes;
        arr[idx].amountCents = (kind === 'contribution') ? amount : -amount;
        arr[idx].kind = kind;
        arr[idx].personId = kind === 'contribution' ? target : null;
        arr[idx].categoryId = kind === 'expense' ? target : null;
        arr[idx].updatedAt = new Date().toISOString();
        setLedger(arr);
        // notify cloud of the updated entry
        Cloud.pushEntry(arr[idx]);
      }
    } else {
      const entry = {
        id: uid('tx'),
        date, notes,
        amountCents: kind === 'contribution' ? amount : -amount,
        kind,
        personId: kind==='contribution' ? target : null,
        categoryId: kind==='expense' ? target : null,
        createdAt: new Date().toISOString()
      };
      arr.push(entry);
      setLedger(arr);
      Cloud.pushEntry(entry);
    }

    editingEntryId = null;
    $('#entryModal').classList.add('hidden');
    document.body.classList.remove('noscroll');
    refreshApp();
  });

  // Allow Enter/Return to Save in the Add Entry modal
  (function enableEnterToSaveEntry(){
    const onEnter = (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        document.getElementById('btnSaveEntry').click();
      }
    };
    ['entryDate','entryTarget','entryAmount','entryNotes'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('keydown', onEnter);
    });
  })();

  // ---------- Settings Modal ----------
  $('#btnOpenSettings').addEventListener('click', ()=>{
    renderSettings();
    const ab = document.getElementById('autoBackup');
    if (ab) ab.checked = (localStorage.getItem(LS.BACKUP_PREF) === '1');
    const wh = document.getElementById('backupWebhook');
    if (wh) wh.value = localStorage.getItem(LS.BACKUP_WEBHOOK) || '';
    // Reattach export/import listeners in case DOM was re-rendered
    if (typeof attachExportImportHandlers === 'function') attachExportImportHandlers();
    document.body.classList.add('noscroll');
    $('#settingsModal').classList.remove('hidden');
  });
  $('#closeSettingsModal').addEventListener('click', ()=>{
    $('#settingsModal').classList.add('hidden');
    document.body.classList.remove('noscroll');
  });
  $('#btnSettingsReset').addEventListener('click', ()=>{
    if (!confirm('This will clear all data saved locally. Continue?')) return;
    document.body.classList.remove('noscroll');
    localStorage.removeItem(LS.STATE);
    localStorage.removeItem(LS.LEDGER);
    localStorage.removeItem(LS.LAST_MONTH);
    location.reload();
  });

  function renderSettings(){
    const st = getState();

    // People
    const wrapP = $('#settingsPeople');
    wrapP.innerHTML = '';
    st.people.forEach(p=>{
      const div = document.createElement('div');
      div.className = 'item';
      div.innerHTML = `
        <input data-id="${p.id}" class="set-person-name" type="text" value="${p.name}" />
        <div class="actions">
          <button class="icon-btn del-set-person" data-id="${p.id}" title="Remove">🗑</button>
        </div>
      `;
      wrapP.appendChild(div);
    });

    // Categories
    const wrapC = $('#settingsCategories');
    wrapC.innerHTML = '';
    st.categories.forEach(c=>{
      const div = document.createElement('div');
      div.className = 'item';
      div.innerHTML = `
        <input data-id="${c.id}" class="set-cat-name" type="text" value="${c.name}" />
        <input data-id="${c.id}" class="set-cat-budget right" type="number" step="0.01" min="0" value="${(c.budgetCents/100).toFixed(2)}" />
        <div class="actions">
          <button class="icon-btn del-set-cat" data-id="${c.id}" title="Remove">🗑</button>
        </div>
      `;
      wrapC.appendChild(div);
    });

    // Bind adders
    $('#btnSettingsAddPerson').onclick = ()=>{
      const name = $('#settingsNewPerson').value.trim();
      if (!name) return;
      if (st.people.some(p=> p.name.toLowerCase() === name.toLowerCase())) {
        alert('That person already exists.'); return;
      }
      st.people.push({ id: `p:${uid()}`, name });
      setState(st);
      $('#settingsNewPerson').value = '';
      renderSettings();
      refreshApp();
    };

    $('#btnSettingsAddCat').onclick = ()=>{
      const name = $('#settingsNewCatName').value.trim();
      const amt = parseAmountToCents($('#settingsNewCatBudget').value);
      if (!name) return;
      if (st.categories.some(c=> c.name.toLowerCase() === name.toLowerCase())) {
        alert('That category already exists.'); return;
      }
      st.categories.push({ id: `c:${uid()}`, name, budgetCents: amt });
      setState(st);
      $('#settingsNewCatName').value = '';
      $('#settingsNewCatBudget').value = '';
      renderSettings();
      refreshApp();
    };

    // Inline edits + deletes
    wrapP.addEventListener('input', (e)=>{
      if (e.target.classList.contains('set-person-name')){
        const id = e.target.dataset.id;
        const p = st.people.find(x=>x.id===id);
        if (p){ p.name = e.target.value; setState(st); refreshApp(); }
      }
    });
    wrapP.addEventListener('click', (e)=>{
      if (e.target.classList.contains('del-set-person')){
        const id = e.target.dataset.id;
        if (st.people.length === 1){ alert('At least one person is required.'); return; }
        st.people = st.people.filter(x=> x.id !== id);
        setState(st); renderSettings(); refreshApp();
      }
    });

    wrapC.addEventListener('input', (e)=>{
      if (e.target.classList.contains('set-cat-name')){
        const id = e.target.dataset.id;
        const c = st.categories.find(x=>x.id===id);
        if (c){ c.name = e.target.value; setState(st); refreshApp(); }
      }
      if (e.target.classList.contains('set-cat-budget')){
        const id = e.target.dataset.id;
        const c = st.categories.find(x=>x.id===id);
        if (c){ c.budgetCents = parseAmountToCents(e.target.value); setState(st); refreshApp(); }
      }
    });
    wrapC.addEventListener('click', (e)=>{
      if (e.target.classList.contains('del-set-cat')){
        const id = e.target.dataset.id;
        if (st.categories.length === 1){ alert('At least one category is required.'); return; }
        st.categories = st.categories.filter(x=>x.id!==id);
        setState(st); renderSettings(); refreshApp();
      }
    });
  }

  $('#btnSettingsSave').addEventListener('click', ()=>{
    // Backups removed from settings
    $('#settingsModal').classList.add('hidden');
    document.body.classList.remove('noscroll');
    refreshApp();
  });

  // ---------- Google Sheets Hooks (for later) ----------
  async function pushToSheets(){ /* stub */ }
  async function pullFromSheets(){ /* stub */ }

  // Web webhook helpers (simple fetch wrapper)
  const API = 'https://script.google.com/macros/s/AKfycbzt8xAISwfAMgINUaHO31RHDzyzhMeCoyLvWVFwK-ZHrz4fxePyAaG8g-B03BfBDad9Vw/exec';

  async function fetchEntries(){
    const r = await fetch(API);
    return (await r.json()).data;
  }

  async function addEntry(entry){
    await fetch(API, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify(entry)
    });
  }

  // ---------- Helpers ----------
  function escapeHtml(s){
    return String(s || '').replace(/[&<>"']/g, m=>({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[m]));
  }

  // Press Enter/Return to "Add" when adding categories (Setup & Settings)
  (function bindEnterForCategoryAdd(){
    const container = document.getElementById('categoryList');
    const addBtn = document.getElementById('btnAddCategory');
    if (!container || !addBtn) return;

    // Intercept Enter key inside any input within the category list/add-row.
    // Instead of moving focus to the amount field, we add the category and
    // focus the name input of the newly created add-row.
    container.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const tgt = e.target;
      if (!tgt || (tgt.tagName !== 'INPUT' && tgt.tagName !== 'TEXTAREA')) return;
      e.preventDefault();
      // Trigger the same action as clicking the Add Category button
      addBtn.click();

      // After the new row is created, focus its name input. Small timeout
      // ensures DOM insertion by existing add handler has completed.
      setTimeout(() => {
        const newName = container.querySelector('.add-row input[type="text"], .add-row input');
        if (newName) newName.focus();
      }, 50);
    });
  })();

  // Export/Import JSON in Settings (guarded handlers)
  function attachExportImportHandlers(){
    const settingsModal = document.getElementById('settingsModal');

    // Helper to download payload
    const doDownload = (filename, obj) => {
      try{
        const payload = JSON.stringify(obj, null, 2);
        const ts = new Date().toISOString().replace(/[:.]/g,'-');
        const blob = new Blob([payload], {type:'application/json'});
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = filename || `trackr-backup-${ts}.json`; a.click(); URL.revokeObjectURL(url);
      }catch(e){ alert('Export failed'); }
    };

    // --- settings modal buttons (existing IDs)
    const expBtn = document.getElementById('btnSettingsExportJSON');
    const impBtn = document.getElementById('btnSettingsImportJSON');
    const fileInput = document.getElementById('settingsImportFile');

    if (expBtn){
      expBtn.replaceWith(expBtn.cloneNode(true));
      const newExp = document.getElementById('btnSettingsExportJSON');
      if (newExp) newExp.addEventListener('click', ()=> doDownload(`trackr-backup-${new Date().toISOString().slice(0,10)}.json`, { state: getState(), ledger: getLedger() }));
    }

    if (impBtn && fileInput){
      impBtn.replaceWith(impBtn.cloneNode(true));
      const newImp = document.getElementById('btnSettingsImportJSON');
      if (newImp) newImp.addEventListener('click', ()=> fileInput.click());

      const fiClone = fileInput.cloneNode(true);
      fileInput.parentNode.replaceChild(fiClone, fileInput);
      // shared import handler that accepts several shapes:
      // - { state: {...}, ledger: [...] }
      // - raw state object (contains people/categories)
      // - an array (treated as ledger)
      function handleImportText(text){
        let parsed;
        try{ parsed = JSON.parse(text); }catch(err){ console.error('Parse error', err); alert('Could not parse JSON'); return; }
        console.log('Import parsed', parsed);
        // If wrapper with state/ledger
        if (parsed && typeof parsed === 'object' && (parsed.state || parsed.ledger)){
          if (parsed.state && typeof parsed.state === 'object') setState(parsed.state);
          if (Array.isArray(parsed.ledger)) setLedger(parsed.ledger);
          else if (parsed.ledger) { alert('Imported ledger invalid (expected array)'); return; }
          refreshApp();
          if (settingsModal){ settingsModal.classList.add('hidden'); document.body.classList.remove('noscroll'); }
          alert('Import successful');
          return;
        }
        // If array -> treat as ledger
        if (Array.isArray(parsed)){
          setLedger(parsed);
          refreshApp();
          if (settingsModal){ settingsModal.classList.add('hidden'); document.body.classList.remove('noscroll'); }
          alert('Imported ledger successfully');
          return;
        }
        // If object that looks like state (has people & categories)
        if (parsed && typeof parsed === 'object' && (parsed.people || parsed.categories)){
          setState(parsed);
          refreshApp();
          if (settingsModal){ settingsModal.classList.add('hidden'); document.body.classList.remove('noscroll'); }
          alert('Imported state successfully');
          return;
        }
        alert('Unrecognized JSON structure. Expected {state,ledger}, a state object, or an array ledger.');
      }

      fiClone.addEventListener('change', (ev)=>{
        const f = ev.target.files && ev.target.files[0]; if (!f) return;
        const reader = new FileReader();
        reader.onload = (e) => handleImportText(String(e.target.result));
        reader.onerror = (e)=> { console.error('FileReader error', e); alert('Failed to read file'); };
        reader.readAsText(f);
        ev.target.value = '';
      });
    }

    // --- support for alternative IDs requested by user ---
    // Export button with id 'btnExportJson'
    const altExp = document.getElementById('btnExportJson');
    if (altExp){
      altExp.onclick = ()=>{
        const filename = `Trackr-backup-${new Date().toISOString().slice(0,10)}.json`;
        doDownload(filename, { state: getState(), ledger: getLedger() });
      };
    }

    // Import input with id 'importJson'
    const altImp = document.getElementById('importJson');
    if (altImp){
      altImp.onchange = (e)=>{
        const file = e.target.files && e.target.files[0]; if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev)=> handleImportText(String(ev.target.result));
        reader.onerror = (ev)=> { console.error('FileReader error', ev); alert('Failed to read file'); };
        reader.readAsText(file);
      };
    }
   }
   // initial attach
   attachExportImportHandlers();

  // Expose a simple export function for inline onclick wiring
  window.doExport = function(){
    try{
      const payload = JSON.stringify({ state: getState(), ledger: getLedger() }, null, 2);
      const ts = new Date().toISOString().replace(/[:.]/g,'-');
      const blob = new Blob([payload], {type:'application/json'});
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `trackr-backup-${ts}.json`; a.click(); URL.revokeObjectURL(url);
    }catch(e){ alert('Export failed'); }
  };
})();
