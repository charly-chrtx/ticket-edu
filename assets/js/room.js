'use strict';

// config
const api_url = "https://api.ticket-edu.com";
const ws_url = "wss://api.ticket-edu.com";
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
// new csv state
let csv_mode = false;
let student_name = sessionStorage.getItem('student_name_cache');

let tickets_list = [];
let last_ticket_ids = new Set();
let announcements_list = [];
let pending_files = [];
let banned_terms = [];
let current_xhr = null;
let ws_retry_count = 0;
let erroroverlay;
let global_ws = null;

// crypto
let crypto_key = null;

// ui state
let ui_elements = {};
let dot_interval = null;

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


// encryption

async function init_crypto(room_code_str) {
    const enc = new TextEncoder();
    const key_material = await window.crypto.subtle.importKey(
        "raw", enc.encode(room_code_str), "PBKDF2", false, ["deriveKey"]
    );
    crypto_key = await window.crypto.subtle.deriveKey(
        { name: "PBKDF2", salt: enc.encode("ticket-static-salt"), iterations: 100000, hash: "SHA-256" },
        key_material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
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
        const options = { method, headers: { "Content-Type": "application/json" } };
        if (body) options.body = JSON.stringify(body);

        const res = await fetch(`${api_url}${endpoint}`, options);
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            if (data.error) throw new Error(data.error);
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
        'fileUploadContainer', 'adminSettingsSection', 'dropArea', 'fileInput',
        'aiToggle', 'aiStatus', 'reportTicketOverlay',
        // new login ids
        'loginOverlay', 'loginName', 'loginEnter', 'issueNameOverlay',
        'nameChoicesContainer', 'csvButton', 'csvInput'
    ];

    ids.forEach(id => {
        ui_elements[id] = document.getElementById(id);
    });
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
        if (el.id === 'loginOverlay' && !is_admin && csv_mode && !student_name) return;
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
    const can_proceed = await load_resources();

    document.body.classList.add('loaded');
    const code_span = document.querySelector('#codebutton .text');
    if (code_span) code_span.textContent = room_code;

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
        await render_tickets();
    }
    return proceed;
}

