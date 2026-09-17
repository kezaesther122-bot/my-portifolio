// ─── SwipeDetector ───────────────────────────────────────────────────────────
// Pure-logic module. Receives raw touch coordinates and returns a swipe
// direction or null. No DOM dependency.

const SWIPE_THRESHOLD_PX = 50;

const SwipeDetector = {
  _startX: null,
  _startY: null,
  _endX: null,
  _endY: null,

  /** Record the touch-start position. */
  trackStart(x, y) {
    this._startX = x;
    this._startY = y;
    this._endX = null;
    this._endY = null;
  },

  /** Record the touch-end position. */
  trackEnd(x, y) {
    this._endX = x;
    this._endY = y;
  },

  /**
   * Derive swipe direction from recorded coordinates.
   * Returns 'left'  when deltaX <= -SWIPE_THRESHOLD_PX and |deltaX| > |deltaY|
   * Returns 'right' when deltaX >=  SWIPE_THRESHOLD_PX and |deltaX| > |deltaY|
   * Returns null    in all other cases (sub-threshold, vertical dominance,
   *                 or uninitialised state).
   */
  getDirection() {
    if (
      this._startX === null ||
      this._startY === null ||
      this._endX === null ||
      this._endY === null
    ) {
      return null;
    }

    const deltaX = this._endX - this._startX;
    const deltaY = this._endY - this._startY;
    const absDeltaX = Math.abs(deltaX);
    const absDeltaY = Math.abs(deltaY);

    // Vertical dominance: do not trigger horizontal navigation.
    if (absDeltaY >= absDeltaX) {
      return null;
    }

    // Sub-threshold: gesture too small to be intentional.
    if (absDeltaX < SWIPE_THRESHOLD_PX) {
      return null;
    }

    return deltaX < 0 ? 'left' : 'right';
  },

  /** Clear all recorded coordinates, ready for the next gesture. */
  reset() {
    this._startX = null;
    this._startY = null;
    this._endX = null;
    this._endY = null;
  },
};

// ─── LightboxDOM ─────────────────────────────────────────────────────────────
// Plain object populated by buildDOM(). Holds direct element references so
// LightboxController can update the overlay without repeated querySelector calls.

const LightboxDOM = {};

/**
 * Build the lightbox DOM skeleton, append it to <body>, and populate LightboxDOM.
 * Called once during LightboxController.init().
 *
 * Produces:
 *   <div class="lightbox" role="dialog" aria-modal="true" aria-label="Photo viewer">
 *     <button class="lightbox__close" aria-label="Close lightbox">&times;</button>
 *     <div class="lightbox__content">
 *       <button class="lightbox__prev" aria-label="Previous photo">&#8249;</button>
 *       <img class="lightbox__img" src="" alt="">
 *       <button class="lightbox__next" aria-label="Next photo">&#8250;</button>
 *     </div>
 *     <div class="lightbox__caption">
 *       <span class="lightbox__category"></span>
 *       <p class="lightbox__title"></p>
 *     </div>
 *   </div>
 */
