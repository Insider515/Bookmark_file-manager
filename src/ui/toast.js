import { el } from './dom.js';
import { icon } from './icons.js';

/**
 * Transient notifications. Errors stay until dismissed — a failed delete is
 * worth reading; successes fade on their own.
 */
export class ToastHost {
  #host;
  #t;

  /**
   * @param {HTMLElement} container
   * @param {(key: string, params?: object) => string} t translator
   */
  constructor(container, t) {
    this.#t = t ?? ((key) => key);
    this.#host = el('div.fsfm-toasts', { role: 'status', 'aria-live': 'polite' });
    container.append(this.#host);
  }

  /**
   * @param {string} message
   * @param {{type?: 'info'|'success'|'error', timeout?: number}} [options]
   */
  show(message, options = {}) {
    const { type = 'info', timeout = type === 'error' ? 0 : 4000 } = options;

    const close = el('button.fsfm-toast-close', {
      type: 'button',
      'aria-label': this.#t('toast.close'),
      html: icon('xLg', 11),
    });
    const toast = el('div.fsfm-toast', { class: `fsfm-toast-${type}` }, [
      el('span.fsfm-toast-text', { text: message }),
      close,
    ]);

    let timer = null;
    const dismiss = () => {
      if (timer) clearTimeout(timer);
      toast.classList.add('is-leaving');
      // Let the fade finish before removing; the delay matches the CSS.
      setTimeout(() => toast.remove(), 160);
    };
    close.addEventListener('click', dismiss);
    if (timeout > 0) timer = setTimeout(dismiss, timeout);

    this.#host.append(toast);
    // Keep the list short so a burst of errors cannot cover the whole widget.
    while (this.#host.children.length > 4) this.#host.firstChild.remove();
    return dismiss;
  }

  success(message) {
    return this.show(message, { type: 'success' });
  }

  error(message) {
    return this.show(message, { type: 'error' });
  }

  destroy() {
    this.#host.remove();
  }
}
