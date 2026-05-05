// ==UserScript==
// @name          Quizizz Helper - Modern UI
// @namespace     https://github.com/leoaxo098
// @version       6.0.0
// @description   Modern quiz helper with multi-type question support and improved UI
// @author        Leo
// @match         https://quizizz.com/join/game/*
// @match         https://quizizz.com/join/*
// @match         https://wayground.com/join/*
// @match         https://wayground.com/join/game/*
// @grant         GM_xmlhttpRequest
// @grant         GM_addStyle
// @connect       api.cheatnetwork.eu
// @run-at        document-end
// ==/UserScript==

(function() {
    'use strict';

    const DEBUG = true;
    const VERSION = '6.0.0';

    let apiResponse = null;
    let mutationObserver = null;
    let lastProcessedQuestion = '';
    let isProcessing = false;
    let debounceTimer = null;
    let retryTimer = null;
    let currentMatch = null;

    function log(...args) {
        if (DEBUG) console.log('%c[QUIZ-HELPER]', 'color:#6366f1;font-weight:bold;background:#1e1b4b;padding:2px 6px;border-radius:3px', ...args);
    }

    /* ---------- TEXT UTILITIES ---------- */

    function stripHtml(html) {
        if (html === null || html === undefined) return '';
        const tmp = document.createElement('div');
        tmp.innerHTML = String(html);
        return tmp.textContent || tmp.innerText || '';
    }

    function extractText(element) {
        if (!element) return '';
        const clone = element.cloneNode(true);
        clone.querySelectorAll('script, style, noscript, .quiz-correct-marker, .quiz-badge').forEach(el => el.remove());
        return (clone.textContent || clone.innerText || '').trim();
    }

    function normalizeText(text) {
        if (text === null || text === undefined) return '';
        return stripHtml(String(text))
            .toLowerCase()
            .trim()
            .replace(/\s+/g, ' ')
            .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, ' ')
            .replace(/['']/g, "'")
            .replace(/[""]/g, '"')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function hashText(text) {
        const normalized = normalizeText(text);
        let hash = 0;
        for (let i = 0; i < normalized.length; i++) {
            hash = ((hash << 5) - hash) + normalized.charCodeAt(i);
            hash = hash & hash;
        }
        return hash.toString(36);
    }

    function getOptionText(option) {
        if (option === null || option === undefined) return '';
        if (typeof option === 'string') return stripHtml(option);
        if (typeof option === 'number') return String(option);
        if (typeof option === 'object') {
            // Try common shapes
            if (option.text !== undefined) return stripHtml(String(option.text));
            if (option.value !== undefined) return stripHtml(String(option.value));
            if (option.content !== undefined) return stripHtml(String(option.content));
            if (option.label !== undefined) return stripHtml(String(option.label));
            if (option.media && Array.isArray(option.media)) {
                const t = option.media.map(m => m && m.text ? m.text : '').join(' ').trim();
                if (t) return stripHtml(t);
            }
        }
        return '';
    }

    function getAnswerIndices(answer) {
        if (!answer) return [];
        let indices = answer.answer !== undefined ? answer.answer
                    : answer.answers !== undefined ? answer.answers
                    : answer.correctAnswers !== undefined ? answer.correctAnswers
                    : undefined;
        if (indices === undefined || indices === null) return [];
        if (!Array.isArray(indices)) indices = [indices];
        return indices.filter(i => i !== null && i !== undefined && typeof i === 'number');
    }

    function getQuestionType(answer) {
        if (!answer) return 'mcq';
        const t = (answer.type || answer.questionType || '').toString().toLowerCase();
        if (t) return t;
        // Heuristic
        if (Array.isArray(answer.options) && answer.options.length > 0) {
            const indices = getAnswerIndices(answer);
            return indices.length > 1 ? 'multi' : 'mcq';
        }
        if (answer.correctAnswer !== undefined || answer.correct !== undefined) return 'text';
        return 'mcq';
    }

    function levenshtein(a, b) {
        if (a === b) return 0;
        if (!a.length) return b.length;
        if (!b.length) return a.length;
        const m = [];
        for (let i = 0; i <= b.length; i++) m[i] = [i];
        for (let j = 0; j <= a.length; j++) m[0][j] = j;
        for (let i = 1; i <= b.length; i++) {
            for (let j = 1; j <= a.length; j++) {
                m[i][j] = b.charAt(i - 1) === a.charAt(j - 1)
                    ? m[i - 1][j - 1]
                    : Math.min(m[i - 1][j - 1] + 1, m[i][j - 1] + 1, m[i - 1][j] + 1);
            }
        }
        return m[b.length][a.length];
    }

    function similarity(a, b) {
        const longer = a.length > b.length ? a : b;
        const shorter = a.length > b.length ? b : a;
        if (longer.length === 0) return 1;
        return (longer.length - levenshtein(longer, shorter)) / longer.length;
    }

    function textsMatch(text1, text2) {
        const n1 = normalizeText(text1);
        const n2 = normalizeText(text2);
        if (!n1 || !n2) return false;
        if (n1 === n2) return true;
        if (n1.includes(n2) || n2.includes(n1)) return true;
        const clean1 = n1.replace(/[^a-z0-9]/g, '');
        const clean2 = n2.replace(/[^a-z0-9]/g, '');
        if (clean1 && clean1 === clean2) return true;
        if (clean1.length > 4 && clean2.length > 4 && similarity(clean1, clean2) > 0.9) return true;
        return false;
    }

    /* ---------- STYLES ---------- */

    GM_addStyle(`
        :root {
            --qh-primary: #6366f1;
            --qh-primary-dark: #4f46e5;
            --qh-primary-light: #818cf8;
            --qh-success: #10b981;
            --qh-success-dark: #059669;
            --qh-error: #ef4444;
            --qh-warning: #f59e0b;
            --qh-bg: #ffffff;
            --qh-bg-soft: #f8fafc;
            --qh-text: #0f172a;
            --qh-text-soft: #64748b;
            --qh-border: #e2e8f0;
        }

        #quiz-input-gui {
            position: fixed;
            top: 20px;
            right: 20px;
            z-index: 2147483647;
            min-width: 320px;
            max-width: 380px;
            border-radius: 16px;
            background: var(--qh-bg);
            box-shadow: 0 20px 60px rgba(15,23,42,0.25), 0 8px 16px rgba(15,23,42,0.08);
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Inter', sans-serif;
            color: var(--qh-text);
            overflow: hidden;
            backdrop-filter: blur(12px);
            border: 1px solid var(--qh-border);
            animation: qh-slideIn 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
            transition: box-shadow 0.3s ease, transform 0.2s ease;
        }
        #quiz-input-gui:hover {
            box-shadow: 0 25px 70px rgba(15,23,42,0.30), 0 10px 20px rgba(15,23,42,0.10);
        }

        @keyframes qh-slideIn {
            from { opacity: 0; transform: translateY(-20px) scale(0.95); }
            to { opacity: 1; transform: translateY(0) scale(1); }
        }

        #quiz-gui-header {
            padding: 14px 16px;
            background: linear-gradient(135deg, var(--qh-primary) 0%, var(--qh-primary-dark) 100%);
            color: white;
            display: flex;
            justify-content: space-between;
            align-items: center;
            cursor: move;
            user-select: none;
            position: relative;
            overflow: hidden;
        }
        #quiz-gui-header::before {
            content: '';
            position: absolute;
            inset: 0;
            background: linear-gradient(120deg, transparent 30%, rgba(255,255,255,0.15) 50%, transparent 70%);
            background-size: 200% 100%;
            animation: qh-shimmer 4s infinite;
            pointer-events: none;
        }
        @keyframes qh-shimmer {
            0% { background-position: 200% 0; }
            100% { background-position: -200% 0; }
        }

        .qh-title {
            display: flex; align-items: center; gap: 8px;
            font-size: 14px; font-weight: 600; letter-spacing: 0.2px;
        }
        .qh-logo {
            width: 22px; height: 22px;
            background: rgba(255,255,255,0.25);
            border-radius: 6px;
            display: inline-flex; align-items: center; justify-content: center;
            font-size: 13px;
            animation: qh-pop 0.6s cubic-bezier(0.34, 1.56, 0.64, 1);
        }
        @keyframes qh-pop {
            0% { transform: scale(0); }
            100% { transform: scale(1); }
        }
        .qh-version {
            font-size: 10px; opacity: 0.7; font-weight: 500;
            background: rgba(255,255,255,0.15);
            padding: 2px 6px; border-radius: 4px;
        }

        #quiz-toggle-btn {
            background: rgba(255,255,255,0.15);
            border: none; color: white;
            font-size: 18px; cursor: pointer;
            width: 28px; height: 28px;
            border-radius: 8px;
            display: flex; align-items: center; justify-content: center;
            transition: all 0.2s ease;
        }
        #quiz-toggle-btn:hover {
            background: rgba(255,255,255,0.3);
            transform: rotate(90deg);
        }

        #quiz-gui-content {
            padding: 16px;
            background: var(--qh-bg);
            transition: max-height 0.35s ease, opacity 0.25s ease, padding 0.3s ease;
            overflow: hidden;
        }
        #quiz-gui-content.qh-collapsed {
            max-height: 0;
            opacity: 0;
            padding-top: 0;
            padding-bottom: 0;
        }

        .qh-input-wrap {
            position: relative; margin-bottom: 12px;
        }
        #quiz-code-input {
            width: 100%;
            padding: 12px 14px;
            border: 2px solid var(--qh-border);
            border-radius: 10px;
            font-size: 15px;
            font-weight: 500;
            text-align: center;
            letter-spacing: 1px;
            outline: none;
            box-sizing: border-box;
            background: var(--qh-bg-soft);
            color: var(--qh-text);
            transition: all 0.2s ease;
            font-family: 'SF Mono', Menlo, Consolas, monospace;
        }
        #quiz-code-input:focus {
            border-color: var(--qh-primary);
            background: var(--qh-bg);
            box-shadow: 0 0 0 4px rgba(99,102,241,0.12);
        }
        #quiz-code-input::placeholder {
            font-family: -apple-system, sans-serif;
            letter-spacing: 0;
            color: var(--qh-text-soft);
            font-weight: 400;
        }

        #quiz-submit-btn {
            width: 100%;
            padding: 12px;
            background: linear-gradient(135deg, var(--qh-primary) 0%, var(--qh-primary-dark) 100%);
            color: white; border: none;
            border-radius: 10px;
            font-size: 15px; font-weight: 600;
            cursor: pointer;
            transition: all 0.2s ease;
            position: relative; overflow: hidden;
            display: flex; align-items: center; justify-content: center; gap: 8px;
        }
        #quiz-submit-btn:hover:not(:disabled) {
            transform: translateY(-1px);
            box-shadow: 0 8px 20px rgba(99,102,241,0.4);
        }
        #quiz-submit-btn:active:not(:disabled) {
            transform: translateY(0);
        }
        #quiz-submit-btn:disabled {
            background: #cbd5e1; cursor: not-allowed;
            color: #64748b;
        }
        #quiz-submit-btn::after {
            content: ''; position: absolute; inset: 0;
            background: radial-gradient(circle at center, rgba(255,255,255,0.3), transparent 60%);
            opacity: 0; transition: opacity 0.3s ease;
        }
        #quiz-submit-btn:hover:not(:disabled)::after { opacity: 1; }

        .qh-spinner {
            width: 14px; height: 14px;
            border: 2px solid rgba(255,255,255,0.4);
            border-top-color: white;
            border-radius: 50%;
            animation: qh-spin 0.8s linear infinite;
        }
        @keyframes qh-spin {
            to { transform: rotate(360deg); }
        }

        #quiz-status {
            margin-top: 12px;
            font-size: 12px;
            color: var(--qh-text-soft);
            text-align: center;
            min-height: 16px;
            font-weight: 500;
            transition: color 0.2s ease;
            display: flex; align-items: center; justify-content: center; gap: 6px;
        }
        .qh-status-dot {
            width: 6px; height: 6px; border-radius: 50%;
            background: currentColor;
            animation: qh-blink 1.5s ease-in-out infinite;
        }
        @keyframes qh-blink {
            0%, 100% { opacity: 0.4; }
            50% { opacity: 1; }
        }

        #quiz-answer-display {
            margin-top: 14px;
            padding: 14px;
            background: linear-gradient(135deg, #f0fdf4 0%, #ecfdf5 100%);
            border: 1px solid #bbf7d0;
            border-radius: 12px;
            font-size: 13px;
            display: none;
            max-height: 280px;
            overflow-y: auto;
            word-wrap: break-word;
            animation: qh-fadeIn 0.3s ease;
        }
        @keyframes qh-fadeIn {
            from { opacity: 0; transform: translateY(-4px); }
            to { opacity: 1; transform: translateY(0); }
        }

        #quiz-answer-display::-webkit-scrollbar { width: 6px; }
        #quiz-answer-display::-webkit-scrollbar-track { background: transparent; }
        #quiz-answer-display::-webkit-scrollbar-thumb {
            background: #cbd5e1; border-radius: 3px;
        }

        .qh-q-label, .qh-a-label {
            font-size: 11px; font-weight: 700;
            text-transform: uppercase; letter-spacing: 0.6px;
            margin-bottom: 6px;
            display: flex; align-items: center; gap: 6px;
        }
        .qh-q-label { color: var(--qh-text-soft); }
        .qh-a-label { color: var(--qh-success-dark); margin-top: 10px; }

        .qh-q-text {
            color: var(--qh-text);
            font-size: 12px;
            padding: 8px 10px;
            background: white;
            border-radius: 8px;
            border: 1px solid var(--qh-border);
            line-height: 1.4;
        }

        .qh-answer-item {
            color: #065f46;
            padding: 8px 12px;
            background: white;
            border-left: 3px solid var(--qh-success);
            border-radius: 6px;
            margin: 5px 0;
            font-size: 13px;
            font-weight: 500;
            display: flex; align-items: flex-start; gap: 8px;
            animation: qh-slideRight 0.3s ease forwards;
            opacity: 0;
        }
        .qh-answer-item:nth-child(1) { animation-delay: 0.05s; }
        .qh-answer-item:nth-child(2) { animation-delay: 0.10s; }
        .qh-answer-item:nth-child(3) { animation-delay: 0.15s; }
        .qh-answer-item:nth-child(4) { animation-delay: 0.20s; }
        .qh-answer-item:nth-child(5) { animation-delay: 0.25s; }

        @keyframes qh-slideRight {
            from { opacity: 0; transform: translateX(-10px); }
            to { opacity: 1; transform: translateX(0); }
        }

        .qh-answer-check {
            color: var(--qh-success);
            font-weight: bold;
            flex-shrink: 0;
        }

        .qh-type-badge {
            display: inline-block;
            font-size: 10px;
            font-weight: 600;
            padding: 2px 8px;
            border-radius: 10px;
            background: var(--qh-primary);
            color: white;
            text-transform: uppercase;
            letter-spacing: 0.4px;
            margin-left: auto;
        }

        /* Notification */
        .quiz-notification {
            position: fixed; top: 24px; left: 50%;
            transform: translateX(-50%) translateY(-20px);
            z-index: 2147483647;
            color: white; padding: 12px 22px;
            border-radius: 12px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.2);
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            font-size: 14px; font-weight: 500;
            max-width: 80%; text-align: center;
            opacity: 0;
            transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
            display: flex; align-items: center; gap: 10px;
            backdrop-filter: blur(10px);
        }
        .quiz-notification.qh-show {
            opacity: 1; transform: translateX(-50%) translateY(0);
        }

        /* Highlighted answer on the page */
        [data-quiz-marked="true"] {
            outline: 3px solid #10b981 !important;
            outline-offset: 2px !important;
            box-shadow: 0 0 0 6px rgba(16,185,129,0.20), 0 8px 24px rgba(16,185,129,0.35) !important;
            background: rgba(16,185,129,0.08) !important;
            border-radius: 8px !important;
            transition: all 0.3s ease !important;
            animation: qh-glow 2.4s ease-in-out infinite !important;
        }
        @keyframes qh-glow {
            0%, 100% { box-shadow: 0 0 0 6px rgba(16,185,129,0.20), 0 8px 24px rgba(16,185,129,0.35) !important; }
            50%      { box-shadow: 0 0 0 10px rgba(16,185,129,0.10), 0 12px 32px rgba(16,185,129,0.50) !important; }
        }

        .quiz-correct-marker {
            position: absolute;
            top: 6px; right: 6px;
            background: linear-gradient(135deg, #10b981, #059669);
            color: white;
            padding: 4px 10px;
            border-radius: 999px;
            font-size: 11px;
            font-weight: 700;
            letter-spacing: 0.4px;
            z-index: 10000;
            pointer-events: none;
            box-shadow: 0 4px 12px rgba(16,185,129,0.4);
            animation: qh-bounce 0.5s cubic-bezier(0.34, 1.56, 0.64, 1);
            display: flex; align-items: center; gap: 4px;
        }
        @keyframes qh-bounce {
            0% { transform: scale(0) rotate(-15deg); }
            100% { transform: scale(1) rotate(0); }
        }

        /* Floating answer card for unsupported (text/typed) questions */
        #qh-floating-answer {
            position: fixed;
            bottom: 24px; left: 50%;
            transform: translateX(-50%) translateY(40px);
            z-index: 2147483646;
            background: linear-gradient(135deg, #10b981, #059669);
            color: white;
            padding: 14px 20px;
            border-radius: 14px;
            box-shadow: 0 20px 40px rgba(16,185,129,0.4);
            font-family: -apple-system, BlinkMacSystemFont, sans-serif;
            font-size: 14px; font-weight: 600;
            max-width: min(560px, 90vw);
            opacity: 0;
            transition: all 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
            display: flex; align-items: center; gap: 10px;
            cursor: pointer;
        }
        #qh-floating-answer.qh-show {
            opacity: 1; transform: translateX(-50%) translateY(0);
        }
        #qh-floating-answer:hover {
            box-shadow: 0 25px 50px rgba(16,185,129,0.55);
        }
        #qh-floating-answer .qh-fa-label {
            font-size: 10px; text-transform: uppercase;
            letter-spacing: 1px; opacity: 0.85;
            font-weight: 700;
        }
        #qh-floating-answer .qh-fa-text {
            font-size: 15px; font-weight: 700;
            margin-top: 2px;
            word-break: break-word;
        }
        #qh-floating-answer .qh-fa-icon {
            font-size: 22px;
            background: rgba(255,255,255,0.2);
            width: 36px; height: 36px;
            border-radius: 10px;
            display: flex; align-items: center; justify-content: center;
            flex-shrink: 0;
        }

        @media (prefers-color-scheme: dark) {
            :root {
                --qh-bg: #1e293b;
                --qh-bg-soft: #0f172a;
                --qh-text: #f1f5f9;
                --qh-text-soft: #94a3b8;
                --qh-border: #334155;
            }
            #quiz-code-input { color: var(--qh-text); }
            .qh-q-text { background: var(--qh-bg-soft); color: var(--qh-text); }
            .qh-answer-item { background: rgba(255,255,255,0.05); color: #6ee7b7; }
            #quiz-answer-display {
                background: linear-gradient(135deg, rgba(16,185,129,0.1), rgba(5,150,105,0.05));
                border-color: rgba(16,185,129,0.3);
            }
        }
    `);

    /* ---------- GUI ---------- */

    function createInputGUI() {
        const gui = document.createElement('div');
        gui.id = 'quiz-input-gui';
        gui.innerHTML = `
            <div id="quiz-gui-header">
                <div class="qh-title">
                    <span class="qh-logo">🎯</span>
                    <span>Quiz Helper</span>
                    <span class="qh-version">v${VERSION}</span>
                </div>
                <button id="quiz-toggle-btn" title="Collapse">−</button>
            </div>
            <div id="quiz-gui-content">
                <div class="qh-input-wrap">
                    <input type="text" id="quiz-code-input" placeholder="Enter quiz code" autocomplete="off" spellcheck="false" maxlength="20">
                </div>
                <button id="quiz-submit-btn">
                    <span class="qh-btn-label">Load Answers</span>
                </button>
                <div id="quiz-status"></div>
                <div id="quiz-answer-display"></div>
            </div>
        `;
        document.body.appendChild(gui);
        makeDraggable(gui);
        makeCollapsible(gui);
        return gui;
    }

    function makeDraggable(element) {
        const header = element.querySelector('#quiz-gui-header');
        let isDragging = false;
        let initialX, initialY;
        let xOffset = 0, yOffset = 0;

        const storedPos = localStorage.getItem('quiz-helper-position');
        if (storedPos) {
            try {
                const pos = JSON.parse(storedPos);
                if (pos.x >= 0 && pos.y >= 0 &&
                    pos.x < window.innerWidth - 50 &&
                    pos.y < window.innerHeight - 50) {
                    element.style.left = pos.x + 'px';
                    element.style.top = pos.y + 'px';
                    element.style.right = 'auto';
                    xOffset = pos.x; yOffset = pos.y;
                }
            } catch (e) {}
        }

        function dragStart(e) {
            if (e.target.id === 'quiz-toggle-btn' || e.target.closest('#quiz-toggle-btn')) return;
            const point = e.type === 'touchstart' ? e.touches[0] : e;
            initialX = point.clientX - xOffset;
            initialY = point.clientY - yOffset;
            isDragging = true;
            element.style.transition = 'none';
        }

        function drag(e) {
            if (!isDragging) return;
            e.preventDefault();
            const point = e.type === 'touchmove' ? e.touches[0] : e;
            xOffset = point.clientX - initialX;
            yOffset = point.clientY - initialY;
            const rect = element.getBoundingClientRect();
            xOffset = Math.max(0, Math.min(xOffset, window.innerWidth - rect.width));
            yOffset = Math.max(0, Math.min(yOffset, window.innerHeight - rect.height));
            element.style.left = xOffset + 'px';
            element.style.top = yOffset + 'px';
            element.style.right = 'auto';
        }

        function dragEnd() {
            if (isDragging) {
                isDragging = false;
                element.style.transition = '';
                localStorage.setItem('quiz-helper-position', JSON.stringify({ x: xOffset, y: yOffset }));
            }
        }

        header.addEventListener('mousedown', dragStart);
        document.addEventListener('mousemove', drag);
        document.addEventListener('mouseup', dragEnd);
        header.addEventListener('touchstart', dragStart, { passive: false });
        document.addEventListener('touchmove', drag, { passive: false });
        document.addEventListener('touchend', dragEnd);
    }

    function makeCollapsible(element) {
        const toggleBtn = element.querySelector('#quiz-toggle-btn');
        const content = element.querySelector('#quiz-gui-content');
        let isCollapsed = localStorage.getItem('quiz-helper-collapsed') === 'true';

        const apply = () => {
            if (isCollapsed) {
                content.style.maxHeight = content.scrollHeight + 'px';
                requestAnimationFrame(() => {
                    content.classList.add('qh-collapsed');
                    content.style.maxHeight = '0';
                });
                toggleBtn.textContent = '+';
            } else {
                content.classList.remove('qh-collapsed');
                content.style.maxHeight = content.scrollHeight + 'px';
                setTimeout(() => { content.style.maxHeight = ''; }, 360);
                toggleBtn.textContent = '−';
            }
        };

        if (isCollapsed) {
            content.classList.add('qh-collapsed');
            toggleBtn.textContent = '+';
        }

        toggleBtn.onclick = (e) => {
            e.stopPropagation();
            isCollapsed = !isCollapsed;
            apply();
            localStorage.setItem('quiz-helper-collapsed', isCollapsed);
        };
    }

    function setCollapsed(collapsed) {
        const content = document.getElementById('quiz-gui-content');
        const btn = document.getElementById('quiz-toggle-btn');
        if (!content || !btn) return;
        if (collapsed) {
            content.classList.add('qh-collapsed');
            btn.textContent = '+';
        } else {
            content.classList.remove('qh-collapsed');
            btn.textContent = '−';
        }
        localStorage.setItem('quiz-helper-collapsed', collapsed);
    }

    /* ---------- NOTIFICATIONS ---------- */

    function showNotification(message, type = 'info') {
        document.querySelectorAll('.quiz-notification').forEach(n => {
            n.classList.remove('qh-show');
            setTimeout(() => n.remove(), 300);
        });
        const colors = {
            info:    'linear-gradient(135deg, #6366f1, #4f46e5)',
            error:   'linear-gradient(135deg, #ef4444, #dc2626)',
            warning: 'linear-gradient(135deg, #f59e0b, #d97706)',
            success: 'linear-gradient(135deg, #10b981, #059669)'
        };
        const icons = { info: 'ℹ️', error: '⚠️', warning: '⚡', success: '✓' };

        const notif = document.createElement('div');
        notif.className = 'quiz-notification';
        notif.style.background = colors[type] || colors.info;
        notif.innerHTML = `<span style="font-size:16px">${icons[type] || icons.info}</span><span>${message}</span>`;
        document.body.appendChild(notif);
        requestAnimationFrame(() => notif.classList.add('qh-show'));
        setTimeout(() => {
            notif.classList.remove('qh-show');
            setTimeout(() => notif.remove(), 300);
        }, 2800);
    }

    function updateStatus(message, color) {
        const status = document.getElementById('quiz-status');
        if (!status) return;
        const colorMap = {
            success: 'var(--qh-success)',
            error:   'var(--qh-error)',
            warning: 'var(--qh-warning)',
            info:    'var(--qh-text-soft)'
        };
        const c = colorMap[color] || color || 'var(--qh-text-soft)';
        status.innerHTML = message
            ? `<span class="qh-status-dot" style="background:${c}"></span><span>${message}</span>`
            : '';
        status.style.color = c;
    }

    function showAnswerInGUI(questionText, answers, type) {
        const display = document.getElementById('quiz-answer-display');
        if (!display) return;
        const typeLabel = {
            mcq: 'Multiple Choice', multi: 'Multi-Select',
            text: 'Text Answer', fill: 'Fill in Blank',
            poll: 'Poll', open: 'Open Ended', match: 'Match'
        }[type] || type || 'Question';

        display.style.display = 'block';
        display.innerHTML = `
            <div class="qh-q-label">
                <span>📝 Question</span>
                <span class="qh-type-badge">${typeLabel}</span>
            </div>
            <div class="qh-q-text">${escapeHtml(questionText.substring(0, 220))}${questionText.length > 220 ? '…' : ''}</div>
            <div class="qh-a-label">✓ Correct Answer${answers.length > 1 ? 's' : ''}</div>
            ${answers.map(a => `
                <div class="qh-answer-item">
                    <span class="qh-answer-check">✓</span>
                    <span>${escapeHtml(a)}</span>
                </div>
            `).join('')}
        `;
    }

    function escapeHtml(s) {
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    /* ---------- FLOATING ANSWER (for typed/unsupported questions) ---------- */

    function showFloatingAnswer(answers) {
        let card = document.getElementById('qh-floating-answer');
        if (!card) {
            card = document.createElement('div');
            card.id = 'qh-floating-answer';
            card.title = 'Click to dismiss';
            card.addEventListener('click', () => {
                card.classList.remove('qh-show');
            });
            document.body.appendChild(card);
        }
        const text = answers.join('  •  ');
        card.innerHTML = `
            <div class="qh-fa-icon">💡</div>
            <div>
                <div class="qh-fa-label">Answer</div>
                <div class="qh-fa-text">${escapeHtml(text)}</div>
            </div>
        `;
        requestAnimationFrame(() => card.classList.add('qh-show'));
    }

    function hideFloatingAnswer() {
        const card = document.getElementById('qh-floating-answer');
        if (card) card.classList.remove('qh-show');
    }

    /* ---------- API ---------- */

    function loadAnswers(code) {
        log('Loading answers for code:', code);
        const submitBtn = document.getElementById('quiz-submit-btn');
        submitBtn.disabled = true;
        submitBtn.innerHTML = `<span class="qh-spinner"></span><span>Loading…</span>`;
        updateStatus('Fetching answers...', 'info');

        GM_xmlhttpRequest({
            method: 'GET',
            url: `https://api.cheatnetwork.eu/quizizz/${encodeURIComponent(code)}/answers`,
            timeout: 15000,
            onload: function(response) {
                submitBtn.disabled = false;
                submitBtn.innerHTML = `<span class="qh-btn-label">Reload Answers</span>`;

                if (response.status === 200) {
                    try {
                        apiResponse = JSON.parse(response.responseText);
                        if (apiResponse && apiResponse.answers && Array.isArray(apiResponse.answers)) {
                            log('Loaded', apiResponse.answers.length, 'questions');
                            apiResponse.answers.forEach((q, i) => {
                                const indices = getAnswerIndices(q);
                                const texts = indices.map(idx => getOptionText(q.options?.[idx]));
                                log(`Q${i+1} [${getQuestionType(q)}]: "${(q.question || '').substring(0,40)}…" → ${texts.join(', ') || q.correctAnswer || '(typed)'}`);
                            });
                            showNotification(`Loaded ${apiResponse.answers.length} questions`, 'success');
                            updateStatus(`Ready • ${apiResponse.answers.length} questions`, 'success');
                            initializeAnswerSystem();
                            setTimeout(() => setCollapsed(true), 800);
                        } else {
                            showNotification('Invalid response format', 'error');
                            updateStatus('Invalid format', 'error');
                        }
                    } catch (e) {
                        showNotification('Failed to parse response', 'error');
                        updateStatus('Parse error', 'error');
                        log('Parse error:', e);
                    }
                } else if (response.status === 404) {
                    showNotification('Quiz not found - check code', 'error');
                    updateStatus('Not found', 'error');
                } else {
                    showNotification(`Server error: ${response.status}`, 'error');
                    updateStatus(`Error ${response.status}`, 'error');
                }
            },
            onerror: function() {
                submitBtn.disabled = false;
                submitBtn.innerHTML = `<span class="qh-btn-label">Load Answers</span>`;
                showNotification('Network error - check connection', 'error');
                updateStatus('Network error', 'error');
            },
            ontimeout: function() {
                submitBtn.disabled = false;
                submitBtn.innerHTML = `<span class="qh-btn-label">Load Answers</span>`;
                showNotification('Request timed out', 'error');
                updateStatus('Timeout', 'error');
            }
        });
    }

    /* ---------- OBSERVER & PROCESSING ---------- */

    function initializeAnswerSystem() {
        log('Initializing answer system');
        if (mutationObserver) mutationObserver.disconnect();

        mutationObserver = new MutationObserver(() => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => processQuestion(), 180);
        });
        mutationObserver.observe(document.body, { childList: true, subtree: true, characterData: true });

        // Initial scans (some are needed because the question may render late)
        [0, 300, 700, 1300, 2200, 3500].forEach(d => setTimeout(processQuestion, d));
    }

    function findQuestionElement() {
        const selectors = [
            '.question-text-color',
            '[class*="QuestionText"]',
            '[class*="questionText"]',
            '[class*="question-text"]',
            '[data-testid*="question"]',
            '.question-content',
            '[class*="prompt"]',
            '[class*="Prompt"]',
            '[role="heading"]'
        ];
        for (const selector of selectors) {
            try {
                const elements = document.querySelectorAll(selector);
                for (const el of elements) {
                    const text = extractText(el);
                    if (!text || text.length < 2) continue;
                    const rect = el.getBoundingClientRect();
                    if (rect.width > 0 && rect.height > 0) {
                        return { el, text };
                    }
                }
            } catch (e) {}
        }
        return null;
    }

    function processQuestion() {
        if (!apiResponse || !apiResponse.answers) return;
        if (isProcessing) return;
        isProcessing = true;

        try {
            const found = findQuestionElement();
            if (!found) { isProcessing = false; return; }

            const { text: questionText } = found;
            const questionHash = hashText(questionText);

            // If same question, but options haven't been marked yet (because they
            // rendered after the question text), retry the highlight pass.
            if (questionHash === lastProcessedQuestion) {
                if (currentMatch) {
                    const alreadyMarked = document.querySelector('[data-quiz-marked="true"]');
                    if (!alreadyMarked) {
                        // Options may have rendered late - reapply highlights
                        markCorrectAnswers(currentMatch, questionText, /*silent*/ true);
                    }
                }
                isProcessing = false;
                return;
            }

            lastProcessedQuestion = questionHash;
            hideFloatingAnswer();
            log('Processing:', questionText.substring(0, 80));

            const match = findMatch(questionText);
            if (match) {
                currentMatch = match;
                markCorrectAnswers(match, questionText);
                // Schedule retries in case options render after the question
                clearTimeout(retryTimer);
                let attempts = 0;
                const retry = () => {
                    attempts++;
                    if (attempts > 5) return;
                    if (hashText(questionText) !== lastProcessedQuestion) return;
                    const marked = document.querySelector('[data-quiz-marked="true"]');
                    if (!marked && currentMatch) {
                        markCorrectAnswers(currentMatch, questionText, true);
                    }
                    retryTimer = setTimeout(retry, 350 * attempts);
                };
                retryTimer = setTimeout(retry, 400);
            } else {
                currentMatch = null;
                clearPreviousMarkers();
                updateStatus('No match found', 'warning');
            }
        } catch (error) {
            log('Error:', error);
        } finally {
            isProcessing = false;
        }
    }

    function findMatch(questionText) {
        const normalizedQuestion = normalizeText(questionText);
        if (!normalizedQuestion) return null;

        // 1. Exact
        for (const a of apiResponse.answers) {
            if (a.question && normalizedQuestion === normalizeText(a.question)) {
                log('EXACT match'); return a;
            }
        }
        // 2. Contains
        for (const a of apiResponse.answers) {
            if (!a.question) continue;
            const apiQ = normalizeText(a.question);
            if (apiQ.length > 5 && (normalizedQuestion.includes(apiQ) || apiQ.includes(normalizedQuestion))) {
                log('CONTAINS match'); return a;
            }
        }
        // 3. Alphanumeric
        const cleanQ = normalizedQuestion.replace(/[^a-z0-9]/g, '');
        for (const a of apiResponse.answers) {
            if (!a.question) continue;
            const cleanApiQ = normalizeText(a.question).replace(/[^a-z0-9]/g, '');
            if (cleanQ.length > 3 && cleanQ === cleanApiQ) {
                log('ALPHANUMERIC match'); return a;
            }
        }
        // 4. Word overlap (>=70%)
        const words = normalizedQuestion.split(' ').filter(w => w.length > 2);
        let best = null, bestScore = 0;
        for (const a of apiResponse.answers) {
            if (!a.question) continue;
            const apiWords = normalizeText(a.question).split(' ').filter(w => w.length > 2);
            if (!words.length || !apiWords.length) continue;
            const matching = words.filter(w => apiWords.includes(w));
            const score = matching.length / Math.max(words.length, apiWords.length);
            if (score > bestScore) { bestScore = score; best = a; }
        }
        if (bestScore >= 0.7) { log('WORD match', bestScore.toFixed(2)); return best; }

        // 5. Fuzzy similarity
        let fuzzyBest = null, fuzzyScore = 0;
        for (const a of apiResponse.answers) {
            if (!a.question) continue;
            const score = similarity(normalizedQuestion, normalizeText(a.question));
            if (score > fuzzyScore) { fuzzyScore = score; fuzzyBest = a; }
        }
        if (fuzzyScore >= 0.85) { log('FUZZY match', fuzzyScore.toFixed(2)); return fuzzyBest; }

        return null;
    }

    function clearPreviousMarkers() {
        document.querySelectorAll('[data-quiz-marked="true"]').forEach(el => {
            el.removeAttribute('data-quiz-marked');
            el.style.outline = '';
            el.style.outlineOffset = '';
            el.style.boxShadow = '';
            el.style.background = '';
            el.style.borderRadius = '';
        });
        document.querySelectorAll('.quiz-correct-marker').forEach(el => el.remove());
    }

    /* ---------- ANSWER MARKING ---------- */

    function markCorrectAnswers(answer, questionText, silent = false) {
        clearPreviousMarkers();

        const type = getQuestionType(answer);
        const answerIndices = getAnswerIndices(answer);

        // ---------- Build display + correct text list ----------
        const correctTexts = [];   // normalized
        const displayTexts = [];   // raw

        // 1) From option indices
        if (answerIndices.length > 0 && Array.isArray(answer.options)) {
            answerIndices.forEach(index => {
                const opt = answer.options[index];
                if (opt !== undefined) {
                    const text = getOptionText(opt);
                    if (text) {
                        correctTexts.push(normalizeText(text));
                        displayTexts.push(text);
                    }
                }
            });
        }

        // 2) Direct answer field (text/fill-in-blank)
        const directKeys = ['correctAnswer', 'correct', 'answerText', 'correctAnswers'];
        for (const k of directKeys) {
            if (answer[k] !== undefined && answer[k] !== null) {
                const v = answer[k];
                const arr = Array.isArray(v) ? v : [v];
                arr.forEach(item => {
                    const text = typeof item === 'object' ? getOptionText(item) : stripHtml(String(item));
                    if (text && !displayTexts.includes(text)) {
                        correctTexts.push(normalizeText(text));
                        displayTexts.push(text);
                    }
                });
            }
        }

        // 3) Fallback - if multi-select but indices missing, scan options for `correct` flag
        if (displayTexts.length === 0 && Array.isArray(answer.options)) {
            answer.options.forEach(opt => {
                if (opt && (opt.correct === true || opt.isCorrect === true)) {
                    const text = getOptionText(opt);
                    if (text) {
                        correctTexts.push(normalizeText(text));
                        displayTexts.push(text);
                    }
                }
            });
        }

        if (displayTexts.length === 0) {
            log('No answer extractable for question', answer);
            updateStatus('Could not extract answer', 'error');
            return;
        }

        showAnswerInGUI(questionText, displayTexts, type);
        updateStatus(`Found ${displayTexts.length} answer${displayTexts.length > 1 ? 's' : ''}`, 'success');

        // ---------- Highlight on page ----------
        const marked = highlightByText(correctTexts);

        // For text/fill-in/open-ended (or when no UI option matched),
        // show floating answer card so the user always sees the answer.
        const isTyped = ['text', 'fill', 'open', 'openEnded', 'fill-in-the-blank', 'fillInTheBlank'].some(t => type.includes(t));
        if (marked === 0 || isTyped) {
            showFloatingAnswer(displayTexts);
            if (!silent) {
                if (marked === 0) {
                    showNotification('Answer shown - type it in', 'success');
                } else {
                    showNotification(`Marked ${marked} answer${marked > 1 ? 's' : ''}`, 'success');
                }
            }
        } else if (!silent) {
            showNotification(`Marked ${marked} correct answer${marked > 1 ? 's' : ''}`, 'success');
        }
    }

    function highlightByText(correctTexts) {
        const optionSelectors = [
            '.option',
            '[class*="option-container"]',
            '[class*="OptionContainer"]',
            '[class*="option"]',
            '[class*="Option"]',
            '[data-testid*="option"]',
            '[data-testid*="Option"]',
            '.answer-choice',
            '[class*="answer-choice"]',
            '[class*="answer"]',
            '[class*="Answer"]',
            '[class*="choice"]',
            '[role="button"]',
            '.resizeable'
        ];

        let options = [];
        for (const selector of optionSelectors) {
            try {
                const els = Array.from(document.querySelectorAll(selector)).filter(el => {
                    const r = el.getBoundingClientRect();
                    return r.width > 30 && r.height > 20;
                });
                if (els.length >= 2 && els.length <= 12) {
                    options = els;
                    log(`Found ${els.length} options with: ${selector}`);
                    break;
                }
            } catch (e) {}
        }

        if (options.length === 0) {
            log('No clickable options found - probably typed-answer question');
            return 0;
        }

        let marked = 0;
        options.forEach((option, i) => {
            const optionText = extractText(option);
            const normalized = normalizeText(optionText);
            if (!normalized) return;

            const isCorrect = correctTexts.some(ct => textsMatch(normalized, ct));
            if (isCorrect) {
                log(`✓ Marking option ${i + 1}: "${normalized.substring(0, 40)}"`);
                option.dataset.quizMarked = 'true';

                if (!option.querySelector('.quiz-correct-marker')) {
                    const marker = document.createElement('div');
                    marker.className = 'quiz-correct-marker';
                    marker.innerHTML = '✓ CORRECT';
                    const style = getComputedStyle(option);
                    if (!['absolute', 'relative', 'fixed', 'sticky'].includes(style.position)) {
                        option.style.position = 'relative';
                    }
                    option.appendChild(marker);
                }
                marked++;
            }
        });

        return marked;
    }

    /* ---------- INIT ---------- */

    function initialize() {
        log(`Initializing Quiz Helper v${VERSION}`);
        createInputGUI();
        const input = document.getElementById('quiz-code-input');
        const button = document.getElementById('quiz-submit-btn');

        input.addEventListener('input', (e) => {
            e.target.value = e.target.value.replace(/[^0-9a-zA-Z]/g, '');
        });

        button.addEventListener('click', () => {
            const code = input.value.trim();
            if (code.length >= 4) {
                loadAnswers(code);
            } else {
                input.style.borderColor = 'var(--qh-error)';
                input.style.animation = 'qh-shake 0.4s';
                showNotification('Please enter a valid quiz code', 'error');
                setTimeout(() => {
                    input.style.borderColor = '';
                    input.style.animation = '';
                }, 1200);
            }
        });

        input.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') button.click();
        });

        // Add shake animation
        GM_addStyle(`
            @keyframes qh-shake {
                0%, 100% { transform: translateX(0); }
                25% { transform: translateX(-4px); }
                75% { transform: translateX(4px); }
            }
        `);
    }

    window.addEventListener('beforeunload', () => {
        if (mutationObserver) mutationObserver.disconnect();
        clearTimeout(debounceTimer);
        clearTimeout(retryTimer);
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize);
    } else {
        initialize();
    }
})();
