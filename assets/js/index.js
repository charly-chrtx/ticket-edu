let API_URL = "https://api.ticket-edu.com";

(function checkCloudPopup() {
  const params = new URLSearchParams(window.location.search);
  if (params.has('cloud')) {
    const status = params.get('cloud');

    if (window.opener) {
      window.opener.postMessage({ type: 'CLOUD_AUTH_RESULT', status: status }, '*');

      // wait for message delivery before closing
      setTimeout(() => {
        window.close();
      }, 500);
    }
    if (status === 'success') {
      document.body.innerHTML = "<h1 style='color:green; text-align:center; margin-top:50px;'>Connexion réussie ! Vous pouvez fermer cette fenêtre.</h1>";
      throw new Error("Arrêt du script (Connexion Cloud OK)");
    }
  }
})();

const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
const targetRoomFile = isMobile ? "room-phone.html" : "room.html";
const targetIndexFile = "index-phone.html";

// get user id
let userId = localStorage.getItem('userId');
if (!userId) {
  userId = crypto.randomUUID();
  localStorage.setItem('userId', userId);
}

// auto join room if saved
async function tryAutoJoin() {
  const lastRoom = localStorage.getItem('last_room');

  if (lastRoom) {
    try {
      // check if room exists
      const res = await fetch(`${API_URL}/api/rooms/${lastRoom}`);
      const data = await res.json();

      if (data && !data.error) {
        // room valid, redirect
        window.location.href = `${targetRoomFile}?room=${lastRoom}`;
      } else {
        // room invalid, clear storage
        localStorage.removeItem('last_room');
      }
    } catch (err) {
      // api error, clear storage to be safe
      console.error("auto join error", err);
      localStorage.removeItem('last_room');
    }
  }
}

// // try to use local api first
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
      API_URL = local;
      return;
    }
  } catch (e) {
  }
  API_URL = remote;
  console.log('API base:', API_URL);
}
(async function initIndex() {
  await resolveApiBase();
  tryAutoJoin();
})();

// select main buttons
const buttons = document.querySelectorAll('.button-text');
const joinBtn = buttons[0]; // first button is join
const createBtn = buttons[1]; // second button is create

// select overlay elements
const joinOverlay = document.getElementById('joinOverlay');
const joinCodeInput = document.getElementById('joinCodeInput');
const confirmJoinBtn = document.getElementById('confirmJoin');
const cancelJoinBtn = document.getElementById('cancelJoin');



// 1. Ouvrir le menu
if (joinBtn) {
  joinBtn.addEventListener('click', (e) => {
    e.preventDefault();
    joinOverlay.style.display = 'flex';
    joinCodeInput.value = '';
    setTimeout(() => joinCodeInput.focus(), 50);
  });
}

// Fonction pour fermer le menu
function closeOverlay() {
  joinOverlay.style.display = 'none';
}

// 2. Fermer le menu via le bouton Annuler
if (cancelJoinBtn) {
  cancelJoinBtn.addEventListener('click', (e) => {
    e.preventDefault();
    closeOverlay();
  });
}

// 3. Fermer le menu au clic à l'extérieur
if (joinOverlay) {
  joinOverlay.addEventListener('click', (e) => {
    if (e.target === joinOverlay) {
      closeOverlay();
    }
  });
}

// 4. Valider et rejoindre
function submitJoin() {
  const code = joinCodeInput.value.toUpperCase();
  if (code && code.trim() !== "") {
    window.location.href = `${targetRoomFile}?room=${code.trim()}`;
  }
}

if (confirmJoinBtn) {
  confirmJoinBtn.addEventListener('click', (e) => {
    e.preventDefault();
    submitJoin();
  });
}

if (joinCodeInput) {
  joinCodeInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      submitJoin();
    }
  });
}


/* --- LOGIQUE DE CRÉATION DE GROUPE --- */

if (createBtn) {
  createBtn.addEventListener('click', async (e) => {
    e.preventDefault();

    try {
      const res = await fetch(`${API_URL}/api/rooms`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: userId })
      });

      const data = await res.json();

      if (data && data.code) {
        // Redirection vers le bon fichier room (mobile ou desktop)
        window.location.href = `${targetRoomFile}?room=${data.code}`;
      } else {
        alert("Erreur lors de la création du groupe");
      }
    } catch (err) {
      console.error("api error", err);
      alert("Impossible de contacter le serveur");
    }
  });
}