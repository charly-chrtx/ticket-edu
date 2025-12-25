const API_URL = "https://api.ticket-edu.com";

const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
const targetRoomFile = isMobile ? "room-phone.html" : "room.html";
const targetIndexFile = "index-phone.html";

if (isMobile) {
    if (!window.location.href.includes("phone")) {
        const currentParams = window.location.search;
        window.location.href = targetIndexFile + currentParams;
        throw new Error("Redirection vers la version mobile...");
    }
}


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
        // room valid, redirect -> UTILISATION DE LA VARIABLE DYNAMIQUE
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

// run auto join check
tryAutoJoin();

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