'use strict';

// config
let api_url = "https://api.ticket-edu.com";
let ws_url = "wss://api.ticket-edu.com";
const max_files = 10;
const max_storage_bytes = 1.5 * 1024 * 1024 * 1024; // 1.5gb
const animation_delay = 600;
const max_ws_retries = 5;
const retry_delay = 3000;

// state
let room_code = new URLSearchParams(window.location.search).get('room');
let user_id = localStorage.getItem('userId') || crypto.randomUUID();
let is_admin = false;
let is_sending = false;
let max_tickets = 1;
let ai_enabled = false;
let qr_instance = null;
let csv_mode = false;
let force_name_mode = false;
let student_name = sessionStorage.getItem('student_name_cache');

let tickets_list = [];
let last_ticket_ids = new Set();
let announcements_list = [];
let deposits_list = [];
let pending_files = [];
let current_deposit_target = null;
let deposit_pending_file = null;
let banned_terms = [];
let current_xhr = null;
let current_modal_deposit_id = null;
let ws_retry_count = 0;
let erroroverlay;
let global_ws = null;
let report_enabled = false;
let is_connecting_cloud = false;

// crypto
let crypto_key = null;

// try to use local api first
async function resolveApiBase() {
    const local = 'http://localhost:3000';
    const remote = 'https://api.ticket-edu.com';
    const controller = new AbortController();
    const timeoutMs = 1500;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(`${local}`, { method: 'GET', signal: controller.signal });
        clearTimeout(timeout);
        if (res.ok) {
            api_url = local;
        } else {
            api_url = remote;
        }
    } catch (e) {
        api_url = remote;
    }

    // derive websocket url from api_url
    if (api_url.startsWith('https://')) {
        ws_url = api_url.replace(/^https:/, 'wss:');
    } else if (api_url.startsWith('http://')) {
        ws_url = api_url.replace(/^http:/, 'ws:');
    } else {
        ws_url = api_url;
    }
    console.log('api base:', api_url, 'ws base:', ws_url);
}

// ui state
let ui_elements = {};
let dot_interval = null;

// logs
const log_buffer = [];
const max_logs = 50;

const original_console = {
    log: console.log,
    error: console.error,
    warn: console.warn
};

// validation
if (!room_code) {
    window.location.href = "/";
} else {
    // session
    localStorage.setItem('userId', user_id);
    localStorage.setItem('last_room', room_code);
}

// utils