function buildDOM() {
  // Overlay — the full-viewport dialog backdrop
  const overlay = document.createElement('div');
  overlay.className = 'lightbox';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Photo viewer');

  // Close button — top-right corner
  const closeBtn = document.createElement('button');
  closeBtn.className = 'lightbox__close';
  closeBtn.setAttribute('aria-label', 'Close lightbox');
  closeBtn.innerHTML = '&times;';

  // Content panel — holds prev arrow, image, next arrow
  const content = document.createElement('div');
  content.className = 'lightbox__content';

  const prevBtn = document.createElement('button');
  prevBtn.className = 'lightbox__prev';
  prevBtn.setAttribute('aria-label', 'Previous photo');
  prevBtn.innerHTML = '&#8249;';

  const img = document.createElement('img');
  img.className = 'lightbox__img';
  img.src = '';
  img.alt = '';

  const nextBtn = document.createElement('button');
  nextBtn.className = 'lightbox__next';
  nextBtn.setAttribute('aria-label', 'Next photo');
  nextBtn.innerHTML = '&#8250;';

  content.appendChild(prevBtn);
  content.appendChild(img);
  content.appendChild(nextBtn);

  // Caption area — category label and photo title
  const caption = document.createElement('div');
  caption.className = 'lightbox__caption';

  const category = document.createElement('span');
  category.className = 'lightbox__category';

  const title = document.createElement('p');
  title.className = 'lightbox__title';

  caption.appendChild(category);
  caption.appendChild(title);

  // Assemble overlay
  overlay.appendChild(closeBtn);
  overlay.appendChild(content);
  overlay.appendChild(caption);

  document.body.appendChild(overlay);

  // Populate LightboxDOM references
  LightboxDOM.overlay   = overlay;
  LightboxDOM.img       = img;
  LightboxDOM.title     = title;
  LightboxDOM.category  = category;
  LightboxDOM.closeBtn  = closeBtn;
  LightboxDOM.prevBtn   = prevBtn;
  LightboxDOM.nextBtn   = nextBtn;
}

// ─── Photo sequence ───────────────────────────────────────────────────────────

/**
 * Build an ordered snapshot of all gallery photos present in the DOM.
 * Called once per lightbox open so that subsequent gallery mutations do not
 * affect the current navigation session.
 *
 * @returns {Array<{src: string, alt: string, title: string, category: string, element: Element}>}
 */
function buildPhotoSequence() {
  return Array.from(document.querySelectorAll('article.photo img')).map(img => {
    const info = img.closest('article').querySelector('.photo-info');
    return {
      src:      img.src,
      alt:      img.alt,
      title:    info.querySelector('h3').textContent,
      category: info.querySelector('span').textContent,
      element:  img,
    };
  });
}

// ─── Navigation index arithmetic ─────────────────────────────────────────────

/**
 * Return the next index in a circular sequence.
 * @param {number} current - Current index.
 * @param {number} length  - Sequence length (must be ≥ 1).
 * @returns {number}
 */
function nextIndex(current, length) { return (current + 1) % length; }

/**
 * Return the previous index in a circular sequence.
 * @param {number} current - Current index.
 * @param {number} length  - Sequence length (must be ≥ 1).
 * @returns {number}
 */
function prevIndex(current, length) { return (current - 1 + length) % length; }

// ─── LightboxController ───────────────────────────────────────────────────────
// Central coordinator. Private state is scoped to the IIFE closure.
// open(), close(), and navigateTo() are the public surface.
// init() (event wiring) is added in task 7.1.

