// ==UserScript==
// @name          Quizizz Cheats - Study Edition
// @namespace     https://github.com/ShizukuFuru
// @version       7.0.0
// @description   Sleek black UI quiz helper with study tools and memorization features
// @author        Claude and Me
// @match         https://quizizz.com/join/game/*
// @match         https://quizizz.com/join/*
// @match         https://wayground.com/join/*
// @match         https://wayground.com/join/game/*
// @grant         GM_xmlhttpRequest
// @grant         GM_addStyle
// @grant         GM_setValue
// @grant         GM_getValue
// @connect       api.cheatnetwork.eu
// @run-at        document-end
// ==/UserScript==

(function() {
    'use strict';

    const DEBUG = true;
    const VERSION = '7.0.0';
    const STORAGE_KEY = 'quiz-helper-data-v7';

    /* ---------- STATE ---------- */
    let apiResponse = null;
    let mutationObserver = null;
    let lastProcessedQuestion = '';
    let isProcessing = false;
    let debounceTimer = null;
    let retryTimer = null;
    let currentMatch = null;
    let currentQuestionText = '';
    let helperEnabled = GM_getValue('helper-enabled', true);
    let activeTab = 'answer';
    let studyData = loadStudyData();
    let flashcardIndex = 0;
    let flashcardFlipped = false;
    let quizModeIndex = 0;
    let quizModeScore = 0;
    let quizModeAnswered = false;
    let stealthMode = GM_getValue('stealth-mode', false);

    function log(...args) {
        if (DEBUG) console.log('%c[QH]', 'color:#fff;background:#000;padding:2px 8px;border-radius:4px;font-weight:bold', ...args);
    }

    /* ---------- PERSISTENT STUDY DATA ---------- */
    function loadStudyData() {
        try {
            const raw = GM_getValue(STORAGE_KEY, null);
            if (raw) return JSON.parse(raw);
        } catch (e) {}
        return {
            seenQuestions: {},      // hash -> { question, answers, seenCount, correctCount, lastSeen, difficulty, starred }
            stats: { totalSeen: 0, totalCorrect: 0, sessions: 0 },
            currentSession: { quizCode: null, seen: 0, correct: 0, startTime: Date.now() }
        };
    }

    function saveStudyData() {
        try { GM_setValue(STORAGE_KEY, JSON.stringify(studyData)); } catch (e) { log('Save error', e); }
    }

    function recordQuestion(hash, question, answers) {
        if (!studyData.seenQuestions[hash]) {
            studyData.seenQuestions[hash] = {
                question, answers,
                seenCount: 0, correctCount: 0,
                lastSeen: Date.now(),
                difficulty: 0,    // 0=new, 1=easy, 2=medium, 3=hard
                starred: false,
                firstSeen: Date.now()
            };
            studyData.stats.totalSeen++;
        }
        const q = studyData.seenQuestions[hash];
        q.seenCount++;
        q.lastSeen = Date.now();
        q.answers = answers; // refresh in case format changed
        q.question = question;
        studyData.currentSession.seen++;
        saveStudyData();
    }

    /* ---------- TEXT UTILITIES ---------- */
    function stripHtml(html) {
        if (html == null) return '';
        const tmp = document.createElement('div');
        tmp.innerHTML = String(html);
        return tmp.textContent || tmp.innerText || '';
    }
    function extractText(el) {
        if (!el) return '';
        const c = el.cloneNode(true);
        c.querySelectorAll('script,style,noscript,.quiz-correct-marker,.qh-badge').forEach(e => e.remove());
        return (c.textContent || c.innerText || '').trim();
    }
    function normalizeText(text) {
        if (text == null) return '';
        return stripHtml(String(text)).toLowerCase().trim()
            .replace(/\s+/g, ' ')
            .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, ' ')
            .replace(/['']/g, "'").replace(/[""]/g, '"')
            .replace(/\s+/g, ' ').trim();
    }
    function hashText(text) {
        const n = normalizeText(text);
        let h = 0;
        for (let i = 0; i < n.length; i++) { h = ((h << 5) - h) + n.charCodeAt(i); h |= 0; }
        return h.toString(36);
    }
    function getOptionText(opt) {
        if (opt == null) return '';
        if (typeof opt === 'string') return stripHtml(opt);
        if (typeof opt === 'number') return String(opt);
        if (typeof opt === 'object') {
            if (opt.text !== undefined) return stripHtml(String(opt.text));
            if (opt.value !== undefined) return stripHtml(String(opt.value));
            if (opt.content !== undefined) return stripHtml(String(opt.content));
            if (opt.label !== undefined) return stripHtml(String(opt.label));
            if (Array.isArray(opt.media)) {
                const t = opt.media.map(m => m && m.text ? m.text : '').join(' ').trim();
                if (t) return stripHtml(t);
            }
        }
        return '';
    }
    function getAnswerIndices(a) {
        if (!a) return [];
        let idx = a.answer !== undefined ? a.answer
                : a.answers !== undefined ? a.answers
                : a.correctAnswers !== undefined ? a.correctAnswers : undefined;
        if (idx == null) return [];
        if (!Array.isArray(idx)) idx = [idx];
        return idx.filter(i => typeof i === 'number');
    }
    function getQuestionType(a) {
        if (!a) return 'mcq';
        const t = (a.type || a.questionType || '').toString().toLowerCase();
        if (t) return t;
        if (Array.isArray(a.options) && a.options.length > 0) {
            return getAnswerIndices(a).length > 1 ? 'multi' : 'mcq';
        }
        if (a.correctAnswer !== undefined || a.correct !== undefined) return 'text';
        return 'mcq';
    }
    function levenshtein(a, b) {
        if (a === b) return 0;
        if (!a.length) return b.length;
        if (!b.length) return a.length;
        const m = []; for (let i = 0; i <= b.length; i++) m[i] = [i];
        for (let j = 0; j <= a.length; j++) m[0][j] = j;
        for (let i = 1; i <= b.length; i++)
            for (let j = 1; j <= a.length; j++)
                m[i][j] = b[i-1] === a[j-1] ? m[i-1][j-1] : Math.min(m[i-1][j-1]+1, m[i][j-1]+1, m[i-1][j]+1);
        return m[b.length][a.length];
    }
    function similarity(a, b) {
        const lo = a.length > b.length ? a : b, sh = a.length > b.length ? b : a;
        if (!lo.length) return 1;
        return (lo.length - levenshtein(lo, sh)) / lo.length;
    }
    function textsMatch(t1, t2) {
        const n1 = normalizeText(t1), n2 = normalizeText(t2);
        if (!n1 || !n2) return false;
        if (n1 === n2) return true;
        if (n1.includes(n2) || n2.includes(n1)) return true;
        const c1 = n1.replace(/[^a-z0-9]/g, ''), c2 = n2.replace(/[^a-z0-9]/g, '');
        if (c1 && c1 === c2) return true;
        if (c1.length > 4 && c2.length > 4 && similarity(c1, c2) > 0.9) return true;
        return false;
    }
    function escapeHtml(s) {
        return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    }
    function fmtTime(ms) {
        const s = Math.floor(ms/1000), m = Math.floor(s/60), h = Math.floor(m/60);
        if (h) return `${h}h ${m%60}m`;
        if (m) return `${m}m ${s%60}s`;
        return `${s}s`;
    }

    /* ---------- STYLES ---------- */
    GM_addStyle(`
        :root {
            --qh-bg: #0a0a0a;
            --qh-bg-elev: #141414;
            --qh-bg-elev-2: #1c1c1c;
            --qh-border: #262626;
            --qh-border-strong: #3a3a3a;
            --qh-text: #f5f5f5;
            --qh-text-soft: #a1a1a1;
            --qh-text-dim: #666;
            --qh-accent: #ffffff;
            --qh-success: #22c55e;
            --qh-error: #ef4444;
            --qh-warning: #f59e0b;
            --qh-info: #3b82f6;
        }

        #quiz-input-gui {
            position: fixed;
            top: 20px; right: 20px;
            z-index: 2147483647;
            width: 340px;
            border-radius: 16px;
            background: var(--qh-bg);
            box-shadow: 0 30px 60px rgba(0,0,0,0.5), 0 0 0 1px var(--qh-border);
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Inter', sans-serif;
            color: var(--qh-text);
            overflow: hidden;
            animation: qh-slideIn 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
            transition: opacity 0.3s, transform 0.3s, box-shadow 0.3s;
        }
        #quiz-input-gui.qh-disabled {
            opacity: 0.55;
        }
        #quiz-input-gui.qh-disabled #quiz-gui-content {
            pointer-events: none;
        }
        #quiz-input-gui.qh-stealth {
            opacity: 0.08;
            transform: scale(0.6);
            transform-origin: top right;
        }
        #quiz-input-gui.qh-stealth:hover {
            opacity: 1;
            transform: scale(1);
        }

        @keyframes qh-slideIn {
            from { opacity: 0; transform: translateY(-20px) scale(0.96); }
            to { opacity: 1; transform: translateY(0) scale(1); }
        }

        #quiz-gui-header {
            padding: 14px 16px;
            background: linear-gradient(180deg, #1a1a1a 0%, #0f0f0f 100%);
            border-bottom: 1px solid var(--qh-border);
            display: flex; justify-content: space-between; align-items: center;
            cursor: move; user-select: none;
            position: relative;
        }
        #quiz-gui-header::after {
            content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: 1px;
            background: linear-gradient(90deg, transparent, rgba(255,255,255,0.08), transparent);
        }

        .qh-title {
            display: flex; align-items: center; gap: 10px;
            font-size: 14px; font-weight: 600;
        }
        .qh-logo {
            width: 26px; height: 26px;
            background: var(--qh-text); color: var(--qh-bg);
            border-radius: 8px;
            display: flex; align-items: center; justify-content: center;
            font-size: 14px; font-weight: 800;
            box-shadow: 0 0 20px rgba(255,255,255,0.15);
        }
        .qh-version {
            font-size: 10px; color: var(--qh-text-dim); font-weight: 500;
            font-family: 'SF Mono', Menlo, monospace;
        }
        .qh-header-actions {
            display: flex; gap: 6px; align-items: center;
        }

        /* Switch */
        .qh-switch {
            position: relative; display: inline-block;
            width: 36px; height: 20px;
            cursor: pointer;
        }
        .qh-switch input { opacity: 0; width: 0; height: 0; }
        .qh-switch-slider {
            position: absolute; inset: 0;
            background: #2a2a2a;
            border-radius: 999px;
            transition: 0.3s;
            border: 1px solid var(--qh-border-strong);
        }
        .qh-switch-slider::before {
            content: ''; position: absolute;
            height: 14px; width: 14px;
            left: 2px; top: 2px;
            background: var(--qh-text-soft);
            border-radius: 50%;
            transition: 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);
        }
        .qh-switch input:checked + .qh-switch-slider {
            background: var(--qh-success);
            border-color: var(--qh-success);
        }
        .qh-switch input:checked + .qh-switch-slider::before {
            transform: translateX(16px);
            background: white;
        }

        .qh-icon-btn {
            background: transparent; border: 1px solid var(--qh-border);
            color: var(--qh-text-soft); cursor: pointer;
            width: 28px; height: 28px; border-radius: 8px;
            display: flex; align-items: center; justify-content: center;
            transition: all 0.2s;
            font-size: 14px;
        }
        .qh-icon-btn:hover {
            background: var(--qh-bg-elev-2);
            color: var(--qh-text);
            border-color: var(--qh-border-strong);
        }

        /* Tabs */
        .qh-tabs {
            display: flex;
            background: var(--qh-bg-elev);
            border-bottom: 1px solid var(--qh-border);
            padding: 0 8px;
            gap: 2px;
            overflow-x: auto;
            scrollbar-width: none;
        }
        .qh-tabs::-webkit-scrollbar { display: none; }
        .qh-tab {
            background: none; border: none; color: var(--qh-text-dim);
            padding: 10px 12px; cursor: pointer;
            font-size: 12px; font-weight: 600;
            border-bottom: 2px solid transparent;
            transition: all 0.2s;
            white-space: nowrap;
            display: flex; align-items: center; gap: 5px;
            font-family: inherit;
        }
        .qh-tab:hover { color: var(--qh-text-soft); }
        .qh-tab.active {
            color: var(--qh-text);
            border-bottom-color: var(--qh-text);
        }
        .qh-tab-badge {
            background: var(--qh-bg-elev-2);
            color: var(--qh-text-soft);
            padding: 1px 6px; border-radius: 999px;
            font-size: 10px; font-weight: 700;
        }
        .qh-tab.active .qh-tab-badge {
            background: var(--qh-text);
            color: var(--qh-bg);
        }

        #quiz-gui-content {
            background: var(--qh-bg);
            transition: max-height 0.35s, opacity 0.25s;
            overflow: hidden;
        }
        #quiz-gui-content.qh-collapsed {
            max-height: 0 !important; opacity: 0;
        }

        .qh-pane { display: none; padding: 16px; }
        .qh-pane.active { display: block; animation: qh-fadeIn 0.25s; }
        @keyframes qh-fadeIn {
            from { opacity: 0; transform: translateY(4px); }
            to { opacity: 1; transform: translateY(0); }
        }

        /* Inputs / buttons */
        .qh-input-wrap { position: relative; margin-bottom: 10px; }
        #quiz-code-input {
            width: 100%; padding: 12px 14px;
            border: 1px solid var(--qh-border);
            border-radius: 10px; font-size: 15px;
            text-align: center; letter-spacing: 1px;
            outline: none; box-sizing: border-box;
            background: var(--qh-bg-elev);
            color: var(--qh-text);
            transition: all 0.2s;
            font-family: 'SF Mono', Menlo, monospace; font-weight: 500;
        }
        #quiz-code-input:focus {
            border-color: var(--qh-text-soft);
            box-shadow: 0 0 0 4px rgba(255,255,255,0.06);
            background: var(--qh-bg-elev-2);
        }
        #quiz-code-input::placeholder {
            font-family: -apple-system, sans-serif;
            letter-spacing: 0; color: var(--qh-text-dim);
        }

        .qh-btn {
            width: 100%; padding: 11px;
            background: var(--qh-text); color: var(--qh-bg);
            border: none; border-radius: 10px;
            font-size: 14px; font-weight: 700;
            cursor: pointer; transition: all 0.2s;
            display: flex; align-items: center; justify-content: center; gap: 8px;
            font-family: inherit;
        }
        .qh-btn:hover:not(:disabled) {
            transform: translateY(-1px);
            box-shadow: 0 8px 20px rgba(255,255,255,0.15);
        }
        .qh-btn:active:not(:disabled) { transform: translateY(0); }
        .qh-btn:disabled { background: #333; color: #666; cursor: not-allowed; }
        .qh-btn-secondary {
            background: var(--qh-bg-elev-2); color: var(--qh-text);
            border: 1px solid var(--qh-border);
        }
        .qh-btn-secondary:hover:not(:disabled) {
            background: var(--qh-bg-elev); border-color: var(--qh-border-strong);
            box-shadow: none;
        }
        .qh-btn-row { display: flex; gap: 8px; margin-top: 8px; }
        .qh-btn-row .qh-btn { flex: 1; padding: 9px; font-size: 12px; }

        .qh-spinner {
            width: 14px; height: 14px;
            border: 2px solid rgba(0,0,0,0.2);
            border-top-color: var(--qh-bg);
            border-radius: 50%; animation: qh-spin 0.7s linear infinite;
        }
        @keyframes qh-spin { to { transform: rotate(360deg); } }

        #quiz-status {
            margin-top: 12px; font-size: 12px;
            color: var(--qh-text-soft);
            text-align: center; min-height: 16px; font-weight: 500;
            display: flex; align-items: center; justify-content: center; gap: 6px;
        }
        .qh-status-dot {
            width: 6px; height: 6px; border-radius: 50%;
            background: currentColor; animation: qh-blink 1.5s infinite;
        }
        @keyframes qh-blink { 0%,100% { opacity: 0.4; } 50% { opacity: 1; } }

        /* Answer display */
        #quiz-answer-display {
            padding: 14px;
            background: var(--qh-bg-elev);
            border: 1px solid var(--qh-border);
            border-radius: 12px;
            font-size: 13px;
            display: none;
            max-height: 320px; overflow-y: auto;
            word-wrap: break-word;
            animation: qh-fadeIn 0.3s;
        }
        #quiz-answer-display::-webkit-scrollbar { width: 6px; }
        #quiz-answer-display::-webkit-scrollbar-thumb {
            background: var(--qh-border-strong); border-radius: 3px;
        }
        .qh-q-label, .qh-a-label {
            font-size: 10px; font-weight: 700;
            text-transform: uppercase; letter-spacing: 0.8px;
            margin-bottom: 6px;
            display: flex; align-items: center; gap: 6px;
            color: var(--qh-text-dim);
        }
        .qh-a-label { color: var(--qh-success); margin-top: 12px; }
        .qh-q-text {
            color: var(--qh-text); font-size: 13px;
            padding: 10px 12px;
            background: var(--qh-bg);
            border-radius: 8px;
            border: 1px solid var(--qh-border);
            line-height: 1.5;
        }
        .qh-answer-item {
            color: var(--qh-text);
            padding: 10px 12px;
            background: var(--qh-bg);
            border-left: 3px solid var(--qh-success);
            border-radius: 6px;
            margin: 6px 0;
            font-size: 13px; font-weight: 500;
            display: flex; align-items: flex-start; gap: 8px;
            animation: qh-slideRight 0.3s forwards;
            opacity: 0;
        }
        .qh-answer-item:nth-child(1) { animation-delay: 0.05s; }
        .qh-answer-item:nth-child(2) { animation-delay: 0.10s; }
        .qh-answer-item:nth-child(3) { animation-delay: 0.15s; }
        .qh-answer-item:nth-child(4) { animation-delay: 0.20s; }
        .qh-answer-item:nth-child(5) { animation-delay: 0.25s; }
        @keyframes qh-slideRight {
            from { opacity: 0; transform: translateX(-8px); }
            to { opacity: 1; transform: translateX(0); }
        }
        .qh-answer-check { color: var(--qh-success); font-weight: bold; flex-shrink: 0; }
        .qh-type-badge {
            display: inline-block; font-size: 9px; font-weight: 700;
            padding: 2px 8px; border-radius: 999px;
            background: var(--qh-bg); color: var(--qh-text-soft);
            border: 1px solid var(--qh-border-strong);
            text-transform: uppercase; letter-spacing: 0.5px;
            margin-left: auto;
        }
        .qh-typed-indicator {
            display: inline-block;
            background: var(--qh-warning); color: black;
            padding: 2px 8px; border-radius: 999px;
            font-size: 9px; font-weight: 700;
            margin-left: 6px; text-transform: uppercase; letter-spacing: 0.5px;
        }

        /* Memory hint - hide answer to test yourself */
        .qh-memory-mode .qh-answer-item {
            color: transparent !important;
            background: var(--qh-bg-elev-2) !important;
            border-left-color: var(--qh-warning) !important;
            cursor: pointer;
            transition: all 0.2s;
        }
        .qh-memory-mode .qh-answer-item:hover {
            color: var(--qh-text) !important;
            background: var(--qh-bg) !important;
        }
        .qh-memory-mode .qh-answer-item .qh-answer-check {
            color: var(--qh-warning) !important;
        }
        .qh-memory-mode .qh-answer-item::after {
            content: 'Hover to reveal';
            color: var(--qh-text-dim);
            position: absolute; left: 50%; transform: translateX(-50%);
            font-size: 11px; font-style: italic;
            pointer-events: none;
            transition: opacity 0.2s;
        }
        .qh-memory-mode .qh-answer-item:hover::after { opacity: 0; }
        .qh-memory-mode .qh-answer-item { position: relative; }

        /* Stats */
        .qh-stats-grid {
            display: grid; grid-template-columns: 1fr 1fr; gap: 8px;
            margin-bottom: 12px;
        }
        .qh-stat-card {
            background: var(--qh-bg-elev);
            border: 1px solid var(--qh-border);
            border-radius: 10px;
            padding: 12px;
        }
        .qh-stat-label {
            font-size: 10px; color: var(--qh-text-dim);
            text-transform: uppercase; letter-spacing: 0.6px;
            font-weight: 600;
        }
        .qh-stat-value {
            font-size: 22px; font-weight: 800;
            color: var(--qh-text); margin-top: 4px;
            font-variant-numeric: tabular-nums;
        }
        .qh-stat-sub {
            font-size: 11px; color: var(--qh-text-soft); margin-top: 2px;
        }

        .qh-progress {
            height: 6px; background: var(--qh-bg-elev-2);
            border-radius: 999px; overflow: hidden;
            margin: 6px 0 12px;
        }
        .qh-progress-bar {
            height: 100%;
            background: linear-gradient(90deg, var(--qh-success), #4ade80);
            border-radius: 999px;
            transition: width 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
        }

        /* Flashcards */
        .qh-flashcard {
            perspective: 1000px;
            height: 220px;
            margin-bottom: 12px;
        }
        .qh-flashcard-inner {
            position: relative; width: 100%; height: 100%;
            transition: transform 0.6s cubic-bezier(0.4, 0.0, 0.2, 1);
            transform-style: preserve-3d;
            cursor: pointer;
        }
        .qh-flashcard.flipped .qh-flashcard-inner {
            transform: rotateY(180deg);
        }
        .qh-flashcard-face {
            position: absolute; inset: 0;
            backface-visibility: hidden;
            background: var(--qh-bg-elev);
            border: 1px solid var(--qh-border);
            border-radius: 14px;
            padding: 18px;
            display: flex; flex-direction: column;
            justify-content: center; align-items: center;
            text-align: center;
            box-shadow: 0 10px 30px rgba(0,0,0,0.3);
        }
        .qh-flashcard-face.back {
            transform: rotateY(180deg);
            background: linear-gradient(135deg, #1a1a1a, #0a0a0a);
            border-color: var(--qh-success);
        }
        .qh-flashcard-tag {
            font-size: 9px; font-weight: 700;
            text-transform: uppercase; letter-spacing: 1px;
            color: var(--qh-text-dim); margin-bottom: 12px;
        }
        .qh-flashcard-tag.back { color: var(--qh-success); }
        .qh-flashcard-text {
            font-size: 14px; line-height: 1.5;
            color: var(--qh-text); font-weight: 500;
            max-height: 130px; overflow-y: auto;
            width: 100%;
        }
        .qh-flashcard-hint {
            position: absolute; bottom: 10px; right: 12px;
            font-size: 10px; color: var(--qh-text-dim);
        }
        .qh-flashcard-controls {
            display: flex; gap: 8px; align-items: center;
            margin-bottom: 8px;
        }
        .qh-flashcard-counter {
            flex: 1; text-align: center;
            font-size: 12px; color: var(--qh-text-soft); font-weight: 600;
            font-variant-numeric: tabular-nums;
        }
        .qh-difficulty-row {
            display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px;
            margin-top: 8px;
        }
        .qh-diff-btn {
            padding: 8px 4px; border-radius: 8px;
            border: 1px solid var(--qh-border);
            background: var(--qh-bg-elev);
            color: var(--qh-text-soft);
            cursor: pointer; font-size: 11px; font-weight: 700;
            transition: all 0.2s; font-family: inherit;
        }
        .qh-diff-btn:hover { transform: translateY(-1px); }
        .qh-diff-btn.easy:hover { background: var(--qh-success); color: #000; border-color: var(--qh-success); }
        .qh-diff-btn.medium:hover { background: var(--qh-warning); color: #000; border-color: var(--qh-warning); }
        .qh-diff-btn.hard:hover { background: var(--qh-error); color: white; border-color: var(--qh-error); }

        /* Quiz mode */
        .qh-quiz-question {
            background: var(--qh-bg-elev);
            border: 1px solid var(--qh-border);
            border-radius: 12px;
            padding: 16px;
            margin-bottom: 10px;
            font-size: 14px; line-height: 1.5;
            min-height: 80px;
        }
        .qh-quiz-options { display: flex; flex-direction: column; gap: 6px; }
        .qh-quiz-option {
            background: var(--qh-bg-elev);
            border: 1px solid var(--qh-border);
            border-radius: 10px;
            padding: 10px 12px;
            cursor: pointer; transition: all 0.2s;
            font-size: 13px; color: var(--qh-text);
            text-align: left; font-family: inherit;
        }
        .qh-quiz-option:hover:not(:disabled) {
            border-color: var(--qh-text-soft);
            background: var(--qh-bg-elev-2);
        }
        .qh-quiz-option.correct {
            background: rgba(34,197,94,0.15) !important;
            border-color: var(--qh-success) !important;
            color: var(--qh-success) !important;
        }
        .qh-quiz-option.wrong {
            background: rgba(239,68,68,0.15) !important;
            border-color: var(--qh-error) !important;
            color: var(--qh-error) !important;
        }
        .qh-quiz-option:disabled { cursor: default; }

        /* List */
        .qh-list-item {
            background: var(--qh-bg-elev);
            border: 1px solid var(--qh-border);
            border-radius: 10px;
            padding: 10px 12px;
            margin-bottom: 6px;
            font-size: 12px;
            transition: all 0.2s;
            cursor: pointer;
        }
        .qh-list-item:hover {
            border-color: var(--qh-border-strong);
            background: var(--qh-bg-elev-2);
        }
        .qh-list-q {
            color: var(--qh-text); font-weight: 600;
            margin-bottom: 4px; line-height: 1.4;
        }
        .qh-list-a {
            color: var(--qh-success); font-size: 11px;
            opacity: 0.85; line-height: 1.4;
        }
        .qh-list-meta {
            display: flex; gap: 8px; margin-top: 6px;
            font-size: 10px; color: var(--qh-text-dim);
        }
        .qh-empty {
            text-align: center; padding: 40px 20px;
            color: var(--qh-text-dim); font-size: 13px;
        }

        /* Toggle row in settings */
        .qh-setting-row {
            display: flex; align-items: center; justify-content: space-between;
            padding: 12px 0; border-bottom: 1px solid var(--qh-border);
        }
        .qh-setting-row:last-child { border-bottom: none; }
        .qh-setting-label {
            font-size: 13px; color: var(--qh-text); font-weight: 500;
        }
        .qh-setting-desc {
            font-size: 11px; color: var(--qh-text-dim); margin-top: 2px;
        }

        /* Notification */
        .quiz-notification {
            position: fixed; top: 24px; left: 50%;
            transform: translateX(-50%) translateY(-20px);
            z-index: 2147483647;
            color: var(--qh-bg);
            padding: 12px 22px; border-radius: 12px;
            box-shadow: 0 20px 40px rgba(0,0,0,0.4);
            font-family: -apple-system, sans-serif;
            font-size: 14px; font-weight: 600;
            max-width: 80%; text-align: center;
            opacity: 0;
            transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
            display: flex; align-items: center; gap: 10px;
        }
        .quiz-notification.qh-show {
            opacity: 1; transform: translateX(-50%) translateY(0);
        }

        /* Highlighted answers on the page */
        [data-quiz-marked="true"] {
            outline: 2px solid var(--qh-success) !important;
            outline-offset: 3px !important;
            box-shadow: 0 0 0 5px rgba(34,197,94,0.18), 0 6px 20px rgba(34,197,94,0.3) !important;
            background: rgba(34,197,94,0.08) !important;
            border-radius: 8px !important;
            transition: all 0.3s !important;
            animation: qh-glow 2.4s ease-in-out infinite !important;
        }
        @keyframes qh-glow {
            0%,100% { box-shadow: 0 0 0 5px rgba(34,197,94,0.18), 0 6px 20px rgba(34,197,94,0.3) !important; }
            50%     { box-shadow: 0 0 0 8px rgba(34,197,94,0.10), 0 10px 28px rgba(34,197,94,0.45) !important; }
        }
        .quiz-correct-marker {
            position: absolute; top: 6px; right: 6px;
            background: black; color: var(--qh-success);
            border: 1px solid var(--qh-success);
            padding: 4px 10px; border-radius: 999px;
            font-size: 11px; font-weight: 800; letter-spacing: 0.5px;
            z-index: 10000; pointer-events: none;
            box-shadow: 0 4px 12px rgba(0,0,0,0.4);
            animation: qh-bounce 0.5s cubic-bezier(0.34, 1.56, 0.64, 1);
            display: flex; align-items: center; gap: 4px;
        }
        @keyframes qh-bounce {
            0% { transform: scale(0) rotate(-15deg); }
            100% { transform: scale(1) rotate(0); }
        }

        /* Floating answer card for typed questions */
        #qh-floating-answer {
            position: fixed; bottom: 24px; left: 50%;
            transform: translateX(-50%) translateY(40px);
            z-index: 2147483646;
            background: black; color: white;
            border: 1px solid var(--qh-success);
            padding: 14px 20px; border-radius: 14px;
            box-shadow: 0 20px 50px rgba(0,0,0,0.5), 0 0 30px rgba(34,197,94,0.25);
            font-family: -apple-system, sans-serif;
            font-size: 14px; font-weight: 600;
            max-width: min(560px, 90vw);
            opacity: 0;
            transition: all 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
            display: flex; align-items: center; gap: 12px;
            cursor: pointer;
        }
        #qh-floating-answer.qh-show {
            opacity: 1; transform: translateX(-50%) translateY(0);
        }
        #qh-floating-answer .qh-fa-label {
            font-size: 9px; text-transform: uppercase;
            letter-spacing: 1.2px; color: var(--qh-success);
            font-weight: 800;
        }
        #qh-floating-answer .qh-fa-text {
            font-size: 15px; font-weight: 700;
            margin-top: 2px; word-break: break-word;
            color: white;
        }
        #qh-floating-answer .qh-fa-icon {
            font-size: 18px;
            background: var(--qh-success); color: black;
            width: 36px; height: 36px;
            border-radius: 10px;
            display: flex; align-items: center; justify-content: center;
            flex-shrink: 0; font-weight: 800;
        }

        @keyframes qh-shake {
            0%,100% { transform: translateX(0); }
            25% { transform: translateX(-4px); }
            75% { transform: translateX(4px); }
        }

        /* Scrollbars */
        .qh-pane::-webkit-scrollbar,
        .qh-list-scroll::-webkit-scrollbar { width: 6px; }
        .qh-pane::-webkit-scrollbar-thumb,
        .qh-list-scroll::-webkit-scrollbar-thumb {
            background: var(--qh-border-strong); border-radius: 3px;
        }
        .qh-list-scroll {
            max-height: 320px; overflow-y: auto;
            padding-right: 4px;
        }
    `);

    /* ---------- GUI ---------- */
    function createGUI() {
        const gui = document.createElement('div');
        gui.id = 'quiz-input-gui';
        gui.innerHTML = `
            <div id="quiz-gui-header">
                <div class="qh-title">
                    <span class="qh-logo">Q</span>
                    <span>Quiz Helper</span>
                    <span class="qh-version">v${VERSION}</span>
                </div>
                <div class="qh-header-actions">
                    <label class="qh-switch" title="Enable / Disable">
                        <input type="checkbox" id="qh-master-toggle" ${helperEnabled ? 'checked' : ''}>
                        <span class="qh-switch-slider"></span>
                    </label>
                    <button class="qh-icon-btn" id="quiz-toggle-btn" title="Collapse">−</button>
                </div>
            </div>

            <div class="qh-tabs">
                <button class="qh-tab active" data-tab="answer">⚡ Answer</button>
                <button class="qh-tab" data-tab="study">📚 Study</button>
                <button class="qh-tab" data-tab="flash">🎴 Cards</button>
                <button class="qh-tab" data-tab="practice">🎯 Practice</button>
                <button class="qh-tab" data-tab="stats">📊 Stats</button>
                <button class="qh-tab" data-tab="settings">⚙️</button>
            </div>

            <div id="quiz-gui-content">
                <!-- ANSWER PANE -->
                <div class="qh-pane active" data-pane="answer">
                    <div class="qh-input-wrap">
                        <input type="text" id="quiz-code-input" placeholder="Enter quiz code" autocomplete="off" spellcheck="false" maxlength="20">
                    </div>
                    <button class="qh-btn" id="quiz-submit-btn">
                        <span>Load Answers</span>
                    </button>
                    <div id="quiz-status"></div>
                    <div id="quiz-answer-display" style="margin-top:12px"></div>
                </div>

                <!-- STUDY (browse all loaded Q&As) -->
                <div class="qh-pane" data-pane="study">
                    <div class="qh-btn-row" style="margin-top:0;margin-bottom:10px">
                        <button class="qh-btn qh-btn-secondary" id="qh-toggle-memory">👁 Hide Answers</button>
                        <button class="qh-btn qh-btn-secondary" id="qh-shuffle-list">🔀 Shuffle</button>
                    </div>
                    <input type="text" id="qh-search-input" placeholder="Search questions..."
                        style="width:100%;padding:9px 12px;border:1px solid var(--qh-border);border-radius:8px;background:var(--qh-bg-elev);color:var(--qh-text);font-size:12px;outline:none;box-sizing:border-box;margin-bottom:10px;font-family:inherit">
                    <div id="qh-study-list" class="qh-list-scroll"></div>
                </div>

                <!-- FLASHCARDS -->
                <div class="qh-pane" data-pane="flash">
                    <div class="qh-flashcard-controls">
                        <button class="qh-icon-btn" id="qh-flash-prev">‹</button>
                        <div class="qh-flashcard-counter" id="qh-flash-counter">0 / 0</div>
                        <button class="qh-icon-btn" id="qh-flash-next">›</button>
                    </div>
                    <div class="qh-progress"><div class="qh-progress-bar" id="qh-flash-progress" style="width:0%"></div></div>
                    <div class="qh-flashcard" id="qh-flashcard">
                        <div class="qh-flashcard-inner">
                            <div class="qh-flashcard-face front">
                                <div class="qh-flashcard-tag">Question</div>
                                <div class="qh-flashcard-text" id="qh-flash-q">Load a quiz to start</div>
                                <div class="qh-flashcard-hint">Click to flip</div>
                            </div>
                            <div class="qh-flashcard-face back">
                                <div class="qh-flashcard-tag back">Answer</div>
                                <div class="qh-flashcard-text" id="qh-flash-a">—</div>
                                <div class="qh-flashcard-hint">Click to flip back</div>
                            </div>
                        </div>
                    </div>
                    <div class="qh-difficulty-row">
                        <button class="qh-diff-btn hard" data-diff="3">😓 Hard</button>
                        <button class="qh-diff-btn medium" data-diff="2">😐 Medium</button>
                        <button class="qh-diff-btn easy" data-diff="1">😎 Easy</button>
                    </div>
                    <div class="qh-btn-row">
                        <button class="qh-btn qh-btn-secondary" id="qh-flash-star">⭐ Star</button>
                        <button class="qh-btn qh-btn-secondary" id="qh-flash-only-hard">🔥 Hard only</button>
                    </div>
                </div>

                <!-- PRACTICE QUIZ MODE -->
                <div class="qh-pane" data-pane="practice">
                    <div class="qh-stats-grid" style="grid-template-columns:1fr 1fr 1fr;margin-bottom:10px">
                        <div class="qh-stat-card" style="padding:8px">
                            <div class="qh-stat-label">Q</div>
                            <div class="qh-stat-value" id="qh-practice-num" style="font-size:16px">0/0</div>
                        </div>
                        <div class="qh-stat-card" style="padding:8px">
                            <div class="qh-stat-label">Score</div>
                            <div class="qh-stat-value" id="qh-practice-score" style="font-size:16px">0</div>
                        </div>
                        <div class="qh-stat-card" style="padding:8px">
                            <div class="qh-stat-label">Acc</div>
                            <div class="qh-stat-value" id="qh-practice-acc" style="font-size:16px">—</div>
                        </div>
                    </div>
                    <div class="qh-quiz-question" id="qh-practice-q">Load a quiz first, then click Start to test yourself.</div>
                    <div class="qh-quiz-options" id="qh-practice-opts"></div>
                    <div class="qh-btn-row">
                        <button class="qh-btn" id="qh-practice-start">▶ Start</button>
                        <button class="qh-btn qh-btn-secondary" id="qh-practice-skip">⏭ Skip</button>
                    </div>
                </div>

                <!-- STATS -->
                <div class="qh-pane" data-pane="stats">
                    <div class="qh-stats-grid">
                        <div class="qh-stat-card">
                            <div class="qh-stat-label">Questions Seen</div>
                            <div class="qh-stat-value" id="qh-stat-seen">0</div>
                            <div class="qh-stat-sub" id="qh-stat-session">this session: 0</div>
                        </div>
                        <div class="qh-stat-card">
                            <div class="qh-stat-label">Mastery</div>
                            <div class="qh-stat-value" id="qh-stat-mastery">0%</div>
                            <div class="qh-stat-sub" id="qh-stat-mastery-sub">0 mastered</div>
                        </div>
                        <div class="qh-stat-card">
                            <div class="qh-stat-label">Starred</div>
                            <div class="qh-stat-value" id="qh-stat-starred">0</div>
                            <div class="qh-stat-sub">favorites</div>
                        </div>
                        <div class="qh-stat-card">
                            <div class="qh-stat-label">Session</div>
                            <div class="qh-stat-value" id="qh-stat-time" style="font-size:18px">0s</div>
                            <div class="qh-stat-sub">elapsed</div>
                        </div>
                    </div>
                    <div class="qh-progress"><div class="qh-progress-bar" id="qh-stat-progress" style="width:0%"></div></div>
                    <div class="qh-btn-row">
                        <button class="qh-btn qh-btn-secondary" id="qh-export">📤 Export</button>
                        <button class="qh-btn qh-btn-secondary" id="qh-clear">🗑 Reset</button>
                    </div>
                </div>

                <!-- SETTINGS -->
                <div class="qh-pane" data-pane="settings">
                    <div class="qh-setting-row">
                        <div>
                            <div class="qh-setting-label">Stealth Mode</div>
                            <div class="qh-setting-desc">Make panel barely visible until hovered</div>
                        </div>
                        <label class="qh-switch">
                            <input type="checkbox" id="qh-stealth-toggle" ${stealthMode ? 'checked' : ''}>
                            <span class="qh-switch-slider"></span>
                        </label>
                    </div>
                    <div class="qh-setting-row">
                        <div>
                            <div class="qh-setting-label">Auto-highlight</div>
                            <div class="qh-setting-desc">Highlight correct answers on the page</div>
                        </div>
                        <label class="qh-switch">
                            <input type="checkbox" id="qh-highlight-toggle" ${GM_getValue('auto-highlight', true) ? 'checked' : ''}>
                            <span class="qh-switch-slider"></span>
                        </label>
                    </div>
                    <div class="qh-setting-row">
                        <div>
                            <div class="qh-setting-label">Floating answer card</div>
                            <div class="qh-setting-desc">Show big card for typed questions</div>
                        </div>
                        <label class="qh-switch">
                            <input type="checkbox" id="qh-floating-toggle" ${GM_getValue('floating-card', true) ? 'checked' : ''}>
                            <span class="qh-switch-slider"></span>
                        </label>
                    </div>
                    <div class="qh-setting-row">
                        <div>
                            <div class="qh-setting-label">Sound effects</div>
                            <div class="qh-setting-desc">Subtle beeps on actions</div>
                        </div>
                        <label class="qh-switch">
                            <input type="checkbox" id="qh-sound-toggle" ${GM_getValue('sounds', false) ? 'checked' : ''}>
                            <span class="qh-switch-slider"></span>
                        </label>
                    </div>
                    <div style="margin-top:12px;padding:10px;background:var(--qh-bg-elev);border-radius:8px;font-size:11px;color:var(--qh-text-dim);line-height:1.5">
                        Toggle the helper with <kbd style="background:var(--qh-bg-elev-2);padding:1px 6px;border-radius:4px;border:1px solid var(--qh-border-strong);color:var(--qh-text)">Alt+Q</kbd>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(gui);
        makeDraggable(gui);
        makeCollapsible(gui);
        wireGUI();
        if (stealthMode) gui.classList.add('qh-stealth');
        if (!helperEnabled) gui.classList.add('qh-disabled');
        return gui;
    }

    function makeDraggable(element) {
        const header = element.querySelector('#quiz-gui-header');
        let dragging = false, ix, iy, xo = 0, yo = 0;
        const stored = localStorage.getItem('quiz-helper-position');
        if (stored) {
            try {
                const p = JSON.parse(stored);
                if (p.x >= 0 && p.y >= 0 && p.x < innerWidth - 50 && p.y < innerHeight - 50) {
                    element.style.left = p.x + 'px';
                    element.style.top = p.y + 'px';
                    element.style.right = 'auto';
                    xo = p.x; yo = p.y;
                }
            } catch (e) {}
        }
        function start(e) {
            if (e.target.closest('.qh-icon-btn, .qh-switch, button, input')) return;
            const p = e.type === 'touchstart' ? e.touches[0] : e;
            ix = p.clientX - xo; iy = p.clientY - yo;
            dragging = true;
            element.style.transition = 'none';
        }
        function move(e) {
            if (!dragging) return;
            e.preventDefault();
            const p = e.type === 'touchmove' ? e.touches[0] : e;
            xo = p.clientX - ix; yo = p.clientY - iy;
            const r = element.getBoundingClientRect();
            xo = Math.max(0, Math.min(xo, innerWidth - r.width));
            yo = Math.max(0, Math.min(yo, innerHeight - r.height));
            element.style.left = xo + 'px';
            element.style.top = yo + 'px';
            element.style.right = 'auto';
        }
        function end() {
            if (dragging) {
                dragging = false;
                element.style.transition = '';
                localStorage.setItem('quiz-helper-position', JSON.stringify({ x: xo, y: yo }));
            }
        }
        header.addEventListener('mousedown', start);
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', end);
        header.addEventListener('touchstart', start, { passive: false });
        document.addEventListener('touchmove', move, { passive: false });
        document.addEventListener('touchend', end);
    }

    function makeCollapsible(element) {
        const btn = element.querySelector('#quiz-toggle-btn');
        const content = element.querySelector('#quiz-gui-content');
        const tabs = element.querySelector('.qh-tabs');
        let collapsed = localStorage.getItem('quiz-helper-collapsed') === 'true';
        const apply = () => {
            if (collapsed) {
                content.classList.add('qh-collapsed');
                tabs.style.display = 'none';
                btn.textContent = '+';
            } else {
                content.classList.remove('qh-collapsed');
                tabs.style.display = '';
                btn.textContent = '−';
            }
        };
        if (collapsed) apply();
        btn.onclick = (e) => {
            e.stopPropagation();
            collapsed = !collapsed;
            apply();
            localStorage.setItem('quiz-helper-collapsed', collapsed);
        };
    }

    function setCollapsed(c) {
        const content = document.getElementById('quiz-gui-content');
        const tabs = document.querySelector('.qh-tabs');
        const btn = document.getElementById('quiz-toggle-btn');
        if (!content) return;
        if (c) {
            content.classList.add('qh-collapsed');
            tabs.style.display = 'none';
            btn.textContent = '+';
        } else {
            content.classList.remove('qh-collapsed');
            tabs.style.display = '';
            btn.textContent = '−';
        }
        localStorage.setItem('quiz-helper-collapsed', c);
    }

    /* ---------- TAB SWITCHING ---------- */
    function switchTab(name) {
        activeTab = name;
        document.querySelectorAll('.qh-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
        document.querySelectorAll('.qh-pane').forEach(p => p.classList.toggle('active', p.dataset.pane === name));
        if (name === 'study') renderStudyList();
        if (name === 'flash') renderFlashcard();
        if (name === 'stats') renderStats();
        if (name === 'practice') renderPractice();
    }

    /* ---------- NOTIFICATIONS ---------- */
    function showNotification(msg, type = 'info') {
        document.querySelectorAll('.quiz-notification').forEach(n => {
            n.classList.remove('qh-show');
            setTimeout(() => n.remove(), 300);
        });
        const colors = {
            info: '#fff', error: '#ef4444',
            warning: '#f59e0b', success: '#22c55e'
        };
        const icons = { info: '◉', error: '✕', warning: '!', success: '✓' };
        const notif = document.createElement('div');
        notif.className = 'quiz-notification';
        notif.style.background = colors[type] || colors.info;
        notif.innerHTML = `<span style="font-size:16px;font-weight:800">${icons[type] || icons.info}</span><span>${escapeHtml(msg)}</span>`;
        document.body.appendChild(notif);
        requestAnimationFrame(() => notif.classList.add('qh-show'));
        setTimeout(() => {
            notif.classList.remove('qh-show');
            setTimeout(() => notif.remove(), 300);
        }, 2600);
    }

    function updateStatus(msg, color) {
        const status = document.getElementById('quiz-status');
        if (!status) return;
        const map = {
            success: 'var(--qh-success)', error: 'var(--qh-error)',
            warning: 'var(--qh-warning)', info: 'var(--qh-text-soft)'
        };
        const c = map[color] || color || 'var(--qh-text-soft)';
        status.innerHTML = msg
            ? `<span class="qh-status-dot" style="background:${c}"></span><span>${escapeHtml(msg)}</span>`
            : '';
        status.style.color = c;
    }

    /* ---------- ANSWER DISPLAY (ALWAYS shows, including typed) ---------- */
    function showAnswerInGUI(questionText, answers, type, isTyped) {
        const display = document.getElementById('quiz-answer-display');
        if (!display) return;
        const typeLabel = ({
            mcq: 'Multiple Choice', multi: 'Multi-Select',
            text: 'Text Answer', fill: 'Fill in Blank',
            poll: 'Poll', open: 'Open Ended', match: 'Match',
            openEnded: 'Open Ended'
        }[type]) || type || 'Question';

        display.style.display = 'block';
        display.innerHTML = `
            <div class="qh-q-label">
                <span>📝 Question</span>
                <span class="qh-type-badge">${escapeHtml(typeLabel)}</span>
                ${isTyped ? '<span class="qh-typed-indicator">Type it</span>' : ''}
            </div>
            <div class="qh-q-text">${escapeHtml(questionText.substring(0, 240))}${questionText.length > 240 ? '…' : ''}</div>
            <div class="qh-a-label">✓ Correct Answer${answers.length > 1 ? 's' : ''}</div>
            ${answers.map(a => `
                <div class="qh-answer-item">
                    <span class="qh-answer-check">✓</span>
                    <span>${escapeHtml(a)}</span>
                </div>`).join('')}
        `;
    }

    /* ---------- FLOATING ANSWER ---------- */
    function showFloatingAnswer(answers) {
        if (!GM_getValue('floating-card', true)) return;
        let card = document.getElementById('qh-floating-answer');
        if (!card) {
            card = document.createElement('div');
            card.id = 'qh-floating-answer';
            card.title = 'Click to dismiss';
            card.addEventListener('click', () => card.classList.remove('qh-show'));
            document.body.appendChild(card);
        }
        card.innerHTML = `
            <div class="qh-fa-icon">✎</div>
            <div>
                <div class="qh-fa-label">Type this answer</div>
                <div class="qh-fa-text">${escapeHtml(answers.join('  •  '))}</div>
            </div>
        `;
        requestAnimationFrame(() => card.classList.add('qh-show'));
    }
    function hideFloatingAnswer() {
        const c = document.getElementById('qh-floating-answer');
        if (c) c.classList.remove('qh-show');
    }

    /* ---------- API ---------- */
    function loadAnswers(code) {
        log('Loading code:', code);
        const btn = document.getElementById('quiz-submit-btn');
        btn.disabled = true;
        btn.innerHTML = `<span class="qh-spinner"></span><span>Loading…</span>`;
        updateStatus('Fetching answers...', 'info');

        GM_xmlhttpRequest({
            method: 'GET',
            url: `https://api.cheatnetwork.eu/quizizz/${encodeURIComponent(code)}/answers`,
            timeout: 15000,
            onload: function(res) {
                btn.disabled = false;
                btn.innerHTML = '<span>Reload Answers</span>';
                if (res.status === 200) {
                    try {
                        apiResponse = JSON.parse(res.responseText);
                        if (apiResponse?.answers && Array.isArray(apiResponse.answers)) {
                            studyData.currentSession.quizCode = code;
                            studyData.currentSession.startTime = Date.now();
                            studyData.stats.sessions++;
                            saveStudyData();
                            log('Loaded', apiResponse.answers.length, 'questions');
                            showNotification(`Loaded ${apiResponse.answers.length} questions`, 'success');
                            updateStatus(`Ready • ${apiResponse.answers.length} questions`, 'success');
                            initializeAnswerSystem();
                            updateTabBadges();
                        } else {
                            showNotification('Invalid response format', 'error');
                            updateStatus('Invalid format', 'error');
                        }
                    } catch (e) {
                        showNotification('Failed to parse response', 'error');
                        updateStatus('Parse error', 'error');
                    }
                } else if (res.status === 404) {
                    showNotification('Quiz not found', 'error');
                    updateStatus('Not found', 'error');
                } else {
                    showNotification(`Server error: ${res.status}`, 'error');
                    updateStatus(`Error ${res.status}`, 'error');
                }
            },
            onerror: () => {
                btn.disabled = false;
                btn.innerHTML = '<span>Load Answers</span>';
                showNotification('Network error', 'error');
                updateStatus('Network error', 'error');
            },
            ontimeout: () => {
                btn.disabled = false;
                btn.innerHTML = '<span>Load Answers</span>';
                showNotification('Request timed out', 'error');
                updateStatus('Timeout', 'error');
            }
        });
    }

    /* ---------- OBSERVER & MATCHING ---------- */
    function initializeAnswerSystem() {
        if (mutationObserver) mutationObserver.disconnect();
        mutationObserver = new MutationObserver(() => {
            if (!helperEnabled) return;
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(processQuestion, 180);
        });
        mutationObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
        [0, 300, 700, 1300, 2200].forEach(d => setTimeout(processQuestion, d));
    }

    function findQuestionElement() {
        const sels = [
            '.question-text-color',
            '[class*="QuestionText"]','[class*="questionText"]','[class*="question-text"]',
            '[data-testid*="question"]', '.question-content',
            '[class*="prompt"]','[class*="Prompt"]','[role="heading"]'
        ];
        for (const sel of sels) {
            try {
                for (const el of document.querySelectorAll(sel)) {
                    const text = extractText(el);
                    if (!text || text.length < 2) continue;
                    const r = el.getBoundingClientRect();
                    if (r.width > 0 && r.height > 0) return { el, text };
                }
            } catch (e) {}
        }
        return null;
    }

    function processQuestion() {
        if (!helperEnabled || !apiResponse?.answers || isProcessing) return;
        isProcessing = true;
        try {
            const found = findQuestionElement();
            if (!found) { isProcessing = false; return; }
            const { text: questionText } = found;
            const qhash = hashText(questionText);
            currentQuestionText = questionText;

            if (qhash === lastProcessedQuestion) {
                if (currentMatch && !document.querySelector('[data-quiz-marked="true"]')) {
                    markCorrectAnswers(currentMatch, questionText, true);
                }
                isProcessing = false; return;
            }
            lastProcessedQuestion = qhash;
            hideFloatingAnswer();

            const match = findMatch(questionText);
            if (match) {
                currentMatch = match;
                markCorrectAnswers(match, questionText);
                clearTimeout(retryTimer);
                let attempts = 0;
                const retry = () => {
                    attempts++;
                    if (attempts > 5 || hashText(questionText) !== lastProcessedQuestion) return;
                    if (!document.querySelector('[data-quiz-marked="true"]') && currentMatch) {
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
        } catch (e) { log('proc err', e); }
        finally { isProcessing = false; }
    }

    function findMatch(questionText) {
        const nq = normalizeText(questionText);
        if (!nq) return null;
        for (const a of apiResponse.answers) {
            if (a.question && nq === normalizeText(a.question)) return a;
        }
        for (const a of apiResponse.answers) {
            if (!a.question) continue;
            const aq = normalizeText(a.question);
            if (aq.length > 5 && (nq.includes(aq) || aq.includes(nq))) return a;
        }
        const cq = nq.replace(/[^a-z0-9]/g, '');
        for (const a of apiResponse.answers) {
            if (!a.question) continue;
            const caq = normalizeText(a.question).replace(/[^a-z0-9]/g, '');
            if (cq.length > 3 && cq === caq) return a;
        }
        const words = nq.split(' ').filter(w => w.length > 2);
        let best = null, bestScore = 0;
        for (const a of apiResponse.answers) {
            if (!a.question) continue;
            const aw = normalizeText(a.question).split(' ').filter(w => w.length > 2);
            if (!words.length || !aw.length) continue;
            const matching = words.filter(w => aw.includes(w));
            const s = matching.length / Math.max(words.length, aw.length);
            if (s > bestScore) { bestScore = s; best = a; }
        }
        if (bestScore >= 0.7) return best;
        let fb = null, fs = 0;
        for (const a of apiResponse.answers) {
            if (!a.question) continue;
            const s = similarity(nq, normalizeText(a.question));
            if (s > fs) { fs = s; fb = a; }
        }
        return fs >= 0.85 ? fb : null;
    }

    function clearPreviousMarkers() {
        document.querySelectorAll('[data-quiz-marked="true"]').forEach(el => {
            el.removeAttribute('data-quiz-marked');
            el.style.outline = ''; el.style.outlineOffset = '';
            el.style.boxShadow = ''; el.style.background = ''; el.style.borderRadius = '';
        });
        document.querySelectorAll('.quiz-correct-marker').forEach(el => el.remove());
    }

    /* ---------- BUILD ANSWERS (FIXED for typed questions) ---------- */
    function extractAnswers(answer) {
        const correctTexts = [], displayTexts = [];
        const indices = getAnswerIndices(answer);

        if (indices.length > 0 && Array.isArray(answer.options)) {
            indices.forEach(i => {
                const opt = answer.options[i];
                if (opt !== undefined) {
                    const t = getOptionText(opt);
                    if (t) { correctTexts.push(normalizeText(t)); displayTexts.push(t); }
                }
            });
        }

        // Direct fields - critical for typed/fill-in/open-ended
        const directKeys = ['correctAnswer', 'correct', 'answerText', 'correctAnswers',
                            'typedAnswer', 'expectedAnswer', 'answer_text'];
        for (const k of directKeys) {
            if (answer[k] != null) {
                const arr = Array.isArray(answer[k]) ? answer[k] : [answer[k]];
                arr.forEach(item => {
                    if (typeof item === 'number' && Array.isArray(answer.options) && answer.options[item]) {
                        const t = getOptionText(answer.options[item]);
                        if (t && !displayTexts.includes(t)) {
                            correctTexts.push(normalizeText(t)); displayTexts.push(t);
                        }
                        return;
                    }
                    const t = typeof item === 'object' ? getOptionText(item) : stripHtml(String(item));
                    if (t && !displayTexts.includes(t)) {
                        correctTexts.push(normalizeText(t)); displayTexts.push(t);
                    }
                });
            }
        }

        // Options with `correct: true` flag
        if (displayTexts.length === 0 && Array.isArray(answer.options)) {
            answer.options.forEach(o => {
                if (o && (o.correct === true || o.isCorrect === true)) {
                    const t = getOptionText(o);
                    if (t) { correctTexts.push(normalizeText(t)); displayTexts.push(t); }
                }
            });
        }

        // Last resort - structured.answer
        if (displayTexts.length === 0 && answer.structured?.answer) {
            const v = answer.structured.answer;
            const arr = Array.isArray(v) ? v : [v];
            arr.forEach(item => {
                const t = typeof item === 'object' ? getOptionText(item) : stripHtml(String(item));
                if (t) { correctTexts.push(normalizeText(t)); displayTexts.push(t); }
            });
        }

        return { correctTexts, displayTexts };
    }

    function markCorrectAnswers(answer, questionText, silent = false) {
        clearPreviousMarkers();
        const type = getQuestionType(answer);
        const { correctTexts, displayTexts } = extractAnswers(answer);

        if (displayTexts.length === 0) {
            log('No answer extractable', answer);
            updateStatus('Could not extract answer', 'error');
            // Still show the question in the panel so user knows what's happening
            showAnswerInGUI(questionText, ['(answer not available in API response)'], type, false);
            return;
        }

        const isTyped = ['text','fill','open','openended','open_ended','fill-in-the-blank','fillintheblank','typed']
            .some(t => type.includes(t));

        // ALWAYS populate the panel - this fixes the "written question doesn't show" bug
        showAnswerInGUI(questionText, displayTexts, type, isTyped);
        updateStatus(`Found ${displayTexts.length} answer${displayTexts.length > 1 ? 's' : ''}`, 'success');

        // Record for study tools
        recordQuestion(hashText(questionText), questionText, displayTexts);
        updateTabBadges();

        // Highlight on page if enabled
        const autoHighlight = GM_getValue('auto-highlight', true);
        const marked = autoHighlight ? highlightByText(correctTexts) : 0;

        if (isTyped || marked === 0) {
            showFloatingAnswer(displayTexts);
        }
        if (!silent && marked > 0) {
            showNotification(`Marked ${marked} answer${marked > 1 ? 's' : ''}`, 'success');
            playBeep('success');
        } else if (!silent && isTyped) {
            playBeep('info');
        }
    }

    function highlightByText(correctTexts) {
        const sels = [
            '.option','[class*="option-container"]','[class*="OptionContainer"]',
            '[class*="option"]','[class*="Option"]','[data-testid*="option"]',
            '[data-testid*="Option"]','.answer-choice','[class*="answer-choice"]',
            '[class*="answer"]','[class*="Answer"]','[class*="choice"]',
            '[role="button"]','.resizeable'
        ];
        let options = [];
        for (const sel of sels) {
            try {
                const els = Array.from(document.querySelectorAll(sel)).filter(el => {
                    const r = el.getBoundingClientRect();
                    return r.width > 30 && r.height > 20;
                });
                if (els.length >= 2 && els.length <= 12) { options = els; break; }
            } catch (e) {}
        }
        if (!options.length) return 0;
        let marked = 0;
        options.forEach(opt => {
            const t = normalizeText(extractText(opt));
            if (!t) return;
            if (correctTexts.some(ct => textsMatch(t, ct))) {
                opt.dataset.quizMarked = 'true';
                if (!opt.querySelector('.quiz-correct-marker')) {
                    const m = document.createElement('div');
                    m.className = 'quiz-correct-marker';
                    m.innerHTML = '✓ CORRECT';
                    const cs = getComputedStyle(opt);
                    if (!['absolute','relative','fixed','sticky'].includes(cs.position)) {
                        opt.style.position = 'relative';
                    }
                    opt.appendChild(m);
                }
                marked++;
            }
        });
        return marked;
    }

    /* ---------- STUDY LIST ---------- */
    function renderStudyList(filter = '') {
        const container = document.getElementById('qh-study-list');
        if (!container) return;
        const memMode = container.classList.contains('qh-memory-mode');
        let items = Object.entries(studyData.seenQuestions)
            .map(([h, q]) => ({ ...q, hash: h }))
            .filter(q => !filter || q.question.toLowerCase().includes(filter.toLowerCase())
                       || q.answers.some(a => a.toLowerCase().includes(filter.toLowerCase())));
        if (!items.length) {
            container.innerHTML = `<div class="qh-empty">📚<br>No questions yet.<br><span style="font-size:11px">Load a quiz to start collecting.</span></div>`;
            return;
        }
        container.innerHTML = items.map(q => `
            <div class="qh-list-item" data-hash="${q.hash}">
                <div class="qh-list-q">${q.starred ? '⭐ ' : ''}${escapeHtml(q.question.substring(0, 120))}${q.question.length > 120 ? '…' : ''}</div>
                <div class="qh-list-a">→ ${escapeHtml(q.answers.join(' • ').substring(0, 120))}${q.answers.join(' • ').length > 120 ? '…' : ''}</div>
                <div class="qh-list-meta">
                    <span>👁 ${q.seenCount}×</span>
                    ${q.difficulty ? `<span>${['','😎 easy','😐 med','😓 hard'][q.difficulty]}</span>` : ''}
                </div>
            </div>
        `).join('');
        container.querySelectorAll('.qh-list-item').forEach(el => {
            el.onclick = () => {
                const q = studyData.seenQuestions[el.dataset.hash];
                q.starred = !q.starred;
                saveStudyData();
                renderStudyList(filter);
            };
        });
    }

    /* ---------- FLASHCARDS ---------- */
    let flashcardFilter = 'all'; // 'all' | 'hard' | 'starred'

    function getFlashcardDeck() {
        let items = Object.entries(studyData.seenQuestions).map(([h, q]) => ({ ...q, hash: h }));
        if (flashcardFilter === 'hard') items = items.filter(q => q.difficulty === 3);
        if (flashcardFilter === 'starred') items = items.filter(q => q.starred);
        return items;
    }

    function renderFlashcard() {
        const deck = getFlashcardDeck();
        const card = document.getElementById('qh-flashcard');
        const qEl = document.getElementById('qh-flash-q');
        const aEl = document.getElementById('qh-flash-a');
        const counter = document.getElementById('qh-flash-counter');
        const progress = document.getElementById('qh-flash-progress');
        const starBtn = document.getElementById('qh-flash-star');

        if (!deck.length) {
            qEl.textContent = 'No cards yet';
            aEl.textContent = '—';
            counter.textContent = '0 / 0';
            progress.style.width = '0%';
            return;
        }
        if (flashcardIndex >= deck.length) flashcardIndex = 0;
        if (flashcardIndex < 0) flashcardIndex = deck.length - 1;
        const item = deck[flashcardIndex];
        qEl.textContent = item.question;
        aEl.textContent = item.answers.join(' • ');
        counter.textContent = `${flashcardIndex + 1} / ${deck.length}`;
        progress.style.width = (((flashcardIndex + 1) / deck.length) * 100) + '%';
        card.classList.toggle('flipped', flashcardFlipped);
        if (starBtn) starBtn.textContent = item.starred ? '⭐ Starred' : '☆ Star';
    }

    /* ---------- PRACTICE MODE (multiple choice generated from your seen questions) ---------- */
    function renderPractice(reset = false) {
        if (reset) { quizModeIndex = 0; quizModeScore = 0; quizModeAnswered = false; }
        const items = Object.values(studyData.seenQuestions);
        const numEl = document.getElementById('qh-practice-num');
        const scoreEl = document.getElementById('qh-practice-score');
        const accEl = document.getElementById('qh-practice-acc');
        const qEl = document.getElementById('qh-practice-q');
        const optsEl = document.getElementById('qh-practice-opts');

        if (!items.length) {
            qEl.textContent = 'Load a quiz first - then click Start to test yourself with random Qs you have seen.';
            optsEl.innerHTML = '';
            numEl.textContent = '0/0';
            scoreEl.textContent = '0';
            accEl.textContent = '—';
            return;
        }

        if (quizModeIndex >= items.length) {
            qEl.innerHTML = `<div style="text-align:center"><div style="font-size:32px;margin-bottom:6px">🎉</div><strong>Done!</strong><br><span style="color:var(--qh-text-soft);font-size:12px">Score: ${quizModeScore} / ${items.length}</span></div>`;
            optsEl.innerHTML = '';
            return;
        }
        const q = items[quizModeIndex];
        numEl.textContent = `${quizModeIndex + 1}/${items.length}`;
        scoreEl.textContent = quizModeScore;
        const answered = quizModeIndex;
        accEl.textContent = answered ? Math.round((quizModeScore / answered) * 100) + '%' : '—';

        qEl.textContent = q.question;

        // Build options: correct + 3 random distractors from other questions
        const correct = q.answers[0];
        const pool = items.filter(x => x !== q).flatMap(x => x.answers);
        const distractors = [];
        const seen = new Set([normalizeText(correct)]);
        while (distractors.length < 3 && pool.length) {
            const pick = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
            if (pick && !seen.has(normalizeText(pick))) {
                seen.add(normalizeText(pick));
                distractors.push(pick);
            }
        }
        const options = [correct, ...distractors].sort(() => Math.random() - 0.5);
        optsEl.innerHTML = options.map(o => `<button class="qh-quiz-option">${escapeHtml(o)}</button>`).join('');
        quizModeAnswered = false;
        optsEl.querySelectorAll('.qh-quiz-option').forEach(btn => {
            btn.onclick = () => {
                if (quizModeAnswered) return;
                quizModeAnswered = true;
                const picked = btn.textContent;
                const isCorrect = textsMatch(picked, correct);
                if (isCorrect) {
                    btn.classList.add('correct');
                    quizModeScore++;
                    playBeep('success');
                } else {
                    btn.classList.add('wrong');
                    optsEl.querySelectorAll('.qh-quiz-option').forEach(b => {
                        if (textsMatch(b.textContent, correct)) b.classList.add('correct');
                    });
                    playBeep('error');
                }
                optsEl.querySelectorAll('.qh-quiz-option').forEach(b => b.disabled = true);
                setTimeout(() => { quizModeIndex++; renderPractice(); }, 1100);
            };
        });
    }

    /* ---------- STATS ---------- */
    function renderStats() {
        const items = Object.values(studyData.seenQuestions);
        const total = items.length;
        const mastered = items.filter(q => q.difficulty === 1).length;
        const starred = items.filter(q => q.starred).length;
        const masteryPct = total ? Math.round((mastered / total) * 100) : 0;
        const elapsed = Date.now() - (studyData.currentSession.startTime || Date.now());

        document.getElementById('qh-stat-seen').textContent = total;
        document.getElementById('qh-stat-session').textContent = `this session: ${studyData.currentSession.seen}`;
        document.getElementById('qh-stat-mastery').textContent = masteryPct + '%';
        document.getElementById('qh-stat-mastery-sub').textContent = `${mastered} mastered`;
        document.getElementById('qh-stat-starred').textContent = starred;
        document.getElementById('qh-stat-time').textContent = fmtTime(elapsed);
        document.getElementById('qh-stat-progress').style.width = masteryPct + '%';
    }

    function updateTabBadges() {
        const total = Object.keys(studyData.seenQuestions).length;
        document.querySelectorAll('.qh-tab').forEach(tab => {
            const t = tab.dataset.tab;
            const existing = tab.querySelector('.qh-tab-badge');
            if (existing) existing.remove();
            if ((t === 'study' || t === 'flash') && total > 0) {
                const badge = document.createElement('span');
                badge.className = 'qh-tab-badge';
                badge.textContent = total;
                tab.appendChild(badge);
            }
        });
    }

    /* ---------- SOUNDS ---------- */
    function playBeep(type) {
        if (!GM_getValue('sounds', false)) return;
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const osc = ctx.createOscillator(), gain = ctx.createGain();
            osc.connect(gain); gain.connect(ctx.destination);
            const freqs = { success: [600, 900], error: [300, 200], info: [500, 500] };
            const [f1, f2] = freqs[type] || freqs.info;
            osc.frequency.setValueAtTime(f1, ctx.currentTime);
            osc.frequency.exponentialRampToValueAtTime(f2, ctx.currentTime + 0.1);
            gain.gain.setValueAtTime(0.05, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
            osc.start(); osc.stop(ctx.currentTime + 0.15);
        } catch (e) {}
    }

    /* ---------- WIRE GUI ---------- */
    function wireGUI() {
        // Master toggle
        document.getElementById('qh-master-toggle').addEventListener('change', (e) => {
            helperEnabled = e.target.checked;
            GM_setValue('helper-enabled', helperEnabled);
            const gui = document.getElementById('quiz-input-gui');
            gui.classList.toggle('qh-disabled', !helperEnabled);
            if (!helperEnabled) {
                clearPreviousMarkers();
                hideFloatingAnswer();
                showNotification('Helper disabled', 'info');
            } else {
                showNotification('Helper enabled', 'success');
                if (apiResponse) processQuestion();
            }
        });

        // Tabs
        document.querySelectorAll('.qh-tab').forEach(t => {
            t.onclick = () => switchTab(t.dataset.tab);
        });

        // Answer pane
        const input = document.getElementById('quiz-code-input');
        const button = document.getElementById('quiz-submit-btn');
        input.addEventListener('input', e => e.target.value = e.target.value.replace(/[^0-9a-zA-Z]/g, ''));
        button.addEventListener('click', () => {
            const code = input.value.trim();
            if (code.length >= 4) loadAnswers(code);
            else {
                input.style.borderColor = 'var(--qh-error)';
                input.style.animation = 'qh-shake 0.4s';
                showNotification('Enter a valid quiz code', 'error');
                setTimeout(() => { input.style.borderColor = ''; input.style.animation = ''; }, 1200);
            }
        });
        input.addEventListener('keypress', e => { if (e.key === 'Enter') button.click(); });

        // Study pane
        document.getElementById('qh-toggle-memory').onclick = (e) => {
            const list = document.getElementById('qh-study-list');
            list.classList.toggle('qh-memory-mode');
            e.target.textContent = list.classList.contains('qh-memory-mode') ? '👁 Show Answers' : '👁 Hide Answers';
        };
        document.getElementById('qh-shuffle-list').onclick = () => {
            const items = document.querySelectorAll('#qh-study-list .qh-list-item');
            const arr = Array.from(items).sort(() => Math.random() - 0.5);
            const parent = document.getElementById('qh-study-list');
            arr.forEach(el => parent.appendChild(el));
        };
        document.getElementById('qh-search-input').addEventListener('input', e => renderStudyList(e.target.value));

        // Flashcards
        document.getElementById('qh-flashcard').onclick = () => {
            flashcardFlipped = !flashcardFlipped;
            renderFlashcard();
        };
        document.getElementById('qh-flash-prev').onclick = (e) => {
            e.stopPropagation(); flashcardIndex--; flashcardFlipped = false; renderFlashcard();
        };
        document.getElementById('qh-flash-next').onclick = (e) => {
            e.stopPropagation(); flashcardIndex++; flashcardFlipped = false; renderFlashcard();
        };
        document.querySelectorAll('.qh-diff-btn').forEach(b => {
            b.onclick = (e) => {
                e.stopPropagation();
                const deck = getFlashcardDeck();
                if (!deck.length) return;
                const item = deck[flashcardIndex];
                if (item) {
                    studyData.seenQuestions[item.hash].difficulty = parseInt(b.dataset.diff);
                    saveStudyData();
                }
                flashcardIndex++; flashcardFlipped = false;
                renderFlashcard();
                playBeep('info');
            };
        });
        document.getElementById('qh-flash-star').onclick = (e) => {
            e.stopPropagation();
            const deck = getFlashcardDeck();
            if (!deck.length) return;
            const item = deck[flashcardIndex];
            studyData.seenQuestions[item.hash].starred = !studyData.seenQuestions[item.hash].starred;
            saveStudyData();
            renderFlashcard();
        };
        document.getElementById('qh-flash-only-hard').onclick = (e) => {
            e.stopPropagation();
            flashcardFilter = flashcardFilter === 'hard' ? 'all' : 'hard';
            flashcardIndex = 0; flashcardFlipped = false;
            e.target.textContent = flashcardFilter === 'hard' ? '📚 All cards' : '🔥 Hard only';
            renderFlashcard();
        };

        // Practice
        document.getElementById('qh-practice-start').onclick = () => renderPractice(true);
        document.getElementById('qh-practice-skip').onclick = () => { quizModeIndex++; renderPractice(); };

        // Stats actions
        document.getElementById('qh-export').onclick = () => {
            const blob = new Blob([JSON.stringify(studyData, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = `quiz-helper-export-${Date.now()}.json`;
            a.click(); URL.revokeObjectURL(url);
            showNotification('Exported study data', 'success');
        };
        document.getElementById('qh-clear').onclick = () => {
            if (confirm('Reset all study progress? This cannot be undone.')) {
                studyData = {
                    seenQuestions: {},
                    stats: { totalSeen: 0, totalCorrect: 0, sessions: 0 },
                    currentSession: { quizCode: null, seen: 0, correct: 0, startTime: Date.now() }
                };
                saveStudyData(); renderStats(); renderStudyList(); renderFlashcard(); updateTabBadges();
                showNotification('Progress reset', 'info');
            }
        };

        // Settings
        document.getElementById('qh-stealth-toggle').addEventListener('change', e => {
            stealthMode = e.target.checked;
            GM_setValue('stealth-mode', stealthMode);
            document.getElementById('quiz-input-gui').classList.toggle('qh-stealth', stealthMode);
        });
        document.getElementById('qh-highlight-toggle').addEventListener('change', e => {
            GM_setValue('auto-highlight', e.target.checked);
            if (!e.target.checked) clearPreviousMarkers();
            else if (currentMatch) markCorrectAnswers(currentMatch, currentQuestionText, true);
        });
        document.getElementById('qh-floating-toggle').addEventListener('change', e => {
            GM_setValue('floating-card', e.target.checked);
            if (!e.target.checked) hideFloatingAnswer();
        });
        document.getElementById('qh-sound-toggle').addEventListener('change', e => {
            GM_setValue('sounds', e.target.checked);
            if (e.target.checked) playBeep('success');
        });

        // Periodic stats refresh
        setInterval(() => { if (activeTab === 'stats') renderStats(); }, 1000);
    }

    /* ---------- KEYBOARD SHORTCUTS ---------- */
    function setupShortcuts() {
        document.addEventListener('keydown', (e) => {
            // Alt+Q toggles helper
            if (e.altKey && e.key.toLowerCase() === 'q') {
                e.preventDefault();
                const cb = document.getElementById('qh-master-toggle');
                cb.checked = !cb.checked;
                cb.dispatchEvent(new Event('change'));
            }
            // In flashcard tab, arrow keys / space
            if (activeTab === 'flash') {
                if (e.key === 'ArrowLeft') document.getElementById('qh-flash-prev').click();
                if (e.key === 'ArrowRight') document.getElementById('qh-flash-next').click();
                if (e.key === ' ' && document.activeElement.tagName !== 'INPUT') {
                    e.preventDefault();
                    document.getElementById('qh-flashcard').click();
                }
            }
        });
    }

    /* ---------- INIT ---------- */
    function initialize() {
        log(`Init v${VERSION}`);
        createGUI();
        setupShortcuts();
        updateTabBadges();
    }

    window.addEventListener('beforeunload', () => {
        if (mutationObserver) mutationObserver.disconnect();
        clearTimeout(debounceTimer);
        clearTimeout(retryTimer);
        saveStudyData();
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize);
    } else {
        initialize();
    }
})();
