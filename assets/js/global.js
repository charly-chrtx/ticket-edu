// -- Systeme pour le darkmod

const ICON_PATHS = {
  'light': './assets/icon/lightmod.png',
  'auto': './assets/icon/automod.png',
  'dark': './assets/icon/darkmod.png'
};

const themeRadios = document.querySelectorAll('input[name="ThemeOption"]');
const indexThemeBtn = document.getElementById('indexThemeToggle');
const themeIcon = document.getElementById('themeIcon');
const savedTheme = localStorage.getItem('theme_preference') || 'auto';

/**
 * Applique le thème visuellement et met à jour tous les contrôles (radios et icône toggle)
 * @param {string} theme - 'light', 'dark', ou 'auto'
 */
function applyTheme(theme) {

  localStorage.setItem('theme_preference', theme);

  if (themeRadios.length > 0) {
      const radioToSelect = document.querySelector(`input[name="ThemeOption"][value="${theme}"]`);
      if (radioToSelect) radioToSelect.checked = true;
  }

  if (themeIcon && ICON_PATHS[theme]) {
    themeIcon.src = ICON_PATHS[theme];
    themeIcon.alt = "Mode actuel : " + theme;
  }

  if (theme === 'dark') {
    document.body.classList.add('dark-mode');
  } else if (theme === 'light') {
    document.body.classList.remove('dark-mode');
  } else if (theme === 'auto') {
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      document.body.classList.add('dark-mode');
    } else {
      document.body.classList.remove('dark-mode');
    }
  }
}

/**
 * Cycle à travers les modes : Light -> Auto -> Dark -> Light ...
 */
function cycleNextTheme() {
  const currentTheme = localStorage.getItem('theme_preference') || 'auto';
  let nextTheme;

  if (currentTheme === 'light') {
    nextTheme = 'auto';
  } else if (currentTheme === 'auto') {
    nextTheme = 'dark';
  } else {
    nextTheme = 'light';
  }

  applyTheme(nextTheme);
}

applyTheme(savedTheme);

themeRadios.forEach(radio => {
  radio.addEventListener('change', (e) => {
    applyTheme(e.target.value);
  });
});

if (indexThemeBtn) {
  indexThemeBtn.addEventListener('click', (e) => {
    e.preventDefault();
    cycleNextTheme();
  });
}

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
  const currentTheme = localStorage.getItem('theme_preference');
  if (currentTheme === 'auto') {
    applyTheme('auto');
  }
});

// -- Système de Notifications --

function notif(message, type = 'info') {
    const styles = {
        success: { 
            icon: './assets/icon/success.png',
            sound: './assets/sound/success.mp3',
            color: '#9ecaff'
        },
        error: { 
            icon: './assets/icon/error.png',
            sound: './assets/sound/error.mp3',
            color: '#9ecaff'
        },
        info: { 
            icon: './assets/icon/info.png',
            sound: './assets/sound/success.mp3',
            color: '#9ecaff'
        }
    };

    const selectedStyle = styles[type] || styles['info'];

    if (selectedStyle.sound) {
        const audio = new Audio(selectedStyle.sound);
        const savedVolume = localStorage.getItem('savedVolume');

        if (savedVolume !== null) {
            audio.volume = parseInt(savedVolume) / 100;
        } else {
            audio.volume = 0.5;
        }

        audio.play().catch(error => {
            console.warn("Impossible de jouer le son de notification :", error);
        });
    }

    let container = document.getElementById('notif-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'notif-container';
        container.className = 'notif-container';
        document.body.appendChild(container);
    }

    const notif = document.createElement('div');
    notif.className = 'custom-notif';
    
    notif.innerHTML = `
        <div class="notif-progress" style="background-color: ${selectedStyle.color || '#ccc'};"></div>
        <img src="${selectedStyle.icon}" class="notif-icon" onerror="this.src='./assets/icon/icon thin.png'">
        <span class="notif-message">${message}</span>
        <img src="./assets/icon/cross.png" class="notif-icon close-btn">
    `;

    notif.querySelector('.close-btn').onclick = () => notif.remove();
    container.appendChild(notif);

    setTimeout(() => {
        const bar = notif.querySelector('.notif-progress');
        if (bar) {
            bar.style.transition = "width 5s linear";
            bar.style.width = "0%";
        }
    }, 50);

    setTimeout(() => {
        notif.style.opacity = '0';
        setTimeout(() => notif.remove(), 300);
    }, 5000);
}

// --- Gestion des sons ---

const rangeInput = document.getElementById('rangeInput');
const sliderFill = document.getElementById('sliderFill');
const volumebutton = document.getElementById('volumebutton'); 
const volumeIcon = document.querySelector('.slider-icon');
const tickSound = new Audio('./assets/sound/volume.mp3');
const startingMusic = document.getElementById("startinMusic");
const muteButton = document.getElementById('indexSoundToggle');

const icons = {
    mute: './assets/icon/volume_off.png',
    low: './assets/icon/volume_low.png',
    mid: './assets/icon/volume_mid.png',
    high: './assets/icon/volume_high.png'
};

const savedVolume = localStorage.getItem('savedVolume');

if (rangeInput) {
    if (savedVolume !== null) {
        rangeInput.value = savedVolume;
    } else {
        rangeInput.value = 50;
    }
}

let previousValue = rangeInput ? rangeInput.value : 50;
let lastStep = Math.floor(previousValue / 15);

function updateSlider() {
    if (!rangeInput) return;

    const val = parseInt(rangeInput.value);
    const currentStep = Math.floor(val / 15);
    const volumeLevel = val / 100;
    
    if (tickSound) tickSound.volume = volumeLevel;
    if (startingMusic) startingMusic.volume = volumeLevel;

    if (currentStep !== lastStep) {
        if (tickSound) {
            tickSound.currentTime = 0;
            tickSound.play().catch(() => {});
        }
        lastStep = currentStep;
    }
    
    if (sliderFill) sliderFill.style.width = val + '%';

    let iconSrc;
    if (val === 0) {
        iconSrc = icons.mute;
    } else if (val > 0 && val <= 33) {
        iconSrc = icons.low;
    } else if (val > 33 && val <= 66) {
        iconSrc = icons.mid;
    } else {
        iconSrc = icons.high;
    }

    if (volumeIcon) volumeIcon.src = iconSrc;
    if (volumebutton) volumebutton.src = iconSrc;

    localStorage.setItem('savedVolume', val);
}

function toggleMute() {
    if (!rangeInput) return;

    if (parseInt(rangeInput.value) > 0) {
        previousValue = rangeInput.value;
        rangeInput.value = 0;
    } else {
        rangeInput.value = previousValue > 0 ? previousValue : 50;
    }
    updateSlider();
}

if (volumeIcon) {
    volumeIcon.addEventListener('click', toggleMute);
}

if (muteButton) {
    muteButton.addEventListener('click', (e) => {
        e.preventDefault();
        toggleMute();
    });
}

window.addEventListener('load', function() {
    if (startingMusic) {
        updateSlider(); 
        startingMusic.play().catch(error => {
            console.warn("Le navigateur a bloqué l'autoplay audio :", error);
        });
    }
});

if (rangeInput) {
    rangeInput.addEventListener('input', updateSlider);
    updateSlider();
}