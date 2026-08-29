/** Minimal DOM helpers — enough structure to avoid string-concatenated HTML
 * for anything that carries user data. */

/**
 * Create an element.
 * @param {string} tag tag name, optionally with `.class.names`
 * @param {object} [attrs] properties; `class`, `dataset`, `style`, `on` and
 *   `text` get special handling, everything else becomes an attribute
 * @param {Array<Node|string|null|undefined>} [children]
 */
export function el(tag, attrs = {}, children = []) {
  const [tagName, ...classes] = tag.split('.');
  const node = document.createElement(tagName || 'div');
  if (classes.length) node.classList.add(...classes);

  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') {
      node.classList.add(...String(value).split(/\s+/).filter(Boolean));
    } else if (key === 'text') {
      node.textContent = String(value);
    } else if (key === 'html') {
      node.innerHTML = String(value);
    } else if (key === 'dataset') {
      Object.assign(node.dataset, value);
    } else if (key === 'style') {
      Object.assign(node.style, value);
    } else if (key === 'on') {
      for (const [event, handler] of Object.entries(value)) {
        node.addEventListener(event, handler);
      }
    } else if (key in node && key !== 'list' && key !== 'form') {
      node[key] = value;
    } else {
      node.setAttribute(key, value === true ? '' : String(value));
    }
  }

  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** Remove every child of a node. */
export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/**
 * Trap Tab focus inside `container` until the returned function is called.
 * Restores focus to whatever was active before.
 */
export function trapFocus(container) {
  const previouslyFocused = document.activeElement;
  const selector =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  const onKeyDown = (event) => {
    if (event.key !== 'Tab') return;
    const focusable = [...container.querySelectorAll(selector)].filter(
      (node) => node.offsetParent !== null || node === document.activeElement
    );
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  container.addEventListener('keydown', onKeyDown);
  return () => {
    container.removeEventListener('keydown', onKeyDown);
    if (previouslyFocused instanceof HTMLElement && document.contains(previouslyFocused)) {
      previouslyFocused.focus();
    }
  };
}

/**
 * Put text on the clipboard.
 *
 * The async Clipboard API exists only in a secure context — https, or
 * localhost. Serving a file manager over plain http on a LAN is an ordinary
 * way to run this, and there `navigator.clipboard` is simply undefined, so the
 * old execCommand route stays as the fallback rather than letting the button
 * quietly do nothing on half the deployments.
 *
 * @returns {Promise<boolean>} whether the text actually got there
 */
export async function copyToClipboard(text) {
  const value = String(text ?? '');
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // Denied, or not permitted from this context; fall through.
    }
  }

  // The legacy path needs a real, selectable, on-screen element: one that is
  // display:none or hidden cannot be selected and the copy silently fails.
  // Off-screen, readonly and opacity 0 is the combination that works.
  const area = document.createElement('textarea');
  area.value = value;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.top = '-1000px';
  area.style.opacity = '0';
  document.body.append(area);
  try {
    area.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

/** Tiny synchronous event emitter used for the widget's public events. */
export class Emitter {
  #listeners = new Map();

  on(event, handler) {
    if (!this.#listeners.has(event)) this.#listeners.set(event, new Set());
    this.#listeners.get(event).add(handler);
    return () => this.off(event, handler);
  }

  off(event, handler) {
    this.#listeners.get(event)?.delete(handler);
  }

  emit(event, payload) {
    for (const handler of this.#listeners.get(event) ?? []) {
      // A misbehaving listener must not abort the operation that emitted.
      try {
        handler(payload);
      } catch (err) {
        console.error(`[bookmark-file-manager] listener for "${event}" threw`, err);
      }
    }
  }

  clearListeners() {
    this.#listeners.clear();
  }
}
