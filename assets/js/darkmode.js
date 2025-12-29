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