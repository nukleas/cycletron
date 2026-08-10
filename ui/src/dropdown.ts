/**
 * Shared header-dropdown behavior: anchored panel under a toggle button,
 * closing on outside pointerdown / Escape / Tab, with roving arrow-key
 * focus over the menu's items (buttons or links).
 *
 * Escape stops propagation so the app-level Escape handler (stop playback)
 * never fires while a menu is open.
 */

interface DropdownOptions {
    button: HTMLButtonElement;
    menu: HTMLElement;
    /** Called just before the menu is shown (e.g. to refresh checked states). */
    onOpen?: () => void;
}

export interface DropdownHandle {
    close(focusButton?: boolean): void;
    isOpen(): boolean;
}

export function attachDropdown({button, menu, onOpen}: DropdownOptions): DropdownHandle {
    const items = (): HTMLElement[] =>
        Array.from(menu.querySelectorAll<HTMLElement>('button:not([disabled]), a[href]'));

    const isOpen = () => !menu.hasAttribute('hidden');

    const onOutsidePointer = (e: PointerEvent): void => {
        const t = e.target as Node;
        if (menu.contains(t) || button.contains(t)) return;
        close(false);
    };

    const open = (): void => {
        onOpen?.();
        menu.removeAttribute('hidden');
        button.setAttribute('aria-expanded', 'true');
        document.addEventListener('pointerdown', onOutsidePointer, true);
        items()[0]?.focus();
    };

    const close = (focusButton = true): void => {
        menu.setAttribute('hidden', '');
        button.setAttribute('aria-expanded', 'false');
        document.removeEventListener('pointerdown', onOutsidePointer, true);
        if (focusButton) button.focus();
    };

    const onMenuKeydown = (e: KeyboardEvent): void => {
        if (e.key === 'Escape') {
            // Keep the app-level Escape (stop playback) from firing.
            e.preventDefault();
            e.stopPropagation();
            close();
            return;
        }
        if (e.key === 'Tab') {
            close(false);
            return;
        }

        const list = items();
        if (list.length === 0) return;
        const idx = list.indexOf(document.activeElement as HTMLElement);

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            list[(idx + 1) % list.length].focus();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            list[(idx - 1 + list.length) % list.length].focus();
        } else if (e.key === 'Home') {
            e.preventDefault();
            list[0].focus();
        } else if (e.key === 'End') {
            e.preventDefault();
            list[list.length - 1].focus();
        }
    };

    button.addEventListener('click', () => {
        if (isOpen()) close();
        else open();
    });
    menu.addEventListener('keydown', onMenuKeydown);

    return {close, isOpen};
}
