// ==UserScript==
// @name          Quizizz Helper - Study Edition
// @namespace     https://github.com/ShizukuFuru
// @version       7.6.0
// @description   Sleek black UI quiz helper with study tools, practice, custom selection, retry-wrong-questions, full-question view & image support
// @author        Furu
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

    const DEBUG = false;
    const VERSION = '7.6.0';
    const STORAGE_KEY = 'quiz-helper-data-v7';
    const SAVE_DEBOUNCE_MS = 500;

    /* ---------- STATE ---------- */
    let apiResponse = null;
    let normalizedApiCache = [];
    let mutationObserver = null;
    let lastProcessedQuestion = '';
    let isProcessing = false;
    let debounceTimer = null;
    let retryTimer = null;
    let saveTimer = null;
    let badgeTimer = null;
    let statsInterval = null;
    let currentMatch = null;
    let currentQuestionText = '';
    let currentQuestionImages = [];
    let helperEnabled = GM_getValue('helper-enabled', true);
    let activeTab = 'answer';
    let activePracticeSubTab = 'practice';
    let studyData = loadStudyData();
    let flashcardIndex = 0;
    let flashcardFlipped = false;
    let flashcardFilter = 'all';
    let flashcardOrder = null;
    let quizModeIndex = 0;
    let quizModeScore = 0;
    let quizModeAnswered = false;
    let practiceDeck = [];
    let practiceScope = 'session';
    let practiceWrongHashes = new Set();
    let stealthMode = GM_getValue('stealth-mode', false);
    let audioCtx = null;

    let customSelected = new Set();
    let customSearch = '';
    let customMethod = 'practice';
    let customActive = false;
    let customMode = null;
    let customDeck = [];
    let customFlashIndex = 0;
    let customFlashFlipped = false;

    let lastDetectedAnswerHash = null;
    let answerDetectionTimer = null;

    function log(...args) {
        if (DEBUG) console.log('%c[QH]', 'color:#fff;background:#000;padding:2px 8px;border-radius:4px;font-weight:bold', ...args);
    }

    /* ---------- PERSISTENT STUDY DATA ---------- */
    function loadStudyData() {
        try {
            const raw = GM_getValue(STORAGE_KEY, null);
            if (raw) {
                const data = JSON.parse(raw);
                data.seenQuestions = data.seenQuestions || {};
                data.stats = data.stats || { totalSeen: 0, totalCorrect: 0, sessions: 0 };
                data.currentSession = data.currentSession || { quizCode: null, seen: 0, correct: 0, startTime: Date.now(), questionHashes: [] };
                data.currentSession.questionHashes = data.currentSession.questionHashes || [];
                Object.values(data.seenQuestions).forEach(q => {
                    if (q.wrongCount === undefined) q.wrongCount = 0;
                    if (q.lastAnsweredCorrectly === undefined) q.lastAnsweredCorrectly = null;
                    if (q.quizizzWrongCount === undefined) q.quizizzWrongCount = 0;
                    if (q.quizizzLastWrong === undefined) q.quizizzLastWrong = null;
                    if (q.quizizzLastCorrect === undefined) q.quizizzLastCorrect = null;
                    if (!Array.isArray(q.images)) q.images = [];
                });
                return data;
            }
        } catch (e) {}
        return {
            seenQuestions: {},
            stats: { totalSeen: 0, totalCorrect: 0, sessions: 0 },
            currentSession: { quizCode: null, seen: 0, correct: 0, startTime: Date.now(), questionHashes: [] }
        };
    }

    function saveStudyData(immediate = false) {
        if (immediate) {
            clearTimeout(saveTimer);
            try { GM_setValue(STORAGE_KEY, JSON.stringify(studyData)); } catch (e) { log('Save error', e); }
            return;
        }
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            try { GM_setValue(STORAGE_KEY, JSON.stringify(studyData)); } catch (e) { log('Save error', e); }
        }, SAVE_DEBOUNCE_MS);
    }

    function recordQuestion(hash, question, answers, allOptions, qType, images) {
        if (!studyData.seenQuestions[hash]) {
            studyData.seenQuestions[hash] = {
                question, answers,
                allOptions: allOptions || [],
                qType: qType || 'mcq',
                images: images || [],
                seenCount: 0, correctCount: 0, wrongCount: 0,
                quizizzWrongCount: 0,
                quizizzLastWrong: null,
                quizizzLastCorrect: null,
                lastSeen: Date.now(), difficulty: 0,
                starred: false, firstSeen: Date.now(),
                lastAnsweredCorrectly: null
            };
            studyData.stats.totalSeen++;
        }
        const q = studyData.seenQuestions[hash];
        q.seenCount++;
        q.lastSeen = Date.now();
        q.answers = answers;
        q.question = question;
        q.allOptions = allOptions || q.allOptions || [];
        q.qType = qType || q.qType || 'mcq';
        if (Array.isArray(images) && images.length) q.images = images;
        else if (!Array.isArray(q.images)) q.images = [];
        if (!studyData.currentSession.questionHashes.includes(hash)) {
            studyData.currentSession.questionHashes.push(hash);
            studyData.currentSession.seen++;
        }
        saveStudyData();
    }

    function recordPracticeResult(hash, wasCorrect) {
        const q = studyData.seenQuestions[hash];
        if (!q) return;
        if (wasCorrect) {
            q.correctCount = (q.correctCount || 0) + 1;
            q.lastAnsweredCorrectly = Date.now();
        } else {
            q.wrongCount = (q.wrongCount || 0) + 1;
            q.lastAnsweredCorrectly = null;
            practiceWrongHashes.add(hash);
        }
        saveStudyData();
    }

    function recordQuizizzResult(hash, wasCorrect) {
        const q = studyData.seenQuestions[hash];
        if (!q) return;
        if (wasCorrect) {
            q.quizizzLastCorrect = Date.now();
            q.quizizzLastWrong = null;
        } else {
            q.quizizzWrongCount = (q.quizizzWrongCount || 0) + 1;
            q.quizizzLastWrong = Date.now();
        }
        saveStudyData();
        scheduleBadgeUpdate();
    }

    /* ---------- TEXT UTILITIES ---------- */
    const _scratchDiv = document.createElement('div');

    function stripHtml(html) {
        if (html == null) return '';
        _scratchDiv.innerHTML = String(html);
        return _scratchDiv.textContent || _scratchDiv.innerText || '';
    }

    function extractText(el) {
        if (!el) return '';
        const c = el.cloneNode(true);
        c.querySelectorAll('script,style,noscript,.quiz-correct-marker,.qh-badge').forEach(e => e.remove());
        return (c.textContent || c.innerText || '').trim();
    }

    function normalizeText(text) {
        if (text == null) return '';
        let s = String(text);
        if (s.indexOf('<') !== -1) s = stripHtml(s);
        return s.toLowerCase().trim()
            .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, ' ')
            .replace(/['']/g, "'")
            .replace(/[""]/g, '"')
            .replace(/\s+/g, ' ')
            .trim();
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

    function isTypedType(type) {
        const t = (type || '').toLowerCase();
        return t.includes('text') || t.includes('fill') || t.includes('open') ||
               t.includes('blank') || t.includes('typed') || t.includes('shortanswer') || t.includes('short_answer');
    }

    function isMultiSelect(qType) {
        const t = (qType || '').toLowerCase();
        return t === 'multi' || t.includes('multi') || t === 'checkbox' || t.includes('select');
    }

    /* ---------- IMAGE EXTRACTION ---------- */
    function isLikelyImageUrl(s) {
        if (!s || typeof s !== 'string') return false;
        if (!/^https?:\/\//i.test(s) && !s.startsWith('//') && !s.startsWith('data:image')) return false;
        return /\.(png|jpe?g|gif|webp|svg|bmp|avif)(\?|#|$)/i.test(s)
            || /quizizz\.com\/.*\/(media|image|attachment)/i.test(s)
            || s.startsWith('data:image');
    }

    function pushImg(arr, url) {
        if (!url) return;
        let u = String(url).trim();
        if (!u) return;
        if (u.startsWith('//')) u = 'https:' + u;
        if (!isLikelyImageUrl(u) && !u.startsWith('http')) return;
        if (!arr.includes(u)) arr.push(u);
    }

    function collectImagesFromValue(val, out) {
        if (!val) return;
        if (typeof val === 'string') {
            if (isLikelyImageUrl(val)) pushImg(out, val);
            return;
        }
        if (Array.isArray(val)) {
            val.forEach(v => collectImagesFromValue(v, out));
            return;
        }
        if (typeof val === 'object') {
            // Common Quizizz media shapes
            const keys = ['url', 'src', 'href', 'image', 'imageUrl', 'thumbnail', 'thumbnailUrl', 'preview', 'previewUrl'];
            for (const k of keys) {
                if (val[k] && typeof val[k] === 'string' && isLikelyImageUrl(val[k])) pushImg(out, val[k]);
            }
            // Type hints
            const type = (val.type || val.kind || '').toString().toLowerCase();
            if (type.includes('image') || type.includes('photo') || type.includes('picture')) {
                if (val.url) pushImg(out, val.url);
                if (val.src) pushImg(out, val.src);
            }
            // Recurse known containers
            ['media', 'attachments', 'images', 'questionMedia', 'medias', 'files'].forEach(k => {
                if (val[k]) collectImagesFromValue(val[k], out);
            });
        }
    }

    function extractQuestionImages(answer) {
        const out = [];
        if (!answer) return out;
        // Direct fields
        ['image', 'imageUrl', 'questionImage', 'questionImageUrl'].forEach(k => {
            if (answer[k]) collectImagesFromValue(answer[k], out);
        });
        // Common containers
        ['media', 'questionMedia', 'attachments', 'images', 'medias', 'files'].forEach(k => {
            if (answer[k]) collectImagesFromValue(answer[k], out);
        });
        // structured.query / question wrapper
        if (answer.structured) collectImagesFromValue(answer.structured, out);
        if (answer.query) collectImagesFromValue(answer.query, out);
        // Fallback: scan question html for <img>
        const qStr = typeof answer.question === 'string' ? answer.question : '';
        if (qStr.includes('<img')) {
            const re = /<img[^>]+src=["']([^"']+)["']/gi;
            let m; while ((m = re.exec(qStr)) !== null) pushImg(out, m[1]);
        }
        return out;
    }

    function extractImagesFromElement(el) {
        const out = [];
        if (!el) return out;
        // Look at the question element and a couple ancestors for sibling images
        const scopes = [el];
        let p = el.parentElement;
        for (let i = 0; i < 3 && p; i++) { scopes.push(p); p = p.parentElement; }
        const seen = new Set();
        for (const scope of scopes) {
            scope.querySelectorAll('img').forEach(img => {
                const r = img.getBoundingClientRect();
                if (r.width < 24 || r.height < 24) return;
                const src = img.currentSrc || img.src;
                if (!src || seen.has(src)) return;
                // Skip helper's own images
                if (img.closest('#quiz-input-gui') || img.closest('#qh-floating-answer')) return;
                seen.add(src);
                pushImg(out, src);
            });
            // Also look for inline background images
            scope.querySelectorAll('[style*="background-image"]').forEach(node => {
                if (node.closest('#quiz-input-gui')) return;
                const bg = (node.style.backgroundImage || '').match(/url\((['"]?)(.*?)\1\)/);
                if (bg && bg[2]) {
                    const r = node.getBoundingClientRect();
                    if (r.width >= 40 && r.height >= 40 && !seen.has(bg[2])) {
                        seen.add(bg[2]);
                        pushImg(out, bg[2]);
                    }
                }
            });
            if (out.length) break;
        }
        return out;
    }

    function levenshtein(a, b) {
        if (a === b) return 0;
        const al = a.length, bl = b.length;
        if (!al) return bl;
        if (!bl) return al;
        if (Math.abs(al - bl) > Math.max(al, bl) * 0.4) return Math.max(al, bl);
        let prev = new Array(al + 1);
        let curr = new Array(al + 1);
        for (let j = 0; j <= al; j++) prev[j] = j;
        for (let i = 1; i <= bl; i++) {
            curr[0] = i;
            for (let j = 1; j <= al; j++) {
                curr[j] = b.charCodeAt(i-1) === a.charCodeAt(j-1)
                    ? prev[j-1]
                    : 1 + Math.min(prev[j-1], curr[j-1], prev[j]);
            }
            const tmp = prev; prev = curr; curr = tmp;
        }
        return prev[al];
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
        if (n1.length > 2 && n2.length > 2 && (n1.includes(n2) || n2.includes(n1))) return true;
        const c1 = n1.replace(/[^a-z0-9]/g, ''), c2 = n2.replace(/[^a-z0-9]/g, '');
        if (c1 && c1 === c2) return true;
        if (c1.length > 4 && c2.length > 4 && Math.abs(c1.length - c2.length) <= 3 && similarity(c1, c2) > 0.9) return true;
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

    function shuffle(arr) {
        const a = [...arr];
        for (let i = a.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [a[i], a[j]] = [a[j], a[i]];
        }
        return a;
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
            --qh-success: #22c55e;
            --qh-error: #ef4444;
            --qh-warning: #f59e0b;
            --qh-info: #3b82f6;
        }

        #quiz-input-gui {
            position: fixed; top: 20px; right: 20px;
            z-index: 2147483647;
            width: 340px;
            max-height: calc(100vh - 40px);
            display: flex; flex-direction: column;
            border-radius: 16px;
            background: var(--qh-bg);
            box-shadow: 0 30px 60px rgba(0,0,0,0.5), 0 0 0 1px var(--qh-border);
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Inter', sans-serif;
            color: var(--qh-text);
            overflow: hidden;
            animation: qh-slideIn 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
            transition: opacity 0.3s, transform 0.3s, box-shadow 0.3s;
        }
        #quiz-input-gui.qh-disabled { opacity: 0.55; }
        #quiz-input-gui.qh-disabled #quiz-gui-content { pointer-events: none; }
        #quiz-input-gui.qh-stealth { opacity: 0.08; transform: scale(0.6); transform-origin: top right; }
        #quiz-input-gui.qh-stealth:hover { opacity: 1; transform: scale(1); }

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
            flex-shrink: 0;
        }
        #quiz-gui-header::after {
            content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: 1px;
            background: linear-gradient(90deg, transparent, rgba(255,255,255,0.08), transparent);
        }

        .qh-title { display: flex; align-items: center; gap: 10px; font-size: 14px; font-weight: 600; }
        .qh-logo {
            width: 26px; height: 26px;
            background: var(--qh-text); color: var(--qh-bg);
            border-radius: 8px;
            display: flex; align-items: center; justify-content: center;
            font-size: 14px; font-weight: 800;
            box-shadow: 0 0 20px rgba(255,255,255,0.15);
        }
        .qh-version { font-size: 10px; color: var(--qh-text-dim); font-weight: 500; font-family: 'SF Mono', Menlo, monospace; }
        .qh-header-actions { display: flex; gap: 6px; align-items: center; }

        .qh-switch { position: relative; display: inline-block; width: 36px; height: 20px; cursor: pointer; flex-shrink: 0; }
        .qh-switch input { opacity: 0; width: 0; height: 0; }
        .qh-switch-slider {
            position: absolute; inset: 0; background: #2a2a2a;
            border-radius: 999px; transition: 0.3s;
            border: 1px solid var(--qh-border-strong);
        }
        .qh-switch-slider::before {
            content: ''; position: absolute;
            height: 14px; width: 14px; left: 2px; top: 2px;
            background: var(--qh-text-soft); border-radius: 50%;
            transition: 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);
        }
        .qh-switch input:checked + .qh-switch-slider {
            background: var(--qh-success); border-color: var(--qh-success);
        }
        .qh-switch input:checked + .qh-switch-slider::before {
            transform: translateX(16px); background: white;
        }

        .qh-icon-btn {
            background: transparent; border: 1px solid var(--qh-border);
            color: var(--qh-text-soft); cursor: pointer;
            width: 28px; height: 28px; border-radius: 8px;
            display: flex; align-items: center; justify-content: center;
            transition: all 0.2s; font-size: 14px;
        }
        .qh-icon-btn:hover {
            background: var(--qh-bg-elev-2); color: var(--qh-text);
            border-color: var(--qh-border-strong);
        }

        .qh-tabs-wrap { position: relative; background: var(--qh-bg-elev); border-bottom: 1px solid var(--qh-border); flex-shrink: 0; }
        .qh-tabs {
            display: flex; padding: 0 28px; gap: 2px;
            overflow-x: auto; scroll-behavior: smooth; scrollbar-width: none;
        }
        .qh-tabs::-webkit-scrollbar { display: none; }
        .qh-tab-arrow {
            position: absolute; top: 0; bottom: 0;
            width: 26px; background: var(--qh-bg-elev);
            border: none; color: var(--qh-text-soft);
            cursor: pointer; font-size: 16px; font-weight: bold;
            display: flex; align-items: center; justify-content: center;
            z-index: 2; transition: all 0.2s;
            opacity: 0; pointer-events: none;
        }
        .qh-tab-arrow.visible { opacity: 1; pointer-events: auto; }
        .qh-tab-arrow:hover { color: var(--qh-text); background: var(--qh-bg-elev-2); }
        .qh-tab-arrow.left { left: 0; box-shadow: 6px 0 8px -4px var(--qh-bg-elev); }
        .qh-tab-arrow.right { right: 0; box-shadow: -6px 0 8px -4px var(--qh-bg-elev); }

        .qh-tab {
            background: none; border: none; color: var(--qh-text-dim);
            padding: 10px 12px; cursor: pointer;
            font-size: 12px; font-weight: 600;
            border-bottom: 2px solid transparent;
            transition: all 0.2s; white-space: nowrap;
            display: flex; align-items: center; gap: 5px;
            font-family: inherit; flex-shrink: 0;
        }
        .qh-tab:hover { color: var(--qh-text-soft); }
        .qh-tab.active { color: var(--qh-text); border-bottom-color: var(--qh-text); }
        .qh-tab-badge {
            background: var(--qh-bg-elev-2); color: var(--qh-text-soft);
            padding: 1px 6px; border-radius: 999px;
            font-size: 10px; font-weight: 700;
        }
        .qh-tab.active .qh-tab-badge { background: var(--qh-text); color: var(--qh-bg); }
        .qh-tab-badge.error { background: var(--qh-error); color: white; }

        .qh-subtabs {
            display: flex;
            background: var(--qh-bg-elev);
            border: 1px solid var(--qh-border);
            border-radius: 10px;
            padding: 3px;
            margin-bottom: 12px;
            gap: 2px;
        }
        .qh-subtab {
            flex: 1;
            background: none; border: none;
            padding: 8px 6px;
            color: var(--qh-text-dim);
            font-size: 11px; font-weight: 700;
            cursor: pointer; border-radius: 7px;
            transition: all 0.2s;
            font-family: inherit;
            display: flex; align-items: center; justify-content: center; gap: 5px;
            text-transform: uppercase; letter-spacing: 0.4px;
        }
        .qh-subtab.active { background: var(--qh-text); color: var(--qh-bg); }
        .qh-subtab:hover:not(.active) { color: var(--qh-text); }
        .qh-subtab-count {
            background: rgba(255,255,255,0.15);
            color: inherit;
            padding: 1px 6px; border-radius: 999px;
            font-size: 9px; font-weight: 800;
            min-width: 14px; text-align: center;
        }
        .qh-subtab.active .qh-subtab-count {
            background: rgba(0,0,0,0.2);
        }
        .qh-subtab.qh-subtab-quizizz .qh-subtab-count.has {
            background: var(--qh-error); color: white;
        }
        .qh-subtab.qh-subtab-quizizz.active { background: var(--qh-error); color: white; }

        .qh-subpane { display: none; }
        .qh-subpane.active { display: block; animation: qh-fadeIn 0.25s; }

        #quiz-gui-content {
            background: var(--qh-bg);
            transition: max-height 0.35s, opacity 0.25s;
            overflow-y: auto;
            overflow-x: hidden;
            flex: 1 1 auto;
            min-height: 0;
        }
        #quiz-gui-content::-webkit-scrollbar { width: 8px; }
        #quiz-gui-content::-webkit-scrollbar-thumb { background: var(--qh-border-strong); border-radius: 4px; }
        #quiz-gui-content.qh-collapsed { max-height: 0 !important; opacity: 0; flex: 0 0 auto; }

        .qh-pane { display: none; padding: 16px; }
        .qh-pane.active { display: block; animation: qh-fadeIn 0.25s; }
        @keyframes qh-fadeIn {
            from { opacity: 0; transform: translateY(4px); }
            to { opacity: 1; transform: translateY(0); }
        }

        .qh-input-wrap { position: relative; margin-bottom: 10px; }
        #quiz-code-input {
            width: 100%; padding: 12px 14px;
            border: 1px solid var(--qh-border); border-radius: 10px;
            font-size: 15px; text-align: center; letter-spacing: 1px;
            outline: none; box-sizing: border-box;
            background: var(--qh-bg-elev); color: var(--qh-text);
            transition: all 0.2s;
            font-family: 'SF Mono', Menlo, monospace; font-weight: 500;
        }
        #quiz-code-input:focus {
            border-color: var(--qh-text-soft);
            box-shadow: 0 0 0 4px rgba(255,255,255,0.06);
            background: var(--qh-bg-elev-2);
        }
        #quiz-code-input::placeholder {
            font-family: -apple-system, sans-serif; letter-spacing: 0; color: var(--qh-text-dim);
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
        .qh-btn-danger {
            background: linear-gradient(135deg, #ef4444, #dc2626); color: white;
        }
        .qh-btn-danger:hover:not(:disabled) {
            box-shadow: 0 8px 20px rgba(239,68,68,0.4);
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
            color: var(--qh-text-soft); text-align: center;
            min-height: 16px; font-weight: 500;
            display: flex; align-items: center; justify-content: center; gap: 6px;
        }
        .qh-status-dot {
            width: 6px; height: 6px; border-radius: 50%;
            background: currentColor; animation: qh-blink 1.5s infinite;
        }
        @keyframes qh-blink { 0%,100% { opacity: 0.4; } 50% { opacity: 1; } }

        #quiz-answer-display {
            padding: 14px;
            background: var(--qh-bg-elev);
            border: 1px solid var(--qh-border);
            border-radius: 12px;
            font-size: 13px;
            display: none;
            word-wrap: break-word;
            animation: qh-fadeIn 0.3s;
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
            max-height: 240px;
            overflow-y: auto;
            white-space: pre-wrap;
            word-break: break-word;
        }
        .qh-q-text::-webkit-scrollbar { width: 6px; }
        .qh-q-text::-webkit-scrollbar-thumb { background: var(--qh-border-strong); border-radius: 3px; }

        .qh-q-images {
            margin-top: 10px;
            display: flex;
            flex-direction: column;
            gap: 8px;
        }
        .qh-q-image-wrap {
            position: relative;
            background: var(--qh-bg);
            border: 1px solid var(--qh-border);
            border-radius: 8px;
            overflow: hidden;
            cursor: zoom-in;
        }
        .qh-q-image-wrap img {
            display: block;
            width: 100%;
            max-height: 220px;
            object-fit: contain;
            background: #000;
        }
        .qh-q-image-wrap .qh-img-label {
            position: absolute; top: 6px; left: 6px;
            background: rgba(0,0,0,0.6);
            color: var(--qh-text);
            font-size: 9px; font-weight: 700;
            padding: 3px 7px; border-radius: 999px;
            letter-spacing: 0.5px; text-transform: uppercase;
            backdrop-filter: blur(6px);
        }

        #qh-img-lightbox {
            position: fixed; inset: 0;
            background: rgba(0,0,0,0.92);
            z-index: 2147483647;
            display: none;
            align-items: center; justify-content: center;
            cursor: zoom-out;
            padding: 24px;
        }
        #qh-img-lightbox.show { display: flex; animation: qh-fadeIn 0.2s; }
        #qh-img-lightbox img {
            max-width: 100%;
            max-height: 100%;
            object-fit: contain;
            border-radius: 8px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.6);
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
            word-break: break-word;
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

        .qh-memory-mode .qh-answer-item {
            color: transparent !important;
            background: var(--qh-bg-elev-2) !important;
            border-left-color: var(--qh-warning) !important;
            cursor: pointer; transition: all 0.2s; position: relative;
        }
        .qh-memory-mode .qh-answer-item:hover {
            color: var(--qh-text) !important; background: var(--qh-bg) !important;
        }
        .qh-memory-mode .qh-answer-item .qh-answer-check { color: var(--qh-warning) !important; }
        .qh-memory-mode .qh-answer-item::after {
            content: 'Hover to reveal';
            color: var(--qh-text-dim);
            position: absolute; left: 50%; transform: translateX(-50%);
            font-size: 11px; font-style: italic;
            pointer-events: none; transition: opacity 0.2s;
        }
        .qh-memory-mode .qh-answer-item:hover::after { opacity: 0; }

        .qh-stats-grid {
            display: grid; grid-template-columns: 1fr 1fr; gap: 8px;
            margin-bottom: 12px;
        }
        .qh-stat-card {
            background: var(--qh-bg-elev);
            border: 1px solid var(--qh-border);
            border-radius: 10px; padding: 12px;
        }
        .qh-stat-label {
            font-size: 10px; color: var(--qh-text-dim);
            text-transform: uppercase; letter-spacing: 0.6px; font-weight: 600;
        }
        .qh-stat-value {
            font-size: 22px; font-weight: 800;
            color: var(--qh-text); margin-top: 4px;
            font-variant-numeric: tabular-nums;
        }
        .qh-stat-sub { font-size: 11px; color: var(--qh-text-soft); margin-top: 2px; }

        .qh-progress {
            height: 6px; background: var(--qh-bg-elev-2);
            border-radius: 999px; overflow: hidden; margin: 6px 0 12px;
        }
        .qh-progress-bar {
            height: 100%;
            background: linear-gradient(90deg, var(--qh-success), #4ade80);
            border-radius: 999px;
            transition: width 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
        }

        .qh-flashcard { perspective: 1000px; min-height: 240px; margin-bottom: 12px; }
        .qh-flashcard-inner {
            position: relative; width: 100%; min-height: 240px;
            transition: transform 0.6s cubic-bezier(0.4, 0.0, 0.2, 1);
            transform-style: preserve-3d; cursor: pointer;
        }
        .qh-flashcard.flipped .qh-flashcard-inner { transform: rotateY(180deg); }
        .qh-flashcard-face {
            position: absolute; inset: 0;
            backface-visibility: hidden;
            background: var(--qh-bg-elev);
            border: 1px solid var(--qh-border);
            border-radius: 14px; padding: 18px 18px 28px;
            display: flex; flex-direction: column;
            justify-content: center; align-items: center;
            text-align: center;
            box-shadow: 0 10px 30px rgba(0,0,0,0.3);
            box-sizing: border-box;
        }
        .qh-flashcard-face.back {
            transform: rotateY(180deg);
            background: linear-gradient(135deg, #1a1a1a, #0a0a0a);
            border-color: var(--qh-success);
            justify-content: flex-start;
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
            max-height: 150px; overflow-y: auto; width: 100%;
        }
        .qh-flashcard-img {
            max-width: 100%;
            max-height: 110px;
            object-fit: contain;
            border-radius: 6px;
            margin-bottom: 8px;
            background: #000;
        }
        .qh-flash-answers {
            width: 100%; max-height: 170px; overflow-y: auto;
            display: flex; flex-direction: column; gap: 6px;
            padding-right: 4px;
        }
        .qh-flash-answers::-webkit-scrollbar { width: 4px; }
        .qh-flash-answers::-webkit-scrollbar-thumb { background: var(--qh-border-strong); border-radius: 2px; }
        .qh-flash-answer-section {
            background: rgba(34,197,94,0.08);
            border: 1px solid rgba(34,197,94,0.25);
            border-left: 3px solid var(--qh-success);
            border-radius: 8px;
            padding: 8px 10px;
            display: flex; align-items: flex-start; gap: 8px;
            text-align: left;
            font-size: 13px;
            color: var(--qh-text);
            font-weight: 500;
            line-height: 1.4;
            animation: qh-slideRight 0.25s forwards;
            opacity: 0;
        }
        .qh-flash-answer-section:nth-child(1) { animation-delay: 0.05s; }
        .qh-flash-answer-section:nth-child(2) { animation-delay: 0.10s; }
        .qh-flash-answer-section:nth-child(3) { animation-delay: 0.15s; }
        .qh-flash-answer-section:nth-child(4) { animation-delay: 0.20s; }
        .qh-flash-answer-section:nth-child(5) { animation-delay: 0.25s; }
        .qh-flash-answer-num {
            background: var(--qh-success);
            color: black;
            width: 18px; height: 18px;
            border-radius: 50%;
            display: flex; align-items: center; justify-content: center;
            font-size: 10px; font-weight: 800;
            flex-shrink: 0;
            margin-top: 1px;
        }
        .qh-flash-multi-label {
            font-size: 9px; font-weight: 700; letter-spacing: 1px;
            text-transform: uppercase;
            color: var(--qh-warning);
            margin-bottom: 6px;
            text-align: center;
        }

        .qh-flashcard-hint {
            position: absolute; bottom: 8px; right: 12px;
            font-size: 10px; color: var(--qh-text-dim);
        }
        .qh-flashcard-controls {
            display: flex; gap: 8px; align-items: center; margin-bottom: 8px;
        }
        .qh-flashcard-counter {
            flex: 1; text-align: center;
            font-size: 12px; color: var(--qh-text-soft); font-weight: 600;
            font-variant-numeric: tabular-nums;
        }
        .qh-difficulty-row {
            display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px; margin-top: 8px;
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

        .qh-scope-toggle {
            display: flex;
            background: var(--qh-bg-elev);
            border: 1px solid var(--qh-border);
            border-radius: 10px;
            padding: 3px;
            margin-bottom: 10px;
            gap: 2px;
        }
        .qh-scope-btn {
            flex: 1;
            background: none; border: none;
            padding: 7px 4px;
            color: var(--qh-text-dim);
            font-size: 11px; font-weight: 600;
            cursor: pointer; border-radius: 7px;
            transition: all 0.2s;
            font-family: inherit;
            position: relative;
            display: flex; align-items: center; justify-content: center; gap: 4px;
        }
        .qh-scope-btn.active { background: var(--qh-text); color: var(--qh-bg); }
        .qh-scope-btn[data-scope="wrong"].active { background: var(--qh-error); color: white; }
        .qh-scope-btn:hover:not(.active) { color: var(--qh-text); }
        .qh-scope-btn-count {
            background: rgba(255,255,255,0.15);
            color: inherit;
            padding: 1px 5px; border-radius: 999px;
            font-size: 9px; font-weight: 800;
            min-width: 14px; text-align: center;
        }
        .qh-scope-btn.active .qh-scope-btn-count {
            background: rgba(0,0,0,0.2);
        }

        .qh-quiz-question {
            background: var(--qh-bg-elev);
            border: 1px solid var(--qh-border);
            border-radius: 12px;
            padding: 16px; margin-bottom: 10px;
            font-size: 14px; line-height: 1.5;
            min-height: 60px;
            max-height: 260px;
            overflow-y: auto;
            word-break: break-word;
            white-space: pre-wrap;
        }
        .qh-quiz-question::-webkit-scrollbar { width: 6px; }
        .qh-quiz-question::-webkit-scrollbar-thumb { background: var(--qh-border-strong); border-radius: 3px; }
        .qh-quiz-question img.qh-q-inline-img {
            max-width: 100%; max-height: 160px;
            object-fit: contain;
            border-radius: 6px;
            margin-top: 8px;
            background: #000;
            display: block;
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
            width: 100%;
            display: flex; align-items: center; gap: 10px;
            word-break: break-word;
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
        .qh-quiz-option.selected {
            background: rgba(99,102,241,0.15);
            border-color: #818cf8;
            color: var(--qh-text);
        }
        .qh-quiz-option:disabled { cursor: default; }
        .qh-quiz-checkbox {
            width: 16px; height: 16px;
            border: 2px solid var(--qh-border-strong);
            border-radius: 4px;
            flex-shrink: 0;
            display: flex; align-items: center; justify-content: center;
            font-size: 10px; font-weight: 800;
            transition: all 0.2s;
        }
        .qh-quiz-option.selected .qh-quiz-checkbox {
            background: #818cf8; border-color: #818cf8; color: white;
        }
        .qh-quiz-option.correct .qh-quiz-checkbox {
            background: var(--qh-success); border-color: var(--qh-success); color: black;
        }
        .qh-quiz-option.wrong .qh-quiz-checkbox {
            background: var(--qh-error); border-color: var(--qh-error); color: white;
        }

        .qh-type-input {
            width: 100%; padding: 12px 14px;
            border: 1px solid var(--qh-border); border-radius: 10px;
            font-size: 14px; outline: none; box-sizing: border-box;
            background: var(--qh-bg-elev); color: var(--qh-text);
            transition: all 0.2s; font-family: inherit;
        }
        .qh-type-input:focus {
            border-color: var(--qh-text-soft);
            box-shadow: 0 0 0 4px rgba(255,255,255,0.06);
            background: var(--qh-bg-elev-2);
        }
        .qh-type-input.correct {
            border-color: var(--qh-success) !important;
            box-shadow: 0 0 0 4px rgba(34,197,94,0.15) !important;
            color: var(--qh-success);
        }
        .qh-type-input.wrong {
            border-color: var(--qh-error) !important;
            box-shadow: 0 0 0 4px rgba(239,68,68,0.15) !important;
            color: var(--qh-error);
            animation: qh-shake 0.4s;
        }
        .qh-type-feedback {
            margin-top: 8px; padding: 8px 10px;
            background: var(--qh-bg-elev);
            border-radius: 8px;
            font-size: 12px;
            border-left: 3px solid var(--qh-text-soft);
            display: none;
        }
        .qh-type-feedback.show { display: block; animation: qh-fadeIn 0.3s; }
        .qh-type-feedback.correct { border-left-color: var(--qh-success); }
        .qh-type-feedback.wrong { border-left-color: var(--qh-error); }
        .qh-type-feedback strong { color: var(--qh-success); }

        .qh-practice-end {
            text-align: center;
            padding: 8px 0;
        }
        .qh-practice-end-icon {
            font-size: 36px;
            margin-bottom: 8px;
        }
        .qh-practice-end-title {
            font-size: 16px; font-weight: 700;
            color: var(--qh-text); margin-bottom: 4px;
        }
        .qh-practice-end-score {
            font-size: 13px;
            color: var(--qh-text-soft);
            margin-bottom: 12px;
        }
        .qh-practice-end-wrongs {
            background: rgba(239,68,68,0.1);
            border: 1px solid rgba(239,68,68,0.3);
            border-radius: 10px;
            padding: 10px 12px;
            margin: 8px 0 12px;
            text-align: left;
            font-size: 12px;
        }
        .qh-practice-end-wrongs-title {
            color: var(--qh-error);
            font-weight: 700;
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            margin-bottom: 6px;
        }
        .qh-practice-end-wrongs-list {
            color: var(--qh-text-soft);
            line-height: 1.5;
            max-height: 100px;
            overflow-y: auto;
        }
        .qh-practice-end-wrongs-list::-webkit-scrollbar { width: 4px; }
        .qh-practice-end-wrongs-list::-webkit-scrollbar-thumb { background: var(--qh-border-strong); border-radius: 2px; }

        .qh-list-item {
            background: var(--qh-bg-elev);
            border: 1px solid var(--qh-border);
            border-radius: 10px;
            padding: 10px 12px; margin-bottom: 6px;
            font-size: 12px;
            transition: all 0.2s; cursor: pointer;
            position: relative;
        }
        .qh-list-item:hover {
            border-color: var(--qh-border-strong);
            background: var(--qh-bg-elev-2);
        }
        .qh-list-item.has-wrongs {
            border-left: 3px solid var(--qh-error);
        }
        .qh-list-item-row { display: flex; gap: 8px; align-items: flex-start; }
        .qh-list-thumb {
            width: 42px; height: 42px;
            border-radius: 6px; flex-shrink: 0;
            object-fit: cover;
            background: #000;
            border: 1px solid var(--qh-border);
        }
        .qh-list-q { color: var(--qh-text); font-weight: 600; margin-bottom: 4px; line-height: 1.4; }
        .qh-list-a { color: var(--qh-success); font-size: 11px; opacity: 0.85; line-height: 1.4; }
        .qh-list-meta {
            display: flex; gap: 8px; margin-top: 6px;
            font-size: 10px; color: var(--qh-text-dim);
            flex-wrap: wrap;
        }
        .qh-list-meta-wrong { color: var(--qh-error); font-weight: 700; }
        .qh-empty {
            text-align: center; padding: 40px 20px;
            color: var(--qh-text-dim); font-size: 13px;
        }

        .qh-custom-item {
            background: var(--qh-bg-elev);
            border: 1px solid var(--qh-border);
            border-radius: 10px;
            padding: 9px 11px; margin-bottom: 5px;
            font-size: 12px;
            transition: all 0.15s; cursor: pointer;
            display: flex; gap: 9px; align-items: flex-start;
        }
        .qh-custom-item:hover { border-color: var(--qh-border-strong); background: var(--qh-bg-elev-2); }
        .qh-custom-item.selected {
            border-color: var(--qh-success);
            background: rgba(34,197,94,0.08);
        }
        .qh-custom-checkbox {
            width: 16px; height: 16px;
            border: 2px solid var(--qh-border-strong);
            border-radius: 4px;
            flex-shrink: 0; margin-top: 1px;
            display: flex; align-items: center; justify-content: center;
            font-size: 10px; font-weight: 800;
            transition: all 0.15s;
        }
        .qh-custom-item.selected .qh-custom-checkbox {
            background: var(--qh-success); border-color: var(--qh-success); color: black;
        }
        .qh-custom-item-body { flex: 1; min-width: 0; }
        .qh-custom-q { color: var(--qh-text); font-weight: 600; margin-bottom: 2px; line-height: 1.35; }
        .qh-custom-a { color: var(--qh-success); font-size: 10.5px; opacity: 0.85; line-height: 1.35; }

        .qh-method-toggle {
            display: flex;
            background: var(--qh-bg-elev);
            border: 1px solid var(--qh-border);
            border-radius: 10px;
            padding: 3px;
            gap: 2px;
        }
        .qh-method-btn {
            flex: 1;
            background: none; border: none;
            padding: 8px 4px;
            color: var(--qh-text-dim);
            font-size: 11px; font-weight: 700;
            cursor: pointer; border-radius: 7px;
            transition: all 0.2s;
            font-family: inherit;
            display: flex; align-items: center; justify-content: center; gap: 5px;
            text-transform: uppercase; letter-spacing: 0.4px;
        }
        .qh-method-btn.active { background: var(--qh-text); color: var(--qh-bg); }
        .qh-method-btn:hover:not(.active) { color: var(--qh-text); }

        .qh-custom-toolbar {
            display: flex; gap: 6px; margin-bottom: 8px; flex-wrap: wrap;
        }
        .qh-mini-btn {
            background: var(--qh-bg-elev-2);
            border: 1px solid var(--qh-border);
            color: var(--qh-text-soft);
            padding: 5px 9px; border-radius: 7px;
            font-size: 10.5px; font-weight: 700;
            cursor: pointer; font-family: inherit;
            transition: all 0.15s;
            text-transform: uppercase; letter-spacing: 0.4px;
        }
        .qh-mini-btn:hover { color: var(--qh-text); border-color: var(--qh-border-strong); }
        .qh-selected-count {
            margin-left: auto; font-size: 11px; color: var(--qh-text-soft);
            font-weight: 600; align-self: center;
        }
        .qh-selected-count strong { color: var(--qh-success); }

        .qh-setting-row {
            display: flex; align-items: center; justify-content: space-between;
            padding: 12px 0; border-bottom: 1px solid var(--qh-border);
            gap: 12px;
        }
        .qh-setting-row:last-child { border-bottom: none; }
        .qh-setting-row > div:first-child { flex: 1; min-width: 0; }
        .qh-setting-label { font-size: 13px; color: var(--qh-text); font-weight: 500; }
        .qh-setting-desc { font-size: 11px; color: var(--qh-text-dim); margin-top: 2px; }

        .quiz-notification {
            position: fixed; top: 24px; left: 50%;
            transform: translateX(-50%) translateY(-20px);
            z-index: 2147483647;
            color: var(--qh-bg);
            padding: 12px 22px; border-radius: 12px;
            box-shadow: 0 20px 40px rgba(0,0,0,0.4);
            font-family: -apple-system, sans-serif;
            font-size: 14px; font-weight: 600;
            max-width: 80%; text-align: center; opacity: 0;
            transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
            display: flex; align-items: center; gap: 10px;
        }
        .quiz-notification.qh-show { opacity: 1; transform: translateX(-50%) translateY(0); }

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
            max-width: min(560px, 90vw); opacity: 0;
            transition: all 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
            display: flex; align-items: center; gap: 12px; cursor: pointer;
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
            margin-top: 2px; word-break: break-word; color: white;
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

        .qh-pane::-webkit-scrollbar,
        .qh-list-scroll::-webkit-scrollbar { width: 6px; }
        .qh-pane::-webkit-scrollbar-thumb,
        .qh-list-scroll::-webkit-scrollbar-thumb {
            background: var(--qh-border-strong); border-radius: 3px;
        }
        .qh-list-scroll { max-height: 320px; overflow-y: auto; padding-right: 4px; }
    `);

    /* ---------- IMAGE LIGHTBOX ---------- */
    function ensureLightbox() {
        let lb = document.getElementById('qh-img-lightbox');
        if (lb) return lb;
        lb = document.createElement('div');
        lb.id = 'qh-img-lightbox';
        lb.innerHTML = `<img alt="">`;
        lb.addEventListener('click', () => lb.classList.remove('show'));
        document.body.appendChild(lb);
        return lb;
    }
    function openLightbox(src) {
        const lb = ensureLightbox();
        lb.querySelector('img').src = src;
        lb.classList.add('show');
    }

    /* ---------- GUI ---------- */
    function createGUI() {
        const gui = document.createElement('div');
        gui.id = 'quiz-input-gui';
        gui.innerHTML = `
            <div id="quiz-gui-header">
                <div class="qh-title">
                    <span class="qh-logo">Q</span>
                    <span>Quiz AURA EZ KID!!!</span>
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

            <div class="qh-tabs-wrap">
                <button class="qh-tab-arrow left" id="qh-tab-left">‹</button>
                <div class="qh-tabs">
                    <button class="qh-tab active" data-tab="answer">⚡ Answer</button>
                    <button class="qh-tab" data-tab="study">📚 Study</button>
                    <button class="qh-tab" data-tab="flash">🎴 Cards</button>
                    <button class="qh-tab" data-tab="practice">🎯 Practice</button>
                    <button class="qh-tab" data-tab="custom">🛠 Custom</button>
                    <button class="qh-tab" data-tab="stats">📊 Stats</button>
                    <button class="qh-tab" data-tab="settings">⚙️</button>
                </div>
                <button class="qh-tab-arrow right" id="qh-tab-right">›</button>
            </div>

            <div id="quiz-gui-content">
                <div class="qh-pane active" data-pane="answer">
                    <div class="qh-input-wrap">
                        <input type="text" id="quiz-code-input" placeholder="Enter quiz code" autocomplete="off" spellcheck="false" maxlength="20">
                    </div>
                    <button class="qh-btn" id="quiz-submit-btn"><span>Load Answers</span></button>
                    <div id="quiz-status"></div>
                    <div id="quiz-answer-display" style="margin-top:12px"></div>
                </div>

                <div class="qh-pane" data-pane="study">
                    <div class="qh-btn-row" style="margin-top:0;margin-bottom:10px">
                        <button class="qh-btn qh-btn-secondary" id="qh-toggle-memory">👁 Hide Answers</button>
                        <button class="qh-btn qh-btn-secondary" id="qh-shuffle-list">🔀 Shuffle</button>
                    </div>
                    <input type="text" id="qh-search-input" placeholder="Search questions..."
                        style="width:100%;padding:9px 12px;border:1px solid var(--qh-border);border-radius:8px;background:var(--qh-bg-elev);color:var(--qh-text);font-size:12px;outline:none;box-sizing:border-box;margin-bottom:10px;font-family:inherit">
                    <div id="qh-study-list" class="qh-list-scroll"></div>
                </div>

                <div class="qh-pane" data-pane="flash">
                    <div class="qh-flashcard-controls">
                        <button class="qh-icon-btn" id="qh-flash-prev">‹</button>
                        <div class="qh-flashcard-counter" id="qh-flash-counter">0 / 0</div>
                        <button class="qh-icon-btn" id="qh-flash-next">›</button>
                        <button class="qh-icon-btn" id="qh-flash-shuffle" title="Shuffle cards">🔀</button>
                    </div>
                    <div class="qh-progress"><div class="qh-progress-bar" id="qh-flash-progress" style="width:0%"></div></div>
                    <div class="qh-flashcard" id="qh-flashcard">
                        <div class="qh-flashcard-inner">
                            <div class="qh-flashcard-face front">
                                <div class="qh-flashcard-tag">Question</div>
                                <div id="qh-flash-front-content" style="width:100%;flex:1;display:flex;flex-direction:column;justify-content:center;align-items:center;gap:6px">
                                    <div class="qh-flashcard-text" id="qh-flash-q">Load a quiz to start</div>
                                </div>
                                <div class="qh-flashcard-hint">Click to flip</div>
                            </div>
                            <div class="qh-flashcard-face back">
                                <div class="qh-flashcard-tag back" id="qh-flash-back-tag">Answer</div>
                                <div id="qh-flash-back-content" style="width:100%;flex:1;display:flex;flex-direction:column;justify-content:center"></div>
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

                <div class="qh-pane" data-pane="practice">
                    <div class="qh-subtabs">
                        <button class="qh-subtab active" data-subtab="practice">
                            <span>🎯 Practice</span>
                            <span class="qh-subtab-count" id="qh-subtab-practice-count">0</span>
                        </button>
                        <button class="qh-subtab qh-subtab-quizizz" data-subtab="quizizz">
                            <span>🎮 Quizizz</span>
                            <span class="qh-subtab-count" id="qh-subtab-quizizz-count">0</span>
                        </button>
                    </div>

                    <div class="qh-subpane active" data-subpane="practice">
                        <div class="qh-scope-toggle">
                            <button class="qh-scope-btn active" data-scope="session">Current</button>
                            <button class="qh-scope-btn" data-scope="all">All Saved</button>
                            <button class="qh-scope-btn" data-scope="wrong">
                                <span>❌ Wrong</span>
                                <span class="qh-scope-btn-count" id="qh-wrong-count">0</span>
                            </button>
                        </div>
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
                        <div id="qh-practice-body"></div>
                        <div class="qh-btn-row" id="qh-practice-controls">
                            <button class="qh-btn" id="qh-practice-start">▶ Start</button>
                            <button class="qh-btn qh-btn-secondary" id="qh-practice-skip">⏭ Skip</button>
                        </div>
                    </div>

                    <div class="qh-subpane" data-subpane="quizizz">
                        <div style="font-size:11px;color:var(--qh-text-dim);margin-bottom:10px;line-height:1.5">
                            Questions you got wrong on the actual Quizizz quiz are tracked here automatically. Retry them to clear them from this list.
                        </div>
                        <div id="qh-quizizz-wrongs-summary" style="margin-bottom:10px"></div>
                        <div id="qh-quizizz-wrongs-list" class="qh-list-scroll" style="max-height:240px;margin-bottom:10px"></div>
                        <div class="qh-btn-row">
                            <button class="qh-btn qh-btn-danger" id="qh-quizizz-retry">🔁 Retry All</button>
                            <button class="qh-btn qh-btn-secondary" id="qh-quizizz-clear">🗑 Clear</button>
                        </div>
                        <div id="qh-quizizz-practice-area" style="margin-top:12px;display:none">
                            <div class="qh-quiz-question" id="qh-qz-q"></div>
                            <div id="qh-qz-body"></div>
                            <div class="qh-btn-row" id="qh-qz-controls"></div>
                        </div>
                    </div>
                </div>

                <div class="qh-pane" data-pane="custom">
                    <div id="qh-custom-picker">
                        <div style="font-size:11px;color:var(--qh-text-dim);margin-bottom:10px;line-height:1.5">
                            Pick the questions you want to study, then choose a method.
                        </div>
                        <input type="text" id="qh-custom-search" placeholder="Search questions..."
                            style="width:100%;padding:9px 12px;border:1px solid var(--qh-border);border-radius:8px;background:var(--qh-bg-elev);color:var(--qh-text);font-size:12px;outline:none;box-sizing:border-box;margin-bottom:8px;font-family:inherit">
                        <div class="qh-custom-toolbar">
                            <button class="qh-mini-btn" id="qh-custom-select-all">All</button>
                            <button class="qh-mini-btn" id="qh-custom-select-none">None</button>
                            <button class="qh-mini-btn" id="qh-custom-select-visible">Visible</button>
                            <button class="qh-mini-btn" id="qh-custom-select-wrong">❌ Wrong</button>
                            <button class="qh-mini-btn" id="qh-custom-select-starred">⭐ Starred</button>
                            <span class="qh-selected-count"><strong id="qh-custom-sel-count">0</strong> selected</span>
                        </div>
                        <div id="qh-custom-list" class="qh-list-scroll" style="max-height:220px;margin-bottom:10px"></div>
                        <div style="font-size:10px;color:var(--qh-text-dim);text-transform:uppercase;letter-spacing:0.6px;font-weight:700;margin-bottom:6px">Method</div>
                        <div class="qh-method-toggle" style="margin-bottom:10px">
                            <button class="qh-method-btn active" data-method="practice">🎯 Practice</button>
                            <button class="qh-method-btn" data-method="flashcard">🎴 Flashcards</button>
                        </div>
                        <button class="qh-btn" id="qh-custom-start">▶ Start with Selected</button>
                    </div>
                    <div id="qh-custom-session" style="display:none">
                        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
                            <button class="qh-icon-btn" id="qh-custom-back" title="Back to selection">←</button>
                            <div style="flex:1;font-size:11px;color:var(--qh-text-dim);text-transform:uppercase;letter-spacing:0.5px;font-weight:700" id="qh-custom-mode-label"></div>
                            <button class="qh-icon-btn" id="qh-custom-shuffle" title="Shuffle">🔀</button>
                        </div>
                        <div id="qh-custom-session-body"></div>
                    </div>
                </div>

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
                            <div class="qh-stat-label">Wrongs</div>
                            <div class="qh-stat-value" id="qh-stat-wrongs" style="color:var(--qh-error)">0</div>
                            <div class="qh-stat-sub">need review</div>
                        </div>
                        <div class="qh-stat-card">
                            <div class="qh-stat-label">Session</div>
                            <div class="qh-stat-value" id="qh-stat-time" style="font-size:18px">0s</div>
                            <div class="qh-stat-sub">elapsed</div>
                        </div>
                        <div class="qh-stat-card">
                            <div class="qh-stat-label">Sessions</div>
                            <div class="qh-stat-value" id="qh-stat-sessions" style="font-size:18px">0</div>
                            <div class="qh-stat-sub">total</div>
                        </div>
                    </div>
                    <div class="qh-progress"><div class="qh-progress-bar" id="qh-stat-progress" style="width:0%"></div></div>
                    <div class="qh-btn-row">
                        <button class="qh-btn qh-btn-secondary" id="qh-export">📤 Export</button>
                        <button class="qh-btn qh-btn-secondary" id="qh-clear">🗑 Reset</button>
                    </div>
                </div>

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
                            <div class="qh-setting-label">Show question images</div>
                            <div class="qh-setting-desc">Display images attached to the question</div>
                        </div>
                        <label class="qh-switch">
                            <input type="checkbox" id="qh-images-toggle" ${GM_getValue('show-images', true) ? 'checked' : ''}>
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
                    <div class="qh-setting-row">
                        <div>
                            <div class="qh-setting-label">Track Quizizz wrongs</div>
                            <div class="qh-setting-desc">Detect wrong answers on the actual quiz page</div>
                        </div>
                        <label class="qh-switch">
                            <input type="checkbox" id="qh-track-quizizz-toggle" ${GM_getValue('track-quizizz-wrongs', true) ? 'checked' : ''}>
                            <span class="qh-switch-slider"></span>
                        </label>
                    </div>
                    <div style="margin-top:12px;padding:10px;background:var(--qh-bg-elev);border-radius:8px;font-size:11px;color:var(--qh-text-dim);line-height:1.5">
                        Toggle helper: <kbd style="background:var(--qh-bg-elev-2);padding:1px 6px;border-radius:4px;border:1px solid var(--qh-border-strong);color:var(--qh-text)">Alt+Q</kbd>
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
        const tabsWrap = element.querySelector('.qh-tabs-wrap');
        let collapsed = localStorage.getItem('quiz-helper-collapsed') === 'true';
        const apply = () => {
            if (collapsed) {
                content.classList.add('qh-collapsed');
                tabsWrap.style.display = 'none';
                btn.textContent = '+';
            } else {
                content.classList.remove('qh-collapsed');
                tabsWrap.style.display = '';
                btn.textContent = '−';
                requestAnimationFrame(updateTabArrows);
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

    function updateTabArrows() {
        const tabs = document.querySelector('.qh-tabs');
        const left = document.getElementById('qh-tab-left');
        const right = document.getElementById('qh-tab-right');
        if (!tabs || !left || !right) return;
        const canScroll = tabs.scrollWidth > tabs.clientWidth + 1;
        if (!canScroll) {
            left.classList.remove('visible');
            right.classList.remove('visible');
            return;
        }
        left.classList.toggle('visible', tabs.scrollLeft > 4);
        right.classList.toggle('visible', tabs.scrollLeft < tabs.scrollWidth - tabs.clientWidth - 4);
    }

    function switchTab(name) {
        activeTab = name;
        document.querySelectorAll('.qh-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
        document.querySelectorAll('.qh-pane').forEach(p => p.classList.toggle('active', p.dataset.pane === name));
        const activeBtn = document.querySelector(`.qh-tab[data-tab="${name}"]`);
        if (activeBtn) activeBtn.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
        if (name === 'study') renderStudyList();
        if (name === 'flash') renderFlashcard();
        if (name === 'stats') { renderStats(); ensureStatsInterval(true); } else { ensureStatsInterval(false); }
        if (name === 'practice') {
            updateWrongCount();
            updateSubtabCounts();
            if (activePracticeSubTab === 'practice') renderPractice();
            else renderQuizizzWrongsList();
        }
        if (name === 'custom') {
            if (customActive) renderCustomSession();
            else renderCustomPicker();
        }
        requestAnimationFrame(updateTabArrows);
    }

    function switchPracticeSubTab(name) {
        activePracticeSubTab = name;
        document.querySelectorAll('.qh-subtab').forEach(t => t.classList.toggle('active', t.dataset.subtab === name));
        document.querySelectorAll('.qh-subpane').forEach(p => p.classList.toggle('active', p.dataset.subpane === name));
        if (name === 'practice') renderPractice();
        else renderQuizizzWrongsList();
    }

    function ensureStatsInterval(active) {
        if (active && !statsInterval) {
            statsInterval = setInterval(renderStats, 1000);
        } else if (!active && statsInterval) {
            clearInterval(statsInterval);
            statsInterval = null;
        }
    }

    function showNotification(msg, type = 'info') {
        document.querySelectorAll('.quiz-notification').forEach(n => {
            n.classList.remove('qh-show');
            setTimeout(() => n.remove(), 300);
        });
        const colors = { info: '#fff', error: '#ef4444', warning: '#f59e0b', success: '#22c55e' };
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

    function buildImagesHtml(images) {
        if (!images || !images.length) return '';
        if (!GM_getValue('show-images', true)) return '';
        return `
            <div class="qh-q-images">
                ${images.map((src, i) => `
                    <div class="qh-q-image-wrap" data-img-src="${escapeHtml(src)}">
                        <span class="qh-img-label">Image ${images.length > 1 ? (i + 1) : ''}</span>
                        <img src="${escapeHtml(src)}" alt="Question image" loading="lazy">
                    </div>
                `).join('')}
            </div>
        `;
    }

    function showAnswerInGUI(questionText, answers, type, isTyped, images) {
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
            <div class="qh-q-text">${escapeHtml(questionText)}</div>
            ${buildImagesHtml(images)}
            <div class="qh-a-label">✓ Correct Answer${answers.length > 1 ? 's' : ''}</div>
            ${answers.map(a => `
                <div class="qh-answer-item">
                    <span class="qh-answer-check">✓</span>
                    <span>${escapeHtml(a)}</span>
                </div>`).join('')}
        `;

        // Wire up image click-to-zoom
        display.querySelectorAll('.qh-q-image-wrap').forEach(w => {
            w.onclick = () => openLightbox(w.dataset.imgSrc);
        });
    }

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
                            normalizedApiCache = apiResponse.answers.map(a => ({
                                ref: a,
                                norm: normalizeText(a.question || ''),
                                clean: normalizeText(a.question || '').replace(/[^a-z0-9]/g, ''),
                                words: normalizeText(a.question || '').split(' ').filter(w => w.length > 2)
                            }));

                            studyData.currentSession = {
                                quizCode: code,
                                seen: 0, correct: 0,
                                startTime: Date.now(),
                                questionHashes: []
                            };
                            studyData.stats.sessions++;

                            apiResponse.answers.forEach(a => {
                                if (!a.question) return;
                                const { displayTexts } = extractAnswers(a);
                                if (displayTexts.length === 0) return;
                                const allOptions = Array.isArray(a.options)
                                    ? a.options.map(getOptionText).filter(Boolean)
                                    : [];
                                const qType = getQuestionType(a);
                                const images = extractQuestionImages(a);
                                const h = hashText(a.question);
                                if (!studyData.seenQuestions[h]) {
                                    studyData.seenQuestions[h] = {
                                        question: a.question,
                                        answers: displayTexts,
                                        allOptions, qType,
                                        images,
                                        seenCount: 0, correctCount: 0, wrongCount: 0,
                                        quizizzWrongCount: 0,
                                        quizizzLastWrong: null,
                                        quizizzLastCorrect: null,
                                        lastSeen: Date.now(), difficulty: 0,
                                        starred: false, firstSeen: Date.now(),
                                        lastAnsweredCorrectly: null
                                    };
                                    studyData.stats.totalSeen++;
                                } else {
                                    studyData.seenQuestions[h].allOptions = allOptions;
                                    studyData.seenQuestions[h].qType = qType;
                                    studyData.seenQuestions[h].answers = displayTexts;
                                    if (images.length) studyData.seenQuestions[h].images = images;
                                }
                                studyData.currentSession.questionHashes.push(h);
                            });
                            saveStudyData(true);

                            log('Loaded', apiResponse.answers.length, 'questions');
                            showNotification(`Loaded ${apiResponse.answers.length} questions`, 'success');
                            updateStatus(`Ready • ${apiResponse.answers.length} questions`, 'success');
                            initializeAnswerSystem();
                            scheduleBadgeUpdate();
                        } else {
                            showNotification('Invalid response format', 'error');
                            updateStatus('Invalid format', 'error');
                        }
                    } catch (e) {
                        showNotification('Failed to parse response', 'error');
                        updateStatus('Parse error', 'error');
                        log(e);
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

    function initializeAnswerSystem() {
        if (mutationObserver) mutationObserver.disconnect();
        mutationObserver = new MutationObserver(() => {
            if (!helperEnabled) return;
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                processQuestion();
                detectQuizizzAnswerResult();
            }, 180);
        });
        mutationObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
        [0, 300, 700, 1300, 2200].forEach(d => setTimeout(processQuestion, d));
    }

    const QUESTION_SELECTORS = [
        '.question-text-color',
        '[class*="QuestionText"]','[class*="questionText"]','[class*="question-text"]',
        '[data-testid*="question"]', '.question-content',
        '[class*="prompt"]','[class*="Prompt"]','[role="heading"]'
    ];

    function findQuestionElement() {
        for (const sel of QUESTION_SELECTORS) {
            try {
                const els = document.querySelectorAll(sel);
                for (const el of els) {
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
            const { el, text: questionText } = found;
            const qhash = hashText(questionText);
            currentQuestionText = questionText;

            if (qhash === lastProcessedQuestion) {
                if (currentMatch && !document.querySelector('[data-quiz-marked="true"]')) {
                    markCorrectAnswers(currentMatch, questionText, true);
                }
                isProcessing = false; return;
            }
            lastProcessedQuestion = qhash;
            lastDetectedAnswerHash = null;
            hideFloatingAnswer();

            // Capture any images visible near the question on the page
            currentQuestionImages = extractImagesFromElement(el);

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

    function detectQuizizzAnswerResult() {
        if (!GM_getValue('track-quizizz-wrongs', true)) return;
        if (!currentQuestionText) return;
        const qhash = hashText(currentQuestionText);
        if (qhash === lastDetectedAnswerHash) return;

        const feedbackSelectors = [
            '[class*="incorrect"]', '[class*="Incorrect"]',
            '[class*="wrong-answer"]', '[class*="WrongAnswer"]',
            '[class*="correct-answer"]', '[class*="CorrectAnswer"]',
            '[class*="answer-feedback"]', '[class*="AnswerFeedback"]',
            '[class*="result-banner"]', '[class*="ResultBanner"]',
            '[data-testid*="incorrect"]', '[data-testid*="correct"]'
        ];

        let detected = null;

        for (const sel of feedbackSelectors) {
            try {
                const els = document.querySelectorAll(sel);
                for (const el of els) {
                    const r = el.getBoundingClientRect();
                    if (r.width === 0 || r.height === 0) continue;
                    const cls = (el.className || '').toString().toLowerCase();
                    const txt = (el.textContent || '').toLowerCase();
                    if (cls.includes('incorrect') || cls.includes('wrong') || txt.includes('incorrect') || txt.includes('not quite')) {
                        detected = 'wrong'; break;
                    }
                    if (cls.includes('correct') && !cls.includes('incorrect')) {
                        detected = 'correct'; break;
                    }
                }
                if (detected) break;
            } catch (e) {}
        }

        if (!detected) {
            const optionEls = document.querySelectorAll('.option, [class*="option-container"], [class*="OptionContainer"], [class*="answer-choice"]');
            for (const el of optionEls) {
                const cls = (el.className || '').toString().toLowerCase();
                if (cls.includes('selected') || cls.includes('chosen') || el.getAttribute('aria-selected') === 'true') {
                    if (cls.includes('incorrect') || cls.includes('wrong')) { detected = 'wrong'; break; }
                    if (cls.includes('correct')) { detected = 'correct'; break; }
                }
            }
        }

        if (!detected) return;

        lastDetectedAnswerHash = qhash;

        if (studyData.seenQuestions[qhash]) {
            recordQuizizzResult(qhash, detected === 'correct');
            if (detected === 'wrong') {
                showNotification('Tracked: wrong on Quizizz', 'warning');
            }
        }
    }

    function findMatch(questionText) {
        const nq = normalizeText(questionText);
        if (!nq || !normalizedApiCache.length) return null;

        for (const e of normalizedApiCache) {
            if (e.norm && nq === e.norm) return e.ref;
        }
        for (const e of normalizedApiCache) {
            if (e.norm.length > 5 && (nq.includes(e.norm) || e.norm.includes(nq))) return e.ref;
        }
        const cq = nq.replace(/[^a-z0-9]/g, '');
        if (cq.length > 3) {
            for (const e of normalizedApiCache) {
                if (e.clean && cq === e.clean) return e.ref;
            }
        }
        const words = nq.split(' ').filter(w => w.length > 2);
        if (words.length) {
            let best = null, bestScore = 0;
            const wordSet = new Set(words);
            for (const e of normalizedApiCache) {
                if (!e.words.length) continue;
                let matching = 0;
                for (const w of e.words) if (wordSet.has(w)) matching++;
                const score = matching / Math.max(words.length, e.words.length);
                if (score > bestScore) { bestScore = score; best = e.ref; }
            }
            if (bestScore >= 0.7) return best;
        }
        let fb = null, fs = 0;
        for (const e of normalizedApiCache) {
            if (!e.norm) continue;
            if (Math.abs(e.norm.length - nq.length) > Math.max(e.norm.length, nq.length) * 0.3) continue;
            const s = similarity(nq, e.norm);
            if (s > fs) { fs = s; fb = e.ref; }
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

    function extractAnswers(answer) {
        const correctTexts = [], displayTexts = [];
        const seen = new Set();
        const push = (t) => {
            if (!t) return;
            const n = normalizeText(t);
            if (seen.has(n)) return;
            seen.add(n);
            correctTexts.push(n);
            displayTexts.push(t);
        };

        const indices = getAnswerIndices(answer);
        if (indices.length > 0 && Array.isArray(answer.options)) {
            indices.forEach(i => {
                const opt = answer.options[i];
                if (opt !== undefined) push(getOptionText(opt));
            });
        }
        const directKeys = ['correctAnswer', 'correct', 'answerText', 'correctAnswers',
                            'typedAnswer', 'expectedAnswer', 'answer_text'];
        for (const k of directKeys) {
            if (answer[k] != null) {
                const arr = Array.isArray(answer[k]) ? answer[k] : [answer[k]];
                arr.forEach(item => {
                    if (typeof item === 'number' && Array.isArray(answer.options) && answer.options[item]) {
                        push(getOptionText(answer.options[item]));
                        return;
                    }
                    push(typeof item === 'object' ? getOptionText(item) : stripHtml(String(item)));
                });
            }
        }
        if (displayTexts.length === 0 && Array.isArray(answer.options)) {
            answer.options.forEach(o => {
                if (o && (o.correct === true || o.isCorrect === true)) push(getOptionText(o));
            });
        }
        if (displayTexts.length === 0 && answer.structured?.answer) {
            const v = answer.structured.answer;
            const arr = Array.isArray(v) ? v : [v];
            arr.forEach(item => {
                push(typeof item === 'object' ? getOptionText(item) : stripHtml(String(item)));
            });
        }
        return { correctTexts, displayTexts };
    }

    function markCorrectAnswers(answer, questionText, silent = false) {
        clearPreviousMarkers();
        const type = getQuestionType(answer);
        const { correctTexts, displayTexts } = extractAnswers(answer);

        // Combine API images with on-page images (dedupe)
        const apiImages = extractQuestionImages(answer);
        const merged = [];
        [...apiImages, ...currentQuestionImages].forEach(u => { if (u && !merged.includes(u)) merged.push(u); });

        if (displayTexts.length === 0) {
            log('No answer extractable', answer);
            updateStatus('Could not extract answer', 'error');
            showAnswerInGUI(questionText, ['(answer not available in API response)'], type, false, merged);
            return;
        }

        const isTyped = isTypedType(type);

        showAnswerInGUI(questionText, displayTexts, type, isTyped, merged);
        updateStatus(`Found ${displayTexts.length} answer${displayTexts.length > 1 ? 's' : ''}`, 'success');

        const allOptions = Array.isArray(answer.options)
            ? answer.options.map(getOptionText).filter(Boolean)
            : [];
        recordQuestion(hashText(questionText), questionText, displayTexts, allOptions, type, merged);
        scheduleBadgeUpdate();

        const autoHighlight = GM_getValue('auto-highlight', true);
        const marked = autoHighlight ? highlightByText(correctTexts) : 0;

        if (isTyped || marked === 0) showFloatingAnswer(displayTexts);
        if (!silent && marked > 0) {
            showNotification(`Marked ${marked} answer${marked > 1 ? 's' : ''}`, 'success');
            playBeep('success');
        } else if (!silent && isTyped) {
            playBeep('info');
        }
    }

    const HIGHLIGHT_SELECTORS = [
        '.option','[class*="option-container"]','[class*="OptionContainer"]',
        '[class*="option"]','[class*="Option"]','[data-testid*="option"]',
        '[data-testid*="Option"]','.answer-choice','[class*="answer-choice"]',
        '[class*="answer"]','[class*="Answer"]','[class*="choice"]',
        '[role="button"]','.resizeable'
    ];

    function highlightByText(correctTexts) {
        let options = [];
        for (const sel of HIGHLIGHT_SELECTORS) {
            try {
                const els = document.querySelectorAll(sel);
                if (els.length < 2 || els.length > 12) continue;
                const visible = [];
                for (const el of els) {
                    const r = el.getBoundingClientRect();
                    if (r.width > 30 && r.height > 20) visible.push(el);
                }
                if (visible.length >= 2 && visible.length <= 12) { options = visible; break; }
            } catch (e) {}
        }
        if (!options.length) return 0;
        let marked = 0;
        for (const opt of options) {
            const t = normalizeText(extractText(opt));
            if (!t) continue;
            let match = false;
            for (const ct of correctTexts) {
                if (textsMatch(t, ct)) { match = true; break; }
            }
            if (match) {
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
        }
        return marked;
    }

    /* ---------- STUDY LIST ---------- */
    function renderStudyList(filter = '') {
        const container = document.getElementById('qh-study-list');
        if (!container) return;
        const filterLower = filter.toLowerCase();
        const items = Object.entries(studyData.seenQuestions)
            .map(([h, q]) => ({ ...q, hash: h }))
            .filter(q => {
                if (!filterLower) return true;
                if (q.question.toLowerCase().includes(filterLower)) return true;
                for (const a of q.answers) if (a.toLowerCase().includes(filterLower)) return true;
                return false;
            });
        if (!items.length) {
            container.innerHTML = `<div class="qh-empty">📚<br>No questions yet.<br><span style="font-size:11px">Load a quiz to start collecting.</span></div>`;
            return;
        }
        const showImgs = GM_getValue('show-images', true);
        container.innerHTML = items.map(q => {
            const ansJoined = q.answers.join(' • ');
            const hasQuizizzWrong = q.quizizzLastWrong && !q.quizizzLastCorrect;
            const thumb = showImgs && q.images && q.images.length
                ? `<img class="qh-list-thumb" src="${escapeHtml(q.images[0])}" loading="lazy" alt="">`
                : '';
            return `
            <div class="qh-list-item ${q.wrongCount > 0 || hasQuizizzWrong ? 'has-wrongs' : ''}" data-hash="${q.hash}">
                <div class="qh-list-item-row">
                    ${thumb}
                    <div style="flex:1;min-width:0">
                        <div class="qh-list-q">${q.starred ? '⭐ ' : ''}${escapeHtml(q.question.substring(0, 120))}${q.question.length > 120 ? '…' : ''}</div>
                        <div class="qh-list-a">→ ${escapeHtml(ansJoined.substring(0, 120))}${ansJoined.length > 120 ? '…' : ''}</div>
                        <div class="qh-list-meta">
                            <span>👁 ${q.seenCount}×</span>
                            ${q.correctCount ? `<span style="color:var(--qh-success)">✓ ${q.correctCount}</span>` : ''}
                            ${q.wrongCount ? `<span class="qh-list-meta-wrong">✕ ${q.wrongCount}</span>` : ''}
                            ${hasQuizizzWrong ? `<span class="qh-list-meta-wrong">🎮 wrong</span>` : ''}
                            ${q.images && q.images.length ? `<span>🖼 ${q.images.length}</span>` : ''}
                            ${q.difficulty ? `<span>${['','😎 easy','😐 med','😓 hard'][q.difficulty]}</span>` : ''}
                        </div>
                    </div>
                </div>
            </div>`;
        }).join('');
        container.querySelectorAll('.qh-list-item').forEach(el => {
            el.onclick = () => {
                const q = studyData.seenQuestions[el.dataset.hash];
                if (!q) return;
                q.starred = !q.starred;
                saveStudyData();
                renderStudyList(filter);
            };
        });
    }

    /* ---------- FLASHCARDS ---------- */
    function getFlashcardDeck() {
        const items = Object.entries(studyData.seenQuestions).map(([h, q]) => ({ ...q, hash: h }));
        let filtered;
        if (flashcardFilter === 'hard') filtered = items.filter(q => q.difficulty === 3);
        else if (flashcardFilter === 'starred') filtered = items.filter(q => q.starred);
        else filtered = items;

        if (flashcardOrder && flashcardOrder.length) {
            const map = new Map(filtered.map(q => [q.hash, q]));
            const ordered = [];
            for (const h of flashcardOrder) {
                if (map.has(h)) {
                    ordered.push(map.get(h));
                    map.delete(h);
                }
            }
            for (const q of map.values()) ordered.push(q);
            return ordered;
        }
        return filtered;
    }

    function renderFlashcard() {
        const deck = getFlashcardDeck();
        const card = document.getElementById('qh-flashcard');
        const qEl = document.getElementById('qh-flash-q');
        const frontContent = document.getElementById('qh-flash-front-content');
        const backTag = document.getElementById('qh-flash-back-tag');
        const backContent = document.getElementById('qh-flash-back-content');
        const counter = document.getElementById('qh-flash-counter');
        const progress = document.getElementById('qh-flash-progress');
        const starBtn = document.getElementById('qh-flash-star');
        if (!deck.length) {
            frontContent.innerHTML = `<div class="qh-flashcard-text" id="qh-flash-q">No cards yet</div>`;
            backContent.innerHTML = '<div class="qh-flashcard-text">—</div>';
            backTag.textContent = 'Answer';
            counter.textContent = '0 / 0';
            progress.style.width = '0%';
            flashcardIndex = 0;
            return;
        }
        flashcardIndex = ((flashcardIndex % deck.length) + deck.length) % deck.length;
        const item = deck[flashcardIndex];

        const showImgs = GM_getValue('show-images', true);
        const imgHtml = (showImgs && item.images && item.images.length)
            ? `<img class="qh-flashcard-img" src="${escapeHtml(item.images[0])}" alt="" loading="lazy">`
            : '';
        frontContent.innerHTML = `
            ${imgHtml}
            <div class="qh-flashcard-text" id="qh-flash-q">${escapeHtml(item.question)}</div>
        `;

        counter.textContent = `${flashcardIndex + 1} / ${deck.length}`;
        progress.style.width = (((flashcardIndex + 1) / deck.length) * 100) + '%';

        const answers = item.answers || [];
        const isMulti = answers.length > 1;
        backTag.textContent = isMulti ? `${answers.length} Correct Answers` : 'Answer';

        if (answers.length === 0) {
            backContent.innerHTML = '<div class="qh-flashcard-text">—</div>';
        } else if (answers.length === 1) {
            backContent.innerHTML = `<div class="qh-flashcard-text">${escapeHtml(answers[0])}</div>`;
        } else {
            backContent.innerHTML = `
                <div class="qh-flash-multi-label">All of these are correct</div>
                <div class="qh-flash-answers">
                    ${answers.map((a, i) => `
                        <div class="qh-flash-answer-section">
                            <span class="qh-flash-answer-num">${i + 1}</span>
                            <span>${escapeHtml(a)}</span>
                        </div>`).join('')}
                </div>`;
        }
        card.classList.toggle('flipped', flashcardFlipped);
        if (starBtn) starBtn.textContent = item.starred ? '⭐ Starred' : '☆ Star';
    }

    function shuffleFlashcards() {
        const deck = getFlashcardDeck();
        if (deck.length < 2) {
            showNotification('Need at least 2 cards to shuffle', 'info');
            return;
        }
        flashcardOrder = shuffle(deck.map(q => q.hash));
        flashcardIndex = 0;
        flashcardFlipped = false;
        renderFlashcard();
        showNotification('Cards shuffled', 'success');
        playBeep('info');
    }

    /* ---------- PRACTICE MODE ---------- */
    function buildPracticeDeck() {
        if (practiceScope === 'session') {
            if (studyData.currentSession.questionHashes?.length) {
                return studyData.currentSession.questionHashes
                    .map(h => studyData.seenQuestions[h])
                    .filter(Boolean);
            }
            return [];
        }
        if (practiceScope === 'wrong') {
            return Object.values(studyData.seenQuestions)
                .filter(q => q.wrongCount > 0 && q.lastAnsweredCorrectly === null);
        }
        return Object.values(studyData.seenQuestions);
    }

    function getQuizizzWrongList() {
        return Object.entries(studyData.seenQuestions)
            .map(([h, q]) => ({ ...q, hash: h }))
            .filter(q => q.quizizzLastWrong && !q.quizizzLastCorrect);
    }

    function updateWrongCount() {
        const cnt = Object.values(studyData.seenQuestions)
            .filter(q => q.wrongCount > 0 && q.lastAnsweredCorrectly === null).length;
        const el = document.getElementById('qh-wrong-count');
        if (el) el.textContent = cnt;
    }

    function updateSubtabCounts() {
        const practiceWrongs = Object.values(studyData.seenQuestions)
            .filter(q => q.wrongCount > 0 && q.lastAnsweredCorrectly === null).length;
        const quizizzWrongs = getQuizizzWrongList().length;
        const pEl = document.getElementById('qh-subtab-practice-count');
        const qEl = document.getElementById('qh-subtab-quizizz-count');
        if (pEl) pEl.textContent = practiceWrongs;
        if (qEl) {
            qEl.textContent = quizizzWrongs;
            qEl.classList.toggle('has', quizizzWrongs > 0);
        }
    }

    function startPracticeWithDeck(deck) {
        practiceDeck = shuffle(deck);
        quizModeIndex = 0;
        quizModeScore = 0;
        quizModeAnswered = false;
        practiceWrongHashes = new Set();
        renderPractice();
    }

    function questionHtmlWithImage(q) {
        const showImgs = GM_getValue('show-images', true);
        const img = (showImgs && q.images && q.images.length)
            ? `<img class="qh-q-inline-img" src="${escapeHtml(q.images[0])}" alt="" loading="lazy">`
            : '';
        return `${escapeHtml(q.question)}${img}`;
    }

    function renderPractice(reset = false) {
        if (reset) {
            quizModeIndex = 0; quizModeScore = 0; quizModeAnswered = false;
            practiceWrongHashes = new Set();
            practiceDeck = shuffle(buildPracticeDeck());
        }
        const items = practiceDeck;
        const numEl = document.getElementById('qh-practice-num');
        const scoreEl = document.getElementById('qh-practice-score');
        const accEl = document.getElementById('qh-practice-acc');
        const qEl = document.getElementById('qh-practice-q');
        const body = document.getElementById('qh-practice-body');
        const controls = document.getElementById('qh-practice-controls');

        controls.innerHTML = `
            <button class="qh-btn" id="qh-practice-start">▶ ${items.length ? 'Restart' : 'Start'}</button>
            <button class="qh-btn qh-btn-secondary" id="qh-practice-skip">⏭ Skip</button>
        `;
        document.getElementById('qh-practice-start').onclick = () => renderPractice(true);
        document.getElementById('qh-practice-skip').onclick = () => {
            if (quizModeIndex < practiceDeck.length) {
                quizModeIndex++;
                quizModeAnswered = false;
                renderPractice();
            }
        };

        if (!items.length) {
            const msg = practiceScope === 'session'
                ? 'No questions in current quiz yet. Load a quiz first.'
                : practiceScope === 'wrong'
                ? 'No wrong answers yet! Run practice and miss a few to populate this list.'
                : 'No saved questions. Load a quiz to collect some.';
            qEl.textContent = msg;
            body.innerHTML = '';
            numEl.textContent = '0/0';
            scoreEl.textContent = '0';
            accEl.textContent = '—';
            return;
        }
        if (quizModeIndex >= items.length) {
            renderPracticeEndScreen(items.length);
            return;
        }

        const q = items[quizModeIndex];
        numEl.textContent = `${quizModeIndex + 1}/${items.length}`;
        scoreEl.textContent = quizModeScore;
        accEl.textContent = quizModeIndex ? Math.round((quizModeScore / quizModeIndex) * 100) + '%' : '—';
        qEl.innerHTML = questionHtmlWithImage(q);

        const correctAnswers = q.answers || [];
        const allOptions = q.allOptions || [];

        const explicitlyTyped = isTypedType(q.qType);
        const hasOptions = allOptions.length >= 2;
        const isTyped = explicitlyTyped || !hasOptions;
        const isMulti = isMultiSelect(q.qType) || correctAnswers.length > 1;

        quizModeAnswered = false;

        if (isTyped) {
            renderTypedQuestion(body, correctAnswers, q.hash || hashText(q.question), 'practice');
        } else if (isMulti) {
            renderMultiSelectQuestion(body, correctAnswers, allOptions, items, q, 'practice');
        } else {
            renderSingleChoiceQuestion(body, correctAnswers, allOptions, items, q, 'practice');
        }
    }

    function renderPracticeEndScreen(total) {
        const acc = total ? Math.round((quizModeScore / total) * 100) : 0;
        const icon = acc >= 90 ? '🏆' : acc >= 70 ? '🎉' : acc >= 50 ? '💪' : '📖';
        const wrongHashList = [...practiceWrongHashes];
        const wrongQs = wrongHashList.map(h => studyData.seenQuestions[h]).filter(Boolean);

        const qEl = document.getElementById('qh-practice-q');
        const body = document.getElementById('qh-practice-body');
        const controls = document.getElementById('qh-practice-controls');

        qEl.innerHTML = `
            <div class="qh-practice-end">
                <div class="qh-practice-end-icon">${icon}</div>
                <div class="qh-practice-end-title">Practice Complete</div>
                <div class="qh-practice-end-score">${quizModeScore} / ${total} correct (${acc}%)</div>
            </div>
        `;

        if (wrongQs.length) {
            body.innerHTML = `
                <div class="qh-practice-end-wrongs">
                    <div class="qh-practice-end-wrongs-title">❌ Got ${wrongQs.length} wrong</div>
                    <div class="qh-practice-end-wrongs-list">
                        ${wrongQs.map((q, i) => `<div style="margin:3px 0">${i + 1}. ${escapeHtml(q.question.substring(0, 80))}${q.question.length > 80 ? '…' : ''}</div>`).join('')}
                    </div>
                </div>
            `;
            controls.innerHTML = `
                <button class="qh-btn qh-btn-danger" id="qh-retry-wrong">🔁 Retry Wrong (${wrongQs.length})</button>
                <button class="qh-btn qh-btn-secondary" id="qh-practice-restart">▶ New Round</button>
            `;
            document.getElementById('qh-retry-wrong').onclick = () => {
                startPracticeWithDeck(wrongQs);
            };
            document.getElementById('qh-practice-restart').onclick = () => renderPractice(true);
        } else {
            body.innerHTML = `<div style="text-align:center;color:var(--qh-success);font-size:13px;font-weight:600;padding:8px">🌟 Perfect score! No wrongs to retry.</div>`;
            controls.innerHTML = `
                <button class="qh-btn" id="qh-practice-restart">▶ New Round</button>
            `;
            document.getElementById('qh-practice-restart').onclick = () => renderPractice(true);
        }
        updateWrongCount();
        updateSubtabCounts();
    }

    function advancePractice() {
        quizModeIndex++;
        quizModeAnswered = false;
        renderPractice();
    }

    function renderTypedQuestion(body, correctAnswers, qHash, mode) {
        body.innerHTML = `
            <input type="text" class="qh-type-input" id="qh-type-input" placeholder="Type your answer..." autocomplete="off" spellcheck="false">
            <div class="qh-type-feedback" id="qh-type-feedback"></div>
            <button class="qh-btn" id="qh-type-submit" style="margin-top:8px">Check Answer</button>
        `;
        const inp = body.querySelector('#qh-type-input');
        const fb = body.querySelector('#qh-type-feedback');
        const submitBtn = body.querySelector('#qh-type-submit');
        setTimeout(() => inp.focus(), 50);

        const submit = () => {
            if (quizModeAnswered) return;
            const val = inp.value.trim();
            if (!val) return;
            quizModeAnswered = true;
            const isCorrect = correctAnswers.some(a => textsMatch(val, a));
            if (isCorrect) {
                inp.classList.add('correct');
                fb.className = 'qh-type-feedback show correct';
                fb.innerHTML = `<strong>✓ Correct!</strong> ${escapeHtml(correctAnswers.join(' • '))}`;
                quizModeScore++;
                playBeep('success');
            } else {
                inp.classList.add('wrong');
                fb.className = 'qh-type-feedback show wrong';
                fb.innerHTML = `<strong style="color:var(--qh-error)">✕ Wrong.</strong> Answer: <strong>${escapeHtml(correctAnswers.join(' • '))}</strong>`;
                playBeep('error');
            }
            recordPracticeResult(qHash, isCorrect);
            if (mode === 'quizizz' && isCorrect) {
                recordQuizizzResult(qHash, true);
            }
            inp.disabled = true;
            submitBtn.disabled = true;
            const advance = mode === 'quizizz' ? advanceQuizizzPractice
                          : mode === 'custom' ? advanceCustomPractice
                          : advancePractice;
            setTimeout(advance, 1800);
        };
        submitBtn.onclick = submit;
        inp.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
    }

    function renderSingleChoiceQuestion(body, correctAnswers, allOptions, allItems, currentQ, mode) {
        const correctSet = new Set(correctAnswers.map(normalizeText));
        const correctAns = correctAnswers[0];
        const wrongOptions = allOptions.filter(o => !correctSet.has(normalizeText(o)));
        const distractors = shuffle(wrongOptions).slice(0, 3);

        if (distractors.length < 3) {
            const others = allItems
                .filter(o => o !== currentQ)
                .flatMap(o => (o.allOptions || []).filter(opt => {
                    const n = normalizeText(opt);
                    return !correctSet.has(n) && !distractors.some(d => normalizeText(d) === n);
                }));
            const pool = shuffle(others);
            for (const pick of pool) {
                if (distractors.length >= 3) break;
                if (!distractors.some(d => normalizeText(d) === normalizeText(pick))) {
                    distractors.push(pick);
                }
            }
        }

        const choices = shuffle([correctAns, ...distractors]);
        const qHash = currentQ.hash || hashText(currentQ.question);

        body.innerHTML = `<div class="qh-quiz-options">${
            choices.map(o => `<button class="qh-quiz-option" data-opt="${escapeHtml(o)}">${escapeHtml(o)}</button>`).join('')
        }</div>`;
        body.querySelectorAll('.qh-quiz-option').forEach(btn => {
            btn.onclick = () => {
                if (quizModeAnswered) return;
                quizModeAnswered = true;
                const picked = btn.dataset.opt;
                const isCorrect = textsMatch(picked, correctAns);
                if (isCorrect) {
                    btn.classList.add('correct');
                    quizModeScore++;
                    playBeep('success');
                } else {
                    btn.classList.add('wrong');
                    body.querySelectorAll('.qh-quiz-option').forEach(b => {
                        if (textsMatch(b.dataset.opt, correctAns)) b.classList.add('correct');
                    });
                    playBeep('error');
                }
                recordPracticeResult(qHash, isCorrect);
                if (mode === 'quizizz' && isCorrect) {
                    recordQuizizzResult(qHash, true);
                }
                body.querySelectorAll('.qh-quiz-option').forEach(b => b.disabled = true);
                const advance = mode === 'quizizz' ? advanceQuizizzPractice
                              : mode === 'custom' ? advanceCustomPractice
                              : advancePractice;
                setTimeout(advance, 1100);
            };
        });
    }

    function renderMultiSelectQuestion(body, correctAnswers, allOptions, allItems, currentQ, mode) {
        const correctSet = new Set(correctAnswers.map(normalizeText));
        const wrongOptions = allOptions.filter(o => !correctSet.has(normalizeText(o)));

        let choices;
        if (allOptions.length >= correctAnswers.length + 1) {
            choices = shuffle(allOptions);
        } else {
            const distractors = [...wrongOptions];
            const others = allItems
                .filter(o => o !== currentQ)
                .flatMap(o => (o.allOptions || []).filter(opt => {
                    const n = normalizeText(opt);
                    return !correctSet.has(n) && !distractors.some(d => normalizeText(d) === n);
                }));
            const targetTotal = Math.max(4, correctAnswers.length + 2);
            const pool = shuffle(others);
            for (const pick of pool) {
                if (distractors.length >= targetTotal - correctAnswers.length) break;
                if (!distractors.some(d => normalizeText(d) === normalizeText(pick))) {
                    distractors.push(pick);
                }
            }
            choices = shuffle([...correctAnswers, ...distractors]);
        }

        const qHash = currentQ.hash || hashText(currentQ.question);

        body.innerHTML = `
            <div style="font-size:11px;color:var(--qh-text-dim);margin-bottom:8px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px">Select all ${correctAnswers.length} correct answers</div>
            <div class="qh-quiz-options" id="qh-multi-opts">${
                choices.map(o => `<button class="qh-quiz-option" data-opt="${escapeHtml(o)}"><span class="qh-quiz-checkbox"></span><span>${escapeHtml(o)}</span></button>`).join('')
            }</div>
            <button class="qh-btn" id="qh-multi-submit" style="margin-top:10px">Submit Selection</button>
        `;

        const selected = new Set();
        body.querySelectorAll('.qh-quiz-option').forEach(btn => {
            btn.onclick = () => {
                if (quizModeAnswered) return;
                const val = btn.dataset.opt;
                if (selected.has(val)) {
                    selected.delete(val);
                    btn.classList.remove('selected');
                    btn.querySelector('.qh-quiz-checkbox').textContent = '';
                } else {
                    selected.add(val);
                    btn.classList.add('selected');
                    btn.querySelector('.qh-quiz-checkbox').textContent = '✓';
                }
            };
        });

        body.querySelector('#qh-multi-submit').onclick = () => {
            if (quizModeAnswered) return;
            if (selected.size === 0) {
                showNotification('Pick at least one option', 'warning');
                return;
            }
            quizModeAnswered = true;
            const selectedArr = [...selected];
            const allCorrect = correctAnswers.every(c => selectedArr.some(s => textsMatch(s, c)))
                            && selectedArr.every(s => correctAnswers.some(c => textsMatch(s, c)));

            body.querySelectorAll('.qh-quiz-option').forEach(btn => {
                const val = btn.dataset.opt;
                const isCorrectOpt = correctAnswers.some(c => textsMatch(val, c));
                const wasPicked = selected.has(val);
                btn.classList.remove('selected');
                btn.disabled = true;
                if (isCorrectOpt) {
                    btn.classList.add('correct');
                    btn.querySelector('.qh-quiz-checkbox').textContent = '✓';
                } else if (wasPicked) {
                    btn.classList.add('wrong');
                    btn.querySelector('.qh-quiz-checkbox').textContent = '✕';
                }
            });
            body.querySelector('#qh-multi-submit').disabled = true;
            recordPracticeResult(qHash, allCorrect);
            if (mode === 'quizizz' && allCorrect) {
                recordQuizizzResult(qHash, true);
            }
            if (allCorrect) {
                quizModeScore++;
                playBeep('success');
            } else {
                playBeep('error');
            }
            const advance = mode === 'quizizz' ? advanceQuizizzPractice
                          : mode === 'custom' ? advanceCustomPractice
                          : advancePractice;
            setTimeout(advance, 1600);
        };
    }

    /* ---------- QUIZIZZ WRONGS SUB-TAB ---------- */
    let quizizzPracticeDeck = [];
    let quizizzPracticeIndex = 0;
    let quizizzPracticeScore = 0;

    function renderQuizizzWrongsList() {
        const list = document.getElementById('qh-quizizz-wrongs-list');
        const summary = document.getElementById('qh-quizizz-wrongs-summary');
        const practiceArea = document.getElementById('qh-quizizz-practice-area');
        if (!list) return;
        if (practiceArea) practiceArea.style.display = 'none';

        const wrongs = getQuizizzWrongList();
        summary.innerHTML = `
            <div class="qh-stats-grid" style="grid-template-columns:1fr 1fr;margin-bottom:0">
                <div class="qh-stat-card" style="padding:10px">
                    <div class="qh-stat-label">Wrong on Quizizz</div>
                    <div class="qh-stat-value" style="font-size:20px;color:var(--qh-error)">${wrongs.length}</div>
                </div>
                <div class="qh-stat-card" style="padding:10px">
                    <div class="qh-stat-label">Total Tracked</div>
                    <div class="qh-stat-value" style="font-size:20px">${
                        Object.values(studyData.seenQuestions).filter(q => q.quizizzWrongCount > 0).length
                    }</div>
                </div>
            </div>
        `;

        if (!wrongs.length) {
            list.innerHTML = `<div class="qh-empty">🎮<br>No wrong answers from Quizizz yet.<br><span style="font-size:11px">Play a quiz — any wrong answers will show here.</span></div>`;
            return;
        }

        const showImgs = GM_getValue('show-images', true);
        list.innerHTML = wrongs.map(q => {
            const ansJoined = (q.answers || []).join(' • ');
            const when = q.quizizzLastWrong ? new Date(q.quizizzLastWrong).toLocaleString() : '';
            const thumb = showImgs && q.images && q.images.length
                ? `<img class="qh-list-thumb" src="${escapeHtml(q.images[0])}" loading="lazy" alt="">`
                : '';
            return `
            <div class="qh-list-item has-wrongs" data-hash="${q.hash}">
                <div class="qh-list-item-row">
                    ${thumb}
                    <div style="flex:1;min-width:0">
                        <div class="qh-list-q">${escapeHtml(q.question.substring(0, 120))}${q.question.length > 120 ? '…' : ''}</div>
                        <div class="qh-list-a">→ ${escapeHtml(ansJoined.substring(0, 120))}${ansJoined.length > 120 ? '…' : ''}</div>
                        <div class="qh-list-meta">
                            <span class="qh-list-meta-wrong">✕ ${q.quizizzWrongCount}× wrong</span>
                            ${when ? `<span>${escapeHtml(when)}</span>` : ''}
                        </div>
                    </div>
                </div>
            </div>`;
        }).join('');

        list.querySelectorAll('.qh-list-item').forEach(el => {
            el.onclick = () => {
                if (!confirm('Mark this question as resolved (remove from Quizizz wrongs)?')) return;
                const q = studyData.seenQuestions[el.dataset.hash];
                if (q) {
                    q.quizizzLastWrong = null;
                    q.quizizzLastCorrect = Date.now();
                    saveStudyData();
                    renderQuizizzWrongsList();
                    updateSubtabCounts();
                    updateTabBadges();
                }
            };
        });
    }

    function startQuizizzRetry() {
        const wrongs = getQuizizzWrongList();
        if (!wrongs.length) {
            showNotification('No wrong answers to retry', 'info');
            return;
        }
        quizizzPracticeDeck = shuffle(wrongs);
        quizizzPracticeIndex = 0;
        quizizzPracticeScore = 0;
        document.getElementById('qh-quizizz-wrongs-list').style.display = 'none';
        document.getElementById('qh-quizizz-wrongs-summary').style.display = 'none';
        document.getElementById('qh-quizizz-practice-area').style.display = 'block';
        renderQuizizzPractice();
    }

    function advanceQuizizzPractice() {
        quizizzPracticeIndex++;
        quizModeAnswered = false;
        renderQuizizzPractice();
    }

    function renderQuizizzPractice() {
        const qEl = document.getElementById('qh-qz-q');
        const body = document.getElementById('qh-qz-body');
        const controls = document.getElementById('qh-qz-controls');

        if (quizizzPracticeIndex >= quizizzPracticeDeck.length) {
            const total = quizizzPracticeDeck.length;
            const acc = total ? Math.round((quizizzPracticeScore / total) * 100) : 0;
            const icon = acc >= 90 ? '🏆' : acc >= 70 ? '🎉' : acc >= 50 ? '💪' : '📖';
            qEl.innerHTML = `
                <div class="qh-practice-end">
                    <div class="qh-practice-end-icon">${icon}</div>
                    <div class="qh-practice-end-title">Retry Complete</div>
                    <div class="qh-practice-end-score">${quizizzPracticeScore} / ${total} correct (${acc}%)</div>
                </div>`;
            body.innerHTML = '';
            controls.innerHTML = `<button class="qh-btn qh-btn-secondary" id="qh-qz-back">← Back to list</button>`;
            document.getElementById('qh-qz-back').onclick = () => {
                document.getElementById('qh-quizizz-wrongs-list').style.display = '';
                document.getElementById('qh-quizizz-wrongs-summary').style.display = '';
                renderQuizizzWrongsList();
                updateSubtabCounts();
                updateTabBadges();
            };
            return;
        }

        const q = quizizzPracticeDeck[quizizzPracticeIndex];
        qEl.innerHTML = `<div style="font-size:10px;color:var(--qh-error);font-weight:700;letter-spacing:0.5px;text-transform:uppercase;margin-bottom:6px">Quizizz Wrong • ${quizizzPracticeIndex + 1}/${quizizzPracticeDeck.length}</div>${questionHtmlWithImage(q)}`;

        controls.innerHTML = `
            <button class="qh-btn qh-btn-secondary" id="qh-qz-skip">⏭ Skip</button>
            <button class="qh-btn qh-btn-secondary" id="qh-qz-back">← Back</button>
        `;
        document.getElementById('qh-qz-skip').onclick = advanceQuizizzPractice;
        document.getElementById('qh-qz-back').onclick = () => {
            document.getElementById('qh-quizizz-wrongs-list').style.display = '';
            document.getElementById('qh-quizizz-wrongs-summary').style.display = '';
            renderQuizizzWrongsList();
        };

        const correctAnswers = q.answers || [];
        const allOptions = q.allOptions || [];
        const explicitlyTyped = isTypedType(q.qType);
        const hasOptions = allOptions.length >= 2;
        const isTyped = explicitlyTyped || !hasOptions;
        const isMulti = isMultiSelect(q.qType) || correctAnswers.length > 1;

        const prevScore = quizModeScore;
        quizModeScore = quizizzPracticeScore;
        quizModeAnswered = false;

        const allItems = quizizzPracticeDeck;
        if (isTyped) {
            renderTypedQuestion(body, correctAnswers, q.hash, 'quizizz');
        } else if (isMulti) {
            renderMultiSelectQuestion(body, correctAnswers, allOptions, allItems, q, 'quizizz');
        } else {
            renderSingleChoiceQuestion(body, correctAnswers, allOptions, allItems, q, 'quizizz');
        }

        setTimeout(() => {
            const syncScore = setInterval(() => {
                if (quizModeAnswered) {
                    quizizzPracticeScore = quizModeScore;
                    quizModeScore = prevScore;
                    clearInterval(syncScore);
                }
            }, 100);
        }, 50);
    }

    /* ---------- CUSTOM TAB ---------- */
    function getCustomFilteredItems() {
        const filterLower = customSearch.toLowerCase();
        return Object.entries(studyData.seenQuestions)
            .map(([h, q]) => ({ ...q, hash: h }))
            .filter(q => {
                if (!filterLower) return true;
                if (q.question.toLowerCase().includes(filterLower)) return true;
                for (const a of q.answers) if (a.toLowerCase().includes(filterLower)) return true;
                return false;
            });
    }

    function updateCustomSelCount() {
        const el = document.getElementById('qh-custom-sel-count');
        if (el) el.textContent = customSelected.size;
        const startBtn = document.getElementById('qh-custom-start');
        if (startBtn) {
            startBtn.disabled = customSelected.size === 0;
            startBtn.innerHTML = customSelected.size
                ? `▶ Start with ${customSelected.size} question${customSelected.size > 1 ? 's' : ''}`
                : '▶ Start with Selected';
        }
    }

    function renderCustomPicker() {
        const picker = document.getElementById('qh-custom-picker');
        const session = document.getElementById('qh-custom-session');
        if (picker) picker.style.display = '';
        if (session) session.style.display = 'none';

        const list = document.getElementById('qh-custom-list');
        if (!list) return;
        const items = getCustomFilteredItems();

        if (!items.length) {
            list.innerHTML = `<div class="qh-empty">📚<br>${
                Object.keys(studyData.seenQuestions).length
                    ? 'No questions match your search.'
                    : 'No questions yet. Load a quiz first.'
            }</div>`;
            updateCustomSelCount();
            return;
        }

        list.innerHTML = items.map(q => {
            const ansJoined = q.answers.join(' • ');
            const isSel = customSelected.has(q.hash);
            return `
            <div class="qh-custom-item ${isSel ? 'selected' : ''}" data-hash="${q.hash}">
                <div class="qh-custom-checkbox">${isSel ? '✓' : ''}</div>
                <div class="qh-custom-item-body">
                    <div class="qh-custom-q">${q.starred ? '⭐ ' : ''}${q.images && q.images.length ? '🖼 ' : ''}${escapeHtml(q.question.substring(0, 100))}${q.question.length > 100 ? '…' : ''}</div>
                    <div class="qh-custom-a">→ ${escapeHtml(ansJoined.substring(0, 100))}${ansJoined.length > 100 ? '…' : ''}</div>
                </div>
            </div>`;
        }).join('');

        list.querySelectorAll('.qh-custom-item').forEach(el => {
            el.onclick = () => {
                const h = el.dataset.hash;
                if (customSelected.has(h)) customSelected.delete(h);
                else customSelected.add(h);
                el.classList.toggle('selected');
                el.querySelector('.qh-custom-checkbox').textContent = customSelected.has(h) ? '✓' : '';
                updateCustomSelCount();
            };
        });

        updateCustomSelCount();
    }

    function startCustomSession() {
        if (customSelected.size === 0) {
            showNotification('Select at least one question', 'warning');
            return;
        }
        customDeck = [...customSelected]
            .map(h => ({ ...studyData.seenQuestions[h], hash: h }))
            .filter(q => q && q.question);
        if (!customDeck.length) {
            showNotification('Selected questions not found', 'error');
            return;
        }
        customDeck = shuffle(customDeck);
        customMode = customMethod;
        customActive = true;
        customFlashIndex = 0;
        customFlashFlipped = false;
        quizModeIndex = 0;
        quizModeScore = 0;
        quizModeAnswered = false;
        practiceWrongHashes = new Set();
        renderCustomSession();
    }

    function exitCustomSession() {
        customActive = false;
        customMode = null;
        customDeck = [];
        renderCustomPicker();
    }

    function renderCustomSession() {
        const picker = document.getElementById('qh-custom-picker');
        const session = document.getElementById('qh-custom-session');
        if (picker) picker.style.display = 'none';
        if (session) session.style.display = '';

        const label = document.getElementById('qh-custom-mode-label');
        if (label) label.textContent = customMode === 'flashcard'
            ? `🎴 Flashcards • ${customDeck.length}`
            : `🎯 Practice • ${customDeck.length}`;

        if (customMode === 'flashcard') renderCustomFlashcard();
        else renderCustomPractice();
    }

    function renderCustomFlashcard() {
        const body = document.getElementById('qh-custom-session-body');
        if (!body) return;

        if (!customDeck.length) {
            body.innerHTML = `<div class="qh-empty">No cards.</div>`;
            return;
        }

        customFlashIndex = ((customFlashIndex % customDeck.length) + customDeck.length) % customDeck.length;
        const item = customDeck[customFlashIndex];
        const answers = item.answers || [];
        const isMulti = answers.length > 1;
        const backTag = isMulti ? `${answers.length} Correct Answers` : 'Answer';

        let backInner;
        if (answers.length === 0) {
            backInner = '<div class="qh-flashcard-text">—</div>';
        } else if (answers.length === 1) {
            backInner = `<div class="qh-flashcard-text">${escapeHtml(answers[0])}</div>`;
        } else {
            backInner = `
                <div class="qh-flash-multi-label">All of these are correct</div>
                <div class="qh-flash-answers">
                    ${answers.map((a, i) => `
                        <div class="qh-flash-answer-section">
                            <span class="qh-flash-answer-num">${i + 1}</span>
                            <span>${escapeHtml(a)}</span>
                        </div>`).join('')}
                </div>`;
        }

        const showImgs = GM_getValue('show-images', true);
        const imgHtml = (showImgs && item.images && item.images.length)
            ? `<img class="qh-flashcard-img" src="${escapeHtml(item.images[0])}" alt="" loading="lazy">`
            : '';

        body.innerHTML = `
            <div class="qh-flashcard-controls">
                <button class="qh-icon-btn" id="qh-cf-prev">‹</button>
                <div class="qh-flashcard-counter">${customFlashIndex + 1} / ${customDeck.length}</div>
                <button class="qh-icon-btn" id="qh-cf-next">›</button>
            </div>
            <div class="qh-progress"><div class="qh-progress-bar" style="width:${((customFlashIndex + 1) / customDeck.length) * 100}%"></div></div>
            <div class="qh-flashcard ${customFlashFlipped ? 'flipped' : ''}" id="qh-cf-card">
                <div class="qh-flashcard-inner">
                    <div class="qh-flashcard-face front">
                        <div class="qh-flashcard-tag">Question</div>
                        <div style="width:100%;flex:1;display:flex;flex-direction:column;justify-content:center;align-items:center;gap:6px">
                            ${imgHtml}
                            <div class="qh-flashcard-text">${escapeHtml(item.question)}</div>
                        </div>
                        <div class="qh-flashcard-hint">Click to flip</div>
                    </div>
                    <div class="qh-flashcard-face back">
                        <div class="qh-flashcard-tag back">${escapeHtml(backTag)}</div>
                        <div style="width:100%;flex:1;display:flex;flex-direction:column;justify-content:center">${backInner}</div>
                        <div class="qh-flashcard-hint">Click to flip back</div>
                    </div>
                </div>
            </div>
        `;

        document.getElementById('qh-cf-card').onclick = () => {
            customFlashFlipped = !customFlashFlipped;
            renderCustomFlashcard();
        };
        document.getElementById('qh-cf-prev').onclick = (e) => {
            e.stopPropagation(); customFlashIndex--; customFlashFlipped = false; renderCustomFlashcard();
        };
        document.getElementById('qh-cf-next').onclick = (e) => {
            e.stopPropagation(); customFlashIndex++; customFlashFlipped = false; renderCustomFlashcard();
        };
    }

    function renderCustomPractice() {
        const body = document.getElementById('qh-custom-session-body');
        if (!body) return;

        if (quizModeIndex >= customDeck.length) {
            const total = customDeck.length;
            const acc = total ? Math.round((quizModeScore / total) * 100) : 0;
            const icon = acc >= 90 ? '🏆' : acc >= 70 ? '🎉' : acc >= 50 ? '💪' : '📖';
            const wrongQs = [...practiceWrongHashes].map(h => studyData.seenQuestions[h]).filter(Boolean);

            body.innerHTML = `
                <div class="qh-quiz-question">
                    <div class="qh-practice-end">
                        <div class="qh-practice-end-icon">${icon}</div>
                        <div class="qh-practice-end-title">Custom Practice Complete</div>
                        <div class="qh-practice-end-score">${quizModeScore} / ${total} correct (${acc}%)</div>
                    </div>
                </div>
                ${wrongQs.length ? `
                    <div class="qh-practice-end-wrongs">
                        <div class="qh-practice-end-wrongs-title">❌ Got ${wrongQs.length} wrong</div>
                        <div class="qh-practice-end-wrongs-list">
                            ${wrongQs.map((q, i) => `<div style="margin:3px 0">${i + 1}. ${escapeHtml(q.question.substring(0, 80))}${q.question.length > 80 ? '…' : ''}</div>`).join('')}
                        </div>
                    </div>` : `<div style="text-align:center;color:var(--qh-success);font-size:13px;font-weight:600;padding:8px">🌟 Perfect score!</div>`}
                <div class="qh-btn-row">
                    ${wrongQs.length ? `<button class="qh-btn qh-btn-danger" id="qh-cp-retry-wrong">🔁 Retry Wrong (${wrongQs.length})</button>` : ''}
                    <button class="qh-btn" id="qh-cp-restart">▶ New Round</button>
                </div>
            `;
            const retryBtn = document.getElementById('qh-cp-retry-wrong');
            if (retryBtn) retryBtn.onclick = () => {
                customDeck = shuffle(wrongQs);
                quizModeIndex = 0;
                quizModeScore = 0;
                quizModeAnswered = false;
                practiceWrongHashes = new Set();
                renderCustomPractice();
            };
            document.getElementById('qh-cp-restart').onclick = () => {
                customDeck = shuffle(customDeck);
                quizModeIndex = 0;
                quizModeScore = 0;
                quizModeAnswered = false;
                practiceWrongHashes = new Set();
                renderCustomPractice();
            };
            updateWrongCount();
            updateSubtabCounts();
            return;
        }

        const q = customDeck[quizModeIndex];
        const correctAnswers = q.answers || [];
        const allOptions = q.allOptions || [];
        const explicitlyTyped = isTypedType(q.qType);
        const hasOptions = allOptions.length >= 2;
        const isTyped = explicitlyTyped || !hasOptions;
        const isMulti = isMultiSelect(q.qType) || correctAnswers.length > 1;

        const acc = quizModeIndex ? Math.round((quizModeScore / quizModeIndex) * 100) + '%' : '—';

        body.innerHTML = `
            <div class="qh-stats-grid" style="grid-template-columns:1fr 1fr 1fr;margin-bottom:10px">
                <div class="qh-stat-card" style="padding:8px">
                    <div class="qh-stat-label">Q</div>
                    <div class="qh-stat-value" style="font-size:16px">${quizModeIndex + 1}/${customDeck.length}</div>
                </div>
                <div class="qh-stat-card" style="padding:8px">
                    <div class="qh-stat-label">Score</div>
                    <div class="qh-stat-value" style="font-size:16px">${quizModeScore}</div>
                </div>
                <div class="qh-stat-card" style="padding:8px">
                    <div class="qh-stat-label">Acc</div>
                    <div class="qh-stat-value" style="font-size:16px">${acc}</div>
                </div>
            </div>
            <div class="qh-quiz-question">${questionHtmlWithImage(q)}</div>
            <div id="qh-cp-body"></div>
            <div class="qh-btn-row">
                <button class="qh-btn qh-btn-secondary" id="qh-cp-skip">⏭ Skip</button>
            </div>
        `;

        document.getElementById('qh-cp-skip').onclick = () => {
            quizModeIndex++;
            quizModeAnswered = false;
            renderCustomPractice();
        };

        const cpBody = document.getElementById('qh-cp-body');
        quizModeAnswered = false;

        if (isTyped) {
            renderTypedQuestion(cpBody, correctAnswers, q.hash, 'custom');
        } else if (isMulti) {
            renderMultiSelectQuestion(cpBody, correctAnswers, allOptions, customDeck, q, 'custom');
        } else {
            renderSingleChoiceQuestion(cpBody, correctAnswers, allOptions, customDeck, q, 'custom');
        }
    }

    function advanceCustomPractice() {
        quizModeIndex++;
        quizModeAnswered = false;
        renderCustomPractice();
    }

    /* ---------- STATS ---------- */
    function renderStats() {
        const items = Object.values(studyData.seenQuestions);
        const total = items.length;
        const mastered = items.filter(q => q.difficulty === 1).length;
        const starred = items.filter(q => q.starred).length;
        const wrongs = items.filter(q => q.wrongCount > 0 && q.lastAnsweredCorrectly === null).length;
        const masteryPct = total ? Math.round((mastered / total) * 100) : 0;
        const elapsed = Date.now() - (studyData.currentSession.startTime || Date.now());

        const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
        set('qh-stat-seen', total);
        set('qh-stat-session', `this session: ${studyData.currentSession.questionHashes?.length || 0}`);
        set('qh-stat-mastery', masteryPct + '%');
        set('qh-stat-mastery-sub', `${mastered} mastered`);
        set('qh-stat-starred', starred);
        set('qh-stat-wrongs', wrongs);
        set('qh-stat-time', fmtTime(elapsed));
        set('qh-stat-sessions', studyData.stats.sessions || 0);
        const prog = document.getElementById('qh-stat-progress');
        if (prog) prog.style.width = masteryPct + '%';
    }

    function scheduleBadgeUpdate() {
        clearTimeout(badgeTimer);
        badgeTimer = setTimeout(() => {
            updateTabBadges();
            updateWrongCount();
            updateSubtabCounts();
        }, 200);
    }

    function updateTabBadges() {
        const total = Object.keys(studyData.seenQuestions).length;
        const wrongs = Object.values(studyData.seenQuestions)
            .filter(q => q.wrongCount > 0 && q.lastAnsweredCorrectly === null).length;
        const quizizzWrongs = getQuizizzWrongList().length;
        const totalPracticeBadge = wrongs + quizizzWrongs;
        document.querySelectorAll('.qh-tab').forEach(tab => {
            const t = tab.dataset.tab;
            const existing = tab.querySelector('.qh-tab-badge');
            if (existing) existing.remove();
            if (t === 'practice' && totalPracticeBadge > 0) {
                const badge = document.createElement('span');
                badge.className = 'qh-tab-badge error';
                badge.textContent = totalPracticeBadge;
                tab.appendChild(badge);
            } else if ((t === 'study' || t === 'flash' || t === 'custom') && total > 0) {
                const badge = document.createElement('span');
                badge.className = 'qh-tab-badge';
                badge.textContent = total;
                tab.appendChild(badge);
            }
        });
        requestAnimationFrame(updateTabArrows);
    }

    /* ---------- SOUNDS ---------- */
    function getAudioCtx() {
        if (audioCtx) return audioCtx;
        try {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (Ctx) audioCtx = new Ctx();
        } catch (e) {}
        return audioCtx;
    }

    function playBeep(type) {
        if (!GM_getValue('sounds', false)) return;
        const ctx = getAudioCtx();
        if (!ctx) return;
        try {
            const osc = ctx.createOscillator(), gain = ctx.createGain();
            osc.connect(gain); gain.connect(ctx.destination);
            const freqs = { success: [600, 900], error: [300, 200], info: [500, 500] };
            const [f1, f2] = freqs[type] || freqs.info;
            const t = ctx.currentTime;
            osc.frequency.setValueAtTime(f1, t);
            osc.frequency.exponentialRampToValueAtTime(f2, t + 0.1);
            gain.gain.setValueAtTime(0.05, t);
            gain.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
            osc.start(t); osc.stop(t + 0.16);
        } catch (e) {}
    }

    /* ---------- WIRE GUI ---------- */
    function wireGUI() {
        document.getElementById('qh-master-toggle').addEventListener('change', (e) => {
            helperEnabled = e.target.checked;
            GM_setValue('helper-enabled', helperEnabled);
            document.getElementById('quiz-input-gui').classList.toggle('qh-disabled', !helperEnabled);
            if (!helperEnabled) {
                clearPreviousMarkers();
                hideFloatingAnswer();
                showNotification('Helper disabled', 'info');
            } else {
                showNotification('Helper enabled', 'success');
                if (apiResponse) processQuestion();
            }
        });

        document.querySelectorAll('.qh-tab').forEach(t => {
            t.onclick = () => switchTab(t.dataset.tab);
        });

        document.querySelectorAll('.qh-subtab').forEach(t => {
            t.onclick = () => switchPracticeSubTab(t.dataset.subtab);
        });

        const tabs = document.querySelector('.qh-tabs');
        document.getElementById('qh-tab-left').onclick = () => tabs.scrollBy({ left: -120, behavior: 'smooth' });
        document.getElementById('qh-tab-right').onclick = () => tabs.scrollBy({ left: 120, behavior: 'smooth' });
        tabs.addEventListener('scroll', updateTabArrows);
        window.addEventListener('resize', updateTabArrows);
        tabs.addEventListener('wheel', (e) => {
            if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
                e.preventDefault();
                tabs.scrollBy({ left: e.deltaY, behavior: 'smooth' });
            }
        }, { passive: false });
        requestAnimationFrame(updateTabArrows);

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

        document.getElementById('qh-toggle-memory').onclick = (e) => {
            const list = document.getElementById('qh-study-list');
            list.classList.toggle('qh-memory-mode');
            e.target.textContent = list.classList.contains('qh-memory-mode') ? '👁 Show Answers' : '👁 Hide Answers';
        };
        document.getElementById('qh-shuffle-list').onclick = () => {
            const items = document.querySelectorAll('#qh-study-list .qh-list-item');
            const arr = shuffle([...items]);
            const parent = document.getElementById('qh-study-list');
            arr.forEach(el => parent.appendChild(el));
        };
        document.getElementById('qh-search-input').addEventListener('input', e => renderStudyList(e.target.value));

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
        document.getElementById('qh-flash-shuffle').onclick = (e) => {
            e.stopPropagation();
            shuffleFlashcards();
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
            flashcardOrder = null;
            e.target.textContent = flashcardFilter === 'hard' ? '📚 All cards' : '🔥 Hard only';
            renderFlashcard();
        };

        document.querySelectorAll('.qh-scope-btn').forEach(b => {
            b.onclick = () => {
                document.querySelectorAll('.qh-scope-btn').forEach(x => x.classList.remove('active'));
                b.classList.add('active');
                practiceScope = b.dataset.scope;
                renderPractice(true);
            };
        });

        document.getElementById('qh-quizizz-retry').onclick = startQuizizzRetry;
        document.getElementById('qh-quizizz-clear').onclick = () => {
            const wrongs = getQuizizzWrongList();
            if (!wrongs.length) {
                showNotification('Nothing to clear', 'info');
                return;
            }
            if (!confirm(`Clear ${wrongs.length} Quizizz wrong answer(s)?`)) return;
            wrongs.forEach(q => {
                const stored = studyData.seenQuestions[q.hash];
                if (stored) {
                    stored.quizizzLastWrong = null;
                    stored.quizizzLastCorrect = Date.now();
                }
            });
            saveStudyData(true);
            renderQuizizzWrongsList();
            updateSubtabCounts();
            updateTabBadges();
            showNotification('Cleared Quizizz wrongs', 'success');
        };

        document.getElementById('qh-custom-search').addEventListener('input', e => {
            customSearch = e.target.value;
            renderCustomPicker();
        });
        document.getElementById('qh-custom-select-all').onclick = () => {
            Object.keys(studyData.seenQuestions).forEach(h => customSelected.add(h));
            renderCustomPicker();
        };
        document.getElementById('qh-custom-select-none').onclick = () => {
            customSelected.clear();
            renderCustomPicker();
        };
        document.getElementById('qh-custom-select-visible').onclick = () => {
            getCustomFilteredItems().forEach(q => customSelected.add(q.hash));
            renderCustomPicker();
        };
        document.getElementById('qh-custom-select-wrong').onclick = () => {
            Object.entries(studyData.seenQuestions).forEach(([h, q]) => {
                if ((q.wrongCount > 0 && q.lastAnsweredCorrectly === null) ||
                    (q.quizizzLastWrong && !q.quizizzLastCorrect)) {
                    customSelected.add(h);
                }
            });
            renderCustomPicker();
        };
        document.getElementById('qh-custom-select-starred').onclick = () => {
            Object.entries(studyData.seenQuestions).forEach(([h, q]) => {
                if (q.starred) customSelected.add(h);
            });
            renderCustomPicker();
        };
        document.querySelectorAll('.qh-method-btn').forEach(b => {
            b.onclick = () => {
                document.querySelectorAll('.qh-method-btn').forEach(x => x.classList.remove('active'));
                b.classList.add('active');
                customMethod = b.dataset.method;
            };
        });
        document.getElementById('qh-custom-start').onclick = startCustomSession;
        document.getElementById('qh-custom-back').onclick = exitCustomSession;
        document.getElementById('qh-custom-shuffle').onclick = () => {
            if (!customDeck.length) return;
            customDeck = shuffle(customDeck);
            customFlashIndex = 0;
            customFlashFlipped = false;
            quizModeIndex = 0;
            quizModeScore = 0;
            quizModeAnswered = false;
            practiceWrongHashes = new Set();
            renderCustomSession();
            showNotification('Shuffled', 'success');
            playBeep('info');
        };

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
                    currentSession: { quizCode: null, seen: 0, correct: 0, startTime: Date.now(), questionHashes: [] }
                };
                saveStudyData(true);
                customSelected.clear();
                renderStats(); renderStudyList(); renderFlashcard();
                updateTabBadges(); updateWrongCount(); updateSubtabCounts();
                showNotification('Progress reset', 'info');
            }
        };

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
        document.getElementById('qh-images-toggle').addEventListener('change', e => {
            GM_setValue('show-images', e.target.checked);
            if (currentMatch) markCorrectAnswers(currentMatch, currentQuestionText, true);
            renderStudyList(document.getElementById('qh-search-input')?.value || '');
            renderFlashcard();
        });
        document.getElementById('qh-sound-toggle').addEventListener('change', e => {
            GM_setValue('sounds', e.target.checked);
            if (e.target.checked) playBeep('success');
        });
        document.getElementById('qh-track-quizizz-toggle').addEventListener('change', e => {
            GM_setValue('track-quizizz-wrongs', e.target.checked);
            showNotification(e.target.checked ? 'Quizizz tracking enabled' : 'Quizizz tracking disabled', 'info');
        });
    }

    function setupShortcuts() {
        document.addEventListener('keydown', (e) => {
            if (e.altKey && e.key.toLowerCase() === 'q') {
                e.preventDefault();
                const cb = document.getElementById('qh-master-toggle');
                cb.checked = !cb.checked;
                cb.dispatchEvent(new Event('change'));
            }
            if (activeTab === 'flash') {
                if (document.activeElement.tagName === 'INPUT') return;
                if (e.key === 'ArrowLeft') document.getElementById('qh-flash-prev').click();
                if (e.key === 'ArrowRight') document.getElementById('qh-flash-next').click();
                if (e.key === ' ') {
                    e.preventDefault();
                    document.getElementById('qh-flashcard').click();
                }
            }
            if (e.key === 'Escape') {
                const lb = document.getElementById('qh-img-lightbox');
                if (lb && lb.classList.contains('show')) lb.classList.remove('show');
            }
        });
    }

    function initialize() {
        log(`Init v${VERSION}`);
        createGUI();
        ensureLightbox();
        setupShortcuts();
        updateTabBadges();
        updateWrongCount();
        updateSubtabCounts();
    }

    window.addEventListener('beforeunload', () => {
        if (mutationObserver) mutationObserver.disconnect();
        clearTimeout(debounceTimer);
        clearTimeout(retryTimer);
        clearTimeout(saveTimer);
        clearTimeout(badgeTimer);
        if (statsInterval) clearInterval(statsInterval);
        saveStudyData(true);
        if (audioCtx && audioCtx.close) audioCtx.close().catch(()=>{});
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize);
    } else {
        initialize();
    }
})();
