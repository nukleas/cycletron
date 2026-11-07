// The only script on most pages: pick the visitor's platform for the primary
// download button, and load YouTube players only when clicked.

function detectOs() {
    const ua = navigator.userAgent;
    if (/Android|iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'phone';
    if (/Windows/i.test(ua)) return 'windows';
    if (/Mac OS X|Macintosh/i.test(ua)) return 'mac';
    if (/Linux|X11/i.test(ua)) return 'linux';
    return null;
}

const os = detectOs();
document.documentElement.dataset.os = os ?? 'unknown';

for (const box of document.querySelectorAll('[data-downloads]')) {
    if (os === 'phone') {
        box.classList.add('downloads--phone');
        continue;
    }
    // The first installer for this platform leads; the others stay listed.
    const primary = box.querySelector(`[data-os="${os}"]`);
    if (!primary) continue;
    primary.classList.add('button--primary');
    primary.closest('li')?.parentElement?.prepend(primary.closest('li'));
}

for (const row of document.querySelectorAll(`tr[data-os="${os}"]`)) row.classList.add('is-yours');

for (const button of document.querySelectorAll('[data-yt]')) {
    button.addEventListener('click', () => {
        const frame = document.createElement('iframe');
        frame.src = `https://www.youtube-nocookie.com/embed/${button.dataset.yt}?autoplay=1&rel=0`;
        frame.title = button.getAttribute('aria-label')?.replace(/^Play /, '') ?? 'Video';
        frame.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
        frame.allowFullscreen = true;
        frame.className = 'yt yt--playing';
        button.replaceWith(frame);
    });
}
