// ==UserScript==
// @name          Quizizz Cheat - Fixed v3
// @namespace     https://github.com/leoaxo098
// @version       5.2.0
// @description   Fixed quiz helper with multiple answer support
// @author        Leo
// @match         https://quizizz.com/join/game/*
// @match         https://wayground.com/join/*
// @grant         GM_xmlhttpRequest
// @grant         GM_addStyle
// @connect       api.cheatnetwork.eu
// ==/UserScript==

(function() {
    'use strict';

    const DEBUG = true;
    let apiResponse = null;
    let mutationObserver = null;
    let lastProcessedQuestion = '';
    let isProcessing = false;
    let debounceTimer = null;

    function log(...args) {
        if (DEBUG) console.log('%c[QUIZ-HELPER]', 'color: #4CAF50; font-weight: bold', ...args);
    }

    function stripHtml(html) {
        if (!html) return '';
        const tmp = document.createElement('div');
        tmp.innerHTML = html;
        return tmp.textContent || tmp.innerText || '';
    }

    function extractText(element) {
        if (!element) return '';
        const clone = element.cloneNode(true);
        clone.querySelectorAll('script, style, noscript, .quiz-correct-marker').forEach(el => el.remove());
        return (clone.textContent || clone.innerText || '').trim();
    }

    function normalizeText(text) {
        if (!text) return '';
        return stripHtml(text)
            .toLowerCase()
            .trim()
            .replace(/\s+/g, ' ')
            .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, ' ')
            .replace(/['']/g, "'")
            .replace(/[""]/g, '"')
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
        if (!option) return '';
        if (typeof option === 'string') return stripHtml(option);
        if (option.text !== undefined) return stripHtml(String(option.text));
        if (option.value !== undefined) return stripHtml(String(option.value));
        if (option.content !== undefined) return stripHtml(String(option.content));
        return '';
    }

    function getAnswerIndices(answer) {
        if (!answer) return [];
        let indices = answer.answer !== undefined ? answer.answer : answer.answers;
        if (indices === undefined) return [];
        if (!Array.isArray(indices)) indices = [indices];
        return indices.filter(i => i !== null && i !== undefined);
    }

    function textsMatch(text1, text2) {
        const n1 = normalizeText(text1);
        const n2 = normalizeText(text2);
        if (!n1 || !n2) return false;
        if (n1 === n2) return true;
        if (n1.includes(n2) || n2.includes(n1)) return true;
        const clean1 = n1.replace(/[^a-z0-9]/g, '');
        const clean2 = n2.replace(/[^a-z0-9]/g, '');
        if (clean1 === clean2 && clean1.length > 0) return true;
        return false;
    }

    function createInputGUI() {
        const gui = document.createElement('div');
        gui.id = 'quiz-input-gui';
        gui.innerHTML = `
            <div id="quiz-gui-header" style="padding: 12px 15px; background: linear-gradient(135deg, #4CAF50, #45a049); color: white; border-radius: 8px 8px 0 0; display: flex; justify-content: space-between; align-items: center; cursor: move; user-select: none;">
                <span style="font-size: 14px; font-weight: 600;">🎯 Quiz Helper</span>
                <button id="quiz-toggle-btn" style="background: none; border: none; color: white; font-size: 20px; cursor: pointer; padding: 0; width: 24px; height: 24px; line-height: 24px;">−</button>
            </div>
            <div id="quiz-gui-content" style="padding: 15px; background: white; border-radius: 0 0 8px 8px;">
                <input type="text" id="quiz-code-input" placeholder="Enter quiz code"
                    style="width: 100%; padding: 10px; margin-bottom: 10px; border: 2px solid #4CAF50; border-radius: 5px; text-align: center; font-size: 16px; box-sizing: border-box; outline: none;">
                <button id="quiz-submit-btn"
                    style="width: 100%; padding: 12px; background: #4CAF50; color: white; border: none; border-radius: 5px; font-size: 16px; cursor: pointer; font-weight: 600;">
                    Load Answers
                </button>
                <div id="quiz-status" style="margin-top: 10px; font-size: 12px; color: #666; text-align: center; min-height: 18px;"></div>
                <div id="quiz-answer-display" style="margin-top: 10px; padding: 10px; background: #f5f5f5; border-radius: 5px; font-size: 13px; display: none; max-height: 200px; overflow-y: auto; word-wrap: break-word;"></div>
            </div>
        `;

        gui.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            z-index: 2147483647;
            min-width: 300px;
            max-width: 400px;
            border-radius: 8px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.3);
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        `;

        document.body.appendChild(gui);
        makeDraggable(gui);
        makeCollapsible(gui);
        return gui;
    }

    function makeDraggable(element) {
        const header = element.querySelector('#quiz-gui-header');
        let isDragging = false;
        let currentX, currentY, initialX, initialY;
        let xOffset = 0, yOffset = 0;

        const storedPos = localStorage.getItem('quiz-helper-position');
        if (storedPos) {
            try {
                const pos = JSON.parse(storedPos);
                element.style.left = pos.x + 'px';
                element.style.top = pos.y + 'px';
                element.style.right = 'auto';
                xOffset = pos.x;
                yOffset = pos.y;
            } catch (e) {}
        }

        function dragStart(e) {
            if (e.target.id === 'quiz-toggle-btn') return;
            if (e.type === "touchstart") {
                initialX = e.touches[0].clientX - xOffset;
                initialY = e.touches[0].clientY - yOffset;
            } else {
                initialX = e.clientX - xOffset;
                initialY = e.clientY - yOffset;
            }
            isDragging = true;
        }

        function drag(e) {
            if (!isDragging) return;
            e.preventDefault();
            if (e.type === "touchmove") {
                currentX = e.touches[0].clientX - initialX;
                currentY = e.touches[0].clientY - initialY;
            } else {
                currentX = e.clientX - initialX;
                currentY = e.clientY - initialY;
            }
            xOffset = currentX;
            yOffset = currentY;
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

        if (isCollapsed) {
            content.style.display = 'none';
            toggleBtn.textContent = '+';
        }

        toggleBtn.onclick = (e) => {
            e.stopPropagation();
            isCollapsed = !isCollapsed;
            content.style.display = isCollapsed ? 'none' : 'block';
            toggleBtn.textContent = isCollapsed ? '+' : '−';
            localStorage.setItem('quiz-helper-collapsed', isCollapsed);
        };
    }

    function showNotification(message, type = 'info') {
        document.querySelectorAll('.quiz-notification').forEach(n => n.remove());
        const colors = { info: '#4CAF50', error: '#f44336', warning: '#ff9800', success: '#2196F3' };
        const notif = document.createElement('div');
        notif.className = 'quiz-notification';
        notif.textContent = message;
        notif.style.cssText = `
            position: fixed; top: 70px; left: 50%; transform: translateX(-50%);
            z-index: 2147483647; background: ${colors[type] || colors.info}; color: white;
            padding: 12px 24px; border-radius: 5px; box-shadow: 0 2px 10px rgba(0,0,0,0.3);
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            font-size: 14px; font-weight: 500; max-width: 80%; text-align: center;
        `;
        document.body.appendChild(notif);
        setTimeout(() => notif.remove(), 3000);
    }

    function updateStatus(message, color = '#666') {
        const status = document.getElementById('quiz-status');
        if (status) {
            status.textContent = message;
            status.style.color = color;
        }
    }

    function showAnswerInGUI(questionText, answers) {
        const display = document.getElementById('quiz-answer-display');
        if (!display) return;
        display.style.display = 'block';
        display.innerHTML = `
            <div style="margin-bottom: 8px; color: #333; font-weight: 600; font-size: 12px;">Question:</div>
            <div style="color: #666; font-size: 11px; margin-bottom: 10px; padding: 5px; background: #fff; border-radius: 3px;">${questionText.substring(0, 150)}${questionText.length > 150 ? '...' : ''}</div>
            <div style="color: #4CAF50; font-weight: 600; font-size: 12px; margin-bottom: 5px;">✓ Correct Answer(s):</div>
            ${answers.map(a => `<div style="color: #2e7d32; padding: 5px; background: rgba(76,175,80,0.1); border-radius: 3px; margin: 3px 0; font-size: 12px;">${a}</div>`).join('')}
        `;
    }

    // Original fetching method
    function loadAnswers(code) {
        log('Loading answers for code:', code);
        const submitBtn = document.getElementById('quiz-submit-btn');
        submitBtn.disabled = true;
        submitBtn.textContent = 'Loading...';
        updateStatus('Fetching answers...', '#666');

        GM_xmlhttpRequest({
            method: 'GET',
            url: `https://api.cheatnetwork.eu/quizizz/${code}/answers`,
            timeout: 15000,
            onload: function(response) {
                submitBtn.disabled = false;
                submitBtn.textContent = 'Load Answers';

                if (response.status === 200) {
                    try {
                        apiResponse = JSON.parse(response.responseText);
                        if (apiResponse && apiResponse.answers && Array.isArray(apiResponse.answers)) {
                            log('Loaded', apiResponse.answers.length, 'questions');

                            // Debug log
                            apiResponse.answers.forEach((q, i) => {
                                const indices = getAnswerIndices(q);
                                const texts = indices.map(idx => getOptionText(q.options?.[idx]));
                                log(`Q${i+1}: "${(q.question || '').substring(0, 40)}..." → [${indices}] = "${texts.join(', ')}"`);
                            });

                            showNotification(`✓ Loaded ${apiResponse.answers.length} questions`, 'info');
                            updateStatus(`Ready: ${apiResponse.answers.length} questions`, '#4CAF50');
                            initializeAnswerSystem();

                            // Auto collapse
                            document.getElementById('quiz-gui-content').style.display = 'none';
                            document.getElementById('quiz-toggle-btn').textContent = '+';
                            localStorage.setItem('quiz-helper-collapsed', 'true');
                        } else {
                            showNotification('Invalid response format', 'error');
                            updateStatus('Invalid format', '#f44336');
                            log('Invalid response:', apiResponse);
                        }
                    } catch (e) {
                        showNotification('Failed to parse response', 'error');
                        updateStatus('Parse error', '#f44336');
                        log('Parse error:', e);
                    }
                } else {
                    showNotification(`Server error: ${response.status}`, 'error');
                    updateStatus(`Error: ${response.status}`, '#f44336');
                    log('HTTP error:', response.status);
                }
            },
            onerror: function(err) {
                submitBtn.disabled = false;
                submitBtn.textContent = 'Load Answers';
                showNotification('Network error - check connection', 'error');
                updateStatus('Network error', '#f44336');
                log('Network error:', err);
            },
            ontimeout: function() {
                submitBtn.disabled = false;
                submitBtn.textContent = 'Load Answers';
                showNotification('Request timed out', 'error');
                updateStatus('Timeout', '#f44336');
                log('Request timeout');
            }
        });
    }

    function initializeAnswerSystem() {
        log('Initializing answer system');

        if (mutationObserver) mutationObserver.disconnect();

        mutationObserver = new MutationObserver(() => {
            if (!isProcessing) {
                clearTimeout(debounceTimer);
                debounceTimer = setTimeout(() => processQuestion(), 200);
            }
        });

        mutationObserver.observe(document.body, { childList: true, subtree: true });

        processQuestion();
        setTimeout(() => processQuestion(), 500);
        setTimeout(() => processQuestion(), 1000);
        setTimeout(() => processQuestion(), 2000);
    }

    function processQuestion() {
        if (!apiResponse || !apiResponse.answers || isProcessing) return;
        isProcessing = true;

        try {
            const questionSelectors = [
                '.question-text-color',
                '[class*="QuestionText"]',
                '[class*="questionText"]',
                '[class*="question-text"]',
                '[data-testid*="question"]',
                '.question-content',
                '[class*="prompt"]',
                '[role="heading"]'
            ];

            let questionElement = null;
            let questionText = '';

            for (const selector of questionSelectors) {
                try {
                    const elements = document.querySelectorAll(selector);
                    for (const el of elements) {
                        const text = extractText(el);
                        if (text) {
                            const rect = el.getBoundingClientRect();
                            if (rect.width > 0 && rect.height > 0) {
                                questionElement = el;
                                questionText = text;
                                break;
                            }
                        }
                    }
                } catch (e) {}
                if (questionElement) break;
            }

            if (!questionElement || !questionText) {
                isProcessing = false;
                return;
            }

            const questionHash = hashText(questionText);
            if (questionHash === lastProcessedQuestion) {
                isProcessing = false;
                return;
            }

            lastProcessedQuestion = questionHash;
            log('Processing:', questionText.substring(0, 80));

            const match = findMatch(questionText);
            if (match) {
                markCorrectAnswers(match, questionText);
            } else {
                log('No match found');
                clearPreviousMarkers();
                updateStatus('No match found', '#ff9800');
            }

        } catch (error) {
            log('Error:', error);
        } finally {
            isProcessing = false;
        }
    }

    function findMatch(questionText) {
        const normalizedQuestion = normalizeText(questionText);

        // Exact match
        for (const answer of apiResponse.answers) {
            if (!answer.question) continue;
            if (normalizedQuestion === normalizeText(answer.question)) {
                log('EXACT match');
                return answer;
            }
        }

        // Contains match
        for (const answer of apiResponse.answers) {
            if (!answer.question) continue;
            const apiQ = normalizeText(answer.question);
            if (normalizedQuestion.includes(apiQ) || apiQ.includes(normalizedQuestion)) {
                log('CONTAINS match');
                return answer;
            }
        }

        // Alphanumeric match
        const cleanQ = normalizedQuestion.replace(/[^a-z0-9]/g, '');
        for (const answer of apiResponse.answers) {
            if (!answer.question) continue;
            const cleanApiQ = normalizeText(answer.question).replace(/[^a-z0-9]/g, '');
            if (cleanQ === cleanApiQ && cleanQ.length > 3) {
                log('ALPHANUMERIC match');
                return answer;
            }
        }

        // Word match (80%)
        const words = normalizedQuestion.split(' ').filter(w => w.length > 2);
        for (const answer of apiResponse.answers) {
            if (!answer.question) continue;
            const apiWords = normalizeText(answer.question).split(' ').filter(w => w.length > 2);
            if (words.length > 0 && apiWords.length > 0) {
                const matching = words.filter(w => apiWords.includes(w));
                if (matching.length / Math.max(words.length, apiWords.length) >= 0.8) {
                    log('WORD match');
                    return answer;
                }
            }
        }

        return null;
    }

    function clearPreviousMarkers() {
        document.querySelectorAll('[data-quiz-marked="true"]').forEach(el => {
            el.dataset.quizMarked = 'false';
            el.style.border = '';
            el.style.boxShadow = '';
            el.style.background = '';
            el.style.outline = '';
        });
        document.querySelectorAll('.quiz-correct-marker').forEach(el => el.remove());
    }

    function markCorrectAnswers(answer, questionText) {
        clearPreviousMarkers();

        const answerIndices = getAnswerIndices(answer);
        log('Answer indices:', answerIndices);

        if (answerIndices.length === 0) {
            // Try direct answer
            if (answer.correctAnswer || answer.correct) {
                const direct = String(answer.correctAnswer || answer.correct);
                showAnswerInGUI(questionText, [direct]);
                updateStatus(`Answer: ${direct.substring(0, 50)}`, '#4CAF50');
                highlightByText([normalizeText(direct)]);
                return;
            }
            updateStatus('Could not find answer', '#f44336');
            return;
        }

        const correctTexts = [];
        const displayTexts = [];

        answerIndices.forEach(index => {
            if (answer.options && answer.options[index] !== undefined) {
                const text = getOptionText(answer.options[index]);
                if (text) {
                    correctTexts.push(normalizeText(text));
                    displayTexts.push(text);
                }
            }
        });

        log('Correct answers:', displayTexts);

        if (correctTexts.length === 0) {
            updateStatus('Could not extract answers', '#f44336');
            return;
        }

        showAnswerInGUI(questionText, displayTexts);
        updateStatus(`Found ${correctTexts.length} answer(s)`, '#4CAF50');
        highlightByText(correctTexts);
    }

    function highlightByText(correctTexts) {
        const optionSelectors = [
            '.option',
            '[class*="option"]',
            '[class*="Option"]',
            '[data-testid*="option"]',
            '[data-testid*="Option"]',
            '.answer-choice',
            '[role="button"]',
            '[class*="answer"]',
            '[class*="Answer"]',
            '[class*="choice"]',
            '.resizeable'
        ];

        let options = [];
        for (const selector of optionSelectors) {
            try {
                const els = document.querySelectorAll(selector);
                if (els.length >= 2) {
                    options = els;
                    log(`Found ${els.length} options with: ${selector}`);
                    break;
                }
            } catch (e) {}
        }

        if (options.length === 0) {
            log('No options found');
            return;
        }

        let marked = 0;

        options.forEach((option, i) => {
            const optionText = extractText(option);
            const normalized = normalizeText(optionText);

            log(`Option ${i + 1}: "${normalized.substring(0, 40)}"`);

            const isCorrect = correctTexts.some(ct => textsMatch(normalized, ct));

            if (isCorrect) {
                log(`✓ Marking option ${i + 1}`);

                option.dataset.quizMarked = 'true';
                option.style.cssText += `
                    border: 3px solid #00ff00 !important;
                    box-shadow: 0 0 20px rgba(0,255,0,0.6) !important;
                    background: rgba(0,255,0,0.15) !important;
                `;

                if (!option.querySelector('.quiz-correct-marker')) {
                    const marker = document.createElement('div');
                    marker.className = 'quiz-correct-marker';
                    marker.textContent = '✓ CORRECT';
                    marker.style.cssText = `
                        position: absolute;
                        top: 5px;
                        right: 5px;
                        background: #00ff00;
                        color: #000;
                        padding: 5px 10px;
                        border-radius: 4px;
                        font-size: 12px;
                        font-weight: bold;
                        z-index: 10000;
                        pointer-events: none;
                    `;

                    const style = getComputedStyle(option);
                    if (!['absolute', 'relative', 'fixed', 'sticky'].includes(style.position)) {
                        option.style.position = 'relative';
                    }
                    option.appendChild(marker);
                }

                marked++;
            }
        });

        if (marked > 0) {
            showNotification(`✓ Marked ${marked} correct answer(s)`, 'success');
        } else {
            showNotification('Answers shown in panel', 'warning');
        }
    }

    function initialize() {
        log('Initializing Quiz Helper v5.2.0');

        createInputGUI();
        const input = document.getElementById('quiz-code-input');
        const button = document.getElementById('quiz-submit-btn');

        input.addEventListener('input', (e) => {
            e.target.value = e.target.value.replace(/[^0-9a-zA-Z]/g, '');
        });

        button.addEventListener('click', () => {
            const code = input.value.trim();
            if (code.length >= 5) {
                loadAnswers(code);
            } else {
                input.style.borderColor = '#f44336';
                showNotification('Enter a valid quiz code', 'error');
                setTimeout(() => input.style.borderColor = '#4CAF50', 1500);
            }
        });

        input.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') button.click();
        });
    }

    window.addEventListener('beforeunload', () => {
        if (mutationObserver) mutationObserver.disconnect();
        clearTimeout(debounceTimer);
    });

    GM_addStyle(`
        #quiz-submit-btn:hover { background: #45a049 !important; }
        #quiz-submit-btn:disabled { background: #ccc !important; cursor: not-allowed !important; }
        #quiz-toggle-btn:hover { background: rgba(255,255,255,0.2) !important; border-radius: 4px; }
        .quiz-correct-marker { animation: quiz-pulse 1.5s infinite; }
        @keyframes quiz-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.8; } }
        [data-quiz-marked="true"] { animation: quiz-glow 2s infinite; }
        @keyframes quiz-glow { 0%, 100% { box-shadow: 0 0 20px rgba(0,255,0,0.6); } 50% { box-shadow: 0 0 30px rgba(0,255,0,0.9); } }
    `);

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize);
    } else {
        initialize();
    }
})();
