// 브라우저 컨텍스트에서 실행한다. 외부 클로저·라이브러리를 참조하지 않는다.
export async function snapshotDOM(options = {}) {
  const squash = (x) => (x ?? '').replace(/\s+/g, ' ').trim();
  const round = (n) => Math.round(n * 100) / 100;
  const locator = (el) => {
    if (el.id && document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) return `#${CSS.escape(el.id)}`;
    const parts = [];
    for (let x = el; x && x !== document.body; x = x.parentElement) {
      parts.unshift(`${x.tagName.toLowerCase()}:nth-of-type(${[...x.parentElement.children].filter(c => c.tagName === x.tagName).indexOf(x) + 1})`);
    }
    return `body > ${parts.join(' > ')}`;
  };
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && !el.closest('[hidden]'); };
  const rect = (r, base) => ({ x: round(r.left - base.left), y: round(r.top - base.top), width: round(r.width), height: round(r.height) });
  const declarations = [];
  const walkRules = (rules) => { for (const rule of rules) { if (rule.selectorText && rule.style) declarations.push(rule); else if (rule.cssRules && (!rule.conditionText || !rule.media || matchMedia(rule.conditionText).matches)) walkRules(rule.cssRules); } };
  for (const sheet of document.styleSheets) { try { walkRules(sheet.cssRules); } catch { /* cross-origin CSS: 계산값·테마 유지 */ } }
  const color = (el, prop, computed) => {
    const candidateTokens = [];
    for (const rule of declarations) {
      try { if (el.matches(rule.selectorText)) for (const v of rule.style.getPropertyValue(prop).matchAll(/var\(\s*(--[\w-]+)/g)) candidateTokens.push({ token: v[1], selector: rule.selectorText, declaration: rule.style.getPropertyValue(prop), important: rule.style.getPropertyPriority(prop) === 'important' }); } catch { /* 비요소 선택자 */ }
    }
    for (const inline of el.style.getPropertyValue(prop).matchAll(/var\(\s*(--[\w-]+)/g)) candidateTokens.push({ token: inline[1], selector: 'style attribute', declaration: el.style.getPropertyValue(prop), important: el.style.getPropertyPriority(prop) === 'important' });
    return { candidateTokens, value: computed.getPropertyValue(prop) };
  };
  const root = document.querySelector('[data-conformance-root],main,[role=main]') ?? document.body;
  const elements = new Map();
  const classify = (el) => {
    const role = el.getAttribute('role');
    if (el.matches('button,summary,[role=button]')) return 'button';
    if (el.matches('input,textarea,select')) return 'input';
    if (el.matches('a[href]')) return 'link';
    if (role === 'tab' || role === 'switch') return role;
    if (el.matches('svg,img')) return 'icon';
    if (el.matches('h1,h2,h3,h4,h5,h6')) return 'heading';
    if (el.matches('[data-region],[data-component],section,article,fieldset,[role=group]')) return 'region';
    return 'text';
  };
  const capture = (view) => {
    for (const el of [root, ...root.querySelectorAll('*')]) {
      if (!visible(el) || el.matches('script,style,option,svg *,noscript')) continue;
      const direct = [...el.childNodes].filter(x => x.nodeType === Node.TEXT_NODE && squash(x.textContent));
      const kind = classify(el);
      if (kind === 'text' && direct.length === 0) continue;
      const key = locator(el);
      if (elements.has(key)) continue;
      const s = getComputedStyle(el);
      const reference = el.parentElement?.closest('button,summary,[role=button],details,fieldset,[data-region],section,article,[role=group]') ?? root;
      const base = reference.getBoundingClientRect();
      const own = el.getBoundingClientRect();
      const style = Object.fromEntries(['font-size', 'font-weight', 'line-height', 'height', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'gap', 'border-radius', 'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width', 'border-top-style', 'text-decoration-line', 'display', 'align-items', 'justify-content'].map(p => [p, s.getPropertyValue(p)]));
      for (const p of ['color', 'background-color', 'border-top-color']) style[p] = color(el, p, s);
      const textRects = direct.map(node => { const range = document.createRange(); range.selectNodeContents(node); return { text: squash(node.textContent), rect: rect(range.getBoundingClientRect(), own) }; });
      const classes = [...el.classList].sort();
      const componentName = el.dataset.component ?? null;
      const tokens = [...new Set(classes.flatMap(c => c.match(/--[\w-]+/g) ?? []))].sort().map(name => ({ name, value: s.getPropertyValue(name).trim(), definitions: declarations.filter(r => r.style.getPropertyValue(name)).map(r => ({ selector: r.selectorText, value: r.style.getPropertyValue(name).trim() })) }));
      const utilities = classes.filter(c => /^(?:!?[wh]-|min-[wh]-|max-[wh]-|p[xytrbl]?-|m[xytrbl]?-|gap-|rounded-)/.test(c));
      elements.set(key, { id: `E${elements.size + 1}`, locator: key, order: elements.size, kind, tag: el.tagName.toLowerCase(), text: squash(direct.map(x => x.textContent).join(' ')) || (['button', 'link', 'tab', 'switch'].includes(kind) ? squash(el.textContent) : ''), label: el.getAttribute('aria-label') ?? el.getAttribute('alt') ?? '', classes, utilities, tokens, attributes: Object.fromEntries(['placeholder', 'type', 'name', 'role', 'aria-label', 'href'].filter(p => el.hasAttribute(p)).map(p => [p, el.getAttribute(p)])), reference: { locator: locator(reference), kind: classify(reference), label: reference.getAttribute('aria-label') ?? squash(reference.querySelector('h1,h2,h3')?.textContent) }, rect: rect(own, base), textRects, style, componentName, sizeAttribute: el.dataset.size ?? null, variantAttribute: el.dataset.variant ?? null, componentHint: null, view });
    }
  };
  const settle = () => new Promise(r => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(r)), 100));
  const triggers = [...root.querySelectorAll('summary,[aria-expanded],[role=tab],[role=switch],input[type=checkbox],button')].filter(el => {
    if (el.matches('a,[type=submit]') || el.disabled || !visible(el)) return false;
    return el.matches('summary,[aria-expanded],[role=tab],[role=switch],input[type=checkbox]') || [...el.attributes].some(a => /(?:trigger|toggle)$/.test(a.name) && a.name.startsWith('data-')) || /accordion-trigger/.test(el.className);
  });
  const groups = new Map();
  for (const el of triggers) {
    const kind = el.matches('[role=tab]') ? 'tabs' : el.matches('[role=switch],input[type=checkbox]') ? 'toggle' : 'accordion';
    let group = kind === 'tabs' ? el.closest('[role=tablist]') : null;
    if (!group && kind !== 'toggle') {
      for (let p = el.parentElement; p && p !== root.parentElement; p = p.parentElement) {
        if (triggers.filter(t => p.contains(t) && (kind === 'accordion' ? !t.matches('[role=tab],[role=switch],input') : true)).length > 1) { group = p; break; }
      }
    }
    group ??= el.parentElement;
    const key = `${kind}:${locator(group)}`;
    if (!groups.has(key)) groups.set(key, { kind, group, triggers: [] });
    groups.get(key).triggers.push(el);
  }
  const state = (el) => {
    if (el.matches('summary')) return el.parentElement.open;
    if (el.matches('input')) return el.checked;
    for (const attr of ['aria-expanded', 'aria-selected', 'aria-checked']) if (el.hasAttribute(attr)) return el.getAttribute(attr) === 'true';
    if (el.hasAttribute('data-state')) return ['open', 'active', 'on', 'checked'].includes(el.dataset.state);
    const item = el.closest('[data-state]');
    if (item) return ['open', 'active', 'on', 'checked'].includes(item.dataset.state);
    const target = el.getAttribute('aria-controls');
    if (target && document.getElementById(target)) return visible(document.getElementById(target));
    return null;
  };
  capture('initial');
  const interactions = [];
  for (const g of options.probe === false ? [] : groups.values()) {
    const id = `I${interactions.length + 1}`;
    const items = g.triggers.map(el => ({ locator: locator(el), label: squash(el.textContent) || el.getAttribute('aria-label') || el.getAttribute('name') || '' }));
    const initial = g.triggers.map(state);
    const steps = [];
    const click = async (i) => { g.triggers[i].click(); await settle(); const states = g.triggers.map(state); steps.push({ clicked: i, states }); capture(`${id}:${i}`); return states; };
    // 초기 상태와 독립적으로 첫 두 항목을 순서대로 연다.
    if (state(g.triggers[0]) === true && g.kind !== 'tabs') await click(0);
    const first = await click(0);
    let second = null;
    if (g.triggers.length > 1) {
      if (state(g.triggers[1]) === true && g.kind !== 'tabs') await click(1);
      second = await click(1);
    }
    const lastIndex = second ? 1 : 0;
    const beforeReclick = g.triggers.map(state);
    const afterReclick = await click(lastIndex);
    const openPolicy = second?.[1] === true && second[0] !== null ? (second[0] ? 'multi' : 'single') : 'unknown';
    const reclick = beforeReclick[lastIndex] === true && afterReclick[lastIndex] !== null ? (afterReclick[lastIndex] ? 'stay' : 'close') : 'unknown';
    for (let i = 2; i < g.triggers.length; i++) if (state(g.triggers[i]) !== true) await click(i);
    for (let i = 0; i < initial.length; i++) if (initial[i] !== null && state(g.triggers[i]) !== initial[i]) { g.triggers[i].click(); await settle(); }
    interactions.push({ id, kind: g.kind, locator: locator(g.group), items, initial, first, openPolicy, reclick, steps });
  }
  const themeRoot = root.closest('[data-theme],.dark,.light') ?? document.documentElement;
  const theme = themeRoot.dataset.theme ?? (themeRoot.classList.contains('dark') ? 'dark' : themeRoot.classList.contains('light') ? 'light' : null) ?? (getComputedStyle(themeRoot).colorScheme.includes('dark') ? 'dark' : (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  return { reference: locator(root), theme, elements: [...elements.values()], interactions };
}
