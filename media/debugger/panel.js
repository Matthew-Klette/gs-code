// GS Code Debugger webview. Everything shown comes from arbitrary web pages, so the DOM is built with
// textContent only (never innerHTML).
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const saved = vscode.getState() || {};
  let selected = saved.selected;
  let lastDetail;
  let running = false;

  function el(tag, props, children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'text') node.textContent = String(value);
      else if (key === 'class') node.className = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children || []) if (child) node.append(child);
    return node;
  }

  function status(text, isError) {
    const node = $('status');
    node.textContent = text || '';
    node.classList.toggle('error', !!isError);
  }

  function setRunning(value) {
    running = value;
    $('reload').disabled = !value;
    $('stop').disabled = !value;
    $('start').textContent = value ? 'Restart' : 'Start';
    $('pushJson').disabled = !value;
  }

  // ---- toolbar
  $('url').value = saved.url || '';
  $('mode').value = saved.mode || 'workspace';
  $('toolbar').addEventListener('submit', (event) => {
    event.preventDefault();
    const url = $('url').value.trim();
    const mode = $('mode').value;
    vscode.setState({ ...vscode.getState(), url, mode });
    status(mode === 'workspace' ? 'Starting (preparing the workspace preview)…' : 'Starting…');
    vscode.postMessage({ type: 'start', url, mode });
  });
  $('reload').addEventListener('click', () => vscode.postMessage({ type: 'reload' }));
  $('stop').addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
  $('openLast').addEventListener('click', () => vscode.postMessage({ type: 'openLast' }));
  $('live').addEventListener('click', () => selected !== undefined && vscode.postMessage({ type: 'select', seq: selected, live: true }));
  $('onlyRelevant').addEventListener('change', () => lastDetail && renderTags(lastDetail));
  $('pushForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const json = $('pushJson').value.trim();
    try {
      const parsed = JSON.parse(json);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Push an object, e.g. {"event":"purchase"}');
      vscode.postMessage({ type: 'push', json });
    } catch (error) {
      status(`Not valid JSON: ${error.message}`, true);
    }
  });

  // ---- tabs (arrow keys move between tabs, as in VS Code)
  const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
  function selectTab(tab) {
    for (const item of tabs) {
      const on = item === tab;
      item.setAttribute('aria-selected', String(on));
      item.tabIndex = on ? 0 : -1;
      $(item.getAttribute('aria-controls')).hidden = !on;
    }
    vscode.setState({ ...vscode.getState(), tab: tab.id });
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectTab(tab));
    tab.addEventListener('keydown', (event) => {
      const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      if (!step) return;
      const next = tabs[(index + step + tabs.length) % tabs.length];
      selectTab(next);
      next.focus();
    });
  });
  selectTab($(saved.tab || 'tab-tags') || tabs[0]);

  // ---- timeline
  function renderTimeline(message) {
    const list = $('events');
    list.replaceChildren();
    $('eventsEmpty').hidden = message.events.length > 0;
    for (const page of message.pages) {
      const containers = page.containers && page.containers.length ? ` · ${page.containers.join(', ')}` : '';
      list.append(el('li', { class: 'page-head', text: `Page ${page.page}: ${page.title || page.url}${containers}`, title: page.url }));
      for (const event of message.events.filter((item) => item.page === page.page)) {
        const badges = el('span', { class: 'badges' }, [
          event.fired ? el('span', { class: 'badge', title: `${event.fired} tag(s) fired`, text: `${event.fired} ✔` }) : null,
          event.failed ? el('span', { class: 'badge fail', title: `${event.failed} tag(s) failed`, text: `${event.failed} ✘` }) : null,
          event.hits ? el('span', { class: 'badge', title: `${event.hits} network hit(s)`, text: `${event.hits} ↗` }) : null,
        ]);
        const button = el(
          'button',
          {
            class: 'event',
            type: 'button',
            'aria-current': event.seq === selected ? 'true' : 'false',
            onclick: () => select(event.seq),
          },
          [el('span', { class: 'seq', text: `#${event.seq}` }), el('span', { class: `name${event.command ? ' command' : ''}`, text: event.event }), badges],
        );
        list.append(el('li', {}, [button]));
      }
    }
    for (const note of message.notes || []) if (note.level !== 'info') status(note.message, note.level === 'error');
  }

  function select(seq) {
    selected = seq;
    vscode.setState({ ...vscode.getState(), selected: seq });
    for (const node of document.querySelectorAll('.event')) node.setAttribute('aria-current', node.querySelector('.seq').textContent === `#${seq}` ? 'true' : 'false');
    vscode.postMessage({ type: 'select', seq });
  }

  // ---- detail
  function json(value) {
    return JSON.stringify(value, (key, item) => (item && typeof item === 'object' && item.__element ? `<${item.__element.tag}${item.__element.id ? '#' + item.__element.id : ''}>` : item && item.__undefined ? undefined : item), 2);
  }

  function renderDetail(message) {
    lastDetail = message;
    $('detailEmpty').hidden = true;
    $('detail').hidden = false;
    const event = message.event;
    $('detailTitle').textContent = `#${event.seq} ${event.event || '(message)'}`;
    $('detailMeta').textContent = `${event.url}${event.uniqueEventId !== undefined ? ` · gtm.uniqueEventId ${event.uniqueEventId}` : ''}${message.live ? ' · variables evaluated in the page now' : ''}`;
    renderTags(message);
    renderHits(message.hits);
    $('model').textContent = json(event.model);
    $('pushed').textContent = json(event.pushed);
    renderConsent(event.consent);
  }

  const MARK = { fires: '✔', 'does-not-fire': '✘', unknown: '?' };

  function fileButton(file) {
    return el('button', { class: 'link', type: 'button', title: `Open ${file}`, text: file, onclick: () => vscode.postMessage({ type: 'openFile', file }) });
  }

  function renderTags(message) {
    const list = $('tags');
    list.replaceChildren();
    const only = $('onlyRelevant').checked;
    const items = message.explanations.filter((item) => !only || item.observed || item.verdict !== 'does-not-fire');
    if (items.length === 0) list.append(el('li', { class: 'empty', text: only ? 'No tag fired or would fire on this event. Untick the filter to see why each tag did not.' : 'No tags in the mirror.' }));
    for (const item of items) {
      const observed = item.observed ? el('span', { class: 'observed', text: `GTM: ${item.observed}` }) : null;
      const summary = el('summary', {}, [
        el('span', { class: `verdict ${item.verdict}`, 'aria-label': item.verdict, text: MARK[item.verdict] }),
        el('span', {}, [el('span', { class: 'title', text: item.tag }), observed, el('span', { class: 'summary', text: item.summary })]),
      ]);
      const checks = el('ul', { class: 'checks' });
      for (const check of [...item.firing.map((c) => ({ ...c, role: 'fires on' })), ...item.blocking.map((c) => ({ ...c, role: 'blocked by' }))]) {
        const state = check.matched === true ? 'matches' : check.matched === false ? 'no match' : 'unknown';
        const conditions = el('ul', { class: 'conditions' });
        for (const condition of check.conditions) {
          const mark = condition.result === true ? '✔' : condition.result === false ? '✘' : '?';
          conditions.append(
            el('li', { 'data-mark': mark }, [
              document.createTextNode(`${condition.text} ← `),
              el('span', { class: 'value', text: JSON.stringify(condition.left.value) ?? 'undefined' }),
              el('span', { class: 'source', text: ` (${condition.left.source})` }),
            ]),
          );
        }
        checks.append(
          el('li', {}, [
            document.createTextNode(`${check.role} "${check.trigger}": ${state}, ${check.reason} `),
            check.file ? fileButton(check.file) : null,
            check.conditions.length ? conditions : null,
          ]),
        );
      }
      for (const note of item.notes) checks.append(el('li', { text: `Note: ${note}` }));
      checks.append(el('li', {}, [document.createTextNode('Tag file: '), fileButton(item.file)]));
      list.append(el('li', { class: 'tag' }, [el('details', {}, [summary, checks])]));
    }
  }

  function renderHits(hits) {
    const list = $('hits');
    list.replaceChildren();
    if (hits.length === 0) list.append(el('li', { class: 'empty', text: 'No measurement hits were sent during this event.' }));
    for (const hit of hits) {
      const params = el('table', {}, [
        ...Object.entries(hit.events[0] || {})
          .slice(0, 40)
          .map(([key, value]) => el('tr', {}, [el('th', { scope: 'row', text: key }), el('td', { text: value })])),
      ]);
      const client = hit.client ? el('div', { text: `Server container client: ${hit.client.client || '?'} (${hit.client.confidence}, ${hit.client.reason})` }) : null;
      const cookies = hit.setCookies && hit.setCookies.length ? el('div', { text: `Set-Cookie: ${hit.setCookies.map((cookie) => cookie.split(';')[0]).join(', ')}` }) : null;
      list.append(
        el('li', { class: 'hit' }, [
          el('div', {}, [
            el('span', { class: 'vendor', text: `${hit.vendor}${hit.firstParty ? ' (first-party)' : ''}` }),
            document.createTextNode(` ${hit.name || ''} ${hit.id || ''} · ${hit.status ?? 'pending'}${hit.events.length > 1 ? ` · ${hit.events.length} events in one request` : ''}`),
          ]),
          el('div', { class: 'url', text: hit.url }),
          client,
          cookies,
          el('details', {}, [el('summary', { text: 'Parameters' }), params]),
        ]),
      );
    }
  }

  function renderConsent(consent) {
    const table = $('consent');
    table.replaceChildren(el('tr', {}, [el('th', { scope: 'col', text: 'Type' }), el('th', { scope: 'col', text: 'State at this event' })]));
    const entries = Object.entries(consent || {});
    if (entries.length === 0) table.append(el('tr', {}, [el('td', { colspan: '2', class: 'empty', text: 'No Consent Mode state seen yet.' })]));
    for (const [type, granted] of entries) {
      const text = granted === true ? 'granted' : granted === false ? 'denied' : 'not set';
      table.append(el('tr', {}, [el('td', { text: type }), el('td', { class: granted === true ? 'granted' : granted === false ? 'denied' : '', text })]));
    }
  }

  // ---- messages from the extension
  window.addEventListener('message', (event) => {
    const message = event.data;
    switch (message.type) {
      case 'session':
        setRunning(message.running);
        if (message.url && !$('url').value) $('url').value = message.url;
        if (message.running) status(`Recording ${message.mode === 'workspace' ? `the draft of "${message.workspace}"` : 'the live container'} (${message.container || ''}).`);
        else if (message.url) status('Stopped. The session is saved; agents can still read it.');
        break;
      case 'timeline':
        renderTimeline(message);
        break;
      case 'detail':
        if (message.event.seq === selected) renderDetail(message);
        break;
      case 'status':
        status(message.text);
        break;
      case 'error':
        status(message.text, true);
        break;
    }
  });

  setRunning(false);
  vscode.postMessage({ type: 'ready' });
  if (selected !== undefined) vscode.postMessage({ type: 'select', seq: selected });
})();
