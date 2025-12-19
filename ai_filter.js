require('dotenv').config();
const { Ollama } = require('ollama');

// config
const OLLAMA_URL = process.env.OLLAMA_API_URL || 'http://127.0.0.1:11434';
const CHECK_INTERVAL_MS = 30000; 
const COOLDOWN_MS = 60000; 
const MAX_BAD_RESPONSES = 5;
const MODEL_NAME = process.env.OLLAMA_MODEL || 'granite3-guardian:2b';

const ollama = new Ollama({ host: OLLAMA_URL });

// state
let isAiHealthy = false; 
let badResponseCount = 0;
let isOnCooldown = false;
let statusChangeCallback = null;

// status handler
function handleStatusChange(newStatus) {
    if (isAiHealthy !== newStatus) {
        isAiHealthy = newStatus;
        if (statusChangeCallback) statusChangeCallback(isAiHealthy);
    }
}

// health check
async function startHealthCheck() {
    if (process.env.USE_LOCAL_AI !== 'true') return;

    // startup load
    try {
        await ollama.list();
        
        console.log('loading model...');
        const startTime = Date.now();

        // force load model
        await ollama.chat({
            model: MODEL_NAME,
            messages: [{ role: 'user', content: '' }],
            keep_alive: -1
        });

        const duration = (Date.now() - startTime) / 1000;
        console.log(`model loaded in ${duration}s`);

        handleStatusChange(true);
        console.log('ai service connected');
    } catch (e) {
        console.error('ai service unreachable or load failed');
        handleStatusChange(false);
    }

    // loop
    setInterval(async () => {
        if (isOnCooldown) return; 

        try {
            await ollama.list();
            if (!isAiHealthy) console.log('ai service back online');
            handleStatusChange(true);
        } catch (e) {
            if (isAiHealthy) console.error('ai service lost connection');
            handleStatusChange(false);
        }
    }, CHECK_INTERVAL_MS);
}

// cooldown
function triggerCooldown() {
    if (isOnCooldown) return;
    
    console.warn(`ai disabling for ${COOLDOWN_MS/1000}s`);
    handleStatusChange(false);
    isOnCooldown = true;

    setTimeout(() => {
        isOnCooldown = false;
        badResponseCount = 0;
        console.log('ai cooldown over');
    }, COOLDOWN_MS);
}

async function checkTicketSafety(inputString) {
    const startTime = Date.now(); 

    if (process.env.USE_LOCAL_AI !== 'true' || !isAiHealthy) {
        return { is_unsafe: false, skipped: true };
    }

    if (!inputString || typeof inputString !== 'string') {
        return { is_unsafe: false };
    }

    const validResponses = [];
    const targetCount = process.env.AI_VERIFICATION_COUNT ? parseInt(process.env.AI_VERIFICATION_COUNT) : 3;
    let attempts = 0;
    const maxAttempts = 6; 

    while (validResponses.length < targetCount && attempts < maxAttempts) {
        attempts++;
        try {
            const response = await ollama.chat({
                model: MODEL_NAME,
                messages: [{ role: 'user', content: inputString }],
                keep_alive: -1
            });

            const rawContent = response.message.content.trim();

            if (rawContent === 'Yes' || rawContent === 'No') {
                validResponses.push(rawContent);
            } else {
                badResponseCount++;
                if (badResponseCount >= MAX_BAD_RESPONSES) {
                    triggerCooldown();
                    return { is_unsafe: false, skipped: true }; 
                }
            }
        } catch (e) {
            console.error('ai request error', e);
            handleStatusChange(false); 
            return { is_unsafe: false, skipped: true };
        }
    }

    if (validResponses.length === 0) return { is_unsafe: false };

    const yesCount = validResponses.filter(r => r === 'Yes').length;
    const noCount = validResponses.filter(r => r === 'No').length;
    const isUnsafe = yesCount > noCount;

    // log
    const duration = Date.now() - startTime;
    console.log(`ai decision: ${isUnsafe ? 'UNSAFE' : 'SAFE'} | time: ${(duration/1000).toFixed(2)}s`);

    if (badResponseCount > 0) badResponseCount--; 

    return {
        is_unsafe: isUnsafe,
        votes: { yes: yesCount, no: noCount }
    };
}

startHealthCheck();

module.exports = { 
    checkTicketSafety, 
    getAiStatus: () => isAiHealthy && process.env.USE_LOCAL_AI === 'true',
    setAiStatusCallback: (cb) => { statusChangeCallback = cb; }
};