(function () {
    // Get values from storage once
    const savedWidth = localStorage.getItem('sidebar-width');
    const savedFontSize = localStorage.getItem('editor-font-size') || '14';
    const savedVizMode = parseInt(localStorage.getItem('visualizer-mode') || '0', 10);
    const savedBpm = localStorage.getItem('bpm') || '120';
    window.__savedEditorCode = localStorage.getItem('editor-code');
    const oldDefaultClaim = '// Strudel WASM — 100% Rust, compiled to WebAssembly';
    const softenedDefaultClaim = '// Strudel core runs in Rust/WASM; UI and scheduling are TypeScript';
    if (window.__savedEditorCode?.includes(oldDefaultClaim)) {
        window.__savedEditorCode = window.__savedEditorCode.replace(oldDefaultClaim, softenedDefaultClaim);
        localStorage.setItem('editor-code', window.__savedEditorCode);
    }

    // Apply CSS variables immediately (blocks rendering, preventing layout jump)
    const root = document.documentElement;
    if (savedWidth) root.style.setProperty('--sidebar-width', savedWidth + 'px');
    root.style.setProperty('--editor-font-size', savedFontSize + 'px');

    // Fast-path for UI text (ensures elements match variables on first frame)
    function syncUI() {
        const zoomEl = document.getElementById('editorZoomValue');
        const vizEl = document.getElementById('vizMode');
        const bpmSlider = document.getElementById('bpmSlider');
        const bpmValue = document.getElementById('bpmValue');
        const bpmDisplay = document.getElementById('bpmDisplay');
        const editorEl = document.getElementById('editor');

        if (zoomEl) zoomEl.textContent = savedFontSize + 'px';
        if (vizEl) vizEl.selectedIndex = savedVizMode;
        if (bpmSlider) bpmSlider.value = savedBpm;
        if (bpmValue) bpmValue.value = savedBpm;
        if (bpmDisplay) bpmDisplay.textContent = savedBpm;

        if (editorEl && !editorEl.firstChild) {
            const code = window.__savedEditorCode || '';
            const fontSize = parseInt(savedFontSize, 10);
            const lineHeight = Math.round(fontSize * 1.6 * 10) / 10;

            const defaultCode = `// Strudel core runs in Rust/WASM; UI and scheduling are TypeScript
// Press Ctrl+Enter to play, Escape to stop

stack(
  // Drums
  s("bd*4"),
  s("~ cp ~ cp").gain(0.6),
  s("hh*8").gain(0.3).hpf(5000),

  // Bass
  note("<c2 ~ c2 ~> <~ eb2 ~ g2>")
    .s("sawtooth").lpf(500).gain(0.5),

  // Lead
  note("c4 eb4 g4 bb4").fast(2)
    .s("triangle").lpf(2000)
    .delay(0.3).room(0.3).gain(0.4)
)
`;
            const fullCode = code || defaultCode;
            const rawLines = fullCode.split('\n');
            const visibleLines = rawLines.slice(0, 40);
            const digits = String(rawLines.length).length;

            function esc(s) {
                return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            }

            function highlightFull(text) {
                let out = '';
                let i = 0;

                let inString = false;
                let quoteType = null;
                let inBlockComment = false;
                let afterDot = false;

                let currentSpanStyle = null;

                while (i < text.length) {
                    const ch = text[i];
                    const next2 = text.slice(i, i + 2);

                    if (ch === '\n') {
                        if (currentSpanStyle) {
                            out += `</span>\n<span style="${currentSpanStyle}">`;
                        } else {
                            out += '\n';
                        }
                        i++;
                        continue;
                    }

                    if (!inString && !inBlockComment && next2 === '/*') {
                        inBlockComment = true;
                        currentSpanStyle = 'color:var(--text-muted);font-style:italic';
                        out += `<span style="${currentSpanStyle}">/*`;
                        i += 2;
                        continue;
                    }

                    if (inBlockComment) {
                        if (next2 === '*/') {
                            out += '*/</span>';
                            currentSpanStyle = null;
                            inBlockComment = false;
                            i += 2;
                        } else {
                            out += esc(ch);
                            i++;
                        }
                        continue;
                    }

                    if (!inString && (ch === '"' || ch === "'" || ch === '`')) {
                        inString = true;
                        quoteType = ch;
                        currentSpanStyle = 'color:var(--green-bright)';
                        out += `<span style="${currentSpanStyle}">${esc(ch)}`;
                        i++;
                        continue;
                    }

                    if (inString) {
                        if (ch === quoteType && text[i - 1] !== '\\') {
                            out += `${esc(ch)}</span>`;
                            currentSpanStyle = null;
                            inString = false;
                            quoteType = null;
                        } else {
                            out += esc(ch);
                        }
                        i++;
                        continue;
                    }

                    if (next2 === '//') {
                        let lineEnd = text.indexOf('\n', i);
                        if (lineEnd === -1) lineEnd = text.length;
                        out += `<span style="color:var(--text-muted);font-style:italic">${esc(text.slice(i, lineEnd))}</span>`;
                        currentSpanStyle = null;
                        i = lineEnd;
                        continue;
                    }

                    if (ch === '.') {
                        out += `<span style="color:var(--pink)">.</span>`;
                        afterDot = true;
                        i++;
                        continue;
                    }

                    if (/\d/.test(ch)) {
                        let j = i;
                        while (j < text.length && /[\d.]/.test(text[j])) j++;
                        out += `<span style="color:var(--purple)">${text.slice(i, j)}</span>`;
                        i = j;
                        afterDot = false;
                        continue;
                    }

                    if (/[a-zA-Z_$]/.test(ch)) {
                        let j = i;
                        while (j < text.length && /[a-zA-Z0-9_$]/.test(text[j])) j++;
                        const word = text.slice(i, j);
                        const isCall = text[j] === '(';
                        const color = isCall
                            ? (afterDot ? 'var(--accent)' : 'var(--cyan)')
                            : 'var(--text)';
                        out += `<span style="color:${color}">${esc(word)}</span>`;
                        i = j;
                        afterDot = false;
                        continue;
                    }

                    if (ch === '(' || ch === ')') {
                        out += `<span style="color:var(--text)">${ch}</span>`;
                        i++;
                        afterDot = false;
                        continue;
                    }

                    out += esc(ch);
                    if (ch.trim()) afterDot = false;
                    i++;
                }

                if (currentSpanStyle) {
                    out += '</span>';
                    currentSpanStyle = null;
                }

                return out;
            }

            const fullHighlightedHtml = highlightFull(visibleLines.join('\n'));
            const highlightedLines = fullHighlightedHtml.split('\n');

            let activeIdx = visibleLines.findIndex(l => l.trim() && !l.trim().startsWith('//'));
            if (activeIdx === -1) activeIdx = 0;

            const lineNums = visibleLines.map((_, i) => {
                const mt = i === 0 ? 'margin-top:12px;' : '';
                const bg = i === activeIdx ? 'background:var(--bg-lighter);color:var(--text);' : '';
                return `<div class="es-gut-el" style="height:${lineHeight}px;${mt}${bg}">${i + 1}</div>`;
            }).join('');

            const foldHidden = `<div class="es-gut-el" style="height:0;visibility:hidden;pointer-events:none"><span>›</span></div>`;
            const gutterCells = visibleLines.map((_, i) => {
                const mt = i === 0 ? 'margin-top:12px;' : '';
                const bg = i === activeIdx ? 'background:var(--bg-lighter);' : '';
                return `<div class="es-gut-el" style="height:${lineHeight}px;${mt}${bg}"></div>`;
            }).join('');

            let cumulativeDelay = 0;
            const contentRows = highlightedLines.map((hlContent, i) => {
                const rawLine = visibleLines[i];
                const trimmed = rawLine.trim();
                const mt = i === 0 ? 'margin-top:12px;' : '';
                const isActive = i === activeIdx;
                const rowBg = isActive ? 'background:var(--accent-subtle);' : '';

                const indentCount = rawLine.length - rawLine.trimStart().length;
                const typingContent = rawLine.trimStart();
                const charsPerSecond = Math.floor(Math.random() * 20) + 40;
                const duration = Math.max(0.2, typingContent.length / charsPerSecond);
                const startDelay = cumulativeDelay;
                const isEndBlock = trimmed.endsWith('}') || trimmed.endsWith(')');
                const humanPause = (Math.random() * 0.4) + (isEndBlock ? 0.8 : 0.3);
                cumulativeDelay += duration + humanPause;

                if (!trimmed) {
                    cumulativeDelay += 0.25;
                    return `<div class="es-row" style="height:${lineHeight}px;${mt}"></div>`;
                }

                const skipPercent = rawLine.length > 0 ? ((indentCount / rawLine.length) * 100).toFixed(2) : 0;
                const textStyle = `animation-duration:${duration.toFixed(2)}s; animation-delay:${startDelay.toFixed(2)}s; --skip:${skipPercent}%;`;

                return `<div class="es-row" style="height:${lineHeight}px;${mt}${rowBg}">
                    <span class="es-row-text" style="${textStyle}">${hlContent}</span>
                </div>`;
            }).join('');

            // noinspection CssInvalidPropertyValue
            editorEl.innerHTML = `
        <div class="editor-skel">
            <div class="es-gutters" style="font-size:${fontSize}px">
                <div class="es-gutter es-gutter-ln">
                    <div class="es-gut-el" style="height:0;visibility:hidden;pointer-events:none">${'9'.repeat(digits)}</div>
                    ${lineNums}
                </div>
                <div class="es-gutter es-gutter-fold">${foldHidden}${gutterCells}</div>
                <div class="es-gutter es-gutter-lint">${gutterCells}</div>
            </div>
            <div class="es-content" style="font-size:${fontSize}px">${contentRows}</div>
        </div>`;
        }

        if (!zoomEl || !vizEl || !bpmSlider || !bpmValue || !bpmDisplay) {
            requestAnimationFrame(syncUI);
        }
    }

    syncUI();
})();