function format_bytes(bytes) {
    if (bytes === 0) return '0.00 Go';
    const sizes = ['o', 'Ko', 'Mo', 'Go', 'To'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    if (i < 3) return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' Go';
    return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${sizes[i]}`;
}

function format_time_elapsed(date_string) {
    if (!date_string) return '';
    const diff = Date.now() - new Date(date_string).getTime();
    const mins = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (days > 0) return `(${days}j)`;
    if (hours > 0) return `(${hours}h)`;
    return `(${mins}mins)`;
}

function rgb_to_hex(rgb_str) {
    const match = rgb_str.match(/rgb\(\s*(\d+),\s*(\d+),\s*(\d+)\s*\)/);
    if (!match) return '#d40000';
    return "#" + ((1 << 24) + (+match[1] << 16) + (+match[2] << 8) + (+match[3])).toString(16).slice(1);
}

function get_color_from_element(el) {
    if (!el) return '#cdcdcd';
    return el.style.backgroundImage || el.style.backgroundColor || '#cdcdcd';
}

function create_tag(tag, class_name, content = '', style = {}) {
    const el = document.createElement(tag);
    if (class_name) el.className = class_name;
    if (content) el.innerHTML = content;
    Object.assign(el.style, style);
    return el;
}

// cloud interaction
function handle_cloud_click(provider) {
    let cardId = `${provider}Card`;
    if (provider === 'google') cardId = 'googleDriveCard';
    if (provider === 'ticket') cardId = 'ticketcloudCard'; // <--- INDISPENSABLE

    const card = document.getElementById(cardId);
    if (!card) return;

    // Si c'est le cloud privé, on déconnecte juste les autres
    if (provider === 'ticket') {
        disconnect_cloud();
        return;
    }

    // start auth flow
    set_cloud_card_state(provider, 'loading');
    handle_cloud_handshake(provider);
}

// update card visual state
function set_cloud_card_state(provider, state, msg = null) {
    // reset others if connecting
    if (state === 'connected') {
        ['google', 'nextcloud', 'onedrive'].forEach(p => {
            if (p !== provider) set_cloud_card_state(p, 'idle');
        });
    }

    const cardId = provider === 'google' ? 'googleDriveCard' : `${provider}Card`;
    const card = document.getElementById(cardId);
    if (!card) return;

    const statusText = card.querySelector('.provider-status');

    // clear classes
    card.classList.remove('connected', 'loading', "error");

    switch (state) {
        case 'loading':
            card.classList.add('loading');
            statusText.textContent = "Connexion en cours...";
            break;
        case 'connected':
            card.classList.add('connected');
            statusText.textContent = "Connecté & Prêt";
            break;
        case "error":
            card.classList.add("error");
            statusText.textContent = msg || "Erreur de connexion";
            break;
        case 'idle':
        default:
            statusText.textContent = "Non connecté";
            break;
    }
}

// sync ui with config
async function update_cloud_ui() {
    const cloudSection = document.getElementById('cloudSection');
    const cloudServicesContainer = document.querySelector('.cloudservices');

    if (!cloudSection) return;

    const isAdmin = typeof is_admin !== 'undefined' ? is_admin : false;
    const typeRadio = document.querySelector('input[name="AdminType"]:checked');
    const isDepositMode = typeRadio && typeRadio.value === 'depot';

    if (!isAdmin || !isDepositMode) {
        cloudSection.style.display = 'none';
        return;
    }

    cloudSection.style.display = 'block';

    if (cloudServicesContainer) {
        cloudServicesContainer.style.display = 'flex';
        cloudServicesContainer.style.flexWrap = 'wrap';
        cloudServicesContainer.style.gap = '10px';
    }

    // hide all cards first
    const allCards = [
        'ticketcloudCard',
        'googleDriveCard',
        'nextcloudCard',
        'onedriveCard'
    ];

    allCards.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
    });

    // always show private cloud
    const privateCard = document.getElementById('ticketcloudCard');
    if (privateCard) privateCard.style.display = 'flex';

    try {
        // get active providers
        const providers = await api_call('/api/cloud/config');

        if (providers && Array.isArray(providers)) {
            if (providers.includes('google')) {
                const el = document.getElementById('googleDriveCard');
                if (el) el.style.display = 'flex';
            }
            if (providers.includes('onedrive')) {
                const el = document.getElementById('onedriveCard');
                if (el) el.style.display = 'flex';
            }
            if (providers.includes('nextcloud')) {
                const el = document.getElementById('nextcloudCard');
                if (el) el.style.display = 'flex';
            }
        }

        // update status
        const status = await api_call(`/api/cloud/status?roomCode=${room_code}`);
        ['google', 'nextcloud', 'onedrive', 'ticket'].forEach(p => set_cloud_card_state(p, 'idle'));

        if (status.connected && status.provider) {
            set_cloud_card_state(status.provider, 'connected');
        }
    } catch (e) {
        console.error("cloud status error", e);
    }
}


// handshake
async function handle_cloud_handshake(provider) {
    if (is_connecting_cloud) return;

    is_connecting_cloud = true;
    if (provider != 'nextcloud') {
        document.body.style.cursor = 'wait';
    }

    if (!crypto_key) {
        is_connecting_cloud = false;
        document.body.style.cursor = 'default';
        set_cloud_card_state(provider, "error", "Clé manquante");
        return alert("Clé de chiffrement introuvable.");
    }

    let auth_data = {};

    // nextcloud specific flow
    if (provider === 'nextcloud') {
        const nc_url = await prompt_nextcloud_creds();

        if (!nc_url) {
            is_connecting_cloud = false;
            document.body.style.cursor = 'default';
            set_cloud_card_state(provider, 'idle');
            return;
        }

        try {
            // export key
            const raw_key = await window.crypto.subtle.exportKey("raw", crypto_key);
            const key_arr = Array.from(new Uint8Array(raw_key));

            set_cloud_card_state(provider, 'loading');

            // get login link
            const res = await api_call('/api/cloud/nextcloud/init', 'POST', {
                roomCode: room_code,
                serverUrl: nc_url,
                cryptoKey: key_arr
            });

            if (res && res.loginUrl && res.pollToken) {
                const popup = window.open(res.loginUrl, '_blank', 'width=500,height=600');
                
                // poll until valid
                const interval = setInterval(async () => {
                    try {
                        const poll = await api_call('/api/cloud/nextcloud/poll', 'POST', { token: res.pollToken });
                        
                        if (poll.status === 'success') {
                            clearInterval(interval);
                            if (popup) popup.close();
                            await update_cloud_ui();
                            is_connecting_cloud = false;
                            document.body.style.cursor = 'default';
                        } else if (poll.status === 'error') {
                            throw new Error('Auth failed');
                        }
                        // pending...
                    } catch (e) {
                        clearInterval(interval);
                        is_connecting_cloud = false;
                        document.body.style.cursor = 'default';
                        set_cloud_card_state(provider, "error");
                    }
                }, 2000);
            } else {
                throw new Error("Init failed");
            }
        } catch (e) {
            is_connecting_cloud = false;
            document.body.style.cursor = 'default';
            set_cloud_card_state(provider, "error");
            alert("Erreur connexion: " + e.message);
        }
        return;
    }

    try {
        // export key
        const raw_key = await window.crypto.subtle.exportKey("raw", crypto_key);
        const key_arr = Array.from(new Uint8Array(raw_key));

        const body = {
            roomCode: room_code,
            provider: provider,
            cryptoKey: key_arr,
            authData: auth_data
        };

        const res = await api_call('/api/cloud/handshake', 'POST', body);

        if (!res) return;

        if (res.redirectUrl) {
            // redirect flow (google/onedrive)
            window.open(res.redirectUrl, '_blank', 'width=500,height=600');
        } 
        else if (res.connected || res.status === 'connected') {            
            await update_cloud_ui(); 
        }
    } catch (e) {
        set_cloud_card_state(provider, "error");
        alert("Erreur connexion: " + e.message);
    } finally {
        is_connecting_cloud = false;
        document.body.style.cursor = 'default';
    }
}

// disconnect
async function disconnect_cloud() {
    if (!confirm("Arrêter la sauvegarde Cloud ?")) return;
    try {
        await api_call('/api/cloud/disconnect', 'POST', { roomCode: room_code });
        render_cloud_settings();
    } catch (e) {
        alert("Erreur déconnexion");
    }
}

// nextcloud modal helper
function prompt_nextcloud_creds() {
    return new Promise((resolve) => {

        const overlay = create_tag('div', 'menu-overlay');
        overlay.style.display = 'flex';

        const box = create_tag('div', 'menu-box');

        // simplified ui
        box.innerHTML = `
            <h3>Connexion Nextcloud</h3>
            <form id="ncForm" class="nc-input-group" onsubmit="event.preventDefault(); document.getElementById('ncSubmit').click();">
                <input type="text" id="ncUrl" placeholder="URL (ex: https://cloud.exemple.com)" autocomplete="url" />
                <button type="submit" style="display:none;"></button>
            </form>

            <div class="overlay-footer" style="display:flex; justify-content:center; gap:10px;">
                <a class="button-text" id='ncCancel' style="width: auto; padding: 0 30px; margin: 0; min-width: 140px;">
                    <img class="icon" src="./assets/icon/cross.png">
                    <span class="text">Annuler</span>
                </a>
                <a class="button-text" id='ncSubmit' style="width: auto; padding: 0 30px; margin: 0; min-width: 140px; background-color: #9ecaff;">
                    <img class="icon" src="./assets/icon/action.png">
                    <span class="text">Connecter</span>
                </a>
            </div>
        `;

        overlay.appendChild(box);
        document.body.appendChild(overlay);

        const closeAndResolve = (value) => {
            overlay.remove();
            resolve(value);
        };

        document.getElementById('ncCancel').onclick = () => {
            closeAndResolve(null);
        };

        overlay.onclick = (e) => {
            if (e.target === overlay) {
                closeAndResolve(null);
            }
        };

        document.getElementById('ncSubmit').onclick = () => {
            const url = document.getElementById('ncUrl').value.trim();

            if (!url) return alert("URL requise");

            closeAndResolve(url);
        };
    });
}

// download modal logic
function open_download_modal(deposit) {
    current_modal_deposit_id = deposit.id;

    const modal = document.getElementById('download-modal');
    const list = document.getElementById('file-list');
    const dl_all_btn = document.getElementById('download-all');

    // cloud integration elements
    const cloud_provider_el = ui_elements.cloudstoragesolution;
    const cloud_account_el = ui_elements.cloudaccount;
    const cloud_path_el = ui_elements.cloudpath;
    const show_cloud_btn = ui_elements.showcloud;

    if (!modal || !list) return;

    modal.style.display = '';

    // reset cloud ui defaults
    if (cloud_provider_el) cloud_provider_el.textContent = "Stockage: Local";
    if (cloud_account_el) cloud_account_el.style.display = 'none';
    if (cloud_path_el) cloud_path_el.style.display = 'none';
    if (show_cloud_btn) show_cloud_btn.style.display = 'none';

    // populate cloud info if present
    if (deposit.cloudProvider) {
        if (cloud_provider_el) cloud_provider_el.textContent = `Stockage: ${deposit.cloudProvider}`;

        if (deposit.cloudAccount && cloud_account_el) {
            cloud_account_el.textContent = `Compte: ${deposit.cloudAccount}`;
            cloud_account_el.style.display = '';
        }

        if (deposit.cloudPath && cloud_path_el) {
            cloud_path_el.textContent = `Chemin: ${deposit.cloudPath}`;
            cloud_path_el.style.display = '';
        }

        if (deposit.cloudWebUrl && show_cloud_btn) {
            show_cloud_btn.style.display = 'flex';

            const iconImg = show_cloud_btn.querySelector('.icon');
            if (iconImg) {
                const providerKey = deposit.cloudProvider.toLowerCase();
                if (providerKey.includes('google')) {
                    iconImg.src = "./assets/icon/gdrive.png";
                } else if (providerKey.includes('onedrive')) {
                    iconImg.src = "./assets/icon/onedrive.png";
                } else if (providerKey.includes('nextcloud')) {
                    iconImg.src = "./assets/icon/nextcloud.png";
                } else {
                    iconImg.src = "./assets/icon/cloud.png";
                }
            }

            show_cloud_btn.onclick = (e) => {
                e.preventDefault();
                window.open(deposit.cloudWebUrl, '_blank');
            }
        }
    }

    list.innerHTML = '';
    const files = deposit.files || [];

    // remove default list styling
    list.style.listStyle = 'none';
    list.style.padding = '0';

    if (files.length === 0) {
        list.innerHTML = '<li style="justify-content:center; opacity:0.5; padding: 20px; text-align:center;">Aucun fichier</li>';
        if (dl_all_btn) dl_all_btn.style.display = 'none';
    } else {
        if (dl_all_btn) dl_all_btn.style.display = 'flex';

        files.forEach(file => {
            const size = (file.size / (1024 * 1024)).toFixed(2);

            //custom name priority
            const original_name = file.originalName || file.name;
            const main_name = file.customName || original_name;
            const sub_info = file.customName ? `${original_name} • ${size} Mo` : `${size} Mo`;

            const li_style = {
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '10px 20px',
                borderRadius: '50px',
                marginBottom: '8px',
                border: '2px solid black',
                background: '#fff'
            };

            const li = create_tag('li', '', '', li_style);

            // content structure
            const content_div = create_tag('div', '', `
                <div style="font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:280px;" title="${main_name}">${main_name}</div>
                <div style="font-size:0.8em; opacity:0.6; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:280px;">${sub_info}</div>
            `, { display: 'flex', flexDirection: 'column', overflow: 'hidden', marginRight: '10px' });

            const btn = create_tag('button', 'announcement-download', '<img src="./assets/icon/download.png" style="width:20px;">');
            // fix button style for modal context
            btn.style.flexShrink = '0';
            btn.onclick = () => handle_file_download(file.id, file.originalName || file.name);

            li.appendChild(content_div);
            li.appendChild(btn);
            list.appendChild(li);
        });

        // download all handler
        if (dl_all_btn) {
            const new_btn = dl_all_btn.cloneNode(true);
            dl_all_btn.parentNode.replaceChild(new_btn, dl_all_btn);

            new_btn.onclick = async (e) => {
                e.preventDefault();
                const originalText = new_btn.innerHTML;
                new_btn.innerHTML = 'Préparation du ZIP...';
                new_btn.style.opacity = '0.7';
                new_btn.disabled = true;

                try {
                    const zip = new JSZip();

                    // get and process each file
                    for (const file of files) {
                        // download encrypted blob
                        const blob_enc = await api_download(file.id);

                        // decrypt blob
                        const blob_clear = await decrypt_blob(blob_enc);

                        // determine filename
                        const original_name = file.originalName || file.name;
                        let filename = file.customName
                            ? `${normalize_name_segment(file.customName)}.${original_name.split('.').pop()}`
                            : original_name;

                        // add to zip
                        zip.file(filename, blob_clear);
                    }

                    // generate zip
                    const content = await zip.generateAsync({ type: "blob" });

                    // save
                    saveAs(content, `depot-${deposit.name || 'fichiers'}.zip`);

                } catch (err) {
                    console.error("Erreur ZIP:", err);
                    alert("Erreur lors de la création du ZIP via le navigateur.");
                } finally {
                    new_btn.innerHTML = originalText;
                    new_btn.style.opacity = '1';
                    new_btn.disabled = false;
                }
            };
        }
    }

    modal.classList.remove('hidden');
}

function setup_download_modal_listeners() {
    const modal = document.getElementById('download-modal');
    const close_btn = document.getElementById('close-modal');

    if (close_btn && modal) {
        close_btn.onclick = () => {
            modal.classList.add('hidden');
            current_modal_deposit_id = null; // reset tracker
        };
    }

    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.classList.add('hidden');
                current_modal_deposit_id = null; // reset tracker
            }
        });
    }
}

// logs

function capture_log(type, args) {
    original_console[type].apply(console, args);
    const msg = args.map(arg =>
        typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
    ).join(' ');
    log_buffer.push(`[${new Date().toISOString()}] [${type.toUpperCase()}] ${msg}`);
    if (log_buffer.length > max_logs) log_buffer.shift();
}

console.log = (...args) => capture_log('log', args);
console.error = (...args) => capture_log("error", args);
console.warn = (...args) => capture_log('warn', args);

window.onerror = (msg, source, lineno) => {
    console.error(`Uncaught: ${msg} at ${source}:${lineno}`);
};

let current_report_ctx = 'manual';
let last_blocked_info = null;

function open_report_overlay(context, prefill_text = '') {
    close_all_overlays(); // close settings or ai warning
    current_report_ctx = context;

    const desc = document.getElementById('bugDescription');
    if (desc) {
        desc.value = prefill_text ? `Erreur IA: ${prefill_text}\n\nCommentaire: ` : '';
        // focus if manual, otherwise just show
        if (!prefill_text) setTimeout(() => desc.focus(), 100);
    }

    toggle_overlay('bugReportOverlay', true);
}

async function submit_bug_report() {
    const btn = document.getElementById('sendBugReport');
    const desc = document.getElementById('bugDescription');
    const description = desc ? desc.value.trim() : '';

    if (btn) btn.classList.add('button-disabled');

    let ai_context_data = null;
    if (current_report_ctx === 'ai_blocked' && last_blocked_info) {
        ai_context_data = {
            user_input: last_blocked_info.input,
            ai_response: last_blocked_info.reason
        };
    }

    const payload = {
        logs: log_buffer,
        description: description,
        context: current_report_ctx,
        aiData: ai_context_data,
        roomCode: room_code, // from global state
        clientData: {
            userAgent: navigator.userAgent,
            url: window.location.href,
            resolution: `${window.innerWidth}x${window.innerHeight}`
        }
    };

    try {
        // simulation of api call using original console to avoid loop
        original_console.log('Sending report...', payload);

        const res = await fetch(`${api_url}/api/report`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (res.ok) {
            notif('Signalement envoyé.', 'success');
            toggle_overlay('bugReportOverlay', false);
            if (desc) desc.value = '';
        } else {
            throw new Error('Server error ' + res.status);
        }
    } catch (err) {
        original_console.error('Report failed', err);
        notif('Erreur envoi signalement.', "error");
    } finally {
        if (btn) btn.classList.remove('button-disabled');
    }
}

function update_report_ui() {
    const globalBtn = document.getElementById('openGlobalReport');
    const aiBtn = document.getElementById('openAiReport');

    if (!report_enabled) {
        if (globalBtn) globalBtn.style.display = 'none';
        if (aiBtn) aiBtn.style.display = 'none';
    } else {
        // restore display if enabled 
        if (globalBtn) globalBtn.style.display = 'flex'; // ou 'block'
        if (aiBtn) aiBtn.style.display = 'flex'; // ou 'flex'
    }
}


// encryption

async function init_crypto(room_code_str) {
    const enc = new TextEncoder();
    const key_material = await window.crypto.subtle.importKey(
        "raw", enc.encode(room_code_str), "PBKDF2", false, ["deriveKey"]
    );

    crypto_key = await window.crypto.subtle.deriveKey(
        { name: "PBKDF2", salt: enc.encode("ticket-static-salt"), iterations: 100000, hash: "SHA-256" },
        key_material,
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt", "decrypt"]
    );
    console.log('🔒 Crypto key ready');
}

async function encrypt_file(file) {
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const buffer = await file.arrayBuffer();
    const encrypted_content = await window.crypto.subtle.encrypt({ name: "AES-GCM", iv }, crypto_key, buffer);
    return new Blob([iv, encrypted_content], { type: 'application/octet-stream' });
}

async function decrypt_blob(blob) {
    const buffer = await blob.arrayBuffer();
    const iv = buffer.slice(0, 12);
    const data = buffer.slice(12);
    const decrypted_content = await window.crypto.subtle.decrypt({ name: "AES-GCM", iv }, crypto_key, data);
    return new Blob([decrypted_content]);
}


// api

async function api_call(endpoint, method = "GET", body = null) {
    try {
        const options = { method, headers: { "Content-Type": "application/json" }, credentials: 'include' };
        if (body) options.body = JSON.stringify(body);

        const res = await fetch(`${api_url}${endpoint}`, options);
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || `Erreur serveur (${res.status})`);
        }
        if (method === "DELETE") return res.ok;
        return await res.json();
    } catch (e) {
        console.error(`API Error ${method} ${endpoint}:`, e);
        if (e.message && (e.message.includes("bloqué") || e.message.includes("blocked"))) throw e;
        return method === "GET" ? [] : null;
    }
}

async function api_download(file_id) {
    const res = await fetch(`${api_url}/api/files/download/${file_id}`);
    if (!res.ok) throw new Error('Download failed');
    return await res.blob();
}


// ui init

function init_ui() {
    const ids = [
        'copyLink', 'copyText', 'codebutton', 'storageText', 'fileCountText',
        'storageProgressBar', 'announcementContainer', 'announcementArea',
        'adminFilesList', 'right', 'subdiv', 'create', 'createbutton',
        'formOverlay', 'settingsOverlay', 'logoutOverlay', 'name', 'infos',
        'fileUploadContainer', 'adminSettingsSection', 'adminTypeSelector', 'dropArea', 'fileInput',
        'aiToggle', 'aiStatus', 'forceNameToggle', 'reportTicketOverlay',
        'loginOverlay', 'loginName', 'loginEnter', 'issueNameOverlay',
        'nameChoicesContainer', 'csvButton', 'csvInput', 'qrcode-container'
        , 'depositOverlay', 'depositCustomName', 'depositDropArea', 'depositFileInput', 'depositFileName', 'depositSend', 'depositCancel',
        'bugReportOverlay', 'bugDescription', 'sendBugReport',
        'cancelBugReport', 'openGlobalReport', 'openAiReport',
        'cloudstoragesolution', 'cloudaccount', 'cloudpath', 'showcloud',
        'langToggle', 'languageOverlay', 'closeLangOverlay'
    ];

    ids.forEach(id => {
        ui_elements[id] = document.getElementById(id);
    });
}

// qr code logic
function render_room_qr() {
    const container = ui_elements['qrcode-container'];
    if (!container || qr_instance) return;

    const roomcode_text = document.querySelector('#copyText');
    if (roomcode_text) roomcode_text.textContent = room_code;

    roomcode_text.addEventListener('click', () => {
        //copy and modify text to "copié" for 2 seconds
        navigator.clipboard.writeText(window.location.href);
        const original_text = roomcode_text.textContent;
        roomcode_text.textContent = "Copié !";
        setTimeout(() => {
            roomcode_text.textContent = original_text;
        }, 2000);
    });

    // init qr styler
    qr_instance = new QRCodeStyling({
        width: 250,
        height: 250,
        type: "canvas",
        data: window.location.href,
        margin: 0,
        qrOptions: { typeNumber: "0", mode: "Byte", errorCorrectionLevel: "Q" },
        dotsOptions: { type: "extra-rounded", color: "#000000" },
        backgroundOptions: { color: "transparent" },
        image: "data:image/png;base64,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",
        cornersSquareOptions: { type: "extra-rounded", color: "#000000" }
    });

    qr_instance.append(container);
}

function start_dots(idx) {
    if (dot_interval) clearInterval(dot_interval);
    const txt = document.getElementById(`prog-txt-${idx}`);
    if (!txt) return;

    const states = ['traitement.', 'traitement..', 'traitement...'];
    let i = 0;
    txt.textContent = states[0];
    txt.style.fontSize = '0.8em';

    dot_interval = setInterval(() => {
        i = (i + 1) % states.length;
        txt.textContent = states[i];
    }, 500);
}

function stop_dots() {
    if (dot_interval) {
        clearInterval(dot_interval);
        dot_interval = null;
    }
}

function show_copy_feedback(element, original_text, success_text = "Copié !") {
    element.textContent = success_text;
    setTimeout(() => { element.textContent = original_text; }, 2000);
}

function toggle_overlay(id, show) {
    const el = ui_elements[id] || document.getElementById(id);
    if (el) el.style.display = show ? "flex" : "none";
}

function close_all_overlays() {
    document.querySelectorAll('.menu-overlay').forEach(el => {
        // prevent closing login overlay if locked
        if (el.id === 'loginOverlay' && !is_admin && (csv_mode || force_name_mode) && !student_name) return;
        el.style.display = "none";
    });
}

function show_connection_error() {
    const overlay = create_tag('div', 'menu-overlay', '', { display: 'flex', zIndex: '9999' });
    const box = create_tag('div', 'menu-box');
    const title = create_tag('h1', '', 'Impossible de se connecter');
    title.style.color = '#d40000';
    const msg = create_tag('p', '', 'La connexion au serveur a échoué. \n Attendez ou quittez la salle.');
    msg.style.marginBottom = '20px';
    msg.style.textAlign = 'center';

    const btn = create_tag('a', 'button-text', `<img class="icon" src="./assets/icon/logout.png"><span class="text">Partir</span>`, { width: 'auto', padding: '0 30px', margin: '0', minWidth: '140px' });
    btn.href = '/';
    btn.onclick = (e) => {
        e.preventDefault();
        localStorage.removeItem('last_room');
        window.location.href = '/';
    };

    box.appendChild(title); box.appendChild(msg); box.appendChild(btn);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
}


// main initialization

async function init_app() {
    init_ui();
    // resolve API (local first) so subsequent API calls use correct base
    await resolveApiBase();
    const can_proceed = await load_resources();

    document.body.classList.add('loaded');
    const code_span = document.querySelector('#codebutton .text');
    if (code_span) code_span.textContent = room_code;

    render_room_qr();
    setup_event_listeners();

    // only start ws if no login pending
    if (can_proceed) {
        setup_websocket();
    }
}

async function load_resources() {
    await init_crypto(room_code);
    const proceed = await check_permissions(); // returns false if login required

    try {
        const res = await fetch(`./assets/filter.json?cb=${Date.now()}`);
        const data = await res.json();
        banned_terms = data.banned_terms || [];
    } catch (e) {
        console.error("Filter load error", e);
    }

    if (proceed) {
        await sync_announcements();
        await sync_deposits();
        await render_tickets();
    }
    return proceed;
}

async function check_permissions() {
    // send userid in query
    const data = await api_call(`/api/rooms/${room_code}?userId=${user_id}`);

    if (!data || data.error || Array.isArray(data)) {
        window.location.href = "/?error=notfound";
        return false;
    }

    report_enabled = data.reportEnabled || false;
    update_report_ui();

    if (data.maxTickets) {
        max_tickets = data.maxTickets;
        const radio = document.querySelector(`input[name="SliderCount"][value="${data.maxTickets}"]`);
        if (radio) radio.checked = true;
    }

    ai_enabled = data.aiEnabled || false;
    if (ui_elements.aiToggle) ui_elements.aiToggle.checked = ai_enabled;
    update_ai_status(ai_enabled);

    // csv logic
    csv_mode = data.hasCsv || false;
    force_name_mode = data.forceName || false;

    // update ui toggle
    const fnToggle = ui_elements.forceNameToggle;
    if (fnToggle) {
        if (csv_mode) {
            // if csv active, force name is mandatory and locked
            fnToggle.checked = true;
            fnToggle.disabled = true;
            fnToggle.parentElement.style.opacity = '0.5';
            fnToggle.parentElement.title = "Géré par le fichier CSV";
        } else {
            // standard mode
            fnToggle.checked = force_name_mode;
            fnToggle.disabled = false;
            fnToggle.parentElement.style.opacity = '1';
            fnToggle.parentElement.title = "";
        }
    }

    // server status
    const new_admin_status = data.isAdmin === true;

    if (is_admin !== new_admin_status || !document.body.dataset.initDone) {
        set_admin_mode(new_admin_status);
        document.body.dataset.initDone = "true";
    }

    if (!is_admin && (csv_mode || force_name_mode)) {
        if (!student_name) {
            const overlay = document.getElementById('loginOverlay');
            if (overlay && overlay.style.display !== 'flex') {
                start_login_flow();
            }
            return false;
        }
    }

    return true;
}

function update_ai_status(enabled) {
    const el = ui_elements.aiStatus;
    if (!el) return;
    if (enabled) {
        el.textContent = "IA active et opérationnelle";
        el.style.color = "#4CAF50";
    } else {
        el.textContent = "IA désactivée ou indisponible (filtre local actif)";
        el.style.color = "#ff9800";
    }
}

function set_admin_mode(status) {
    if (is_admin === status && document.body.dataset.initDone === "true") return;

    // update state
    is_admin = status;
    const { createbutton, name, infos, formOverlay, fileUploadContainer, adminSettingsSection, adminTypeSelector } = ui_elements;

    // hide or show admin sections
    if (adminTypeSelector) adminTypeSelector.style.display = is_admin ? 'flex' : 'none';
    if (adminSettingsSection) adminSettingsSection.style.display = is_admin ? 'block' : 'none';
    if (fileUploadContainer) fileUploadContainer.style.display = is_admin ? 'flex' : 'none';

    setup_csv_settings();

    // ui elements update
    const title = formOverlay.querySelector('h1');
    const btn_text = createbutton.querySelector('.text');

    if (is_admin) {
        const currentType = document.querySelector('input[name="AdminType"]:checked')?.value;

        if (btn_text) btn_text.textContent = "Nouveau message";
        if (name) { name.placeholder = "Message"; name.value = ""; }
        if (infos) infos.style.display = 'none';
        if (title) title.textContent = currentType === 'depot' ? "Nouveau dépot" : "Nouveau message";

        pending_files = [];
        render_pending_files();
    } else {
        if (btn_text) btn_text.textContent = "Nouveau ticket";
        if (name) {
            name.placeholder = "Nom";
            name.value = "";
        }
        if (infos) infos.style.display = 'block';
        if (title) title.textContent = "Nouveau ticket";
    }

    if (is_admin || (csv_mode && student_name) || !csv_mode) {
        sync_announcements();
        render_tickets();
    }
}

function setup_admin_type_listener() {
    document.querySelectorAll('input[name="AdminType"]').forEach(radio => {
        radio.addEventListener('change', (e) => {
            const title = ui_elements.formOverlay.querySelector('h1');
            const type = e.target.value;

            if (type === 'depot') {
                title.textContent = "Nouveau dépôt";
                if (fileUploadContainer) {
                    fileUploadContainer.style.display = 'none';
                }
            } else {
                title.textContent = "Nouveau message";
                fileUploadContainer.style.display = 'flex';
            }
            update_cloud_ui();
        });
    });
}

// login flow

function start_login_flow() {
    toggle_overlay('loginOverlay', true);
}

async function handle_login_submit() {
    const input = ui_elements.loginName;
    const val = input.value.trim();
    if (!val) return;

    if (force_name_mode && !csv_mode) {
        if (val.length < 2) return alert("Nom trop court.");
        complete_login(val);
        return;
    }

    try {
        const res = await api_call(`/api/rooms/${room_code}/check-name`, 'POST', { nameQuery: val });

        if (res.status === 'none') {
            alert("Nom introuvable dans la liste.");
        } else if (res.status === 'found') {
            complete_login(res.name);
        } else if (res.status === 'multiple') {
            toggle_overlay('loginOverlay', false);
            show_name_choices(res.options);
        }
    } catch (e) {
        alert("Erreur vérification: " + e.message);
    }
}

function show_name_choices(options) {
    const container = ui_elements.nameChoicesContainer;
    container.innerHTML = '';

    options.forEach(name_opt => {
        const btn = create_tag('a', 'button-text', `<span class="text">${name_opt}</span>`, {
            justifyContent: 'center', padding: '0', minHeight: '45px', margin: '0'
        });

        btn.onclick = (e) => {
            e.preventDefault();
            complete_login(name_opt);
            toggle_overlay('issueNameOverlay', false);
        };
        container.appendChild(btn);
    });

    toggle_overlay('issueNameOverlay', true);
}

function complete_login(validated_name) {
    student_name = validated_name;
    sessionStorage.setItem('student_name_cache', student_name);
    toggle_overlay('loginOverlay', false);

    // resume init
    sync_announcements();
    render_tickets();
    setup_websocket();
}


// tickets

async function render_tickets(external_update = false) {
    const data = await api_call(`/api/tickets/${room_code}`);
    tickets_list = Array.isArray(data) ? data : [];

    const current_ids = new Set(tickets_list.map(t => t.id));
    let new_id = null;

    if (external_update) {
        for (const id of current_ids) {
            if (!last_ticket_ids.has(id)) {
                new_id = id;
                break;
            }
        }
    }
    last_ticket_ids = current_ids;

    const active = tickets_list.filter(t => t.etat === "en cours");
    const history = tickets_list.filter(t => t.etat !== "en cours");

    update_ticket_container('right', active, new_id, true);
    update_ticket_container('subdiv', history, new_id, false);
}

function update_ticket_container(container_id, list, new_id, is_active) {
    const container = ui_elements[container_id];
    if (!container) return;

    container.querySelectorAll(is_active ? '.during' : '.history').forEach(el => el.remove());
    container.querySelector('.empty-message')?.remove();

    if (list.length === 0) {
        const msg = create_tag('div', 'empty-message', is_active ? "<Aucun ticket en cours>" : "<Aucun ticket terminé>");
        container.appendChild(msg);
        return;
    }

    list.forEach(t => {
        const div = create_tag('div', is_active ? "during" : "history");
        div.id = t.id;

        if (t.couleur?.includes('gradient')) div.style.backgroundImage = t.couleur;
        else div.style.backgroundColor = t.couleur || "#cdcdcd";

        if (t.id === new_id) {
            div.classList.add('add');
            setTimeout(() => div.classList.remove('add'), animation_delay);
        }

        const time_str = t.dateCreation ? new Date(t.dateCreation).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
        const can_delete = is_admin || (is_active && t.userId === user_id);
        const delete_btn = can_delete ? `<a class="delete" data-id="${t.id}"><img src="assets/icon/delete.png" style="width:22px; height:22px;"></a>` : "";

        if (is_active) {
            let info = `<p id="name">${t.nom}</p>`;
            if (t.description?.trim()) info += `<p id="desc">${t.description}</p>`;
            div.innerHTML = `<div class="checkbox" data-id="${t.id}"></div><div class="info">${info}</div><div class="time"><p id="created">${time_str}</p><p id="remaining">${format_time_elapsed(t.dateCreation)}</p></div>${delete_btn}`;
        } else {
            div.innerHTML = `<p class="name">${t.nom}</p><div class="time"><p class="created">${time_str}</p><p class="etat">${t.etat}</p></div>${delete_btn}`;
        }

        const btn = div.querySelector('.delete');
        if (btn) btn.onclick = (e) => handle_ticket_delete(e, t.id);
        container.appendChild(div);
    });
}

async function handle_ticket_delete(e, id) {
    e.stopPropagation();
    const el = e.target.closest('.during, .history');
    if (!el) return;
    el.classList.add('bounce-reverse');
    el.addEventListener('animationend', async () => {
        await fetch(`${api_url}/api/tickets/${id}?userId=${user_id}&admin=${is_admin}&roomCode=${room_code}`, { method: "DELETE" });
        el.remove();
        render_tickets();
    }, { once: true });
}


// announcements & files

async function sync_announcements() {
    const data = await api_call(`/api/announcements/${room_code}`);
    if (Array.isArray(data)) {
        announcements_list = data;
        update_storage_ui();
        render_announcements();
    }
}

function update_storage_ui() {
    let total_bytes = 0;
    let total_files = 0;

    // calcul des fichiers
    announcements_list.forEach(a => {
        if (a.files) {
            total_files += a.files.length;
            a.files.forEach(f => total_bytes += f.size);
        }
    });

    const { storageText, storageProgressBar, announcementContainer, fileCountText } = ui_elements;

    if (storageText) storageText.textContent = format_bytes(total_bytes) + ' / ' + format_bytes(max_storage_bytes);
    if (fileCountText) fileCountText.textContent = `${total_files} fichier${total_files > 1 ? 's' : ''} partagé${total_files > 1 ? 's' : ''}`;

    let pct = (total_bytes / max_storage_bytes) * 100;

    if (pct < 5 && total_bytes > 0) pct = 5;
    if (pct > 100) pct = 100;

    if (storageProgressBar) storageProgressBar.style.width = `${pct}%`;

    if (announcementContainer) {
        if (announcements_list.length === 0 && deposits_list.length === 0) {
            announcementContainer.classList.add('is-empty');
        } else {
            announcementContainer.classList.remove('is-empty');
        }
    }
}

function render_announcements() {
    const container = ui_elements.announcementArea;
    if (!container) return;
    container.innerHTML = '';
    container.classList.remove('hidden');

    // merge lists and sort by date
    const all_items = [
        ...announcements_list.map(a => ({ ...a, item_type: 'annonce' })),
        ...deposits_list.map(d => ({ ...d, item_type: 'depot' }))
    ].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

    const left_container = document.querySelector('.left-container');
    if (left_container) left_container.style.gap = all_items.length === 0 ? '0px' : '';

    all_items.forEach((item, index) => {
        const is_depot = item.item_type === 'depot';
        const wrapper = create_tag('div', 'announcement-wrapper');
        if (is_depot) wrapper.classList.add('depot');

        wrapper.style.setProperty('--i', index);

        const bg = item.color || '#cdcdcd';
        const style = { display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: '8px' };
        if (bg.includes('gradient')) style.backgroundImage = bg;
        else style.backgroundColor = bg;

        const msg_div = create_tag('div', 'announcement-item', '', style);
        if (is_depot) msg_div.classList.add('depot-item');

        // check for user file in deposit
        let user_file = null;
        if (is_depot && !is_admin && item.files) {
            user_file = item.files.find(f => f.userId === user_id);
        }

        let content_text = is_depot ? `${item.name}` : item.content;

        // append filename if user uploaded
        if (user_file) {
            content_text += `<div style="font-size:0.85em; opacity:0.8; margin-top:4px; font-weight:normal;">Fichier envoyé : ${user_file.originalName}</div>`;
        }

        if (content_text?.trim()) {
            let btn_html = '';

            // admin logic for buttons
            if (is_admin) {
                if (is_depot) {
                    // count files
                    const file_count = item.files ? item.files.length : 0;
                    const count_txt = `<span style="font-size:0.8em; margin-right:10px; white-space: nowrap; opacity:0.6;">${file_count} fichier${file_count > 1 ? 's' : ''} partagé${file_count > 1 ? 's' : ''}</span>`;

                    // download button
                    const dl_btn = `<button class="announcement-download" title="Voir les fichiers" style="margin-right:5px;"><img src="./assets/icon/download.png" alt="DL"></button>`;

                    // delete button
                    const del_btn = `<button class="announcement-delete" title="Supprimer"><img src="./assets/icon/delete.png" alt="X"></button>`;

                    btn_html = count_txt + dl_btn + del_btn;
                } else {
                    // standard announcement delete
                    btn_html = `<button class="announcement-delete" title="Supprimer"><img src="./assets/icon/delete.png" alt="X"></button>`;
                }
            } else if (is_depot) {
                if (user_file) {
                    // show delete button
                    btn_html = `<button class="announcement-delete-file" title="Supprimer mon fichier"><img src="./assets/icon/delete.png" alt="X"></button>`;
                } else {
                    // show add button
                    btn_html = `<button class="announcement-action-btn" title="Ajouter"><img src="./assets/icon/add.png" alt="+"></button>`;
                }
            }

            const text_row = create_tag('div', '', `
                <div class="announcement-content" style="width:100%;"><span class="announcement-text">${content_text}</span></div>
                <div class="announcement-actions" style="display:flex; align-items:center;">${btn_html}</div>
            `, { display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' });

            // attach events
            if (is_admin) {
                const delete_btn = text_row.querySelector('.announcement-delete');
                const path = is_depot ? `/api/deposits/${item.id}` : `/api/announcements/${item.id}`;

                delete_btn.addEventListener('click', (e) => {
                    if (is_depot && item.files && item.files.length > 0) {
                        e.preventDefault();
                        const confirm_msg = `Attention !\nCe dépôt contient ${item.files.length} fichier(s).\n\nVoulez-vous vraiment le supprimer définitivement ?`;
                        if (!confirm(confirm_msg)) return;
                    }
                    delete_item(e, path, wrapper);
                });

                if (is_depot) {
                    const download_btn = text_row.querySelector('.announcement-download');
                    if (download_btn) {
                        download_btn.addEventListener('click', (e) => {
                            e.preventDefault();
                            open_download_modal(item);
                        });
                    }
                }

            } else if (is_depot) {
                if (user_file) {
                    // delete user file handler
                    const del_btn = text_row.querySelector('.announcement-delete-file')
                    if (del_btn) {
                        del_btn.addEventListener('click', (e) => {
                            // delete via file api
                            delete_item(e, `/api/files/${user_file.id}`, null); // null wrapper to force refresh via ws or sync
                        });
                    }
                } else {
                    // upload handler
                    const add_btn = text_row.querySelector('.announcement-action-btn');
                    if (add_btn) add_btn.addEventListener('click', () => open_deposit_overlay(item));
                }
            }
            msg_div.appendChild(text_row);
        }

        // files logic (for standard announcements)
        if (!is_depot && item.files?.length > 0) {
            const file_container = create_tag('div', '', '', { display: 'flex', flexDirection: 'column', gap: '4px', width: '100%' });
            item.files.forEach(file => render_file_item(file, item.id, file_container));
            msg_div.appendChild(file_container);
        }

        wrapper.appendChild(msg_div);
        container.appendChild(wrapper);
    });
}

function normalize_name_segment(str) {
    if (!str) return '';
    // strict normalization: lowercase, no accents, alphanumeric/underscores only
    const norm = str.normalize('NFD').replace(/\p{Diacritic}/gu, '');
    return norm.toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/[\s-]+/g, '_');
}

async function sync_deposits() {
    try {
        const data = await api_call(`/api/rooms/${room_code}/deposits`);
        deposits_list = Array.isArray(data) ? data : [];
        update_storage_ui();
        render_announcements(); // redraw unified list

        // refresh admin modal if open
        if (current_modal_deposit_id) {
            const updated_dep = deposits_list.find(d => d.id === current_modal_deposit_id);
            if (updated_dep) {
                open_download_modal(updated_dep);
            }
        }
    } catch (e) {
        console.error("sync deposits error", e);
    }
}

function render_deposits_list(container) {
    container.innerHTML = '';
    deposits_list.forEach(dep => {
        const row = create_tag('div', 'deposit-item', '', { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 20px', borderRadius: '50px', marginBottom: '8px', border: '2px solid black', background: '#fff' });
        const left = create_tag('div', '', `<strong>${dep.name}</strong><div style="font-size:0.85em; opacity:0.8">Dépôt ouvert</div>`);
        const actions = create_tag('div', '', '', { display: 'flex', gap: '8px', alignItems: 'center' });

        if (is_admin) {
            const del = create_tag('button', 'announcement-delete', `<img src="./assets/icon/delete.png" style="width:18px;height:18px">`);
            del.onclick = async (e) => { e.preventDefault(); if (!confirm('Supprimer le dépôt ?')) return; await delete_deposit(dep.id); };
            actions.appendChild(del);
        } else {
            const add = create_tag('button', 'announcement-action-btn', `<img src="./assets/icon/add.png" style="width:18px;height:18px">`);
            add.onclick = (e) => { e.preventDefault(); open_deposit_overlay(dep); };
            actions.appendChild(add);
        }

        row.appendChild(left); row.appendChild(actions); container.appendChild(row);
    });
}

function open_deposit_overlay(dep) {
    current_deposit_target = dep;
    deposit_pending_file = null;
    const overlay = document.getElementById('depositOverlay');
    const nameInput = document.getElementById('depositCustomName');

    // display file upload ui
    Array.from(document.getElementsByClassName('file-upload-container')).forEach(el => {
        el.style.display = 'block'
    })

    // clear previous file ui
    render_deposit_ui();

    if (!overlay) return;
    if (nameInput) nameInput.value = '';
    toggle_overlay('depositOverlay', true);
}

function render_deposit_ui() {
    const list = document.getElementById('depositFilesList');
    if (!list) return;
    list.innerHTML = '';

    if (deposit_pending_file) {
        const file = deposit_pending_file;
        const size = (file.size / (1024 * 1024)).toFixed(2);

        // reuse 'admin-file-item' classes for consistent look
        const item = create_tag('div', 'admin-file-item', `
            <div class="admin-file-info">
                <span class="admin-file-name">${file.name}</span>
                <span class="admin-file-size">${size} Mo</span>
            </div>
            <button class="admin-file-delete">×</button>
        `);

        // delete handler
        item.querySelector('.admin-file-delete').onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            deposit_pending_file = null;
            render_deposit_ui(); // re-render empty
            document.getElementById('depositFileInput').value = ''; // clear input
        };

        list.appendChild(item);

        // hide placeholder if file exists (optional, depends on css)
        const ph = document.querySelector('#depositDropArea .file-placeholder');
        if (ph) ph.style.display = 'none';
    } else {
        // show placeholder
        const ph = document.querySelector('#depositDropArea .file-placeholder');
        if (ph) ph.style.display = 'block';
    }
}

async function create_deposit(name, color, provider = null) {
    if (!name || !name.trim()) return alert('Nom requis');
    try {
        await api_call('/api/deposits', 'POST', {
            roomCode: room_code,
            userId: user_id,
            name: name.trim(),
            color: color,
            cloudProvider: provider
        });
        toggle_overlay('formOverlay', false);
    } catch (e) {
        alert('Erreur création dépôt: ' + (e.message || e));
    }
}

async function delete_deposit(id) {
    try {
        await api_call(`/api/deposits/${id}?userId=${user_id}`, 'DELETE');
        // refresh happens via websocket update
    } catch (e) { alert('Erreur suppression'); }
}

// deposit upload handling
function setup_deposit_drag_drop() {
    const drop = document.getElementById('depositDropArea');
    const input = document.getElementById('depositFileInput');
    if (!drop || !input) return;

    // click to upload
    drop.onclick = (e) => {
        // prevent click if clicking delete button
        if (e.target.classList.contains('admin-file-delete')) return;
        if (deposit_pending_file) return alert('Un seul fichier autorisé. Supprimez-le pour en changer.');
        input.click();
    };

    // input change
    input.onchange = () => {
        if (input.files && input.files[0]) {
            deposit_pending_file = input.files[0];
            render_deposit_ui();
        }
    };

    // drag events
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(ev => {
        drop.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); }, false);
    });

    drop.addEventListener('dragenter', () => drop.classList.add('drag-over'));
    drop.addEventListener('dragleave', () => drop.classList.remove('drag-over'));

    drop.addEventListener('drop', (e) => {
        drop.classList.remove('drag-over');
        const f = e.dataTransfer.files[0];
        if (!f) return;

        if (deposit_pending_file) {
            alert('Un seul fichier autorisé. Supprimez l\'actuel pour remplacer.');
            return;
        }

        deposit_pending_file = f;
        render_deposit_ui();
    });
}

async function upload_deposit() {
    if (!current_deposit_target) return notif('Dépôt introuvable', "error");
    if (!deposit_pending_file) return notif('Aucun fichier sélectionné', "error");

    if (deposit_pending_file.size > 50 * 1024 * 1024) {
        return notif('Fichier trop volumineux (max 50 Mo).', "error");
    }

    const customNameEl = document.getElementById('depositCustomName');
    const customName = customNameEl?.value.trim() || '';

    // ia/local filter check
    if (!ai_enabled) {
        if (banned_terms.some(term => new RegExp(`\\b${term.toLowerCase()}\\b`, 'i').test(customName))) return notif('Nom bloqué par le filtre local.');
    }

    // show loading state
    const warning = document.getElementById('depositWarning');
    if (warning) warning.style.display = 'block';
    const sendBtn = document.getElementById('depositSend');
    if (sendBtn) sendBtn.classList.add('button-disabled');

    // prepare filename logic
    let outNameBase = '';

    if (customName) {
        // use custom name only
        outNameBase = normalize_name_segment(customName);
    } else {
        // use depositname.originalfilename
        const segmentA = normalize_name_segment(current_deposit_target.name || 'depot');

        // get original name without extension
        const parts = deposit_pending_file.name.split('.');
        const originalBase = parts.length > 1 ? parts.slice(0, -1).join('.') : parts[0];

        outNameBase = `${segmentA}.${normalize_name_segment(originalBase)}`;
    }

    try {
        const enc_blob = await encrypt_file(deposit_pending_file);
        // get clean extension
        const parts = deposit_pending_file.name.split('.');
        const ext = parts.length > 1 ? parts.pop().replace(/[^a-zA-Z0-9]/g, '') : '';
        const filename = ext ? `${outNameBase}.${ext}` : outNameBase;

        const form = new FormData();
        form.append('file', enc_blob, filename);
        form.append('userId', user_id);
        form.append('roomCode', room_code);
        form.append('customName', customName || '');

        const res = await fetch(`${api_url}/api/deposits/${current_deposit_target.id}/upload`, { method: 'POST', body: form, credentials: 'include' });

        if (res.ok) {
            // reset ui
            deposit_pending_file = null;
            if (customNameEl) customNameEl.value = '';
            render_deposit_ui(); // clear list
            toggle_overlay('depositOverlay', false);

            // force update immediately
            await sync_deposits();

            notif("Fichier envoyé avec succès !");
        } else {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || 'Erreur serveur lors de l\'envoi');
        }
    } catch (e) {
        console.error(e);
        if (e.message && e.message.includes('already')) alert('Vous avez déjà déposé un fichier pour ce rendu.');
        if (e.message && e.message.includes("blocked")) {
            last_blocked_info = {
                input: `Nom fichier custom: ${customName || deposit_pending_file.name}`,
                reason: e.message
            };
            close_all_overlays();
            toggle_overlay('reportTicketOverlay', true);
        }
        else alert('Erreur upload: ' + (e.message || "Erreur inconnue"));
    } finally {
        // reset loading state
        if (warning) warning.style.display = 'none';
        if (sendBtn) sendBtn.classList.remove('button-disabled');
    }
}


function render_file_item(file, announcement_id, container) {
    const f_name = file.originalName || file.name;
    const ext = f_name.split('.').pop().toUpperCase();
    const size = (file.size / 1024 / 1024).toFixed(1);

    const row = create_tag('div', '', '', { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 0', borderRadius: '4px', fontSize: '0.85em' });
    const left = create_tag('div', '', `
        <span style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-weight:600;" title="${f_name}">${f_name}</span>
        <span style="opacity:0.7; font-size:0.9em;">(${ext} • ${size} Mo)</span>
    `, { display: 'flex', alignItems: 'center', gap: '6px', overflow: 'hidden' });

    const actions = create_tag('div', '', '', { display: 'flex', alignItems: 'center', gap: '8px' });
    const dl_btn = create_tag('button', 'announcement-action-btn', `<img src="./assets/icon/download.png" style="width:18px; height:18px;">`);
    dl_btn.onclick = (e) => { e.preventDefault(); handle_file_download(file.id, f_name); };
    actions.appendChild(dl_btn);

    if (is_admin) {
        const del_btn = create_tag('button', 'announcement-action-btn', `<img src="./assets/icon/delete.png" style="width:18px; height:18px;">`);
        del_btn.style.borderColor = '#000000';
        del_btn.onclick = (e) => delete_item(e, `/api/announcements/${announcement_id}/files/${file.id}`, row);
        actions.appendChild(del_btn);
    }

    row.appendChild(left); row.appendChild(actions); container.appendChild(row);
}

async function delete_item(e, endpoint, dom_element) {
    e.preventDefault();
    if (!confirm("Supprimer ?")) return;
    if (dom_element) dom_element.style.opacity = '0.5'; // check if exists
    try {
        const success = await api_call(`${endpoint}?userId=${user_id}`, "DELETE");
        if (success) {
            if (dom_element) dom_element.remove();
            await sync_announcements();
            await sync_deposits(); // ensure deposits refresh
        }
        else throw new Error("Delete failed");
    } catch (err) {
        console.error(err); alert("Erreur suppression.");
        if (dom_element) dom_element.style.opacity = '1';
    }
}

async function handle_file_download(file_id, file_name) {
    try {
        const blob_enc = await api_download(file_id);
        const blob_clear = await decrypt_blob(blob_enc);
        const url = URL.createObjectURL(blob_clear);
        const a = document.createElement('a');
        a.href = url; a.download = file_name;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(url);
    } catch (e) {
        console.error("Download error", e); alert("Erreur lors du téléchargement.");
    }
}


// uploads & forms

function render_pending_files() {
    const list_div = ui_elements.adminFilesList;
    if (!list_div) return;
    list_div.innerHTML = '';
    pending_files.forEach((file, index) => {
        const file_size = (file.size / (1024 * 1024)).toFixed(1);
        const item = create_tag('div', 'admin-file-item', `
            <div class="file-progress-bar" id="prog-bar-${index}"></div>
            <div class="admin-file-info"><span class="admin-file-name">${file.name}</span><span class="admin-file-size">${file_size} Mo</span><span class="file-progress-pct" id="prog-txt-${index}"></span></div>
            <button class="admin-file-delete" data-idx="${index}" title="Retirer">×</button>
        `);
        item.querySelector('.admin-file-delete').addEventListener('click', (e) => {
            e.preventDefault();
            if (is_sending) return alert("Upload en cours...");
            pending_files.splice(index, 1); render_pending_files();
        });
        list_div.appendChild(item);
    });
}

async function handle_form_submit() {
    if (is_sending) return;
    const name_input = ui_elements.name;
    const infos_input = ui_elements.infos;
    const create_btn = ui_elements.create;
    const name = name_input.value.trim();
    const description = infos_input.value.trim();

    if (!ai_enabled) {
        const full_text = (name + " " + description).toLowerCase();
        if (banned_terms.some(term => new RegExp(`\\b${term.toLowerCase()}\\b`, 'i').test(full_text))) {
            return alert("Mot interdit détecté (filtre local).");
        }
    }

    const color = get_color_from_element(document.querySelector('.color.selected'));

    if (is_admin) {
        const adminType = document.querySelector('input[name="AdminType"]:checked')?.value || 'message';
        // handle deposit creation
        if (adminType === 'depot') {
            if (!name) return notif('Nom du dépôt requis.', "error");

            let provider = null;

            try {
                const status = await api_call(`/api/cloud/status?roomCode=${room_code}`);
                if (status.connected) {
                    provider = status.provider;
                }
            } catch (e) {
                console.error(e);
            }

            await create_deposit(name, color, provider);
            return;
        }
        if (!name && pending_files.length === 0) return notif('Message requis.', "error");
        await process_admin_upload(name, color);
        return;
    }

    //use student name if csv mode
    const final_name = (csv_mode || force_name_mode) ? student_name : name;

    const active_tickets = tickets_list.filter(t => t.etat === "en cours" && t.userId === user_id);
    if (active_tickets.length >= max_tickets) return notif("Limite atteinte.", "error");
    if (!final_name && !csv_mode && !force_name_mode) return notif("Nom requis.", "error");
    is_sending = true;
    if (create_btn) create_btn.classList.add('button-disabled');

    try {
        await api_call('/api/tickets', "POST", {
            nom: final_name, description, couleur: color, etat: "en cours", userId: user_id, roomCode: room_code
        });
        if (!csv_mode && !force_name_mode) name_input.value = "";
        infos_input.value = "";
        close_all_overlays();
    } catch (e) {
        if (e.message && e.message.includes("blocked")) {
            last_blocked_info = {
                input: `Nom: ${final_name} | Desc: ${description}`,
                reason: e.message
            };
            toggle_overlay('reportTicketOverlay', true);
        }
        else alert(e.message || "Erreur de création");
    } finally {
        is_sending = false;
        if (create_btn) create_btn.classList.remove('button-disabled');
    }
}

async function process_admin_upload(content, color) {
    is_sending = true;
    const create_btn = ui_elements.create;
    if (create_btn) create_btn.classList.add('button-disabled');

    try {
        const form_data = new FormData();
        form_data.append('roomCode', room_code);
        form_data.append('userId', user_id);
        form_data.append('content', content);
        form_data.append('color', color.includes('gradient') ? rgb_to_hex(color) || color : color);

        const encrypted_list = [];
        if (pending_files.length > 0) {
            pending_files.forEach((_, i) => {
                const txt = document.getElementById(`prog-txt-${i}`);
                if (txt) txt.textContent = "Crypto...";
            });
            for (const file of pending_files) {
                const enc_blob = await encrypt_file(file);
                encrypted_list.push(enc_blob);
                form_data.append('files', enc_blob, file.name);
            }
        }

        await new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            current_xhr = xhr;
            xhr.open('POST', `${api_url}/api/announcements`, true);
            xhr.withCredentials = true;
            stop_dots();

            xhr.upload.onprogress = (e) => {
                if (!e.lengthComputable) return;
                let remaining = e.loaded;

                encrypted_list.forEach((blob, idx) => {
                    const bar = document.getElementById(`prog-bar-${idx}`);
                    const txt = document.getElementById(`prog-txt-${idx}`);
                    const size = blob.size;
                    let pct = 0;

                    if (remaining >= size) { pct = 100; remaining -= size; }
                    else if (remaining > 0) { pct = Math.round((remaining / size) * 100); remaining = 0; }

                    if (bar) bar.style.width = `${pct}%`;
                    if (txt) {
                        if (pct === 100) {
                            if (idx === encrypted_list.length - 1) start_dots(idx);
                            else { txt.textContent = 'terminé'; txt.style.fontSize = ''; }
                        } else txt.textContent = `${pct}%`;
                    }
                });
            };

            xhr.onload = () => {
                if (xhr.status >= 200 && xhr.status < 300) resolve();
                else {
                    try { reject(new Error(JSON.parse(xhr.responseText).error || "Upload failed")); }
                    catch { reject(new Error("Upload failed")); }
                }
            };
            xhr.onerror = () => reject(new Error("Network error"));
            xhr.onabort = () => reject(new Error("Aborted"));
            xhr.send(form_data);
        });

        await new Promise(r => setTimeout(r, 1200));
        stop_dots(); close_all_overlays(); ui_elements.name.value = "";
        pending_files = []; render_pending_files(); await sync_announcements();
    } catch (e) {
        if (e.message !== "Aborted") { console.error(e); alert("Erreur: " + e.message); render_pending_files(); }
        if (e.message && e.message.includes("blocked")) {
            last_blocked_info = {
                input: `Contenu annonce: ${content}`,
                reason: e.message
            };
            close_all_overlays();
            toggle_overlay('reportTicketOverlay', true);
        }
    } finally {
        is_sending = false; current_xhr = null;
        if (create_btn) create_btn.classList.remove('button-disabled');
    }
}


// websocket

function setup_websocket() {
    if (global_ws) {
        global_ws.close();
        global_ws = null;
    }

    const ws_params = new URLSearchParams();
    ws_params.set('room', room_code);

    ws_params.set('userId', user_id);

    // send name
    if (student_name) ws_params.set('name', student_name);

    const ws = new WebSocket(`${ws_url}?${ws_params.toString()}`);
    global_ws = ws;

    ws.onopen = () => {
        console.log('WS connected', room_code);
        ws_retry_count = 0;
        if (erroroverlay) { close_all_overlays(); erroroverlay = null; }
    };


    ws.onmessage = (event) => {
        if (event.data === 'ping') return ws.send('pong');
        try {
            const msg = JSON.parse(event.data);
            // triggered on ticket or general room changes
            if (msg.type === 'update' || msg.type === 'updateDeposit') {
                render_tickets(true);
                check_permissions();
                sync_deposits(); // refresh lists and modal
            }

            // triggered on announcement or deposit changes
            if (msg.type === 'updateAnnonce') {
                sync_announcements();
                sync_deposits(); // refresh deposits
            }
        } catch (e) { console.error('ws parse error', e); }
    };

    ws.onclose = () => {
        ws_retry_count++;
        if (ws_retry_count >= max_ws_retries && !erroroverlay) { show_connection_error(); erroroverlay = true; }
        setTimeout(() => setup_websocket(), retry_delay);
    };
}


// settings admin

// 1. au chargement : on essaie de récupérer le nom sauvegardé, sinon défaut
var current_csv_name = localStorage.getItem('my_csv_name') || "Fichier CSV";

function setup_csv_settings() {
    const btn = ui_elements.csvButton;
    const input = ui_elements.csvInput;
    if (!btn || !input) return;

    const new_btn = btn.cloneNode(true);
    btn.parentNode.replaceChild(new_btn, btn);
    ui_elements.csvButton = new_btn;
    const text_span = new_btn.querySelector('.text');

    // render
    if (csv_mode) {
        text_span.style.cssText = "display:flex; justify-content:space-between; align-items:center; width:100%; font-size: 14px;";
        text_span.innerHTML = `<img class="icon" src="assets/icon/delete.png" style="width:24px;"><span> ${current_csv_name}</span>`;
    } else {
        new_btn.style.backgroundColor = '';
        text_span.style.cssText = "display:flex; justify-content:space-between; align-items:center; width:100%; font-size: 14px;";
        text_span.innerHTML = '<img class="icon" src="assets/icon/add.png" style="width:24px;"><span> Ajouter</span>';
    }

    // delete
    new_btn.onclick = async (e) => {
        e.preventDefault();
        if (csv_mode) {
            if (!confirm("Supprimer ?")) return;
            try {
                await api_call(`/api/rooms/${room_code}/csv`, 'DELETE');
                localStorage.removeItem('my_csv_name');
                current_csv_name = "Fichier CSV";

                csv_mode = false;

                // unlock force name toggle
                const fnToggle = ui_elements.forceNameToggle;
                if (fnToggle) {
                    fnToggle.disabled = false;
                    fnToggle.parentElement.style.opacity = '1';
                    fnToggle.checked = false;
                    api_call(`/api/rooms/${room_code}`, "PUT", { forceName: false });
                }

                setup_csv_settings();
            } catch (e) { alert(e); }
        } else input.click();
    };

    // upload
    input.onchange = async () => {
        if (!input.files[0]) return;
        text_span.textContent = "...";

        const form = new FormData();
        form.append('file', input.files[0]);

        try {
            if ((await fetch(`${api_url}/api/rooms/${room_code}/csv`, { method: 'POST', body: form })).ok) {
                current_csv_name = input.files[0].name;
                localStorage.setItem('my_csv_name', current_csv_name);

                csv_mode = true;

                // lock force name toggle
                const fnToggle = ui_elements.forceNameToggle;
                if (fnToggle) {
                    fnToggle.checked = true;
                    fnToggle.disabled = true;
                    fnToggle.parentElement.style.opacity = '0.5';
                }

                setup_csv_settings();
            } else throw new Error();
        } catch (e) { info('Erreur upload', "error"); setup_csv_settings(); }
        input.value = '';
    };
}


// events

function setup_event_listeners() {
    const els = ui_elements;

    if (els.createbutton) els.createbutton.onclick = (e) => {
        e.preventDefault();

        // lock name input if logged in
        if (!is_admin && (csv_mode || force_name_mode) && student_name) {
            els.name.value = student_name;
            els.name.disabled = true;
            els.name.style.opacity = '0.6';
        } else if (!is_admin) {
            els.name.disabled = false;
            els.name.disabled = false;
            els.name.style.opacity = '1';
            if (fileUploadContainer) {
                fileUploadContainer.style.display = 'none';
            }
        }
        if (is_admin) update_cloud_ui();

        toggle_overlay("formOverlay", true);
    };

    if (els.create) els.create.onclick = (e) => { e.preventDefault(); handle_form_submit(); };
    if (els.loginEnter) els.loginEnter.onclick = (e) => { e.preventDefault(); handle_login_submit(); };

    // settings
    document.getElementById("setting")?.addEventListener('click', (e) => {
        e.preventDefault();
        toggle_overlay("settingsOverlay", true);

        if (typeof is_admin !== 'undefined' && is_admin) {
            update_cloud_ui();
        }

        const radio = document.querySelector(`input[name="SliderCount"][value="${max_tickets}"]`);
        if (radio) radio.checked = true;
    });

    document.getElementById("closeSettings")?.addEventListener('click', (e) => { e.preventDefault(); close_all_overlays(); });

    const st_container = els.announcementContainer;
    if (st_container) {
        st_container.onmouseenter = () => {
            if (announcements_list.length > 0 || deposits_list.length > 0) {
                st_container.classList.add('open');
            }
        };
        st_container.onmouseleave = () => st_container.classList.remove('open');
    }

    // copy buttons
    if (els.copyLink) els.copyLink.onclick = (e) => {
        e.preventDefault();
        navigator.clipboard.writeText(window.location.href)
            .then(() => show_copy_feedback(document.getElementById('copyText'), document.getElementById('copyText').textContent));
    };
    if (els.codebutton) els.codebutton.onclick = (e) => {
        e.preventDefault();
        navigator.clipboard.writeText(room_code)
            .then(() => show_copy_feedback(els.codebutton.querySelector('.text'), els.codebutton.querySelector('.text').textContent, "Copié"));
    };

    // ticket completion
    document.getElementById("right")?.addEventListener("click", async (e) => {
        const checkbox = e.target.closest(".checkbox");
        if (!checkbox || !is_admin) return;
        const id = checkbox.dataset.id;
        const el = document.getElementById(id);
        el.classList.add("moving");
        el.addEventListener("animationend", async () => {
            await api_call(`/api/tickets/${id}`, "PUT", { etat: "terminé", roomCode: room_code });
            render_tickets();
        }, { once: true });
    });

    // close overlays
    document.querySelectorAll('.menu-overlay').forEach(overlay => {
        overlay.addEventListener('click', (e) => {
            if (e.target !== overlay) return;
            // protect form/login close
            if (overlay.id === 'loginOverlay' && !is_admin && (csv_mode || force_name_mode) && !student_name) return; if (overlay.id === 'formOverlay' && (is_sending || pending_files.length > 0)) {
                if (is_sending) { if (confirm("Annuler l'envoi ?")) current_xhr?.abort(); else return; }
                else { if (confirm("Fermer et perdre les fichiers ?")) { pending_files = []; render_pending_files(); } else return; }
            }
            close_all_overlays();
        });
    });

    setup_download_modal_listeners();

    // logout
    document.getElementById("logout")?.addEventListener('click', (e) => { e.preventDefault(); toggle_overlay("logoutOverlay", true); });
    document.getElementById("cancelLogout")?.addEventListener('click', (e) => { e.preventDefault(); close_all_overlays(); });
    document.getElementById("confirmLogout")?.addEventListener('click', (e) => {
        e.preventDefault();
        localStorage.removeItem('last_room');
        sessionStorage.removeItem('student_name_cache');
        window.location.href = '/';
    });

    // slider & ai
    document.querySelectorAll('input[name="SliderCount"]').forEach(radio => {
        radio.addEventListener('change', async (e) => {
            max_tickets = parseInt(e.target.value);
            if (is_admin) await api_call(`/api/rooms/${room_code}`, "PUT", { maxTickets: max_tickets });
        });
    });

    setup_admin_type_listener()

    // deposit overlay handlers
    document.getElementById('depositCancel')?.addEventListener('click', (e) => { e.preventDefault(); toggle_overlay('depositOverlay', false); deposit_pending_file = null; });
    document.getElementById('depositSend')?.addEventListener('click', (e) => { e.preventDefault(); upload_deposit(); });
    setup_deposit_drag_drop();

    if (els.aiToggle) els.aiToggle.addEventListener('change', async (e) => {
        if (!is_admin) { e.preventDefault(); e.target.checked = ai_enabled; return notif("Vous n'avez pas la permission.", "error"); }
        const new_state = e.target.checked;
        try {
            await api_call(`/api/rooms/${room_code}`, "PUT", { aiEnabled: new_state });
            ai_enabled = new_state; update_ai_status(ai_enabled);
        } catch (err) { e.target.checked = !new_state; alert("Erreur IA"); }
    });

    if (els.forceNameToggle) els.forceNameToggle.addEventListener('change', async (e) => {
        if (!is_admin) {
            e.preventDefault();
            e.target.checked = force_name_mode;
            return alert("Vous n'avez pas la permission.");
        }
        const new_state = e.target.checked;
        try {
            await api_call(`/api/rooms/${room_code}`, "PUT", { forceName: new_state });
            force_name_mode = new_state;
        } catch (err) {
            e.target.checked = !new_state;
            alert("Erreur serveur");
        }
    });

    // open report from settings
    document.getElementById('openGlobalReport')?.addEventListener('click', (e) => {
        e.preventDefault();
        open_report_overlay('manual_report');
    });

    // open report from ai block (replace specific listener if needed)
    document.getElementById('openAiReport')?.addEventListener('click', (e) => {
        e.preventDefault();
        open_report_overlay('ai_blocked', 'L\'IA a bloqué mon contenu de manière injustifiée.');
    });

    // report form actions
    document.getElementById('cancelBugReport')?.addEventListener('click', (e) => {
        e.preventDefault();
        toggle_overlay('bugReportOverlay', false);
    });

    document.getElementById('cancelCreate')?.addEventListener('click', (e) => {
        e.preventDefault();
        close_all_overlays();

        if (pending_files.length > 0 && confirm("Annuler et perdre les fichiers ?")) {
            pending_files = [];
            render_pending_files();
        } else if (pending_files.length === 0) {

        }
    });


    document.getElementById('closeBlocked')?.addEventListener('click', (e) => {
        e.preventDefault();
        close_all_overlays();
    });

    document.getElementById('leaveClosed')?.addEventListener('click', (e) => {
        e.preventDefault();
        localStorage.removeItem('last_room');
        window.location.href = '/';
    });

    document.getElementById('sendBugReport')?.addEventListener('click', (e) => {
        e.preventDefault();
        submit_bug_report();
    });

    // cloud providers click handlers
    document.getElementById('googleDriveButton')?.addEventListener('click', (e) => {
        e.preventDefault();
        handle_cloud_handshake('google');
    });

    document.getElementById('onedriveButton')?.addEventListener('click', (e) => {
        e.preventDefault();
        handle_cloud_handshake('onedrive');
    });

    document.getElementById('nextcloudButton')?.addEventListener('click', (e) => {
        e.preventDefault();
        handle_cloud_handshake('nextcloud');
    });

    // language overlay
    if (els.langToggle) els.langToggle.onclick = (e) => {
        e.preventDefault();
        toggle_overlay('languageOverlay', true);
    };
    if (els.closeLangOverlay) els.closeLangOverlay.onclick = (e) => {
        e.preventDefault();
        toggle_overlay('languageOverlay', false);
    };

    window.addEventListener('message', (event) => {
        if (event.data && event.data.type === 'CLOUD_AUTH_RESULT') {
            if (event.data.status === 'success') {
                update_cloud_ui();
            } else {
                notif("Erreur lors de la connexion au service Cloud.", "error");
                ['google', 'nextcloud', 'onedrive'].forEach(p => set_cloud_card_state(p, "error"));
            }
        }
    });

    setup_drag_and_drop();
}

function setup_drag_and_drop() {
    const { dropArea, fileInput } = ui_elements;
    if (!dropArea || !fileInput) return;
    dropArea.onclick = () => { if (pending_files.length >= max_files) return alert("Limite atteinte."); fileInput.click(); };
    fileInput.onchange = () => { if (fileInput.files.length) { add_files(Array.from(fileInput.files)); fileInput.value = ''; } };

    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(evt => dropArea.addEventListener(evt, (e) => { e.preventDefault(); e.stopPropagation(); }, false));
    dropArea.addEventListener('dragenter', () => dropArea.classList.add('drag-over'));
    dropArea.addEventListener('dragleave', () => dropArea.classList.remove('drag-over'));
    dropArea.addEventListener('drop', (e) => { dropArea.classList.remove('drag-over'); add_files(Array.from(e.dataTransfer.files)); });
}

function add_files(files) {
    if (pending_files.length + files.length > max_files) return alert(`Trop de fichiers (max ${max_files}).`);
    pending_files = [...pending_files, ...files];
    render_pending_files();
}


// init

window.addEventListener('DOMContentLoaded', () => {
    init_app();
});