async function check_permissions() {
    // send userid in query
    const data = await api_call(`/api/rooms/${room_code}?userId=${user_id}`);

    if (!data || data.error || Array.isArray(data)) {
        alert("Salle introuvable.");
        window.location.href = "/";
        return false;
    }

    if (data.maxTickets) {
        max_tickets = data.maxTickets;
        const radio = document.querySelector(`input[name="SliderCount"][value="${data.maxTickets}"]`);
        if (radio) radio.checked = true;
    }

    ai_enabled = data.aiEnabled || false;
    if (ui_elements.aiToggle) ui_elements.aiToggle.checked = ai_enabled;
    update_ai_status(ai_enabled);

    csv_mode = data.hasCsv || false;
    
    // server returns boolean flag
    set_admin_mode(data.isAdmin === true);

    if (!is_admin && csv_mode) {
        if (!student_name) {
            start_login_flow();
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
    // update state
    is_admin = status;
    const { createbutton, name, infos, formOverlay, fileUploadContainer, adminSettingsSection } = ui_elements;

    // hide or show admin sections
    if (adminSettingsSection) adminSettingsSection.style.display = is_admin ? 'block' : 'none';
    if (fileUploadContainer) fileUploadContainer.style.display = is_admin ? 'flex' : 'none';

    setup_csv_settings(); // update button state

    // ui elements update
    const title = formOverlay.querySelector('h1');
    const btn_text = createbutton.querySelector('.text');

    if (is_admin) {
        if (btn_text) btn_text.textContent = "Nouveau message";
        if (name) { name.placeholder = "Message"; name.value = ""; }
        if (infos) infos.style.display = 'none';
        if (title) title.textContent = "Nouveau message";
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

    // if admin or cached, sync is safe
    if (is_admin || (csv_mode && student_name) || !csv_mode) {
        sync_announcements();
        render_tickets();
    }
}



// login flow

function start_login_flow() {
    toggle_overlay('loginOverlay', true);
}

async function handle_login_submit() {
    const input = ui_elements.loginName;
    const val = input.value.trim();
    if (!val) return;

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

    // Calcul des fichiers
    announcements_list.forEach(a => {
        if (a.files) {
            total_files += a.files.length;
            a.files.forEach(f => total_bytes += f.size);
        }
    });

    const { storageText, storageProgressBar } = ui_elements;

    if (storageText) storageText.textContent = format_bytes(total_bytes) + ' / ' + format_bytes(max_storage_bytes);
    if (fileCountText) fileCountText.textContent = `${total_files} fichier${total_files > 1 ? 's' : ''} partagé${total_files > 1 ? 's' : ''}`;




    let pct = (total_bytes / max_storage_bytes) * 100;

    if (pct < 5 && total_bytes > 0) pct = 5;

    if (pct > 100) pct = 100;


    if (storageProgressBar) storageProgressBar.style.width = `${pct}%`;


    if (announcementContainer) {
        if (announcements_list.length === 0) {
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

    const left_container = document.querySelector('.left-container');
    if (left_container) left_container.style.gap = announcements_list.length === 0 ? '0px' : '';

    announcements_list.forEach((annonce, index) => {
        const wrapper = create_tag('div', 'announcement-wrapper');
        wrapper.style.setProperty('--i', index);
        const bg = annonce.color || '#cdcdcd';
        const style = { display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: '8px' };
        if (bg.includes('gradient')) style.backgroundImage = bg;
        else style.backgroundColor = bg;

        const msg_div = create_tag('div', 'announcement-item', '', style);

        if (annonce.content?.trim()) {
            const delete_btn = is_admin ? `<button class="announcement-delete" title="Supprimer"><img src="./assets/icon/delete.png" alt="X"></button>` : '';
            const text_row = create_tag('div', '', `
                <div class="announcement-content" style="width:100%;"><span class="announcement-text">${annonce.content}</span></div>
                <div class="announcement-actions">${delete_btn}</div>
            `, { display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' });

            if (is_admin) text_row.querySelector('.announcement-delete').addEventListener('click', (e) => delete_item(e, `/api/announcements/${annonce.id}`, wrapper));
            msg_div.appendChild(text_row);
        }

        if (annonce.files?.length > 0) {
            const file_container = create_tag('div', '', '', { display: 'flex', flexDirection: 'column', gap: '4px', width: '100%' });
            annonce.files.forEach(file => render_file_item(file, annonce.id, file_container));
            msg_div.appendChild(file_container);
        }
        wrapper.appendChild(msg_div);
        container.appendChild(wrapper);
    });
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
    dom_element.style.opacity = '0.5';
    try {
        const success = await api_call(`${endpoint}?userId=${user_id}`, "DELETE");
        if (success) { dom_element.remove(); await sync_announcements(); }
        else throw new Error("Delete failed");
    } catch (err) {
        console.error(err); alert("Erreur suppression."); dom_element.style.opacity = '1';
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
        if (!name && pending_files.length === 0) return alert("Message ou fichier requis.");
        await process_admin_upload(name, color);
        return;
    }

    // new: use student name if csv mode
    const final_name = csv_mode ? student_name : name;

    const active_tickets = tickets_list.filter(t => t.etat === "en cours" && t.userId === user_id);
    if (active_tickets.length >= max_tickets) return alert("Limite atteinte.");
    if (!final_name && !csv_mode) return alert("Nom requis.");

    is_sending = true;
    if (create_btn) create_btn.classList.add('button-disabled');

    try {
        await api_call('/api/tickets', "POST", {
            nom: final_name, description, couleur: color, etat: "en cours", userId: user_id, roomCode: room_code
        });
        if (!csv_mode) name_input.value = "";
        infos_input.value = "";
        close_all_overlays();
    } catch (e) {
        if (e.message && e.message.includes("blocked")) toggle_overlay('reportTicketOverlay', true);
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
            if (msg.type === 'update') { render_tickets(true); check_permissions(); }
            if (msg.type === 'updateAnnonce') sync_announcements();
        } catch (e) { console.error('WS parse error', e); }
    };

    ws.onclose = () => {
        ws_retry_count++;
        if (ws_retry_count >= max_ws_retries && !erroroverlay) { show_connection_error(); erroroverlay = true; }
        setTimeout(() => setup_websocket(), retry_delay);
    };
}


// settings admin

// 1. Au chargement : on essaie de récupérer le nom sauvegardé, sinon défaut
var current_csv_name = localStorage.getItem('my_csv_name') || "Fichier CSV";

function setup_csv_settings() {
    const btn = ui_elements.csvButton;
    const input = ui_elements.csvInput;
    if (!btn || !input) return;

    const new_btn = btn.cloneNode(true);
    btn.parentNode.replaceChild(new_btn, btn);
    ui_elements.csvButton = new_btn;
    const text_span = new_btn.querySelector('.text');

    // AFFICHAGE
    if (csv_mode) {
        text_span.style.cssText = "display:flex; justify-content:space-between; align-items:center; width:100%; font-size: 14px;";
        text_span.innerHTML = `<span>${current_csv_name}</span><img class="icon" src="assets/icon/delete.png" style="width:24px;">`;
    } else {
        new_btn.style.backgroundColor = '';
        text_span.style.cssText = "display:flex; justify-content:space-between; align-items:center; width:100%; font-size: 14px;";
        text_span.innerHTML = '<img class="icon" src="assets/icon/add.png" style="width:24px;"><span> Ajouter</span>';
    }

    // CLICK (SUPPRESSION)
    new_btn.onclick = async (e) => {
        e.preventDefault();
        if (csv_mode) {
            if (!confirm("Supprimer ?")) return;
            try {
                await api_call(`/api/rooms/${room_code}/csv`, 'DELETE');
                localStorage.removeItem('my_csv_name'); 
                current_csv_name = "Fichier CSV";
                
                csv_mode = false;
                setup_csv_settings();
            } catch (e) { alert(e); }
        } else input.click();
    };

    // UPLOAD (AJOUT)
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
                setup_csv_settings();
            } else throw new Error();
        } catch (e) { alert("Erreur upload"); setup_csv_settings(); }
        input.value = '';
    };
}


// events

function setup_event_listeners() {
    const els = ui_elements;

    if (els.createbutton) els.createbutton.onclick = (e) => {
        e.preventDefault();

        // lock name input if logged in
        if (!is_admin && csv_mode && student_name) {
            els.name.value = student_name;
            els.name.disabled = true;
            els.name.style.opacity = '0.6';
        } else if (!is_admin) {
            els.name.disabled = false;
            els.name.style.opacity = '1';
        }

        toggle_overlay("formOverlay", true);
    };

    if (els.create) els.create.onclick = (e) => { e.preventDefault(); handle_form_submit(); };
    if (els.loginEnter) els.loginEnter.onclick = (e) => { e.preventDefault(); handle_login_submit(); };

    // settings
    document.getElementById("setting")?.addEventListener('click', (e) => {
        e.preventDefault();
        toggle_overlay("settingsOverlay", true);
        const radio = document.querySelector(`input[name="SliderCount"][value="${max_tickets}"]`);
        if (radio) radio.checked = true;
    });

    document.getElementById("closeSettings")?.addEventListener('click', (e) => { e.preventDefault(); close_all_overlays(); });

    const st_container = els.announcementContainer;
    if (st_container) {
        st_container.onmouseenter = () => {
            if (announcements_list.length > 0) st_container.classList.add('open');
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
            if (overlay.id === 'loginOverlay' && !is_admin && csv_mode && !student_name) return;
            if (overlay.id === 'formOverlay' && (is_sending || pending_files.length > 0)) {
                if (is_sending) { if (confirm("Annuler l'envoi ?")) current_xhr?.abort(); else return; }
                else { if (confirm("Fermer et perdre les fichiers ?")) { pending_files = []; render_pending_files(); } else return; }
            }
            close_all_overlays();
        });
    });

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

    if (els.aiToggle) els.aiToggle.addEventListener('change', async (e) => {
        if (!is_admin) { e.preventDefault(); e.target.checked = ai_enabled; return alert("Vous n'avez pas la permission."); }
        const new_state = e.target.checked;
        try {
            await api_call(`/api/rooms/${room_code}`, "PUT", { aiEnabled: new_state });
            ai_enabled = new_state; update_ai_status(ai_enabled);
        } catch (err) { e.target.checked = !new_state; alert("Erreur IA"); }
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
