/**
 * A progress toast in the window's bottom right corner: a line of text, a bar,
 * and optional action buttons. Long jobs (an update download, a video render)
 * each get their own, stacked.
 */

let stack: HTMLDivElement | null = null;

function container(): HTMLDivElement {
    if (!stack) {
        stack = document.createElement('div');
        stack.className = 'progress-toasts';
        document.body.appendChild(stack);
    }
    return stack;
}

export interface ToastAction {
    label: string;
    run: () => void;
}

export class ProgressToast {
    private el: HTMLDivElement | null = null;
    private text!: HTMLSpanElement;
    private bar!: HTMLDivElement;
    private actions!: HTMLDivElement;
    /** The buttons' labels, so an update that keeps them doesn't swap them under a click. */
    private shown = '';

    /** Show or update the toast. A null fraction fills the bar (a phase with no measure). */
    show(text: string, fraction: number | null, actions: ToastAction[] = []): void {
        if (!this.el) {
            this.el = document.createElement('div');
            this.el.className = 'progress-toast';
            this.el.setAttribute('role', 'status');
            const row = document.createElement('div');
            row.className = 'progress-toast-row';
            this.text = document.createElement('span');
            this.text.className = 'progress-toast-text';
            this.actions = document.createElement('div');
            this.actions.className = 'progress-toast-actions';
            row.append(this.text, this.actions);
            const track = document.createElement('div');
            track.className = 'progress-toast-track';
            this.bar = document.createElement('div');
            this.bar.className = 'progress-toast-bar';
            track.appendChild(this.bar);
            this.el.append(row, track);
            container().appendChild(this.el);
        }
        this.text.textContent = text;
        this.bar.style.width = `${Math.round((fraction ?? 1) * 100)}%`;
        const key = actions.map((a) => a.label).join('\0');
        if (key === this.shown) return;
        this.shown = key;
        this.actions.replaceChildren(...actions.map(({label, run}) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'progress-toast-action';
            b.textContent = label;
            b.addEventListener('click', run);
            return b;
        }));
    }

    hide(): void {
        this.el?.remove();
        this.el = null;
        this.shown = '';
    }
}