const LightboxController = (() => {
  let _photoSequence = [];
  let _currentIndex  = 0;
  let _openerElement = null;
  let _isOpen        = false;

  // ── 6.1 open(index) ─────────────────────────────────────────────────────────
  /**
   * Open the lightbox and display the photo at the given index.
   * No-op if the lightbox is already open (prevents double-open).
   *
   * @param {number} index - Position in the gallery sequence to display.
   */
  function open(index) {
    // Guard: do not open again if already visible.
    if (_isOpen) return;

    // Snapshot the current gallery order each time the lightbox opens so that
    // late DOM mutations (e.g. lazy-loaded images) don't corrupt a live session.
    _photoSequence = buildPhotoSequence();
    _currentIndex  = index;

    const photo = _photoSequence[index];

    // Store the originating article element so focus can be returned on close (Req 2.6).
    // The article has tabindex="0" (set in init()) so .focus() works reliably.
    _openerElement = photo.element.closest('article');

    // Populate lightbox image and metadata (Req 1.2, 7.7, 8.2).
    LightboxDOM.img.src        = photo.src;
    LightboxDOM.img.alt        = photo.alt;
    LightboxDOM.title.textContent    = photo.title;
    LightboxDOM.category.textContent = photo.category;

    // Show/hide navigation arrows based on sequence length.
    _updateArrowVisibility();

    // Lock body scroll (Req 1.3).
    document.body.style.overflow = 'hidden';

    // Reveal overlay via CSS class — the 300ms fade-in is handled by the
    // Animator (CSS transition on .lightbox--visible). (Req 1.4)
    LightboxDOM.overlay.classList.add('lightbox--visible');
    _isOpen = true;

    // Move keyboard focus to the close button (Req 7.6).
    LightboxDOM.closeBtn.focus();
  }

  // ── 6.2 close() ─────────────────────────────────────────────────────────────
  /**
   * Close the lightbox.
   * Restores scroll, hides the overlay, and returns focus to the opener.
   */
  function close() {
    // Hide overlay — CSS fade-out transition fires automatically (Req 2.4).
    LightboxDOM.overlay.classList.remove('lightbox--visible');
    _isOpen = false;

    // Restore body scroll (Req 2.5).
    document.body.style.overflow = '';

    // Return focus to the element that opened the lightbox (Req 2.6).
    // Fall back to the gallery container if the opener has been removed from
    // the DOM since the lightbox was opened.
    if (_openerElement && document.contains(_openerElement)) {
      _openerElement.focus();
    } else {
      const gallery = document.querySelector('.gallery');
      if (gallery) gallery.focus();
    }

    _openerElement = null;
  }

  // ── 6.3 navigateTo(index) ────────────────────────────────────────────────────
  /**
   * Update the displayed photo to the one at the given index.
   * Does not re-open the lightbox; it must already be visible.
   *
   * @param {number} index - Target index in _photoSequence.
   */
  function navigateTo(index) {
    _currentIndex = index;

    const photo = _photoSequence[index];

    // Update image and metadata in-place (Req 3.5, 1.2, 7.7, 8.2).
    LightboxDOM.img.src        = photo.src;
    LightboxDOM.img.alt        = photo.alt;
    LightboxDOM.title.textContent    = photo.title;
    LightboxDOM.category.textContent = photo.category;

    // Keep arrow visibility in sync (e.g. sequence rebuilt mid-session).
    _updateArrowVisibility();
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  /**
   * Hide navigation arrows when the sequence has fewer than 2 photos (no
   * meaningful navigation possible). Show them otherwise.
   */
  function _updateArrowVisibility() {
    const show = _photoSequence.length >= 2;
    LightboxDOM.prevBtn.style.display = show ? '' : 'none';
    LightboxDOM.nextBtn.style.display = show ? '' : 'none';
  }

  // ── Swipe-in-progress flag (used by task 8.1) ────────────────────────────────
  // Set true between touchstart and the end of the touchend handler so that
  // the backdrop-click listener does not fire a spurious close() on lift-off.
  let _swipeInProgress = false;

  // ── 7.2 handleKey(e) ─────────────────────────────────────────────────────────
  /**
   * Global keydown handler. All three keys are no-ops when _isOpen is false
   * (Requirement 4.5).
   *
   * @param {KeyboardEvent} e
   */
  function handleKey(e) {
    if (!_isOpen) return;

    switch (e.key) {
      case 'ArrowRight':
        // Requirement 4.1 — navigate to next photo.
        navigateTo(nextIndex(_currentIndex, _photoSequence.length));
        break;
      case 'ArrowLeft':
        // Requirement 4.2 — navigate to previous photo.
        navigateTo(prevIndex(_currentIndex, _photoSequence.length));
        break;
      case 'Escape':
        // Requirement 4.3 — close the lightbox.
        close();
        break;
    }
  }

  // ── 7.3 trapFocus(e) ─────────────────────────────────────────────────────────
  /**
   * Keydown handler registered on the overlay element. Intercepts Tab and
   * Shift+Tab to keep focus cycling within the lightbox (Requirement 4.4).
   *
   * Focusable candidates: any <button> or element with tabindex >= 0 inside
   * the overlay that is currently visible and not disabled.
   *
   * @param {KeyboardEvent} e
   */
  function trapFocus(e) {
    if (e.key !== 'Tab') return;

    // Collect all currently focusable elements inside the overlay.
    const focusable = Array.from(
      LightboxDOM.overlay.querySelectorAll(
        'button:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    ).filter(el => !el.hidden && el.style.display !== 'none');

    if (focusable.length === 0) return;

    const first = focusable[0];
    const last  = focusable[focusable.length - 1];

    if (e.shiftKey) {
      // Shift+Tab from the first element → wrap to last.
      if (document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    } else {
      // Tab from the last element → wrap to first.
      if (document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  // ── 7.1 init() ───────────────────────────────────────────────────────────────
  /**
   * Bootstrap the lightbox: build the DOM skeleton, attach all event listeners.
   * Must be called once, on DOMContentLoaded.
   *
   * Early-exits gracefully if there are no gallery images so the listener
   * overhead is zero on pages without a gallery (Requirement 8.3).
   */
  function init() {
    // Early exit if no gallery images — nothing to wire up.
    const articles = Array.from(document.querySelectorAll('article.photo'));
    if (articles.length === 0) return;

    // Build the lightbox DOM skeleton once (Requirement 7.1–7.5).
    buildDOM();

    // ── Gallery article click handlers (Requirement 1.1) ────────────────────
    // tabindex="0" makes each article focusable so keyboard users can reach it
    // and focus returns correctly when the lightbox closes (Requirement 2.6).
    articles.forEach((article, index) => {
      article.setAttribute('tabindex', '0');
      article.style.cursor = 'pointer'; // reinforce pointer cursor
      article.addEventListener('click', () => open(index));
      // Allow keyboard activation via Enter or Space (standard button semantics).
      article.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open(index);
        }
      });
    });

    // ── Close button (Requirement 2.1) ──────────────────────────────────────
    LightboxDOM.closeBtn.addEventListener('click', close);

    // ── Backdrop click (Requirement 2.2) ────────────────────────────────────
    // Only close when the click target is the overlay itself (i.e. the dark
    // backdrop), not any of its child elements (content, buttons, image).
    // Also suppressed while a swipe gesture is in progress (Requirement 5.4).
    LightboxDOM.overlay.addEventListener('click', (e) => {
      if (e.target === LightboxDOM.overlay && !_swipeInProgress) close();
    });

    // ── Navigation arrows (Requirements 3.1, 3.2) ───────────────────────────
    LightboxDOM.prevBtn.addEventListener('click', () =>
      navigateTo(prevIndex(_currentIndex, _photoSequence.length))
    );
    LightboxDOM.nextBtn.addEventListener('click', () =>
      navigateTo(nextIndex(_currentIndex, _photoSequence.length))
    );

    // ── Global keyboard handler (Requirements 4.1–4.3, 4.5) ─────────────────
    document.addEventListener('keydown', handleKey);

    // ── Focus trap on the overlay (Requirement 4.4) ──────────────────────────
    LightboxDOM.overlay.addEventListener('keydown', trapFocus);

    // ── Touch swipe navigation (Requirements 5.1–5.4) ────────────────────────
    LightboxDOM.overlay.addEventListener('touchstart', (e) => {
      SwipeDetector.trackStart(e.touches[0].clientX, e.touches[0].clientY);
      _swipeInProgress = true;
    }, { passive: true });

    LightboxDOM.overlay.addEventListener('touchend', (e) => {
      SwipeDetector.trackEnd(e.changedTouches[0].clientX, e.changedTouches[0].clientY);
      const direction = SwipeDetector.getDirection();
      if (direction === 'left') {
        navigateTo(nextIndex(_currentIndex, _photoSequence.length));
      } else if (direction === 'right') {
        navigateTo(prevIndex(_currentIndex, _photoSequence.length));
      }
      SwipeDetector.reset();
      // Defer flag reset so backdrop-click on same gesture sees it still set (Req 5.4).
      setTimeout(() => { _swipeInProgress = false; }, 0);
    });
  }

  // Public API — init exposed so DOMContentLoaded can call it (task 9.1).
  return { open, close, navigateTo, init };
})();

// ─── Bootstrap ───────────────────────────────────────────────────────────────
// Wire up the lightbox (and any other page-level JS) once the DOM is ready.

// ─── KeyboardSound ────────────────────────────────────────────────────────────
// Synthesises a soft mechanical key-click using the Web Audio API.
// No audio file required — runs entirely in the browser.

const KeyboardSound = (() => {
  let _ctx = null;
  let _enabled = true;

  /** Lazily create (or resume) the AudioContext on first user interaction. */
  function _getContext() {
    if (!_ctx) {
      _ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (_ctx.state === 'suspended') _ctx.resume();
    return _ctx;
  }

  /**
   * Play a single soft key-click.
   * Layered: short noise burst (click transient) + low sine thud (body).
   */
  function play() {
    if (!_enabled) return;
    try {
      const ctx  = _getContext();
      const now  = ctx.currentTime;

      /* ── Noise burst — the crisp "click" transient ── */
      const bufferSize = ctx.sampleRate * 0.04; // 40 ms of noise
      const buffer     = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      const data       = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        data[i] = (Math.random() * 2 - 1);
      }

      const noiseSource = ctx.createBufferSource();
      noiseSource.buffer = buffer;

      // Band-pass around 3 kHz — gives it that "tick" character
      const bandpass = ctx.createBiquadFilter();
      bandpass.type            = 'bandpass';
      bandpass.frequency.value = 3000;
      bandpass.Q.value         = 0.8;

      const noiseGain = ctx.createGain();
      noiseGain.gain.setValueAtTime(0.18, now);
      noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.04);

      noiseSource.connect(bandpass);
      bandpass.connect(noiseGain);
      noiseGain.connect(ctx.destination);
      noiseSource.start(now);
      noiseSource.stop(now + 0.04);

      /* ── Sine thud — soft low-frequency body ── */
      const osc     = ctx.createOscillator();
      osc.type      = 'sine';
      osc.frequency.setValueAtTime(180, now);
      osc.frequency.exponentialRampToValueAtTime(60, now + 0.06);

      const oscGain = ctx.createGain();
      oscGain.gain.setValueAtTime(0.12, now);
      oscGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.06);

      osc.connect(oscGain);
      oscGain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.06);

    } catch (e) {
      // Silently ignore — AudioContext not available or suspended
    }
  }

  /** Toggle sound on/off (used by the mute button). */
  function toggle() {
    _enabled = !_enabled;
    return _enabled;
  }

  return { play, toggle };
})();

document.addEventListener('DOMContentLoaded', () => {
  // Mobile menu toggle (existing functionality)
  const menuButton = document.getElementById('menuButton');
  const navMenu    = document.getElementById('navMenu');
  if (menuButton && navMenu) {
    menuButton.addEventListener('click', () => {
      navMenu.classList.toggle('active');
    });
  }

  // Lightbox — early-exits gracefully if no gallery images exist (Req 8.3)
  LightboxController.init();

  // ── Keyboard typing sound on every keydown ──────────────────────────────
  document.addEventListener('keydown', (e) => {
    // Skip modifier-only keys
    if (['Shift','Control','Alt','Meta','CapsLock','Tab'].includes(e.key)) return;
    KeyboardSound.play();
  });

  // ── Mute / unmute toggle button ─────────────────────────────────────────
  const muteBtn = document.createElement('button');
  muteBtn.id = 'soundToggle';
  muteBtn.setAttribute('aria-label', 'Toggle keyboard sound');
  muteBtn.setAttribute('title', 'Toggle keyboard sound');
  muteBtn.innerHTML = `
    <svg id="soundIcon" xmlns="http://www.w3.org/2000/svg" width="18" height="18"
      viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
    </svg>`;
  document.body.appendChild(muteBtn);

  muteBtn.addEventListener('click', () => {
    const on = KeyboardSound.toggle();
    muteBtn.classList.toggle('muted', !on);
    muteBtn.setAttribute('aria-label', on ? 'Mute keyboard sound' : 'Unmute keyboard sound');
  });
});
