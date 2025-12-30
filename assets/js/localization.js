class LocalizationManager {
    constructor() {
        this.supportedLanguages = ['fr', 'en'];
        this.defaultLang = 'fr';
        this.currentLang = this.detectInitialLanguage();
        this.translations = {};
    }

    detectInitialLanguage() {
        const savedLang = localStorage.getItem('ticket_lang');
        if (savedLang && this.supportedLanguages.includes(savedLang)) {
            return savedLang;
        }

        const browserLang = navigator.language.split('-')[0];
        if (this.supportedLanguages.includes(browserLang)) {
            return browserLang;
        }

        return this.defaultLang;
    }

    async init() {
        // load default if current is not default to ensure fallbacks (optional but recommended)
        // or just load current
        await this.loadTranslations(this.currentLang);
        this.setupLanguageSwitcher();
    }

    async loadTranslations(lang) {
        try {
            const response = await fetch(`./assets/lang/${lang}.json`);
            if (!response.ok) throw new Error(`file not found ${lang}`);

            this.translations = await response.json();
            this.applyTranslations();

            // dispatch event when loaded so js can update dynamic content
            window.dispatchEvent(new Event('i18nLoaded'));
        } catch (error) {
            console.error("translation error:", error);
            if (lang !== this.defaultLang) {
                this.currentLang = this.defaultLang;
                localStorage.setItem('ticket_lang', this.defaultLang);
                location.reload();
            }
        }
    }

    applyTranslations() {
        document.querySelectorAll('[data-i18n]').forEach(element => {
            const key = element.getAttribute('data-i18n');
            const translation = this.translate(key);

            if (translation) {
                if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
                    element.placeholder = translation;
                } else {
                    const icon = element.querySelector('.icon');
                    if (icon) {
                        const textElem = element.querySelector('.text');
                        if (textElem) {
                            textElem.textContent = translation;
                        } else {
                            const textNode = Array.from(element.childNodes).find(node => node.nodeType === 3 && node.textContent.trim());
                            if (textNode) textNode.textContent = translation;
                            else element.innerHTML = translation;
                        }
                    } else {
                        element.innerHTML = translation;
                    }
                }
            }
        });
    }

    translate(key, params = {}) {
        if (!key) return '';
        const keys = key.split('.');
        let value = this.translations;

        for (const k of keys) {
            value = value ? value[k] : null;
        }

        if (!value) return key;

        Object.keys(params).forEach(p => {
            value = value.replace(`{${p}}`, params[p]);
        });

        return value;
    }

setupLanguageSwitcher() {
        let btn = document.getElementById('langToggle');

        if (!btn) {
            const links = document.querySelectorAll('#settingsOverlay a.button-text');
            for (const link of links) {
                if (link.style.opacity === '0.3' || link.style.pointerEvents === 'none') {
                    btn = link;
                    break;
                }
            }
        }

        if (btn) {
            btn.style.opacity = '1';
            btn.style.pointerEvents = 'auto';
            btn.style.cursor = 'pointer';
            const textSpan = btn.querySelector('.text');
            if (textSpan) textSpan.textContent = this.currentLang.toUpperCase();
            
            btn.onclick = (e) => {
                e.preventDefault();
                
                const langOverlay = document.getElementById('languageOverlay');
                const settingsOverlay = document.getElementById('settingsOverlay');
                
                if (langOverlay) {
                    if(settingsOverlay) settingsOverlay.style.display = 'none';
                    langOverlay.style.display = 'flex';
                } else {
                    this.cycleLanguage();
                }
            };
        }
    }

    // Nouvelle fonction appelée par les boutons de l'overlay
    changeLanguage(newLang) {
        if (this.supportedLanguages.includes(newLang)) {
            if (this.currentLang !== newLang) {
                localStorage.setItem('ticket_lang', newLang);
                location.reload();
            } else {
                const langOverlay = document.getElementById('languageOverlay');
                const settingsOverlay = document.getElementById('settingsOverlay');
                
                if (langOverlay) langOverlay.style.display = 'none';
                if (settingsOverlay) settingsOverlay.style.display = 'flex';
            }
        }
    }

    cycleLanguage() {
        const currentIndex = this.supportedLanguages.indexOf(this.currentLang);
        const nextIndex = (currentIndex + 1) % this.supportedLanguages.length;
        this.changeLanguage(this.supportedLanguages[nextIndex]);
    }
}

// init on load
document.addEventListener('DOMContentLoaded', () => {
    window.localeManager = new LocalizationManager();
    window.localeManager.init();
});