// check local storage
const isDarkMode = localStorage.getItem('dark_mode') === 'true';

// elements from room page (checkbox)
const darkToggle = document.getElementById('darkModeToggle');

// elements from index page (button)
const indexThemeBtn = document.getElementById('indexThemeToggle');
const themeIcon = document.getElementById('themeIcon');

// apply theme on load
if (isDarkMode) {
  document.body.classList.add('dark-mode');
} else {
  document.body.classList.remove('dark-mode');
}

// function to update ui
function updateThemeUI(isDark) {
  // update body
  if (isDark) document.body.classList.add('dark-mode');
  else document.body.classList.remove('dark-mode');
  
  // save to storage
  localStorage.setItem('dark_mode', isDark);

  // update room checkbox if exists
  if (darkToggle) {
    darkToggle.checked = isDark;
  }

  // update index icon if exists
  if (themeIcon) {
    // if dark mode, show light icon to switch back
    themeIcon.src = isDark ? "./assets/icon/lightmod.png" : "./assets/icon/darkmod.png";
  }
}

// init ui state
updateThemeUI(document.body.classList.contains('dark-mode'));

// event listener for room page (checkbox)
if (darkToggle) {
  darkToggle.addEventListener('change', (e) => {
    updateThemeUI(e.target.checked);
  });
}

// event listener for index page (button)
if (indexThemeBtn) {
  indexThemeBtn.addEventListener('click', (e) => {
    e.preventDefault();
    const currentIsDark = document.body.classList.contains('dark-mode');
    // toggle state
    updateThemeUI(!currentIsDark);
  });
}