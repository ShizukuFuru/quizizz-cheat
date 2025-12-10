(function() {
    'use strict';

    const DEBUG = true;
    let apiResponse = null;
    let mutationObserver = null;
    let debounceTimer = null;
    const MARKER_STYLE = 'color: #00ff00; font-weight: bold; font-size: 0.9em;';
    const SIMILARITY_THRESHOLD = 0.6;

    // Detect platform
    const PLATFORM = {
        isQuizizz: window.location.hostname.includes('quizizz.com'),
        isWayground: window.location.hostname.includes('wayground.com')
    };

    function log(...args) {
        if(DEBUG) console.log('%c[QUIZ-HELPER]', 'color: #4CAF50; font-weight: bold', ...args);
    }

    // Create draggable input GUI
    function createInputGUI() {
        const platformName = PLATFORM.isQuizizz ? 'Quizizz' : 'Wayground';
        const gui = document.createElement('div');
        gui.id = 'quiz-input-gui';
        gui.innerHTML = `
            <div id="quiz-gui-header" style="padding: 12px 15px; background: #4CAF50; color: white; border-radius: 8px 8px 0 0; display: flex; justify-content: space-between; align-items: center; cursor: move; user-select: none; touch-action: none;">
                <span style="font-size: 14px;">🚀 ${platformName} Helper</span>
                <button id="quiz-toggle-btn" style="background: none; border: none; color: white; font-size: 20px; cursor: pointer; padding: 0; width: 24px; height: 24px; display: flex; align-items: center; justify-content: center;">−</button>
            </div>
            <div id="quiz-gui-content" style="padding: 15px; text-align: center; background: white; border-radius: 0 0 8px 8px;">
                <input type="text" id="quiz-code-input" placeholder="6-digit code"
                    style="width: 100%; padding: 10px; margin-bottom: 12px; border: 2px solid #4CAF50; border-radius: 5px; text-align: center; font-size: 16px; box-sizing: border-box;">
                <button id="quiz-submit-btn"
                    style="width: 100%; padding: 12px; background: #4CAF50; color: white; border: none; border-radius: 5px; font-size: 16px; cursor: pointer; font-weight: 500;">
                    Load Answers
                </button>
            </div>
        `;

        gui.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            z-index: 999999;
            min-width: 280px;
            max-width: 90vw;
            border-radius: 8px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.3);
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            transition: all 0.3s ease;
        `;

        document.body.appendChild(gui);
        
        // Make draggable
        makeDraggable(gui);
        
        // Make collapsible
        makeCollapsible(gui);
        
        return gui;
    }

    // Draggable functionality
    function makeDraggable(element) {
        const header = element.querySelector('#quiz-gui-header');
        let isDragging = false;
        let currentX, currentY, initialX, initialY;
        let xOffset = 0, yOffset = 0;

        // Get stored position or use default
        const storedPos = localStorage.getItem('quiz-helper-position');
        if (storedPos) {
            const pos = JSON.parse(storedPos);
            element.style.left = pos.x + 'px';
            element.style.top = pos.y + 'px';
            element.style.right = 'auto';
            xOffset = pos.x;
            yOffset = pos.y;
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
            header.style.cursor = 'grabbing';
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
            const maxX = window.innerWidth - rect.width;
            const maxY = window.innerHeight - rect.height;

            xOffset = Math.max(0, Math.min(xOffset, maxX));
            yOffset = Math.max(0, Math.min(yOffset, maxY));

            element.style.left = xOffset + 'px';
            element.style.top = yOffset + 'px';
            element.style.right = 'auto';
        }

        function dragEnd() {
            if (isDragging) {
                isDragging = false;
                header.style.cursor = 'move';
                
                localStorage.setItem('quiz-helper-position', JSON.stringify({
                    x: xOffset,
                    y: yOffset
                }));
            }
        }

        header.addEventListener('mousedown', dragStart);
        document.addEventListener('mousemove', drag);
        document.addEventListener('mouseup', dragEnd);

        header.addEventListener('touchstart', dragStart, { passive: false });
        document.addEventListener('touchmove', drag, { passive: false });
        document.addEventListener('touchend', dragEnd);
    }

    // Collapsible functionality
    function makeCollapsible(element) {
        const toggleBtn = element.querySelector('#quiz-toggle-btn');
        const content = element.querySelector('#quiz-gui-content');
        let isCollapsed = localStorage.getItem('quiz-helper-collapsed') === 'true';

        function toggleCollapse() {
            isCollapsed = !isCollapsed;
            
            if (isCollapsed) {
                content.style.display = 'none';
                toggleBtn.textContent = '+';
                element.style.minWidth = '200px';
            } else {
                content.style.display = 'block';
                toggleBtn.textContent = '−';
                element.style.minWidth = '280px';
            }
            
            localStorage.setItem('quiz-helper-collapsed', isCollapsed);
        }

        if (isCollapsed) {
            content.style.display = 'none';
            toggleBtn.textContent = '+';
            element.style.minWidth = '200px';
        }

        toggleBtn.addEventListener('click', toggleCollapse);
        toggleBtn.addEventListener('mousedown', (e) => e.stopPropagation());
        toggleBtn.addEventListener('touchstart', (e) => e.stopPropagation());
    }

    // Show notification
    function showNotification(message, type = 'info') {
        const colors = {
            info: '#4CAF50',
            error: '#f44336',
            warning: '#ff9800'
        };

        const notification = document.createElement('div');
        notification.textContent = message;
        notification.style.cssText = `
            position: fixed;
            top: 20px;
            left: 50%;
            transform: translateX(-50%);
            z-index: 999999;
            background: ${colors[type]};
            color: white;
            padding: 12px 20px;
            border-radius: 5px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.3);
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            max-width: 80vw;
            text-align: center;
        `;

        document.body.appendChild(notification);
        setTimeout(() => notification.remove(), 3000);
    }

    // Add CSS
    const style = document.createElement('style');
    style.textContent = `
        #quiz-toggle-btn:hover {
            background: rgba(255,255,255,0.2) !important;
            border-radius: 4px;
        }
        #quiz-submit-btn:active {
            transform: scale(0.98);
        }
    `;
    document.head.appendChild(style);

    // Initialize the script
    function initialize() {
        log('Initializing on platform:', PLATFORM.isQuizizz ? 'Quizizz' : 'Wayground');
        const gui = createInputGUI();
        const input = document.getElementById('quiz-code-input');
        const button = document.getElementById('quiz-submit-btn');

        button.addEventListener('click', () => {
            const code = input.value.replace(/\D/g, '');
            if (code.length >= 6) {
                const content = document.getElementById('quiz-gui-content');
                const toggleBtn = document.getElementById('quiz-toggle-btn');
                content.style.display = 'none';
                toggleBtn.textContent = '+';
                localStorage.setItem('quiz-helper-collapsed', 'true');
                
                loadAnswers(code);
            } else {
                input.style.borderColor = '#ff4444';
                showNotification('Please enter a valid 6-digit code', 'error');
                setTimeout(() => input.style.borderColor = '#4CAF50', 1000);
            }
        });

        input.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') button.click();
        });

        const toggleBtn = document.getElementById('quiz-toggle-btn');
        toggleBtn.addEventListener('click', () => {
            setTimeout(() => {
                if (document.getElementById('quiz-gui-content').style.display !== 'none') {
                    input.focus();
                }
            }, 100);
        });
    }

    // Load answers from API
    function loadAnswers(code) {
        log(`Loading answers for code: ${code}`);
        showNotification('Loading answers...', 'info');

        fetch(`https://api.cheatnetwork.eu/quizizz/${code}/answers`, {
            method: 'GET',
            signal: AbortSignal.timeout(15000)
        })
        .then(response => {
            if (response.status === 200) {
                return response.json();
            } else {
                throw new Error(`Server error: ${response.status}`);
            }
        })
        .then(data => {
            if (data && data.answers && Array.isArray(data.answers)) {
                apiResponse = data;
                log('Loaded', apiResponse.answers.length, 'questions');
                showNotification(`Loaded ${apiResponse.answers.length} questions!`, 'info');
                initializeAnswerSystem();
            } else {
                showNotification('Invalid response format', 'error');
                log('Invalid response structure:', data);
            }
        })
        .catch(error => {
            if (error.name === 'TimeoutError') {
                showNotification('Request timed out', 'error');
                log('Request timeout');
            } else {
                showNotification('Network error - check connection', 'error');
                log('Network error:', error);
            }
        });
    }

    // Answer processing system
    function initializeAnswerSystem() {
        log('Initializing answer system');

        const fab = document.createElement('div');
        fab.innerHTML = '🎯';
        fab.title = 'Mark correct answers';
        fab.style.cssText = `
            position: fixed;
            bottom: 20px;
            right: 20px;
            z-index: 999998;
            width: 56px;
            height: 56px;
            background: #4CAF50;
            color: white;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 28px;
            box-shadow: 0 4px 10px rgba(0,0,0,0.3);
            cursor: pointer;
            transition: all 0.3s ease;
        `;

        fab.addEventListener('mouseenter', () => {
            fab.style.transform = 'scale(1.1)';
            fab.style.boxShadow = '0 6px 15px rgba(0,0,0,0.4)';
        });

        fab.addEventListener('mouseleave', () => {
            fab.style.transform = 'scale(1)';
            fab.style.boxShadow = '0 4px 10px rgba(0,0,0,0.3)';
        });

        fab.addEventListener('click', () => {
            processQuestion();
            fab.style.background = '#2196F3';
            setTimeout(() => fab.style.background = '#4CAF50', 300);
        });

        fab.addEventListener('touchstart', () => {
            fab.style.transform = 'scale(0.95)';
        });

        fab.addEventListener('touchend', () => {
            fab.style.transform = 'scale(1)';
        });

        document.body.appendChild(fab);

        mutationObserver = new MutationObserver(() => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => processQuestion(), 200);
        });

        mutationObserver.observe(document.body, {
            childList: true,
            subtree: true
        });

        processQuestion();
    }

    function processQuestion() {
        if (!apiResponse || !apiResponse.answers) {
            log('API response not ready');
            return;
        }

        const selectors = [
            '.question-text-color',
            '[class*="question-text"]',
            '[class*="questionText"]',
            '.question-content',
            '[data-testid="question-text"]'
        ];

        let questionElement = null;
        for (const selector of selectors) {
            questionElement = document.querySelector(selector);
            if (questionElement) break;
        }

        if (!questionElement) {
            log('Question element not found');
            return;
        }

        const questionText = normalizeText(questionElement.textContent);
        if (!questionText) return;

        log('Processing question:', questionText.substring(0, 50) + '...');

        const match = findAnswerMatch(questionText);
        if (match) {
            markAnswers(match);
        } else {
            log('No match found for question');
        }
    }

    function findAnswerMatch(question) {
        if (!apiResponse || !apiResponse.answers) return null;

        const exactMatch = apiResponse.answers.find(a =>
            normalizeText(a.question) === question
        );
        if (exactMatch) {
            log('Found exact match');
            return exactMatch;
        }

        const fuzzyResult = apiResponse.answers.reduce((best, current) => {
            const similarity = calculateSimilarity(question, normalizeText(current.question));
            if (similarity > best.similarity) {
                return { answer: current, similarity };
            }
            return best;
        }, { answer: null, similarity: 0 });

        if (fuzzyResult.similarity >= SIMILARITY_THRESHOLD) {
            log('Found fuzzy match with similarity:', fuzzyResult.similarity.toFixed(2));
            return fuzzyResult.answer;
        }

        return null;
    }

    function markAnswers(answer) {
        if (!answer || !answer.answer || !answer.options) {
            log('Invalid answer object');
            return;
        }

        log('Marking answers for:', answer.question.substring(0, 50) + '...');
        
        const correctOptions = answer.answer.map(i => {
            if (answer.options[i] && answer.options[i].text) {
                return normalizeText(answer.options[i].text);
            }
            return null;
        }).filter(Boolean);

        if (correctOptions.length === 0) {
            log('No valid correct options found');
            return;
        }

        const optionSelectors = [
            '.option',
            '[class*="option-"]',
            '[class*="Option"]',
            '[data-testid*="option"]',
            '.answer-choice'
        ];

        let options = [];
        for (const selector of optionSelectors) {
            options = document.querySelectorAll(selector);
            if (options.length > 0) break;
        }

        let markedCount = 0;
        options.forEach(option => {
            const textSelectors = [
                '.resizeable',
                '[class*="option-text"]',
                '[class*="optionText"]',
                '[class*="text"]',
                'span',
                'div'
            ];

            let textElement = null;
            for (const selector of textSelectors) {
                textElement = option.querySelector(selector);
                if (textElement && textElement.textContent.trim()) break;
            }

            if (!textElement) {
                textElement = option;
            }

            if (textElement.dataset.quizMarked === 'true') return;

            const originalText = normalizeText(
                textElement.textContent.replace(/\(correct answer\)/gi, '').trim()
            );

            if (correctOptions.includes(originalText)) {
                const currentHTML = textElement.innerHTML;
                textElement.innerHTML = `
                    ${currentHTML.replace(/<span[^>]*>\(correct answer\)<\/span>/gi, '')}
                    <span style="${MARKER_STYLE}">(correct answer)</span>
                `;
                textElement.dataset.quizMarked = 'true';
                markedCount++;
                
                option.style.border = '2px solid #00ff00';
                option.style.boxShadow = '0 0 10px rgba(0,255,0,0.3)';
            }
        });

        if (markedCount > 0) {
            log(`Marked ${markedCount} correct answer(s)`);
            showNotification(`Found ${markedCount} correct answer(s)!`, 'info');
        }
    }

    function normalizeText(text) {
        if (!text) return '';
        return text
            .normalize('NFC')
            .toLowerCase()
            .trim()
            .replace(/\s+/g, ' ')
            .replace(/[^\w\s]/g, '');
    }

    function calculateSimilarity(str1, str2) {
        const m = str1.length;
        const n = str2.length;
        
        if (m === 0) return n === 0 ? 1 : 0;
        if (n === 0) return 0;

        const dp = Array(m + 1).fill().map(() => Array(n + 1).fill(0));

        for (let i = 0; i <= m; i++) dp[i][0] = i;
        for (let j = 0; j <= n; j++) dp[0][j] = j;

        for (let i = 1; i <= m; i++) {
            for (let j = 1; j <= n; j++) {
                const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
                dp[i][j] = Math.min(
                    dp[i - 1][j] + 1,
                    dp[i][j - 1] + 1,
                    dp[i - 1][j - 1] + cost
                );
            }
        }

        const maxLen = Math.max(m, n);
        return 1 - (dp[m][n] / maxLen);
    }

    window.addEventListener('beforeunload', () => {
        if (mutationObserver) {
            mutationObserver.disconnect();
        }
        clearTimeout(debounceTimer);
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize);
    } else {
        initialize();
    }

    console.log('%c✅ Quiz Helper Loaded!', 'color: #4CAF50; font-size: 16px; font-weight: bold');
    console.log('%cDrag the header to move • Click +/- to collapse/expand', 'color: #666; font-size: 12px');
})();
