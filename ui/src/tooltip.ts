/**
 * Lightweight JS-driven tooltip replacing title/CSS-attr tooltips.
 *
 * Pure-CSS `[data-tooltip]::after` tooltips get clipped by any scrolling
 * ancestor (file-tree, sidebar, dropdown-menu all use overflow:auto) and
 * can run off-screen near viewport edges. A single tooltip appended to
 * <body> and positioned via getBoundingClientRect sidesteps both problems,
 * and can flip above/below + clamp horizontally.
 */

let tooltipEl: HTMLDivElement | null = null;
let arrowEl: HTMLDivElement | null = null;
let textEl: HTMLSpanElement | null = null;
let currentTarget: HTMLElement | null = null;
let showTimer: ReturnType<typeof setTimeout> | null = null;

const SHOW_DELAY = 300;
const GAP = 8;
const EDGE_PADDING = 8;

function ensureTooltipEl(): HTMLDivElement {
    if (tooltipEl) return tooltipEl;
    tooltipEl = document.createElement('div');
    tooltipEl.className = 'js-tooltip';
    tooltipEl.setAttribute('role', 'tooltip');
    arrowEl = document.createElement('div');
    arrowEl.className = 'js-tooltip__arrow';
    textEl = document.createElement('span');
    tooltipEl.append(arrowEl, textEl);
    document.body.appendChild(tooltipEl);
    return tooltipEl;
}

function position(target: HTMLElement): void {
    const text = target.getAttribute('data-tooltip');
    if (!text) return;

    const el = ensureTooltipEl();
    textEl!.textContent = text;
    el.classList.remove('js-tooltip--below', 'js-tooltip--above');
    el.classList.add('js-tooltip--visible', 'js-tooltip--below');

    const targetRect = target.getBoundingClientRect();
    const tipRect = el.getBoundingClientRect();

    let top = targetRect.bottom + GAP;
    if (top + tipRect.height > window.innerHeight - EDGE_PADDING) {
        top = targetRect.top - tipRect.height - GAP;
        el.classList.remove('js-tooltip--below');
        el.classList.add('js-tooltip--above');
    }

    let left = targetRect.left + targetRect.width / 2 - tipRect.width / 2;
    left = Math.max(EDGE_PADDING, Math.min(left, window.innerWidth - tipRect.width - EDGE_PADDING));

    el.style.left = `${left}px`;
    el.style.top = `${Math.max(EDGE_PADDING, top)}px`;

    const arrowLeft = targetRect.left + targetRect.width / 2 - left - 4;
    arrowEl!.style.left = `${Math.max(6, Math.min(arrowLeft, tipRect.width - 14))}px`;
}

function show(target: HTMLElement): void {
    currentTarget = target;
    if (showTimer) clearTimeout(showTimer);
    showTimer = setTimeout(() => {
        if (currentTarget === target) position(target);
    }, SHOW_DELAY);
}

function hide(): void {
    currentTarget = null;
    if (showTimer) {
        clearTimeout(showTimer);
        showTimer = null;
    }
    tooltipEl?.classList.remove('js-tooltip--visible');
}

export function initTooltips(): void {
    const onPointerOver = (e: PointerEvent) => {
        const target = (e.target as HTMLElement)?.closest<HTMLElement>('[data-tooltip]');
        if (!target || target === currentTarget || !target.getAttribute('data-tooltip')) return;
        show(target);
    };

    const onPointerOut = (e: PointerEvent) => {
        const target = (e.target as HTMLElement)?.closest<HTMLElement>('[data-tooltip]');
        const related = (e.relatedTarget as HTMLElement | null)?.closest?.('[data-tooltip]');
        if (target && target !== related) hide();
    };

    const onFocusIn = (e: FocusEvent) => {
        const target = (e.target as HTMLElement)?.closest<HTMLElement>('[data-tooltip]');
        if (target && target.getAttribute('data-tooltip')) show(target);
    };

    const onFocusOut = (e: FocusEvent) => {
        if ((e.target as HTMLElement)?.closest('[data-tooltip]')) hide();
    };

    const onScroll = () => {
        if (currentTarget || showTimer) {
            hide();
        }
    };

    const onKeydown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') hide();
    };

    document.addEventListener('pointerover', onPointerOver);
    document.addEventListener('pointerout', onPointerOut);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', hide);
    document.addEventListener('keydown', onKeydown);
}
