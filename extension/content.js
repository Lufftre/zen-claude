/* Claude for Zen – content script.
 * Builds the element tree, resolves refs and synthesizes input. */

if (!window.__zenClaudeLoaded) {
  window.__zenClaudeLoaded = true;

  // -------------------------------------------------------------------------
  // Console capture (patches the page's console through Xray wrappers)

  const consoleBuffer = [];
  const MAX_CONSOLE = 1000;

  function formatArg(a) {
    if (typeof a === 'string') return a;
    if (a instanceof Error || (a && typeof a === 'object' && 'stack' in a && 'message' in a)) {
      return `${a.name || 'Error'}: ${a.message}${a.stack ? `\n${a.stack}` : ''}`;
    }
    try {
      const s = JSON.stringify(a);
      if (s !== undefined && s !== '{}') return s;
    } catch {}
    return String(a);
  }

  function record(level, args) {
    consoleBuffer.push({ time: Date.now(), level, text: Array.from(args, formatArg).join(' ') });
    if (consoleBuffer.length > MAX_CONSOLE) consoleBuffer.shift();
  }

  try {
    const pageWindow = window.wrappedJSObject;
    const pageConsole = pageWindow.console;
    for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
      const original = pageConsole[level];
      exportFunction(function (...args) {
        try { record(level, args); } catch {}
        // The page can't read a content-script array, so hand the arguments back in a page-owned one.
        const pageArgs = new pageWindow.Array();
        for (const a of args) pageArgs.push(a);
        return pageWindow.Reflect.apply(original, pageConsole, pageArgs);
      }, pageConsole, { defineAs: level });
    }
  } catch {}

  window.addEventListener('error', (e) => {
    record('error', [`Uncaught ${e.message}${e.filename ? ` (${e.filename}:${e.lineno}:${e.colno})` : ''}`]);
  });
  window.addEventListener('unhandledrejection', (e) => {
    record('error', ['Unhandled promise rejection:', e.reason]);
  });

  // -------------------------------------------------------------------------
  // Refs

  const refs = new Map(); // id -> WeakRef<Element>
  const elementRefs = new WeakMap(); // Element -> id
  let nextRef = 1;

  function refFor(el) {
    let id = elementRefs.get(el);
    if (!id) {
      id = `ref_${nextRef++}`;
      elementRefs.set(el, id);
      refs.set(id, new WeakRef(el));
    }
    return id;
  }

  function resolveRef(id) {
    const el = refs.get(id)?.deref();
    if (!el || !el.isConnected) {
      throw new Error(`Element ${id} not found or no longer on the page. Call read_page or find again.`);
    }
    return el;
  }

  // -------------------------------------------------------------------------
  // Roles, names, visibility

  const INPUT_ROLES = {
    button: 'button', submit: 'button', reset: 'button', image: 'button',
    checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton',
    search: 'searchbox', email: 'textbox', tel: 'textbox', text: 'textbox', url: 'textbox', password: 'textbox',
    file: 'button', color: 'button', date: 'textbox', 'datetime-local': 'textbox', month: 'textbox',
    time: 'textbox', week: 'textbox',
  };
  const TAG_ROLES = {
    BUTTON: 'button', SELECT: 'combobox', TEXTAREA: 'textbox', H1: 'heading', H2: 'heading', H3: 'heading',
    H4: 'heading', H5: 'heading', H6: 'heading', IMG: 'img', NAV: 'navigation', MAIN: 'main', HEADER: 'banner',
    FOOTER: 'contentinfo', ASIDE: 'complementary', FORM: 'form', UL: 'list', OL: 'list', LI: 'listitem',
    TABLE: 'table', TR: 'row', TH: 'columnheader', TD: 'cell', DIALOG: 'dialog', OPTION: 'option',
    SUMMARY: 'button', IFRAME: 'iframe', VIDEO: 'video', AUDIO: 'audio', P: 'paragraph',
  };
  const INTERACTIVE_ROLES = new Set([
    'button', 'link', 'checkbox', 'radio', 'textbox', 'searchbox', 'combobox', 'listbox', 'option', 'menuitem',
    'menuitemcheckbox', 'menuitemradio', 'tab', 'switch', 'slider', 'spinbutton', 'treeitem',
  ]);
  // Elements whose name already summarises their content.
  const LEAF_ROLES = new Set([
    'button', 'link', 'heading', 'textbox', 'searchbox', 'checkbox', 'radio', 'option', 'menuitem', 'tab',
    'switch', 'img', 'combobox', 'slider', 'spinbutton',
  ]);
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'PATH', 'META', 'LINK', 'HEAD']);

  function roleOf(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.split(/\s+/)[0];
    if (el.tagName === 'A') return el.hasAttribute('href') ? 'link' : null;
    if (el.tagName === 'INPUT') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'hidden') return null;
      return INPUT_ROLES[type] || 'textbox';
    }
    if (el.isContentEditable && (el.parentElement == null || !el.parentElement.isContentEditable)) return 'textbox';
    return TAG_ROLES[el.tagName] || null;
  }

  const clean = (s, max = 100) => {
    s = (s || '').replace(/\s+/g, ' ').trim();
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
  };

  function nameOf(el, role) {
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy.split(/\s+/).map((id) => el.ownerDocument.getElementById(id)?.textContent || '').join(' ');
      if (text.trim()) return clean(text);
    }
    if (el.labels?.length) return clean(Array.from(el.labels, (l) => l.textContent).join(' '));
    if (el.tagName === 'IMG') return clean(el.getAttribute('alt') || el.getAttribute('title'));
    if (el.tagName === 'INPUT' && ['button', 'submit', 'reset'].includes(el.type)) return clean(el.value);
    if (['textbox', 'searchbox', 'combobox', 'spinbutton'].includes(role) || el.tagName === 'SELECT') {
      return clean(el.getAttribute('placeholder') || el.getAttribute('title') || '');
    }
    if (LEAF_ROLES.has(role) || INTERACTIVE_ROLES.has(role)) {
      const text = clean(el.innerText || el.textContent);
      if (text) return text;
      const img = el.querySelector('img[alt]');
      if (img) return clean(img.getAttribute('alt'));
    }
    return clean(el.getAttribute('title') || '');
  }

  function isVisible(el) {
    if (el.checkVisibility) {
      if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    } else {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0 || getComputedStyle(el).display === 'contents';
  }

  function inViewport(el) {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  }

  function isInteractive(el, role) {
    if (INTERACTIVE_ROLES.has(role)) return true;
    if (el.tagName === 'SUMMARY') return true;
    if (el.hasAttribute('onclick') || (el.hasAttribute('tabindex') && el.tabIndex >= 0)) return true;
    return false;
  }

  function details(el, role) {
    const parts = [];
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      if (el.type === 'checkbox' || el.type === 'radio') parts.push(el.checked ? 'checked' : 'unchecked');
      else if (el.type === 'password') parts.push(el.value ? 'value=••••' : 'empty');
      else if (el.value) parts.push(`value="${clean(el.value, 60)}"`);
      if (el.type && el.type !== 'text' && role === 'textbox') parts.push(`type=${el.type}`);
    }
    if (el.tagName === 'SELECT') {
      const opt = el.selectedOptions?.[0];
      if (opt) parts.push(`selected="${clean(opt.textContent, 60)}"`);
      parts.push(`${el.options.length} options`);
    }
    if (role === 'heading') parts.push(`level=${el.getAttribute('aria-level') || el.tagName.slice(1)}`);
    if (role === 'link') {
      const href = el.getAttribute('href');
      if (href && !href.startsWith('javascript:')) parts.push(`href="${clean(href, 80)}"`);
    }
    for (const attr of ['aria-checked', 'aria-selected', 'aria-expanded', 'aria-pressed']) {
      const v = el.getAttribute(attr);
      if (v != null) parts.push(`${attr.slice(5)}=${v}`);
    }
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') parts.push('disabled');
    return parts.length ? ` (${parts.join(', ')})` : '';
  }

  function childrenOf(el) {
    const kids = [];
    if (el.shadowRoot) kids.push(...el.shadowRoot.children);
    if (el.tagName === 'IFRAME') {
      try {
        const body = el.contentDocument?.body;
        if (body) kids.push(body);
      } catch {} // cross-origin
    }
    kids.push(...el.children);
    return kids;
  }

  // -------------------------------------------------------------------------
  // read_page

  function readPage({ filter = 'interactive', ref_id, viewport_only, max_chars = 40000 }) {
    const root = ref_id ? resolveRef(ref_id) : document.body || document.documentElement;
    const lines = [];
    let length = 0;
    let truncated = false;

    const emit = (depth, line) => {
      if (length > max_chars) return (truncated = true);
      const indented = `${'  '.repeat(depth)}${line}`;
      lines.push(indented);
      length += indented.length + 1;
    };

    const walk = (el, depth) => {
      if (truncated || SKIP_TAGS.has(el.tagName?.toUpperCase())) return;
      if (el.getAttribute?.('aria-hidden') === 'true') return;
      if (!isVisible(el)) return;
      const role = roleOf(el);
      const interactive = isInteractive(el, role);
      const include =
        (filter === 'all' ? role != null || interactive : interactive) && (!viewport_only || inViewport(el));
      let childDepth = depth;
      if (include) {
        const name = nameOf(el, role);
        emit(depth, `- ${role || el.tagName.toLowerCase()}${name ? ` "${name}"` : ''} [${refFor(el)}]${details(el, role)}`);
        childDepth = depth + 1;
        if (LEAF_ROLES.has(role) && el.tagName !== 'SELECT') return;
      }
      if (filter === 'all') {
        // Loose text directly inside this element.
        let text = '';
        for (const node of el.childNodes) if (node.nodeType === Node.TEXT_NODE) text += node.textContent;
        text = clean(text, 200);
        if (text && (!viewport_only || inViewport(el))) emit(childDepth, `- text "${text}"`);
      }
      for (const child of childrenOf(el)) walk(child, childDepth);
    };

    walk(root, 0);
    if (!lines.length) {
      return filter === 'interactive'
        ? 'No interactive elements found. Try filter "all", or take a screenshot.'
        : 'No content found.';
    }
    if (truncated) lines.push(`… truncated at ${max_chars} chars; use ref_id or viewport_only to narrow.`);
    return lines.join('\n');
  }

  // -------------------------------------------------------------------------
  // find

  function find({ query }) {
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    const candidates = [];
    const walk = (el) => {
      if (SKIP_TAGS.has(el.tagName?.toUpperCase()) || !isVisible(el)) return;
      const role = roleOf(el);
      if (role || isInteractive(el, role)) {
        const name = nameOf(el, role);
        const haystack = [
          name, role, el.tagName, el.id, el.getAttribute('placeholder'), el.getAttribute('name'),
          el.getAttribute('type'), el.getAttribute('title'), el.getAttribute('href'),
        ].filter(Boolean).join(' ').toLowerCase();
        let score = 0;
        for (const t of tokens) {
          if (name.toLowerCase().includes(t)) score += 3;
          else if (haystack.includes(t)) score += 1;
        }
        if (score > 0) {
          if (isInteractive(el, role)) score += 0.5;
          if (inViewport(el)) score += 0.25;
          candidates.push({ el, role, name, score });
        }
      }
      for (const child of childrenOf(el)) walk(child);
    };
    walk(document.body || document.documentElement);
    candidates.sort((a, b) => b.score - a.score);
    const top = candidates.slice(0, 20);
    if (!top.length) return `No elements matching "${query}". Try read_page with filter "all".`;
    return top
      .map(({ el, role, name }) => {
        const r = el.getBoundingClientRect();
        const pos = `at (${Math.round(r.left + r.width / 2)}, ${Math.round(r.top + r.height / 2)})`;
        return `- ${role || el.tagName.toLowerCase()}${name ? ` "${name}"` : ''} [${refFor(el)}]${details(el, role)} ${pos}`;
      })
      .join('\n');
  }

  // -------------------------------------------------------------------------
  // Pointer / keyboard synthesis

  function deepElementFromPoint(x, y) {
    let doc = document;
    let offsetX = 0;
    let offsetY = 0;
    let el = doc.elementFromPoint(x, y);
    for (;;) {
      if (el?.shadowRoot) {
        const inner = el.shadowRoot.elementFromPoint(x - offsetX, y - offsetY);
        if (inner && inner !== el) { el = inner; continue; }
      }
      if (el?.tagName === 'IFRAME') {
        let innerDoc = null;
        try { innerDoc = el.contentDocument; } catch {}
        if (innerDoc) {
          const r = el.getBoundingClientRect();
          offsetX += r.left + el.clientLeft;
          offsetY += r.top + el.clientTop;
          doc = innerDoc;
          const inner = doc.elementFromPoint(x - offsetX, y - offsetY);
          if (inner) { el = inner; continue; }
        }
      }
      break;
    }
    return { el, x: x - offsetX, y: y - offsetY };
  }

  function target({ coordinate, ref }) {
    if (ref) {
      const el = resolveRef(ref);
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const r = el.getBoundingClientRect();
      return { el, x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    if (!coordinate) throw new Error('Provide coordinate or ref.');
    const [x, y] = coordinate;
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) {
      throw new Error(`Coordinate (${x}, ${y}) is outside the viewport (${innerWidth}x${innerHeight}). Scroll first.`);
    }
    const hit = deepElementFromPoint(x, y);
    if (!hit.el) throw new Error(`No element at (${x}, ${y}).`);
    return hit;
  }

  function parseModifiers(str = '') {
    const m = { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false };
    for (const part of str.toLowerCase().split('+').filter(Boolean)) {
      if (part === 'ctrl' || part === 'control') m.ctrlKey = true;
      else if (part === 'shift') m.shiftKey = true;
      else if (part === 'alt' || part === 'option') m.altKey = true;
      else if (['meta', 'cmd', 'command', 'super', 'win'].includes(part)) m.metaKey = true;
    }
    return m;
  }

  function mouse(el, type, x, y, extra = {}) {
    const view = el.ownerDocument.defaultView;
    const init = {
      bubbles: true, cancelable: true, composed: true, view, clientX: x, clientY: y,
      screenX: x + (view.screenX || 0), screenY: y + (view.screenY || 0), ...extra,
    };
    const isPointer = type.startsWith('pointer');
    const Ctor = isPointer ? view.PointerEvent || PointerEvent : view.MouseEvent || MouseEvent;
    const event = new Ctor(type, isPointer ? { pointerId: 1, pointerType: 'mouse', isPrimary: true, ...init } : init);
    return el.dispatchEvent(event);
  }

  function focusable(el) {
    return el.closest('input, textarea, select, button, a[href], [tabindex], [contenteditable=""], [contenteditable="true"], summary');
  }

  let hovered = null;
  function hoverTo(el, x, y, mods) {
    if (hovered && hovered !== el && hovered.isConnected) {
      mouse(hovered, 'pointerout', x, y, mods);
      mouse(hovered, 'mouseout', x, y, mods);
      mouse(hovered, 'pointerleave', x, y, { ...mods, bubbles: false });
      mouse(hovered, 'mouseleave', x, y, { ...mods, bubbles: false });
    }
    if (hovered !== el) {
      mouse(el, 'pointerover', x, y, mods);
      mouse(el, 'mouseover', x, y, mods);
      mouse(el, 'pointerenter', x, y, { ...mods, bubbles: false });
      mouse(el, 'mouseenter', x, y, { ...mods, bubbles: false });
    }
    mouse(el, 'pointermove', x, y, mods);
    mouse(el, 'mousemove', x, y, mods);
    hovered = el;
  }

  function click(el, x, y, { button = 0, count = 1, mods = {} } = {}) {
    hoverTo(el, x, y, mods);
    const buttons = button === 2 ? 2 : 1;
    for (let detail = 1; detail <= count; detail++) {
      const down = mouse(el, 'pointerdown', x, y, { ...mods, button, buttons, detail }) &&
        mouse(el, 'mousedown', x, y, { ...mods, button, buttons, detail });
      if (down && detail === 1) {
        const f = focusable(el);
        if (f) f.focus({ preventScroll: true });
        else if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
      }
      mouse(el, 'pointerup', x, y, { ...mods, button, buttons: 0, detail });
      mouse(el, 'mouseup', x, y, { ...mods, button, buttons: 0, detail });
      if (button === 0) mouse(el, 'click', x, y, { ...mods, button, buttons: 0, detail });
      else if (button === 2) mouse(el, 'contextmenu', x, y, { ...mods, button, buttons: 0, detail });
    }
    if (count === 2 && button === 0) mouse(el, 'dblclick', x, y, { ...mods, button, detail: 2 });
    if (count === 3 && button === 0) {
      const t = el.closest('input, textarea');
      if (t?.select) t.select();
      else {
        const block = el.closest('p, li, td, div') || el;
        const range = document.createRange();
        range.selectNodeContents(block);
        getSelection().removeAllRanges();
        getSelection().addRange(range);
      }
    }
  }

  function deepActiveElement() {
    let el = document.activeElement;
    for (;;) {
      if (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
      else if (el?.tagName === 'IFRAME') {
        try { el = el.contentDocument.activeElement; } catch { break; }
      } else break;
    }
    return el;
  }

  const isTextInput = (el) =>
    el?.tagName === 'TEXTAREA' ||
    (el?.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'image', 'range', 'color'].includes(el.type));
  const isEditable = (el) => isTextInput(el) || el?.isContentEditable;

  function setNativeValue(el, value) {
    // Assigning through the Xray bypasses setters that frameworks like React install on the instance,
    // so their change tracking notices the new value when the input event arrives.
    el.value = value;
    el.dispatchEvent(new (el.ownerDocument.defaultView.InputEvent || InputEvent)('input', { bubbles: true, composed: true, inputType: 'insertText', data: value }));
  }

  function insertText(el, text) {
    const doc = el.ownerDocument;
    const before = isTextInput(el) ? el.value : el.textContent;
    let ok = false;
    try { ok = doc.execCommand('insertText', false, text); } catch {}
    const after = isTextInput(el) ? el.value : el.textContent;
    if (ok && after !== before) return;
    if (isTextInput(el)) {
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? el.value.length;
      setNativeValue(el, el.value.slice(0, start) + text + el.value.slice(end));
      try { el.setSelectionRange(start + text.length, start + text.length); } catch {}
    } else {
      const sel = doc.getSelection();
      if (sel.rangeCount) {
        const range = sel.getRangeAt(0);
        range.deleteContents();
        range.insertNode(doc.createTextNode(text));
        range.collapse(false);
      } else {
        el.append(text);
      }
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
    }
  }

  function typeText({ text, ref }) {
    if (ref) {
      const el = resolveRef(ref);
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      el.focus();
      if (isTextInput(el)) try { el.setSelectionRange(el.value.length, el.value.length); } catch {}
    }
    const el = deepActiveElement();
    if (!isEditable(el)) {
      throw new Error('No editable element is focused. Click a text field first, or pass its ref.');
    }
    // Per-character key events help sites that listen for keydown/keyup; text goes in via insertText.
    for (const ch of text) {
      const key = ch === '\n' ? 'Enter' : ch;
      const opts = keyInit(key, {});
      const proceed = el.dispatchEvent(new KeyboardEvent('keydown', opts));
      if (proceed) {
        el.dispatchEvent(new KeyboardEvent('keypress', opts));
        if (ch === '\n' && el.tagName === 'INPUT') submitFrom(el);
        else insertText(el, ch === '\n' && el.isContentEditable ? '\n' : ch);
      }
      el.dispatchEvent(new KeyboardEvent('keyup', opts));
    }
    return `Typed ${text.length} character(s) into ${describe(el)}.`;
  }

  const KEY_ALIASES = {
    enter: 'Enter', return: 'Enter', esc: 'Escape', escape: 'Escape', tab: 'Tab', backspace: 'Backspace',
    delete: 'Delete', del: 'Delete', space: ' ', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft',
    right: 'ArrowRight', arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft',
    arrowright: 'ArrowRight', pageup: 'PageUp', pagedown: 'PageDown', page_up: 'PageUp', page_down: 'PageDown',
    home: 'Home', end: 'End', insert: 'Insert',
  };
  const KEY_CODES = { Enter: 13, Escape: 27, Tab: 9, Backspace: 8, Delete: 46, ' ': 32, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, PageUp: 33, PageDown: 34, Home: 36, End: 35 };

  function keyInit(key, mods) {
    let code = key;
    let keyCode = KEY_CODES[key] || 0;
    if (key.length === 1) {
      const upper = key.toUpperCase();
      if (/[A-Z]/.test(upper)) { code = `Key${upper}`; keyCode = upper.charCodeAt(0); }
      else if (/[0-9]/.test(key)) { code = `Digit${key}`; keyCode = key.charCodeAt(0); }
      else if (key === ' ') code = 'Space';
    }
    return {
      key, code, keyCode, which: keyCode, charCode: key.length === 1 ? key.charCodeAt(0) : 0,
      bubbles: true, cancelable: true, composed: true, ...mods,
    };
  }

  function submitFrom(el) {
    const form = el.form || el.closest('form');
    if (!form) return;
    const submitter = form.querySelector('button[type=submit], input[type=submit], button:not([type])');
    if (form.requestSubmit) form.requestSubmit(submitter || undefined);
    else form.submit();
  }

  function tabbables() {
    const sel = 'a[href], button, input:not([type=hidden]), select, textarea, [tabindex], [contenteditable=""], [contenteditable="true"], summary';
    return Array.from(document.querySelectorAll(sel)).filter((e) => e.tabIndex >= 0 && !e.disabled && isVisible(e));
  }

  function pressKey(combo) {
    const parts = combo.split('+');
    const rawKey = parts.pop();
    const mods = parseModifiers(parts.join('+'));
    let key = KEY_ALIASES[rawKey.toLowerCase()] || (/^f\d{1,2}$/i.test(rawKey) ? rawKey.toUpperCase() : rawKey);
    if (key.length === 1 && mods.shiftKey) key = key.toUpperCase();
    const el = deepActiveElement() || document.body;
    const init = keyInit(key, mods);
    const proceed = el.dispatchEvent(new KeyboardEvent('keydown', init));
    const printable = key.length === 1 && !mods.ctrlKey && !mods.metaKey && !mods.altKey;
    if (proceed && (printable || key === 'Enter')) el.dispatchEvent(new KeyboardEvent('keypress', init));
    if (proceed) defaultKeyAction(el, key, mods, printable);
    el.dispatchEvent(new KeyboardEvent('keyup', init));
  }

  function defaultKeyAction(el, key, mods, printable) {
    const doc = el.ownerDocument;
    const accel = mods.ctrlKey || mods.metaKey;
    if (printable && isEditable(el)) return insertText(el, key);
    if (accel && key.toLowerCase() === 'a') {
      if (isTextInput(el)) el.select();
      else doc.execCommand('selectAll');
      return;
    }
    switch (key) {
      case 'Enter':
        if (el.tagName === 'TEXTAREA') return insertText(el, '\n');
        if (el.isContentEditable) return doc.execCommand(mods.shiftKey ? 'insertLineBreak' : 'insertParagraph');
        if (el.tagName === 'INPUT') return submitFrom(el);
        if (el.matches?.('a[href], button, summary, [role=button], [role=link]')) return el.click();
        return;
      case ' ':
        if (el.matches?.('button, summary, [role=button], input[type=checkbox], input[type=radio]')) return el.click();
        if (!isEditable(el)) scrollBy({ top: (mods.shiftKey ? -0.85 : 0.85) * innerHeight, behavior: 'instant' });
        return;
      case 'Backspace':
      case 'Delete':
        if (isEditable(el)) {
          if (!doc.execCommand(key === 'Backspace' ? 'delete' : 'forwardDelete') && isTextInput(el)) {
            let s = el.selectionStart, e = el.selectionEnd;
            if (s === e) key === 'Backspace' ? (s = Math.max(0, s - 1)) : (e = Math.min(el.value.length, e + 1));
            setNativeValue(el, el.value.slice(0, s) + el.value.slice(e));
            el.setSelectionRange(s, s);
          }
        }
        return;
      case 'Tab': {
        const list = tabbables();
        const i = list.indexOf(el);
        const next = list[(i + (mods.shiftKey ? -1 : 1) + list.length) % list.length];
        next?.focus();
        return;
      }
      case 'ArrowLeft':
      case 'ArrowRight':
        if (isTextInput(el)) {
          const pos = key === 'ArrowLeft' ? Math.max(0, el.selectionStart - 1) : Math.min(el.value.length, el.selectionEnd + 1);
          if (mods.shiftKey) el.setSelectionRange(Math.min(pos, el.selectionStart), Math.max(pos, el.selectionEnd));
          else el.setSelectionRange(pos, pos);
        } else if (!isEditable(el)) scrollBy({ left: key === 'ArrowLeft' ? -40 : 40, behavior: 'instant' });
        return;
      case 'Home':
      case 'End':
        if (isTextInput(el)) {
          const pos = key === 'Home' ? 0 : el.value.length;
          el.setSelectionRange(pos, pos);
        } else if (!isEditable(el)) scrollTo({ top: key === 'Home' ? 0 : document.documentElement.scrollHeight, behavior: 'instant' });
        return;
      case 'ArrowUp':
      case 'ArrowDown':
      case 'PageUp':
      case 'PageDown':
        if (!isEditable(el) && el.tagName !== 'SELECT') {
          const page = key.startsWith('Page') ? 0.85 * innerHeight : 40;
          scrollBy({ top: key.endsWith('Up') ? -page : page, behavior: 'instant' });
        }
        return;
    }
  }

  function scrollableAncestor(el, vertical) {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement || n.getRootNode()?.host) {
      const cs = getComputedStyle(n);
      const overflow = vertical ? cs.overflowY : cs.overflowX;
      const canScroll = vertical ? n.scrollHeight > n.clientHeight : n.scrollWidth > n.clientWidth;
      if (canScroll && /(auto|scroll|overlay)/.test(overflow)) return n;
    }
    return null;
  }

  function scroll({ coordinate, ref, scroll_direction = 'down', scroll_amount = 3 }) {
    const hasTarget = coordinate || ref;
    const { el, x, y } = hasTarget ? target({ coordinate, ref }) : { el: document.body, x: innerWidth / 2, y: innerHeight / 2 };
    const vertical = scroll_direction === 'up' || scroll_direction === 'down';
    const sign = scroll_direction === 'up' || scroll_direction === 'left' ? -1 : 1;
    const px = sign * scroll_amount * 100;
    const wheel = new WheelEvent('wheel', {
      bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, deltaMode: 0,
      deltaX: vertical ? 0 : px, deltaY: vertical ? px : 0,
    });
    if (!el.dispatchEvent(wheel)) return `Scroll ${scroll_direction} handled by the page.`;
    const container = scrollableAncestor(el, vertical);
    const scroller = container || document.scrollingElement || document.documentElement;
    const before = vertical ? scroller.scrollTop : scroller.scrollLeft;
    scroller.scrollBy({ top: vertical ? px : 0, left: vertical ? 0 : px, behavior: 'instant' });
    const after = vertical ? scroller.scrollTop : scroller.scrollLeft;
    const where = container ? describe(container) : 'page';
    return after === before
      ? `Could not scroll ${scroll_direction} (${where} is at its limit).`
      : `Scrolled ${where} ${scroll_direction} by ${Math.abs(after - before)}px (now at ${Math.round(after)}).`;
  }

  function drag({ start_coordinate, coordinate, modifiers }) {
    if (!start_coordinate || !coordinate) throw new Error('left_click_drag needs start_coordinate and coordinate.');
    const mods = parseModifiers(modifiers);
    const start = target({ coordinate: start_coordinate });
    hoverTo(start.el, start.x, start.y, mods);
    mouse(start.el, 'pointerdown', start.x, start.y, { ...mods, button: 0, buttons: 1 });
    mouse(start.el, 'mousedown', start.x, start.y, { ...mods, button: 0, buttons: 1 });
    const steps = 10;
    let current = start;
    for (let i = 1; i <= steps; i++) {
      const px = start_coordinate[0] + ((coordinate[0] - start_coordinate[0]) * i) / steps;
      const py = start_coordinate[1] + ((coordinate[1] - start_coordinate[1]) * i) / steps;
      current = deepElementFromPoint(px, py);
      if (!current.el) continue;
      mouse(current.el, 'pointermove', current.x, current.y, { ...mods, buttons: 1 });
      mouse(current.el, 'mousemove', current.x, current.y, { ...mods, buttons: 1 });
    }
    const end = current.el ? current : start;
    mouse(end.el, 'pointerup', end.x, end.y, { ...mods, button: 0, buttons: 0 });
    mouse(end.el, 'mouseup', end.x, end.y, { ...mods, button: 0, buttons: 0 });
    return `Dragged from (${start_coordinate}) to (${coordinate}).`;
  }

  function describe(el) {
    if (!el) return 'nothing';
    const role = roleOf(el);
    const name = nameOf(el, role);
    const tag = el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '');
    return `${role ? `${role} ` : ''}${name ? `"${name}" ` : ''}<${tag}> [${refFor(el)}]`;
  }

  function action(p) {
    const mods = parseModifiers(p.modifiers);
    switch (p.action) {
      case 'left_click':
      case 'right_click':
      case 'double_click':
      case 'triple_click': {
        const { el, x, y } = target(p);
        const button = p.action === 'right_click' ? 2 : 0;
        const count = { double_click: 2, triple_click: 3 }[p.action] || 1;
        click(el, x, y, { button, count, mods });
        return `${p.action} at (${Math.round(x)}, ${Math.round(y)}) on ${describe(el)}.`;
      }
      case 'hover': {
        const { el, x, y } = target(p);
        hoverTo(el, x, y, mods);
        return `Hovering ${describe(el)}.`;
      }
      case 'left_click_drag':
        return drag(p);
      case 'type':
        if (typeof p.text !== 'string') throw new Error('type needs text.');
        return typeText(p);
      case 'key': {
        if (!p.text) throw new Error('key needs text, e.g. "Enter" or "ctrl+a".');
        const combos = p.text.trim().split(/\s+/);
        for (const combo of combos) pressKey(combo);
        return `Pressed ${combos.join(', ')} on ${describe(deepActiveElement())}.`;
      }
      case 'scroll':
        return scroll(p);
      case 'scroll_to': {
        const el = resolveRef(p.ref);
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        return `Scrolled ${describe(el)} into view.`;
      }
    }
    throw new Error(`Unknown action ${p.action}`);
  }

  // -------------------------------------------------------------------------
  // form_input, page text, console

  function formInput({ ref, value }) {
    const el = resolveRef(ref);
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    const fire = (type) => el.dispatchEvent(new Event(type, { bubbles: true, composed: true }));
    if (el.tagName === 'SELECT') {
      const wanted = String(value).toLowerCase();
      const opt = Array.from(el.options).find((o) => o.value.toLowerCase() === wanted) ||
        Array.from(el.options).find((o) => clean(o.textContent).toLowerCase() === wanted) ||
        Array.from(el.options).find((o) => clean(o.textContent).toLowerCase().includes(wanted));
      if (!opt) {
        const available = Array.from(el.options, (o) => `"${clean(o.textContent)}" (${o.value})`).join(', ');
        throw new Error(`No option matching "${value}". Options: ${available}`);
      }
      el.focus();
      el.value = opt.value;
      fire('input');
      fire('change');
      return `Selected "${clean(opt.textContent)}" in ${describe(el)}.`;
    }
    if (el.type === 'checkbox' || el.type === 'radio') {
      const want = value === true || value === 'true' || value === 'on' || value === 1 || value === '1';
      if (el.checked !== want) el.click();
      return `${describe(el)} is now ${el.checked ? 'checked' : 'unchecked'}.`;
    }
    if (isTextInput(el) || el.type === 'range' || el.type === 'color') {
      el.focus();
      setNativeValue(el, String(value));
      fire('change');
      return `Set ${describe(el)} to "${clean(el.value, 80)}".`;
    }
    if (el.isContentEditable) {
      el.focus();
      document.execCommand('selectAll');
      insertText(el, String(value));
      return `Set ${describe(el)} content.`;
    }
    throw new Error(`${describe(el)} is not a form control. Use computer actions instead.`);
  }

  function pageText({ max_chars = 50000 }) {
    const root = document.querySelector('main, [role=main], article') || document.body;
    let text = (root?.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
    if (text.length > max_chars) text = `${text.slice(0, max_chars)}\n… truncated (${text.length} chars total).`;
    return text || '(no text content)';
  }

  function readConsole({ pattern, only_errors, limit = 100, clear }) {
    let list = consoleBuffer;
    if (only_errors) list = list.filter((m) => m.level === 'error');
    if (pattern) {
      const re = new RegExp(pattern, 'i');
      list = list.filter((m) => re.test(m.text));
    }
    const shown = list.slice(-limit);
    if (clear) consoleBuffer.length = 0;
    if (!shown.length) return 'No console messages captured.';
    return shown
      .map((m) => `[${new Date(m.time).toISOString().slice(11, 23)}] ${m.level.toUpperCase()}: ${m.text}`)
      .join('\n');
  }

  // -------------------------------------------------------------------------
  // Helpers for the trusted-input path (the background dispatches the events)

  // Convert a point in a same-origin iframe's viewport to the top frame's viewport.
  function toTopPoint(el, x, y) {
    for (let win = el.ownerDocument.defaultView; win !== window && win.frameElement; win = win.parent) {
      const frame = win.frameElement;
      const r = frame.getBoundingClientRect();
      x += r.left + frame.clientLeft;
      y += r.top + frame.clientTop;
    }
    return { x, y };
  }

  function locate({ ref, coordinate }) {
    if (!ref && !coordinate) {
      return { x: innerWidth / 2, y: innerHeight / 2, description: 'page' };
    }
    const hit = target({ ref, coordinate });
    const { x, y } = coordinate ? { x: coordinate[0], y: coordinate[1] } : toTopPoint(hit.el, hit.x, hit.y);
    return { x, y, description: describe(hit.el) };
  }

  // Gecko drops input sent to a content process before it reports itself ready (after load, and after process-
  // switching navigations). The background probes with mousemoves until one arrives here.
  let trustedInputSeen = false;
  for (const type of ['mousemove', 'mousedown', 'keydown', 'wheel']) {
    window.addEventListener(type, (e) => { if (e.isTrusted) trustedInputSeen = true; }, { capture: true, passive: true });
  }

  // Returns a point in this document (not over an iframe) to probe with, or null if input is known to work.
  function probePoint({ preferred }) {
    if (trustedInputSeen) return null;
    // Stay away from the edges: Zen rounds the corners of the page, so edge pixels can belong to the browser UI.
    const candidates = [preferred, [innerWidth / 2, innerHeight / 2], [24, 24], [innerWidth - 24, innerHeight - 24]];
    for (const p of candidates) {
      if (!p) continue;
      const el = document.elementFromPoint(p[0], p[1]);
      if (el && !['IFRAME', 'FRAME', 'OBJECT', 'EMBED'].includes(el.tagName)) return { x: p[0], y: p[1] };
    }
    return null;
  }

  function focusRef({ ref }) {
    const el = resolveRef(ref);
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    el.focus();
    if (isTextInput(el)) try { el.setSelectionRange(el.value.length, el.value.length); } catch {}
    return describe(deepActiveElement());
  }

  // -------------------------------------------------------------------------
  // Overlay: things the user marks for Claude ("marks") and boxes Claude draws for the user ("highlights"). Both live
  // in a closed shadow root positioned in document coordinates, so they scroll with the page.

  const OVERLAY_CSS = `
    :host { all: initial; }
    .box { position: absolute; box-sizing: border-box; pointer-events: none; border-radius: 4px; }
    .mark { border: 2px dashed #2f6fed; background: rgba(47, 111, 237, .08); }
    .hl { border: 3px solid #d97757; box-shadow: 0 0 0 4px rgba(217, 119, 87, .25); animation: pulse 1.2s ease-out 2; }
    .tag { position: absolute; top: -24px; left: -2px; display: flex; align-items: center; gap: 4px; max-width: 320px;
      padding: 2px 8px; border-radius: 4px; font: 600 12px/18px system-ui, sans-serif; color: #fff; white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis; }
    .mark.el { border-style: solid; background: rgba(47, 111, 237, .06); }
    .mark.done { border: 2px solid #2e9e5b; background: rgba(46, 158, 91, .06); opacity: .75; }
    .mark .tag { background: #2f6fed; pointer-events: auto; }
    .mark.done .tag { background: #2e9e5b; }
    .label { overflow: hidden; text-overflow: ellipsis; cursor: pointer; }
    .note { all: unset; width: 240px; font: 400 12px/18px system-ui, sans-serif; color: #fff; }
    .note::placeholder { color: rgba(255, 255, 255, .75); }
    .pick { border: 2px solid #2f6fed; background: rgba(47, 111, 237, .15); }
    .pick .tag { background: #1f1e1d; font-weight: 500; }
    .hl .tag { background: #d97757; }
    .tag.below { top: auto; bottom: -24px; }
    .x { all: unset; cursor: pointer; opacity: .8; padding: 0 2px; }
    .x:hover { opacity: 1; }
    .layer { position: fixed; inset: 0; cursor: crosshair; background: rgba(0, 0, 0, .12); pointer-events: auto; }
    .hint { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); padding: 6px 12px; border-radius: 6px;
      background: #1f1e1d; color: #eeeae4; font: 13px/1.4 system-ui, sans-serif; pointer-events: none; }
    .draft { position: fixed; box-sizing: border-box; border: 2px dashed #2f6fed; background: rgba(47, 111, 237, .12); }
    @keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(217, 119, 87, .6); } 100% { box-shadow: 0 0 0 14px rgba(217, 119, 87, 0); } }
  `;

  let overlayHost = null;
  let overlayRoot = null;

  function overlay() {
    if (!overlayHost) {
      overlayHost = document.createElement('zen-claude-overlay');
      overlayHost.style.cssText = 'position:absolute;top:0;left:0;width:0;height:0;overflow:visible;z-index:2147483647;pointer-events:none;';
      overlayRoot = overlayHost.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent = OVERLAY_CSS;
      overlayRoot.append(style);
    }
    if (!overlayHost.isConnected) document.documentElement.append(overlayHost); // pages may wipe the DOM
    return overlayRoot;
  }

  // An element's box in the top document's viewport, crossing same-origin iframes.
  function topRect(el) {
    const r = el.getBoundingClientRect();
    const { x, y } = toTopPoint(el, r.left, r.top);
    return { left: x, top: y, width: r.width, height: r.height };
  }

  function placeBox(node, { left, top, width, height }) {
    // Viewport rect -> document coordinates, since the overlay scrolls with the page.
    Object.assign(node.style, {
      left: `${left + scrollX}px`, top: `${top + scrollY}px`, width: `${width}px`, height: `${height}px`,
    });
    // Keep the tag on screen for boxes at the top of the page.
    node.querySelector('.tag')?.classList.toggle('below', top + scrollY < 26);
  }

  const toRect = ([x0, y0, x1, y1]) => ({
    left: Math.min(x0, x1), top: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0),
  });
  const viewportRect = (b) => ({ left: b.pageLeft - scrollX, top: b.pageTop - scrollY, width: b.width, height: b.height });
  const round = (r) => [r.left, r.top, r.left + r.width, r.top + r.height].map(Math.round);

  function boxNode(cls, label) {
    const node = document.createElement('div');
    node.className = `box ${cls}`;
    if (label) {
      const tag = document.createElement('div');
      tag.className = 'tag';
      tag.textContent = label;
      node.append(tag);
    }
    return node;
  }

  const BOX_PAD = 4;
  const pad = (r, p = BOX_PAD) => ({ left: r.left - p, top: r.top - p, width: r.width + 2 * p, height: r.height + 2 * p });
  const paddedRect = (el) => pad(topRect(el));

  // Boxes around elements follow them (inner scrolling, layout changes, fixed headers). Runs while any exist.
  let following = 0;

  function follow() {
    if (!following) following = requestAnimationFrame(followFrame);
  }

  function followFrame() {
    following = 0;
    let any = false;
    for (const h of highlights) {
      if (!h.el) continue;
      any = true;
      track(h.node, h.el);
    }
    for (const m of marks) {
      if (!m.el) continue;
      any = true;
      if (!m.el.isConnected) relocate(m);
      track(m.node, m.el);
    }
    if (any) follow();
  }

  function track(node, el) {
    const r = el.isConnected ? topRect(el) : null;
    const shown = !!r && (r.width > 0 || r.height > 0);
    node.style.display = shown ? '' : 'none';
    if (shown) placeBox(node, pad(r));
  }

  // Up one level, crossing shadow roots and same-origin iframes.
  const parentOf = (n) => n.parentElement || n.getRootNode().host || n.ownerDocument.defaultView?.frameElement || null;

  const summary = (el) => {
    const role = roleOf(el);
    const name = nameOf(el, role);
    return `${role || el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '')}${name ? ` "${name}"` : ''}`;
  };

  // --- Marks (the user points something out) --------------------------------
  // Clicking marks an element, and the mark follows it; dragging marks an area of the page. Either can carry a note.
  // Claude ticks marks off with resolve_marks as it deals with them.

  const marks = []; // { id, node, label, note, done, el?, fp?, retry?, pageLeft?, pageTop?, width?, height? }
  let nextMark = 1;
  let marking = null; // teardown for an active marking session
  let editing = null; // close() of an open note field

  function marksChanged() {
    const open = marks.filter((m) => !m.done).length;
    browser.runtime.sendMessage({ type: 'marksChanged', open, total: marks.length }).catch(() => {});
  }

  function setLabel(mark) {
    mark.label.textContent = `${mark.done ? '✓ ' : ''}${mark.id}${mark.note ? ` · ${mark.note}` : ''}`;
    mark.node.classList.toggle('done', !!mark.done);
  }

  // What's needed to find the element again if the page re-renders it.
  function fingerprint(el) {
    const parts = [];
    let n = el;
    for (; n && n.parentElement; n = n.parentElement) {
      if (n.id) {
        parts.unshift(`#${CSS.escape(n.id)}`);
        break;
      }
      let i = 1;
      for (let s = n.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === n.tagName) i++;
      parts.unshift(`${n.tagName.toLowerCase()}:nth-of-type(${i})`);
    }
    if (!n?.id && n) parts.unshift(n.tagName.toLowerCase());
    return { root: el.getRootNode(), path: parts.join(' > '), tag: el.tagName, name: nameOf(el, roleOf(el)), summary: summary(el) };
  }

  function relocate(m, now = false) {
    if (!now && Date.now() - (m.retry || 0) < 500) return;
    m.retry = Date.now();
    const { root, path, tag, name } = m.fp;
    if (!root.isConnected) return;
    const same = (n) => n?.tagName === tag && nameOf(n, roleOf(n)) === name;
    let found = null;
    try { found = root.querySelector(path); } catch {}
    if (!same(found)) found = name ? [...root.querySelectorAll(tag.toLowerCase())].slice(0, 500).find(same) : null;
    if (found) m.el = found;
  }

  function addMark(mark) {
    mark.id = nextMark++;
    const node = boxNode(mark.el ? 'mark el' : 'mark');
    const tag = document.createElement('div');
    tag.className = 'tag';
    const label = document.createElement('span');
    label.className = 'label';
    label.title = 'Click to add a note for Claude';
    label.addEventListener('click', () => editNote(mark));
    const x = document.createElement('button');
    x.className = 'x';
    x.textContent = '×';
    x.title = 'Remove';
    x.addEventListener('click', () => removeMark(mark));
    // The page would see these as clicks on the overlay host.
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) tag.addEventListener(type, (e) => e.stopPropagation());
    tag.append(label, x);
    node.append(tag);
    Object.assign(mark, { node, label });
    setLabel(mark);
    overlay().append(node);
    if (mark.el) {
      mark.fp = fingerprint(mark.el);
      placeBox(node, paddedRect(mark.el));
      follow();
    } else {
      placeBox(node, viewportRect(mark));
    }
    marks.push(mark);
    marksChanged();
    return mark;
  }

  function removeMark(mark) {
    mark.closeEditor?.(false);
    mark.node.remove();
    marks.splice(marks.indexOf(mark), 1);
    marksChanged();
  }

  function clearMarks() {
    for (const m of marks) {
      m.closeEditor?.(false);
      m.node.remove();
    }
    marks.length = 0;
    marksChanged();
  }

  // A text field in place of the mark's label. Keys typed in it are kept from the page's shortcuts.
  function editNote(mark) {
    if (mark.closeEditor) return;
    const before = mark.note || '';
    const input = document.createElement('input');
    input.className = 'note';
    input.placeholder = 'Note for Claude (optional) · Enter';
    input.value = before;
    const close = (save) => {
      if (!mark.closeEditor) return;
      mark.closeEditor = null;
      if (editing === close) editing = null;
      if (!save) mark.note = before;
      if (input.isConnected) input.replaceWith(mark.label);
      setLabel(mark);
    };
    for (const type of ['keydown', 'keyup', 'keypress']) {
      input.addEventListener(type, (e) => {
        e.stopPropagation();
        if (type !== 'keydown') return;
        if (e.key === 'Enter') close(true);
        else if (e.key === 'Escape') close(false);
      });
    }
    // Kept current so a read while the user is still typing sees it.
    input.addEventListener('input', () => { mark.note = clean(input.value, 200); });
    input.addEventListener('blur', () => close(true));
    mark.closeEditor = close;
    editing = close;
    mark.label.replaceWith(input);
    input.focus();
  }

  function startMarking() {
    if (marking) return 'Already marking.';
    const root = overlay();
    const layer = document.createElement('div');
    layer.className = 'layer';
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = 'Click an element or drag a box for Claude · ↑↓ bigger/smaller · Shift to mark several · Esc to stop';
    const pick = boxNode('pick', ' ');
    pick.style.display = 'none';
    root.append(layer, pick, hint);
    overlayHost.style.pointerEvents = 'auto';

    let chain = []; // the element under the pointer and its ancestors
    let level = 0; // which of them is picked
    let last = null;
    let start = null;
    let draft = null;

    const elementAt = (x, y) => {
      layer.style.pointerEvents = 'none';
      try {
        const { el } = deepElementFromPoint(x, y);
        return el === overlayHost ? null : el;
      } finally {
        layer.style.pointerEvents = '';
      }
    };
    const showPick = () => {
      const el = chain[level];
      pick.style.display = el && !draft ? '' : 'none';
      if (!el || draft) return;
      placeBox(pick, paddedRect(el));
      pick.firstChild.textContent = summary(el);
    };
    const hover = (x, y) => {
      const el = elementAt(x, y);
      if (el !== chain[0]) {
        chain = [];
        for (let n = el; n && n !== document.body && n !== document.documentElement; n = parentOf(n)) {
          if (n.tagName !== 'HTML' && n.tagName !== 'BODY') chain.push(n);
        }
        // Start at the control a click lands in (the button, not the span inside it).
        level = Math.max(0, chain.slice(0, 6).findIndex((n) => {
          const role = roleOf(n);
          return isInteractive(n, role) || LEAF_ROLES.has(role);
        }));
      }
      showPick();
    };

    const onDown = (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      layer.setPointerCapture(e.pointerId);
      start = [e.clientX, e.clientY];
    };
    const onMove = (e) => {
      last = [e.clientX, e.clientY];
      if (!start) return hover(...last);
      const r = toRect([...start, ...last]);
      if (!draft) {
        if (Math.max(r.width, r.height) < 6) return;
        draft = document.createElement('div');
        draft.className = 'draft';
        root.append(draft);
        showPick();
      }
      Object.assign(draft.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    };
    const onUp = (e) => {
      if (!start) return;
      const r = toRect([...start, e.clientX, e.clientY]);
      const dragged = !!draft;
      start = null;
      draft?.remove();
      draft = null;
      let mark = null;
      if (!dragged && chain[level]) mark = addMark({ el: chain[level] });
      else if (dragged && r.width >= 6 && r.height >= 6) {
        mark = addMark({ pageLeft: r.left + scrollX, pageTop: r.top + scrollY, width: r.width, height: r.height });
      }
      if (!mark || e.shiftKey) return showPick();
      stop();
      // The click that follows this pointerup would otherwise reach the page element now under the pointer.
      const swallow = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
      };
      window.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', swallow, true), 300);
      editNote(mark);
    };
    const onKey = (e) => {
      if (editing || !['Escape', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') return stop();
      level = Math.min(Math.max(0, level + (e.key === 'ArrowUp' ? 1 : -1)), Math.max(0, chain.length - 1));
      showPick();
    };
    const onScroll = () => {
      if (last && !start) hover(...last);
    };
    const stop = () => {
      layer.remove();
      hint.remove();
      pick.remove();
      draft?.remove();
      overlayHost.style.pointerEvents = 'none';
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onScroll, true);
      marking = null;
    };
    layer.addEventListener('pointerdown', onDown);
    layer.addEventListener('pointermove', onMove);
    layer.addEventListener('pointerup', onUp);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    marking = stop;
    return 'Marking started.';
  }

  // Interactive and landmark elements under root mostly inside a viewport rect, as read_page-style lines.
  function elementsIn(rect, root = document.body || document.documentElement, max = 60) {
    const lines = [];
    const inside = (r) => {
      const w = Math.min(r.left + r.width, rect.left + rect.width) - Math.max(r.left, rect.left);
      const h = Math.min(r.top + r.height, rect.top + rect.height) - Math.max(r.top, rect.top);
      return w > 0 && h > 0 && (w * h) / Math.max(1, r.width * r.height) >= 0.5;
    };
    const walk = (el, depth) => {
      if (lines.length >= max || SKIP_TAGS.has(el.tagName?.toUpperCase()) || el === overlayHost || !isVisible(el)) return;
      const role = roleOf(el);
      let childDepth = depth;
      if ((role || isInteractive(el, role)) && inside(topRect(el))) {
        const name = nameOf(el, role);
        const r = topRect(el);
        lines.push(`${'  '.repeat(depth)}- ${role || el.tagName.toLowerCase()}${name ? ` "${name}"` : ''} [${refFor(el)}]${details(el, role)} at (${Math.round(r.left + r.width / 2)}, ${Math.round(r.top + r.height / 2)})`);
        childDepth++;
        if (LEAF_ROLES.has(role) && el.tagName !== 'SELECT') return;
      }
      for (const child of childrenOf(el)) walk(child, childDepth);
    };
    for (const child of childrenOf(root)) walk(child, 0);
    return lines;
  }

  // Visible text under root whose line boxes fall inside the rect, if one is given (top document only).
  function textIn(rect, max = 2000, root = document.body || document.documentElement) {
    const parts = [];
    let length = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    for (let node = walker.nextNode(); node && length < max; node = walker.nextNode()) {
      if (!node.textContent.trim() || SKIP_TAGS.has(node.parentElement?.tagName)) continue;
      if (rect) {
        range.selectNodeContents(node);
        const r = range.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        if (cx < rect.left || cx > rect.left + rect.width || cy < rect.top || cy > rect.top + rect.height) continue;
      }
      const text = clean(node.textContent, 400);
      parts.push(text);
      length += text.length + 1;
    }
    const text = parts.join(' ');
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }

  // The innermost element that contains the whole rect, for context ("inside the pricing card").
  function containerOf(rect) {
    const { el } = deepElementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    for (let n = el; n && n.nodeType === 1; n = n.parentElement || n.getRootNode()?.host) {
      const r = topRect(n);
      if (r.left <= rect.left + 1 && r.top <= rect.top + 1 && r.left + r.width >= rect.left + rect.width - 1 &&
          r.top + r.height >= rect.top + rect.height - 1) return n;
    }
    return document.body;
  }

  // The nearest ancestor worth naming: one with a role or an id.
  function contextOf(el) {
    let n = parentOf(el);
    for (let i = 0; n && i < 12 && n !== document.body; i++, n = parentOf(n)) {
      const role = roleOf(n);
      if ((role && role !== 'paragraph') || n.id) return describe(n);
    }
    return '';
  }

  function readMarks({ clear }) {
    const vw = innerWidth;
    const vh = innerHeight;
    // The part of a rect inside the viewport, which is what a screenshot can show.
    const visiblePart = (rect) => {
      const x0 = Math.max(0, rect.left);
      const y0 = Math.max(0, rect.top);
      const x1 = Math.min(vw, rect.left + rect.width);
      const y1 = Math.min(vh, rect.top + rect.height);
      return x1 - x0 >= 4 && y1 - y0 >= 4 ? [x0, y0, x1, y1].map(Math.round) : null;
    };
    const readElement = (m, base) => {
      if (!m.el.isConnected) relocate(m, true);
      if (!m.el.isConnected) return { ...base, lost: m.fp.summary };
      const el = m.el;
      const role = roleOf(el);
      const rect = topRect(el);
      const leaf = LEAF_ROLES.has(role);
      return {
        ...base,
        element: `${describe(el)}${details(el, role)}`,
        center: [rect.left + rect.width / 2, rect.top + rect.height / 2].map(Math.round),
        visible: visiblePart(pad(rect)),
        context: contextOf(el),
        elements: leaf ? [] : elementsIn(rect, el, 20),
        text: leaf ? '' : textIn(null, 500, el),
      };
    };
    const readBox = (m, base) => {
      const rect = viewportRect(m);
      const visible = visiblePart(rect);
      return {
        ...base,
        viewport: round(rect),
        page: round({ left: m.pageLeft, top: m.pageTop, width: m.width, height: m.height }),
        visible,
        container: describe(containerOf(rect)),
        elements: visible ? elementsIn(rect) : [],
        text: visible ? textIn(rect) : '',
      };
    };
    const result = {
      viewport: { width: vw, height: vh, scrollX: Math.round(scrollX), scrollY: Math.round(scrollY) },
      selection: clean(getSelection()?.toString(), 2000),
      marks: marks.map((m) => {
        const base = { id: m.id, kind: m.el ? 'element' : 'box', note: m.note || '', done: !!m.done };
        if (m.done) return base;
        return m.el ? readElement(m, base) : readBox(m, base);
      }),
    };
    if (clear) clearMarks();
    return result;
  }

  // Tick marks off (or remove them) as Claude deals with them. No ids means every open mark.
  function resolveMarks({ ids, remove }) {
    const targets = ids?.length ? marks.filter((m) => ids.includes(m.id)) : marks.filter((m) => !m.done);
    const missing = (ids || []).filter((id) => !marks.some((m) => m.id === id));
    for (const m of targets) {
      if (remove) {
        removeMark(m);
      } else {
        m.done = true;
        m.closeEditor?.(true);
        setLabel(m);
      }
    }
    marksChanged();
    let text = targets.length ? `${remove ? 'Removed' : 'Ticked off'} mark ${targets.map((m) => m.id).join(', ')}.` : 'No marks to update.';
    if (missing.length) text += ` No mark ${missing.join(', ')} on this page.`;
    const open = marks.filter((m) => !m.done).map((m) => m.id);
    return `${text} ${open.length ? `Still open: ${open.join(', ')}.` : 'None left open.'}`;
  }

  // --- Highlights (Claude boxes something for the user) ---------------------

  let highlights = []; // { node, el? }
  let highlightTimer = null;

  function clearHighlights() {
    for (const h of highlights) h.node.remove();
    highlights = [];
    clearTimeout(highlightTimer);
  }

  function highlight({ items = [], duration }) {
    // Resolve everything first so a bad ref doesn't leave a partial set on screen.
    const resolved = items.map((item, i) => {
      if (item.ref) return { ...item, el: resolveRef(item.ref) };
      if (item.region?.length === 4) return { ...item, rect: toRect(item.region) };
      throw new Error(`Highlight ${i + 1} needs a ref or a region [x0, y0, x1, y1].`);
    });
    clearHighlights();
    if (!resolved.length) return 'Cleared highlights.';
    for (const item of resolved) {
      const node = boxNode('hl', item.label);
      overlay().append(node);
      placeBox(node, item.el ? paddedRect(item.el) : item.rect);
      highlights.push({ node, el: item.el });
    }
    // Bring the first one into view if it's off screen.
    const first = highlights[0].node.getBoundingClientRect();
    if (first.bottom < 0 || first.top > innerHeight || first.right < 0 || first.left > innerWidth) {
      if (resolved[0].el) resolved[0].el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      else scrollTo({ top: first.top + scrollY - innerHeight / 3, behavior: 'smooth' });
    }
    if (highlights.some((h) => h.el)) follow();
    if (duration > 0) highlightTimer = setTimeout(clearHighlights, duration * 1000);
    return `Highlighted ${resolved.length} item(s)${duration > 0 ? ` for ${duration}s` : ' until cleared or replaced'}.`;
  }

  // -------------------------------------------------------------------------

  browser.runtime.onMessage.addListener(async (msg) => {
    switch (msg.type) {
      case 'viewport':
        return { width: innerWidth, height: innerHeight, scrollX: Math.round(scrollX), scrollY: Math.round(scrollY), dpr: devicePixelRatio };
      case 'readPage': return readPage(msg);
      case 'find': return find(msg);
      case 'action': return action(msg);
      case 'formInput': return formInput(msg);
      case 'pageText': return pageText(msg);
      case 'console': return readConsole(msg);
      case 'locate': return locate(msg);
      case 'probePoint': return probePoint(msg);
      case 'probeSeen': return trustedInputSeen;
      case 'focus': return focusRef(msg);
      case 'focused': return describe(deepActiveElement());
      case 'startMarking': return startMarking();
      case 'readMarks': return readMarks(msg);
      case 'resolveMarks': return resolveMarks(msg);
      case 'highlight': return highlight(msg);
      case 'overlayHidden':
        if (overlayHost) overlayHost.style.visibility = msg.hidden ? 'hidden' : '';
        // Let the change reach the screen before a capture.
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        return true;
    }
  });
}
