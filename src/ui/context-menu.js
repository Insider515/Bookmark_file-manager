import { el } from './dom.js';

/**
 * Right-click menu. One instance per widget, reopened in place rather than
 * rebuilt, so there is never more than one menu in the DOM.
 */
export class ContextMenu {
  #node = null;

  #dismiss = null;

  constructor(container) {
    this.container = container;
  }

  /**
   * @param {number} x viewport coordinates
   * @param {number} y
   * @param {Array<{label: string, icon?: string, disabled?: boolean, danger?: boolean,
   *                separator?: boolean, onSelect?: () => void}>} items
   */
  open(x, y, items) {
    this.close();

    const menu = el('div.fsfm-menu', { role: 'menu' });
    for (const item of items) {
      if (item.separator) {
        menu.append(el('div.fsfm-menu-separator', { role: 'separator' }));
        continue;
      }
      const button = el('button.fsfm-menu-item', {
        type: 'button',
        role: 'menuitem',
        class: item.danger ? 'is-danger' : '',
        disabled: !!item.disabled,
        on: {
          click: () => {
            this.close();
            item.onSelect?.();
          },
        },
      }, [
        el('span.fsfm-menu-icon', { html: item.icon ?? '' }),
        el('span.fsfm-menu-label', { text: item.label }),
        item.shortcut ? el('span.fsfm-menu-shortcut', { text: item.shortcut }) : null,
      ].filter(Boolean));
      menu.append(button);
    }

    // Position off-screen first so the size can be measured before placing it.
    menu.style.left = '-9999px';
    menu.style.top = '-9999px';
    this.container.append(menu);

    const rect = menu.getBoundingClientRect();
    const hostRect = this.container.getBoundingClientRect();
    // The menu lives inside the widget, and the widget clips its overflow, so
    // the box it has to fit is the widget's — not the viewport's. Measuring
    // against the window let a menu opened near the right edge be cut in half
    // while the browser still had room to spare.
    const fit = (wanted, size, limit) => {
      // Flip to the other side of the cursor when that is where the room is,
      // then clamp: a menu larger than the box lands at 0 and scrolls.
      const flipped = wanted - size;
      const placed = wanted + size > limit && flipped >= 0 ? flipped : wanted;
      return Math.max(0, Math.min(placed, Math.max(0, limit - size)));
    };

    menu.style.left = `${fit(x - hostRect.left, rect.width, hostRect.width)}px`;
    menu.style.top = `${fit(y - hostRect.top, rect.height, hostRect.height)}px`;
    // A menu with more items than the widget is tall scrolls rather than
    // losing its last entries to the clip.
    menu.style.maxHeight = `${Math.max(0, hostRect.height)}px`;

    this.#node = menu;

    const onPointerDown = (event) => {
      if (!menu.contains(event.target)) this.close();
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        this.close();
        return;
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      const options = [...menu.querySelectorAll('.fsfm-menu-item:not([disabled])')];
      if (!options.length) return;
      const index = options.indexOf(document.activeElement);
      const next = event.key === 'ArrowDown' ? index + 1 : index - 1;
      options[(next + options.length) % options.length].focus();
    };

    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', this.close, { once: true });
    // Any scroll leaves the menu detached from what it points at.
    window.addEventListener('scroll', this.close, { once: true, capture: true });

    this.#dismiss = () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('resize', this.close);
      window.removeEventListener('scroll', this.close, true);
    };

    menu.querySelector('.fsfm-menu-item:not([disabled])')?.focus();
  }

  close = () => {
    this.#dismiss?.();
    this.#dismiss = null;
    this.#node?.remove();
    this.#node = null;
  };

  destroy() {
    this.close();
  }
}
