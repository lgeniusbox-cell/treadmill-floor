/**
 * ============================================================================
 * FitTV Arena - Complete Android TV & 10-Foot Web Application Engine
 * Architecture:
 * 1. CONFIG & SYSTEM PARAMETERS
 * 2. INPUT LAYER & SEMANTIC EVENT BUS (Keyboard, Remote, Gamepad, Floor-Mat, Bridge)
 * 3. PROCEDURAL WEBAUDIO SYNTHESIZER
 * 4. SPATIAL FOCUS NAVIGATION ENGINE (Geometric D-Pad Spatial Algorithm)
 * 5. PROFILE, THEMES & STORAGE MANAGER
 * 6. CONTENT LOADER (Manifests & JSON Parser)
 * 7. YOUTUBE IFRAME PLAYER & NON-DESTRUCTIVE EDIT ENGINE
 * 8. GAME ENGINE (Timeline Judging, Score, Combo, Canvas Animator)
 * 9. RUN ENGINE (Floor-Mat Steps Cadence, Speed Sync, Treadmill HUD)
 * 10. APP CONTROLLER & SCREEN ROUTING
 * ============================================================================
 */

(function () {
  'use strict';

  // ==========================================================================
  // SECTION 1: CONFIGURATION OBJECT (CENTRALIZED & EDITABLE)
  // ==========================================================================
  const CONFIG = {
    // Input & Auto-Repeat
    input: {
      gamepadPollIntervalMs: 16,
      navAutoRepeatDelayMs: 400,     // Initial delay before repeating D-pad
      navAutoRepeatRateMs: 120,      // Interval for repeating D-pad
      stickDeadzone: 0.45,           // Analog stick threshold
      stepDebounceMs: 150,           // Ignore steps faster than 150ms (bounce)
      stepTimeoutMs: 2500,           // More than 2.5s without steps = runner stopped
      simulationModeDefault: true    // Alt+L / Alt+R keyboard simulation
    },

    // Video Engine
    video: {
      pollIntervalMs: 50,            // YouTube clock watcher interval
      supportedPlaybackRates: [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0]
    },

    // Game Engine Default Rules
    game: {
      defaultLives: 3,
      defaultMaxMisses: 5,
      timingWindow: {
        perfectMs: 120,
        goodMs: 300
      },
      scoring: {
        perfectPoints: 100,
        goodPoints: 50,
        comboStep: 5,                // Multiplier +1 every 5 hits
        maxMultiplier: 4
      }
    },

    // Virtual Run Default Settings
    run: {
      referenceSpeedKmh: 8.0,        // Speed corresponding to 1.0x video rate
      minSpeedKmh: 3.0,
      maxSpeedKmh: 18.0,
      minPlaybackRate: 0.25,
      maxPlaybackRate: 2.0,
      rateHysteresisKmh: 0.4,        // Prevents rate flickering
      speedSmoothingFactor: 0.25,    // Exponential moving average alpha
      cadenceWindowSize: 6           // Median window for cadence calculation
    },

    // Default Profile
    profileDefaults: {
      name: "Joueur 1",
      theme: "adult",                // "kids" | "adult" | "pro"
      strideLengthM: 0.75,
      weightKg: 70,
      soundEnabled: true,
      calibrationOffsetMs: 0
    }
  };

  // ==========================================================================
  // SECTION 2: INPUT LAYER & SEMANTIC EVENT BUS
  // ==========================================================================
  /**
   * The Input Layer converts raw hardware events (TV Remote D-pad, Keyboard,
   * Gamepad, and Floor-Mat L1/R1 tracker) into SEMANTIC EVENTS.
   * Nothing else in the application reads raw hardware keys!
   */
  class EventBus {
    constructor() {
      this.listeners = new Map();
    }

    on(eventName, callback) {
      if (!this.listeners.has(eventName)) {
        this.listeners.set(eventName, new Set());
      }
      this.listeners.get(eventName).add(callback);
      return () => this.listeners.get(eventName)?.delete(callback);
    }

    emit(eventName, payload = {}) {
      const eventObj = {
        name: eventName,
        timestamp: performance.now(),
        payload: payload || {}
      };

      // Notify internal listeners
      const cbs = this.listeners.get(eventName);
      if (cbs) {
        cbs.forEach(cb => {
          try { cb(eventObj); } catch (err) { console.error(`Error in event listener ${eventName}:`, err); }
        });
      }

      // Universal listener
      const anyCbs = this.listeners.get('*');
      if (anyCbs) {
        anyCbs.forEach(cb => {
          try { cb(eventObj); } catch (err) {}
        });
      }

      // Java Android WebView Bridge Notification
      if (window.Android && typeof window.Android.onAppEvent === 'function') {
        try {
          window.Android.onAppEvent(JSON.stringify(eventObj));
        } catch (e) {
          console.warn("Android onAppEvent call failed:", e);
        }
      }

      return eventObj;
    }
  }

  const bus = new EventBus();

  // Expose TVBridge for Java WebView injection
  window.TVBridge = {
    dispatch: (eventName, payload = {}) => {
      return bus.emit(eventName, payload);
    },
    onEvent: (callback) => {
      return bus.on('*', callback);
    }
  };

  // Input State Tracker
  const inputState = {
    lastStepTime: 0,
    gamepadConnected: false,
    activeGamepadIndex: null,
    navRepeatTimer: null,
    navRepeatKey: null,
    buttonStates: new Map(),
    stickPrevDir: null
  };

  /**
   * Keyboard & TV Remote Listener
   * Handles Android TV Remote D-pad keys, Enter, Back, ContextMenu,
   * Floor-Mat simulation (Alt+L, Alt+R, plain L/R), and PC game keys (F, D).
   */
  function setupKeyboardInput() {
    window.addEventListener('keydown', (e) => {
      const code = e.code;
      const key = e.key;

      // Check if user is typing in a native input or textarea (e.g. in custom script modal)
      const isInputFocused = document.activeElement && 
        (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA');

      // Check if TV On-Screen Keyboard dialog is currently active
      const isTVKeyboardActive = document.getElementById('dialog-keyboard')?.classList.contains('active');

      if (isTVKeyboardActive) {
        // Physical keyboard interaction directly typing into TV keyboard preview
        if (key === 'Backspace') {
          e.preventDefault();
          app.handleKeyboardBackspace();
          return;
        } else if (key === 'Enter') {
          e.preventDefault();
          app.handleKeyboardConfirm();
          return;
        } else if (key === 'Escape') {
          e.preventDefault();
          app.handleKeyboardCancel();
          return;
        } else if (key === ' ' || code === 'Space') {
          e.preventDefault();
          app.handleKeyboardChar(' ');
          return;
        } else if (key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          app.handleKeyboardChar(key.toUpperCase());
          return;
        }
      }

      if (isInputFocused) {
        if (key === 'Escape') {
          e.preventDefault();
          document.activeElement.blur();
          return;
        }
        return; // Allow standard input typing without triggering navigation or game steps
      }

      // 1. STEP EVENTS: Floor-mat simulation (Alt+L = STEP_LEFT, Alt+R = STEP_RIGHT)
      // Also supports plain 'KeyL' or 'KeyR' for convenience on PC.
      // STEPS MUST NEVER REPEAT VIA KEY AUTO-REPEAT!
      if ((e.altKey && (code === 'KeyL' || key === 'l' || key === 'L')) || (!e.altKey && (code === 'KeyL' || key === 'l' || key === 'L'))) {
        e.preventDefault();
        e.stopPropagation();
        if (e.repeat) return; // Ignore browser key repeat for steps
        bus.emit('STEP_LEFT', { source: 'keyboard' });
        return;
      }

      if ((e.altKey && (code === 'KeyR' || key === 'r' || key === 'R')) || (!e.altKey && (code === 'KeyR' || key === 'r' || key === 'R'))) {
        e.preventDefault();
        e.stopPropagation();
        if (e.repeat) return; // Ignore browser key repeat for steps
        bus.emit('STEP_RIGHT', { source: 'keyboard' });
        return;
      }

      // 2. NAVIGATION & TV REMOTE KEYS
      if (key === 'ArrowUp') {
        e.preventDefault();
        bus.emit('NAV_UP');
        bus.emit('JUMP'); // Also triggers JUMP in game mode
      } else if (key === 'ArrowDown') {
        e.preventDefault();
        bus.emit('NAV_DOWN');
        bus.emit('SLIDE_DOWN'); // Also triggers SLIDE_DOWN in game mode
      } else if (key === 'ArrowLeft') {
        e.preventDefault();
        bus.emit('NAV_LEFT');
        bus.emit('LEFT');
      } else if (key === 'ArrowRight') {
        e.preventDefault();
        bus.emit('NAV_RIGHT');
        bus.emit('RIGHT');
      } else if (key === 'Enter' || key === ' ' || code === 'Space' || code === 'NumpadEnter') {
        e.preventDefault();
        bus.emit('OK');
      } else if (key === 'Escape' || key === 'Backspace' || key === 'BrowserBack' || key === 'GoBack') {
        e.preventDefault();
        bus.emit('BACK');
      } else if (key === 'ContextMenu' || code === 'KeyM' || key === 'm' || key === 'M') {
        e.preventDefault();
        bus.emit('MENU');
      } else if (code === 'KeyP' || key === 'p' || key === 'P' || key === 'MediaPlayPause') {
        e.preventDefault();
        bus.emit('PAUSE');
      } else if (code === 'KeyF' || key === 'f' || key === 'F') {
        e.preventDefault();
        bus.emit('PUNCH');
      } else if (code === 'KeyD' || key === 'd' || key === 'D') {
        e.preventDefault();
        bus.emit('SLASH');
      }
    }, { capture: true });
  }

  /**
   * Gamepad & Floor-Mat Tracker (Gamepad API Polling)
   * Standard Mapping:
   * - Left Stick & D-Pad (12-15) = NAV_* / LEFT / RIGHT / JUMP / SLIDE_DOWN
   * - A (0) = OK & JUMP
   * - B (1) = BACK
   * - X (2) = PUNCH
   * - Y (3) = SLASH
   * - L1 (4) = STEP_LEFT (Floor-mat Left Foot!)
   * - R1 (5) = STEP_RIGHT (Floor-mat Right Foot!)
   * - Start (9) = PAUSE / MENU
   */
  function setupGamepadInput() {
    window.addEventListener('gamepadconnected', (e) => {
      console.log(`Gamepad connected at index ${e.gamepad.index}: ${e.gamepad.id}`);
      inputState.gamepadConnected = true;
      if (inputState.activeGamepadIndex === null) {
        inputState.activeGamepadIndex = e.gamepad.index;
      }
      updateGamepadBadge(true, e.gamepad.id);
      sound.play('click');
    });

    window.addEventListener('gamepaddisconnected', (e) => {
      console.log(`Gamepad disconnected from index ${e.gamepad.index}`);
      if (inputState.activeGamepadIndex === e.gamepad.index) {
        inputState.activeGamepadIndex = null;
        inputState.gamepadConnected = false;
        // Check if other gamepads exist
        const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
        for (let i = 0; i < gamepads.length; i++) {
          if (gamepads[i]) {
            inputState.activeGamepadIndex = i;
            inputState.gamepadConnected = true;
            break;
          }
        }
      }
      updateGamepadBadge(inputState.gamepadConnected);
    });

    // Start Polling Loop inside requestAnimationFrame
    function pollGamepads() {
      if (navigator.getGamepads) {
        const gamepads = navigator.getGamepads();
        const gp = (inputState.activeGamepadIndex !== null && gamepads[inputState.activeGamepadIndex])
          ? gamepads[inputState.activeGamepadIndex]
          : null;

        if (gp) {
          processGamepadState(gp);
        }
      }
      requestAnimationFrame(pollGamepads);
    }
    requestAnimationFrame(pollGamepads);
  }

  function updateGamepadBadge(connected, name = "") {
    const badge = document.getElementById('gamepad-status-badge');
    const text = document.getElementById('gamepad-status-text');
    if (!badge || !text) return;

    if (connected) {
      badge.classList.add('connected');
      text.textContent = name ? (name.length > 18 ? name.substring(0, 18) + '...' : name) : "Manette Active (L1/R1)";
    } else {
      badge.classList.remove('connected');
      text.textContent = "Manette déconnectée";
    }
  }

  function processGamepadState(gp) {
    const now = performance.now();

    // 1. FLOOR-MAT TRACKER: L1 (button 4) and R1 (button 5)
    // Steps are EDGE-TRIGGERED ONLY and NEVER affected by nav auto-repeat!
    const btnL1Pressed = gp.buttons[4]?.pressed || (gp.buttons[4]?.value > 0.5);
    const btnR1Pressed = gp.buttons[5]?.pressed || (gp.buttons[5]?.value > 0.5);

    const prevL1 = inputState.buttonStates.get('btn_4') || false;
    const prevR1 = inputState.buttonStates.get('btn_5') || false;

    if (btnL1Pressed && !prevL1) {
      bus.emit('STEP_LEFT', { source: 'gamepad_l1' });
    }
    if (btnR1Pressed && !prevR1) {
      bus.emit('STEP_RIGHT', { source: 'gamepad_r1' });
    }

    inputState.buttonStates.set('btn_4', btnL1Pressed);
    inputState.buttonStates.set('btn_5', btnR1Pressed);

    // 2. ACTION BUTTONS (Edge triggered)
    const btnA = gp.buttons[0]?.pressed; // A (OK & JUMP)
    const btnB = gp.buttons[1]?.pressed; // B (BACK)
    const btnX = gp.buttons[2]?.pressed; // X (PUNCH)
    const btnY = gp.buttons[3]?.pressed; // Y (SLASH)
    const btnStart = gp.buttons[9]?.pressed; // Start (PAUSE/MENU)

    checkEdgeButton(0, btnA, () => { bus.emit('OK'); bus.emit('JUMP'); });
    checkEdgeButton(1, btnB, () => bus.emit('BACK'));
    checkEdgeButton(2, btnX, () => bus.emit('PUNCH'));
    checkEdgeButton(3, btnY, () => bus.emit('SLASH'));
    checkEdgeButton(9, btnStart, () => bus.emit('PAUSE'));

    // 3. NAVIGATION (D-Pad Buttons 12-15 & Left Analog Stick with Auto-Repeat)
    const dpadUp = gp.buttons[12]?.pressed || (gp.axes[1] < -CONFIG.input.stickDeadzone);
    const dpadDown = gp.buttons[13]?.pressed || (gp.axes[1] > CONFIG.input.stickDeadzone);
    const dpadLeft = gp.buttons[14]?.pressed || (gp.axes[0] < -CONFIG.input.stickDeadzone);
    const dpadRight = gp.buttons[15]?.pressed || (gp.axes[0] > CONFIG.input.stickDeadzone);

    let currentNav = null;
    if (dpadUp) currentNav = 'NAV_UP';
    else if (dpadDown) currentNav = 'NAV_DOWN';
    else if (dpadLeft) currentNav = 'NAV_LEFT';
    else if (dpadRight) currentNav = 'NAV_RIGHT';

    handleNavWithAutoRepeat(currentNav, now);
  }

  function checkEdgeButton(buttonIndex, isPressed, callback) {
    const key = 'btn_' + buttonIndex;
    const wasPressed = inputState.buttonStates.get(key) || false;
    if (isPressed && !wasPressed) {
      callback();
    }
    inputState.buttonStates.set(key, isPressed);
  }

  function handleNavWithAutoRepeat(navDir, now) {
    if (!navDir) {
      inputState.navRepeatKey = null;
      inputState.navRepeatTimer = null;
      return;
    }

    if (inputState.navRepeatKey !== navDir) {
      // First press
      inputState.navRepeatKey = navDir;
      inputState.navRepeatTimer = now + CONFIG.input.navAutoRepeatDelayMs;
      bus.emit(navDir);
      // Trigger game directional actions
      if (navDir === 'NAV_UP') bus.emit('JUMP');
      if (navDir === 'NAV_DOWN') bus.emit('SLIDE_DOWN');
      if (navDir === 'NAV_LEFT') bus.emit('LEFT');
      if (navDir === 'NAV_RIGHT') bus.emit('RIGHT');
    } else {
      // Auto-repeat
      if (now >= inputState.navRepeatTimer) {
        inputState.navRepeatTimer = now + CONFIG.input.navAutoRepeatRateMs;
        bus.emit(navDir);
      }
    }
  }

  // ==========================================================================
  // SECTION 3: PROCEDURAL WEBAUDIO SYNTHESIZER
  // ==========================================================================
  /**
   * Generates all sound effects directly in code (no external mp3/wav files).
   */
  class SoundFX {
    constructor() {
      this.ctx = null;
      this.muted = false;
    }

    init() {
      if (!this.ctx) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (AudioCtx) this.ctx = new AudioCtx();
      }
      if (this.ctx && this.ctx.state === 'suspended') {
        this.ctx.resume();
      }
    }

    play(type) {
      if (this.muted) return;
      this.init();
      if (!this.ctx) return;

      const now = this.ctx.currentTime;

      switch (type) {
        case 'focus': {
          const osc = this.ctx.createOscillator();
          const gain = this.ctx.createGain();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(440, now);
          osc.frequency.exponentialRampToValueAtTime(520, now + 0.05);
          gain.gain.setValueAtTime(0.04, now);
          gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
          osc.connect(gain);
          gain.connect(this.ctx.destination);
          osc.start(now);
          osc.stop(now + 0.05);
          break;
        }

        case 'click': {
          const osc = this.ctx.createOscillator();
          const gain = this.ctx.createGain();
          osc.type = 'triangle';
          osc.frequency.setValueAtTime(587, now);
          osc.frequency.exponentialRampToValueAtTime(880, now + 0.08);
          gain.gain.setValueAtTime(0.1, now);
          gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
          osc.connect(gain);
          gain.connect(this.ctx.destination);
          osc.start(now);
          osc.stop(now + 0.08);
          break;
        }

        case 'success': {
          // Cheerful two-tone chime
          [523.25, 659.25, 783.99].forEach((freq, idx) => {
            const osc = this.ctx.createOscillator();
            const gain = this.ctx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(freq, now + idx * 0.06);
            gain.gain.setValueAtTime(0.12, now + idx * 0.06);
            gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.06 + 0.18);
            osc.connect(gain);
            gain.connect(this.ctx.destination);
            osc.start(now + idx * 0.06);
            osc.stop(now + idx * 0.06 + 0.18);
          });
          break;
        }

        case 'fail': {
          const osc = this.ctx.createOscillator();
          const gain = this.ctx.createGain();
          osc.type = 'sawtooth';
          osc.frequency.setValueAtTime(220, now);
          osc.frequency.exponentialRampToValueAtTime(110, now + 0.22);
          gain.gain.setValueAtTime(0.15, now);
          gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
          osc.connect(gain);
          gain.connect(this.ctx.destination);
          osc.start(now);
          osc.stop(now + 0.22);
          break;
        }

        case 'countdown': {
          const osc = this.ctx.createOscillator();
          const gain = this.ctx.createGain();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(440, now);
          gain.gain.setValueAtTime(0.15, now);
          gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
          osc.connect(gain);
          gain.connect(this.ctx.destination);
          osc.start(now);
          osc.stop(now + 0.12);
          break;
        }

        case 'go': {
          const osc = this.ctx.createOscillator();
          const gain = this.ctx.createGain();
          osc.type = 'triangle';
          osc.frequency.setValueAtTime(880, now);
          osc.frequency.exponentialRampToValueAtTime(1320, now + 0.25);
          gain.gain.setValueAtTime(0.2, now);
          gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
          osc.connect(gain);
          gain.connect(this.ctx.destination);
          osc.start(now);
          osc.stop(now + 0.25);
          break;
        }

        case 'win': {
          // Fanfare arpeggio
          [523.25, 659.25, 783.99, 1046.5].forEach((freq, idx) => {
            const osc = this.ctx.createOscillator();
            const gain = this.ctx.createGain();
            osc.type = 'triangle';
            osc.frequency.setValueAtTime(freq, now + idx * 0.1);
            gain.gain.setValueAtTime(0.18, now + idx * 0.1);
            gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.1 + 0.35);
            osc.connect(gain);
            gain.connect(this.ctx.destination);
            osc.start(now + idx * 0.1);
            osc.stop(now + idx * 0.1 + 0.35);
          });
          break;
        }

        case 'stepTick': {
          const osc = this.ctx.createOscillator();
          const gain = this.ctx.createGain();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(320, now);
          gain.gain.setValueAtTime(0.06, now);
          gain.gain.exponentialRampToValueAtTime(0.001, now + 0.04);
          osc.connect(gain);
          gain.connect(this.ctx.destination);
          osc.start(now);
          osc.stop(now + 0.04);
          break;
        }
      }
    }
  }

  const sound = new SoundFX();

  // ==========================================================================
  // SECTION 4: SPATIAL FOCUS NAVIGATION ENGINE
  // ==========================================================================
  /**
   * Hand-crafted Geometric Spatial Navigation algorithm for 10-foot TV UI.
   * Finds the best matching [data-focusable] element in the direction of D-Pad.
   * Traps focus inside open dialogs and remembers the last focused item per screen.
   */
  class SpatialNavigation {
    constructor() {
      this.currentFocused = null;
      this.lastFocusedByScreen = new Map();
      this.activeModal = null;

      // Bind to semantic navigation events
      bus.on('NAV_UP', () => this.navigate('up'));
      bus.on('NAV_DOWN', () => this.navigate('down'));
      bus.on('NAV_LEFT', () => this.navigate('left'));
      bus.on('NAV_RIGHT', () => this.navigate('right'));
      bus.on('OK', () => this.triggerCurrent());
    }

    getFocusableElements() {
      // If a modal dialog is active, trap focus exclusively inside it
      const root = this.activeModal || document;
      const elements = Array.from(root.querySelectorAll('[data-focusable]'));
      return elements.filter(el => {
        // Exclude elements inside hidden parents
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        if (el.closest('.tv-screen:not(.active)')) return false;
        if (!this.activeModal && el.closest('.tv-dialog-backdrop:not(.active)')) return false;
        return true;
      });
    }

    setFocus(element, playSound = true) {
      if (!element) return;
      if (this.currentFocused) {
        this.currentFocused.classList.remove('focused');
      }

      this.currentFocused = element;
      this.currentFocused.classList.add('focused');

      // Scroll element smoothly into view if needed (no scrollbars)
      this.currentFocused.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
        inline: 'nearest'
      });

      // Remember last focused element for current active screen
      const screen = element.closest('.tv-screen');
      if (screen) {
        this.lastFocusedByScreen.set(screen.id, element);
      }

      if (playSound) {
        sound.play('focus');
      }
    }

    navigate(direction) {
      const candidates = this.getFocusableElements();
      if (candidates.length === 0) return;

      if (!this.currentFocused || !candidates.includes(this.currentFocused)) {
        this.setFocus(candidates[0]);
        return;
      }

      const currentRect = this.currentFocused.getBoundingClientRect();
      const currentCenter = {
        x: currentRect.left + currentRect.width / 2,
        y: currentRect.top + currentRect.height / 2
      };

      let bestCandidate = null;
      let minDistanceScore = Infinity;

      for (const candidate of candidates) {
        if (candidate === this.currentFocused) continue;
        const candRect = candidate.getBoundingClientRect();
        const candCenter = {
          x: candRect.left + candRect.width / 2,
          y: candRect.top + candRect.height / 2
        };

        const dx = candCenter.x - currentCenter.x;
        const dy = candCenter.y - currentCenter.y;

        // Verify direction constraint
        let primaryDist = 0;
        let secondaryDist = 0;
        let isValidDirection = false;

        if (direction === 'up' && dy < -5) {
          primaryDist = -dy;
          secondaryDist = Math.abs(dx);
          isValidDirection = true;
        } else if (direction === 'down' && dy > 5) {
          primaryDist = dy;
          secondaryDist = Math.abs(dx);
          isValidDirection = true;
        } else if (direction === 'left' && dx < -5) {
          primaryDist = -dx;
          secondaryDist = Math.abs(dy);
          isValidDirection = true;
        } else if (direction === 'right' && dx > 5) {
          primaryDist = dx;
          secondaryDist = Math.abs(dy);
          isValidDirection = true;
        }

        if (isValidDirection) {
          // Weight orthogonal distance heavier to favor linear grid alignment
          const score = primaryDist + secondaryDist * 2.2;
          if (score < minDistanceScore) {
            minDistanceScore = score;
            bestCandidate = candidate;
          }
        }
      }

      if (bestCandidate) {
        this.setFocus(bestCandidate);
      }
    }

    triggerCurrent() {
      if (this.currentFocused) {
        sound.play('click');
        this.currentFocused.click();
      }
    }

    restoreScreenFocus(screenId) {
      const remembered = this.lastFocusedByScreen.get(screenId);
      const candidates = this.getFocusableElements();
      if (remembered && candidates.includes(remembered)) {
        this.setFocus(remembered, false);
      } else if (candidates.length > 0) {
        this.setFocus(candidates[0], false);
      }
    }

    trapInModal(modalElement) {
      this.activeModal = modalElement;
      const candidates = this.getFocusableElements();
      if (candidates.length > 0) {
        this.setFocus(candidates[0]);
      }
    }

    releaseModal() {
      this.activeModal = null;
      const candidates = this.getFocusableElements();
      if (candidates.length > 0) {
        this.setFocus(candidates[0], false);
      }
    }
  }

  const nav = new SpatialNavigation();

  // ==========================================================================
  // SECTION 5: PROFILE, AUDIENCE THEMES & STORAGE
  // ==========================================================================
  class ProfileManager {
    constructor() {
      this.profile = this.load();
      this.applyTheme(this.profile.theme);
      this.updateUI();
    }

    load() {
      try {
        const raw = localStorage.getItem('fittv_profile');
        if (raw) {
          const parsed = JSON.parse(raw);
          return { ...CONFIG.profileDefaults, ...parsed };
        }
      } catch (e) {}
      return { ...CONFIG.profileDefaults, bestScores: {}, bestRuns: {} };
    }

    save() {
      try {
        localStorage.setItem('fittv_profile', JSON.stringify(this.profile));
      } catch (e) {}
      this.updateUI();
    }

    setPlayerName(name) {
      if (!name || !name.trim()) return;
      this.profile.name = name.trim();
      this.save();
    }

    applyTheme(theme) {
      const validTheme = ['kids', 'adult', 'pro'].includes(theme) ? theme : 'adult';
      this.profile.theme = validTheme;
      document.body.setAttribute('data-theme', validTheme);
      this.save();
    }

    setStrideLength(delta) {
      this.profile.strideLengthM = Math.max(0.4, Math.min(1.4, Number((this.profile.strideLengthM + delta).toFixed(2))));
      this.save();
    }

    setWeight(delta) {
      this.profile.weightKg = Math.max(30, Math.min(150, this.profile.weightKg + delta));
      this.save();
    }

    recordGameScore(gameId, score) {
      this.profile.bestScores = this.profile.bestScores || {};
      const prev = this.profile.bestScores[gameId] || 0;
      if (score > prev) {
        this.profile.bestScores[gameId] = score;
        this.save();
        return true; // New Personal Best!
      }
      return false;
    }

    recordRun(routeId, durationSec, speedKmh) {
      this.profile.bestRuns = this.profile.bestRuns || {};
      const prev = this.profile.bestRuns[routeId];
      if (!prev || durationSec < prev.durationSec) {
        this.profile.bestRuns[routeId] = { durationSec, speedKmh };
        this.save();
        return true;
      }
      return false;
    }

    updateUI() {
      const nameEl = document.getElementById('header-profile-name');
      const dispEl = document.getElementById('profile-name-display');
      const themeBadge = document.getElementById('header-theme-badge');
      const strideVal = document.getElementById('label-stride-val');
      const weightVal = document.getElementById('label-weight-val');

      if (nameEl) nameEl.textContent = this.profile.name;
      if (dispEl) dispEl.value = this.profile.name;
      if (themeBadge) themeBadge.textContent = `[${this.profile.theme.toUpperCase()}]`;
      if (strideVal) strideVal.textContent = `${this.profile.strideLengthM}m`;
      if (weightVal) weightVal.textContent = `${this.profile.weightKg} kg`;
    }
  }

  const profile = new ProfileManager();

  // ==========================================================================
  // SECTION 6: CONTENT LOADER (MANIFESTS & TOLERANT JSON PARSER)
  // ==========================================================================
  class ContentLoader {
    static async loadCatalog(manifestPath, fallbackItems = []) {
      try {
        const resp = await fetch(manifestPath);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const fileList = await resp.json();

        const baseFolder = manifestPath.substring(0, manifestPath.lastIndexOf('/') + 1);
        const items = [];

        for (const filename of fileList) {
          try {
            const itemResp = await fetch(baseFolder + filename);
            if (itemResp.ok) {
              const data = await itemResp.json();
              items.push(ContentLoader.normalizeItem(data, filename));
            }
          } catch (itemErr) {
            console.warn(`Failed to parse catalog file ${filename}:`, itemErr);
          }
        }

        return items.length > 0 ? items : fallbackItems;
      } catch (err) {
        console.warn(`Manifest load failed for ${manifestPath}, using fallbacks:`, err);
        return fallbackItems;
      }
    }

    static extractYouTubeId(urlOrId) {
      if (!urlOrId || typeof urlOrId !== 'string') return null;
      const trimmed = urlOrId.trim();
      if (/^[\w-]{11}$/.test(trimmed)) return trimmed;
      const match = trimmed.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=|shorts\/|live\/))([\w-]{11})/);
      return match ? match[1] : null;
    }

    static getCustomItems(type) {
      try {
        const key = type === 'game' ? 'fittv_custom_games' : 'fittv_custom_runs';
        const raw = localStorage.getItem(key);
        if (raw) {
          const list = JSON.parse(raw);
          if (Array.isArray(list)) {
            return list.map(item => {
              const norm = ContentLoader.normalizeItem(item.raw || item, item.id || `custom_${Date.now()}`);
              norm.isCustom = true;
              return norm;
            });
          }
        }
      } catch (e) {
        console.warn("Failed to load custom items:", e);
      }
      return [];
    }

    static saveCustomItem(item, type) {
      try {
        const key = type === 'game' ? 'fittv_custom_games' : 'fittv_custom_runs';
        const raw = localStorage.getItem(key);
        let list = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(list)) list = [];
        list = list.filter(i => i.id !== item.id);
        list.unshift(item);
        localStorage.setItem(key, JSON.stringify(list));
        return true;
      } catch (e) {
        console.warn("Failed to save custom item:", e);
        return false;
      }
    }

    static normalizeItem(data, filename) {
      // Validate YouTube ID
      const videoId = (data.video && typeof data.video.videoId === 'string' && /^[\w-]{11}$/.test(data.video.videoId))
        ? data.video.videoId
        : 'XTgSxQ6ZLM0';

      return {
        id: filename.replace('.json', ''),
        type: data.type || (data.virtualRun ? 'virtual_run' : 'game'),
        title: data.meta?.title || data.video?.title || "Séance FitTV",
        difficulty: data.meta?.difficulty || "normal",
        level: data.meta?.level || (data.meta?.difficulty === 'hard' ? 3 : (data.meta?.difficulty === 'easy' ? 1 : 2)),
        durationSeconds: data.video?.durationSeconds || 120,
        effectiveDurationSeconds: data.video?.effectiveDurationSeconds || data.video?.durationSeconds || 100,
        trimStart: data.video?.trimStart || 0,
        trimEnd: data.video?.trimEnd || data.video?.durationSeconds || 120,
        cuts: data.video?.cuts || [],
        audioMuted: !!data.video?.audioMuted,
        videoId: videoId,
        thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        raw: data
      };
    }
  }

  // ==========================================================================
  // SECTION 7: YOUTUBE IFRAME PLAYER & NON-DESTRUCTIVE EDIT ENGINE
  // ==========================================================================
  class TVPlayerController {
    constructor() {
      this.player = null;
      this.isReady = false;
      this.currentItem = null;
      this.pollInterval = null;
      this.lastPolledTime = 0;
      this.lastPollTimestamp = 0;
      this.lastSeekTime = 0;
      this.onEndedCallback = null;
    }

    loadVideo(item, onReady, onEnded) {
      this.currentItem = item;
      this.onEndedCallback = onEnded;

      const container = document.getElementById('yt-player-iframe-slot');
      container.innerHTML = '<div id="yt-player-inner"></div>';

      const createPlayer = () => {
        try {
          this.player = new window.YT.Player('yt-player-inner', {
            videoId: item.videoId,
            playerVars: {
              enablejsapi: 1,
              controls: 0,
              playsinline: 1,
              rel: 0,
              modestbranding: 1,
              disablekb: 1,
              fs: 0,
              origin: window.location.origin
            },
            events: {
              onReady: (event) => {
                this.isReady = true;
                if (item.audioMuted) event.target.mute();
                else event.target.unMute();
                event.target.seekTo(item.trimStart, true);
                if (onReady) onReady();
              },
              onStateChange: (event) => {
                // 0 = ENDED
                if (event.data === 0) {
                  this.stopWatcher();
                  if (this.onEndedCallback) this.onEndedCallback();
                }
              },
              onError: (event) => {
                this.handlePlayerError(event.data);
              }
            }
          });
        } catch (e) {
          console.error("Failed to initialize YT Player:", e);
          this.handlePlayerError(100);
        }
      };

      if (window.YT && window.YT.Player) {
        createPlayer();
      } else {
        window.onYouTubeIframeAPIReady = createPlayer;
      }
    }

    startPlayback() {
      if (!this.player || !this.isReady) return;
      this.player.seekTo(this.currentItem.trimStart, true);
      this.player.playVideo();
      this.startWatcher();
    }

    pausePlayback() {
      if (this.player && this.isReady) {
        try { this.player.pauseVideo(); } catch (e) {}
      }
      this.stopWatcher();
    }

    resumePlayback() {
      if (this.player && this.isReady) {
        try { this.player.playVideo(); } catch (e) {}
      }
      this.startWatcher();
    }

    getCurrentTime() {
      if (!this.player || !this.isReady) return this.currentItem ? this.currentItem.trimStart : 0;
      try {
        const rawTime = this.player.getCurrentTime();
        if (typeof rawTime === 'number') {
          this.lastPolledTime = rawTime;
          this.lastPollTimestamp = performance.now();
          return rawTime;
        }
      } catch (e) {}
      // Interpolate with performance.now() between polls
      const elapsed = (performance.now() - this.lastPollTimestamp) / 1000;
      return this.lastPolledTime + elapsed;
    }

    setPlaybackRate(targetRate) {
      if (!this.player || !this.isReady) return targetRate;
      try {
        const avail = this.player.getAvailablePlaybackRates() || CONFIG.video.supportedPlaybackRates;
        let closest = avail[0];
        let minDiff = Math.abs(targetRate - closest);
        for (const r of avail) {
          const diff = Math.abs(targetRate - r);
          if (diff < minDiff) {
            closest = r;
            minDiff = diff;
          }
        }
        this.player.setPlaybackRate(closest);
        return closest;
      } catch (e) {
        return 1.0;
      }
    }

    startWatcher() {
      this.stopWatcher();
      this.pollInterval = setInterval(() => {
        if (!this.isReady || !this.player || !this.currentItem) return;

        const curTime = this.getCurrentTime();
        const tStart = this.currentItem.trimStart || 0;
        const tEnd = this.currentItem.trimEnd || this.currentItem.durationSeconds;

        // 1. In/Out Boundaries
        if (curTime < tStart) {
          this.player.seekTo(tStart, true);
        } else if (curTime >= tEnd) {
          this.player.pauseVideo();
          this.stopWatcher();
          if (this.onEndedCallback) this.onEndedCallback();
          return;
        }

        // 2. Non-Destructive Cut Skipping
        const cuts = this.currentItem.cuts || [];
        const now = performance.now();
        for (const cut of cuts) {
          if (curTime >= cut.start && curTime < cut.end) {
            // Debounce to prevent seek loop jitter
            if (now - this.lastSeekTime > 350) {
              this.lastSeekTime = now;
              this.player.seekTo(cut.end + 0.05, true);
            }
            break;
          }
        }
      }, CONFIG.video.pollIntervalMs);
    }

    stopWatcher() {
      if (this.pollInterval) {
        clearInterval(this.pollInterval);
        this.pollInterval = null;
      }
    }

    destroy() {
      this.stopWatcher();
      if (this.player) {
        try { this.player.destroy(); } catch (e) {}
        this.player = null;
      }
      this.isReady = false;
      this.currentItem = null;
    }

    handlePlayerError(code) {
      const overlay = document.getElementById('player-error-overlay');
      const msg = document.getElementById('player-error-message');
      if (overlay && msg) {
        let text = "Cette vidéo YouTube ne permet pas l'intégration externe.";
        if (code === 100 || code === 2) text = "La vidéo demandée est introuvable ou a été supprimée.";
        else if (code === 101 || code === 150) text = "Le propriétaire de la vidéo a désactivé l'intégration dans YouTube Studio. Vérifiez que la vidéo est Publique/Non répertoriée et que l'intégration est cochée.";
        msg.textContent = text;
        overlay.style.display = 'flex';
        nav.trapInModal(overlay);
      }
    }
  }

  const tvPlayer = new TVPlayerController();

  // ==========================================================================
  // SECTION 8: GAME ENGINE (ACTION CUES, JUDGING, COMBO & CANVAS HUD)
  // ==========================================================================
  class GameEngine {
    constructor() {
      this.active = false;
      this.item = null;
      this.timeline = [];
      this.evaluatedEvents = new Set();
      this.state = {
        score: 0,
        combo: 0,
        multiplier: 1,
        maxCombo: 0,
        lives: 3,
        misses: 0,
        perfectHits: 0,
        goodHits: 0,
        characterState: 'RUNNING',
        charAnimTimer: 0,
        lastFeedback: null,
        feedbackTimer: 0
      };

      this.canvas = document.getElementById('gameplay-canvas-overlay');
      this.ctx = this.canvas ? this.canvas.getContext('2d') : null;
      this.animFrame = null;

      // Subscribe to semantic game actions
      const actions = ['JUMP', 'RIGHT', 'LEFT', 'SLIDE_DOWN', 'SLASH', 'PUNCH', 'GO'];
      actions.forEach(act => {
        bus.on(act, () => this.handleActionInput(act));
      });
    }

    start(item) {
      this.active = true;
      this.item = item;
      this.evaluatedEvents.clear();

      // Normalize timeline events with tolerant defaults
      const rawTimeline = item.raw?.game?.timeline || [];
      this.timeline = rawTimeline.map(ev => ({
        id: ev.id || ('evt_' + Math.random()),
        time: ev.time || 0,
        action: ev.action,
        showOnScreen: ev.showOnScreen !== false, // Explicit showOnScreen flag!
        points: ev.points || 100,
        hint: ev.hint || ev.action,
        window: {
          before: ev.window?.before || 0.3,
          after: ev.window?.after || 0.3
        },
        required: ev.required !== false
      })).sort((a, b) => a.time - b.time);

      // Reset state
      const rules = item.raw?.game?.rules || {};
      this.state.score = 0;
      this.state.combo = 0;
      this.state.multiplier = 1;
      this.state.maxCombo = 0;
      this.state.lives = rules.maxLives || CONFIG.game.defaultLives;
      this.state.misses = 0;
      this.state.perfectHits = 0;
      this.state.goodHits = 0;
      this.state.characterState = 'RUNNING';

      this.resizeCanvas();
      this.loop();
    }

    stop() {
      this.active = false;
      if (this.animFrame) cancelAnimationFrame(this.animFrame);
      if (this.ctx && this.canvas) {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      }
    }

    resizeCanvas() {
      if (!this.canvas) return;
      this.canvas.width = window.innerWidth;
      this.canvas.height = window.innerHeight;
    }

    loop() {
      if (!this.active) return;
      this.render();
      this.animFrame = requestAnimationFrame(() => this.loop());
    }

    handleActionInput(actionName) {
      if (!this.active) return;

      this.state.characterState = actionName;
      this.state.charAnimTimer = performance.now();

      const curTime = tvPlayer.getCurrentTime() + (profile.profile.calibrationOffsetMs / 1000);
      const perfWin = CONFIG.game.timingWindow.perfectMs / 1000;
      const goodWin = CONFIG.game.timingWindow.goodMs / 1000;

      // Find nearest non-evaluated required event
      let closest = null;
      let minDiff = Infinity;

      for (const evt of this.timeline) {
        if (!evt.required || this.evaluatedEvents.has(evt.id)) continue;
        const diff = Math.abs(evt.time - curTime);
        if (diff < minDiff) {
          minDiff = diff;
          closest = evt;
        }
      }

      if (closest && minDiff <= (closest.window.after || goodWin)) {
        // Map action names matching
        const reqAction = closest.action.toUpperCase().replace(/\s+/g, '_');
        const usrAction = actionName.toUpperCase().replace(/\s+/g, '_');

        if (reqAction === usrAction || (reqAction === 'GO' && usrAction === 'GO')) {
          this.evaluatedEvents.add(closest.id);

          if (minDiff <= (closest.window.before || perfWin)) {
            // PERFECT HIT
            this.state.score += closest.points * this.state.multiplier;
            this.state.combo++;
            this.state.perfectHits++;
            this.state.maxCombo = Math.max(this.state.maxCombo, this.state.combo);
            this.state.multiplier = Math.min(CONFIG.game.scoring.maxMultiplier, 1 + Math.floor(this.state.combo / CONFIG.game.scoring.comboStep));
            this.showFeedback("PERFECT !", "#10b981");
            sound.play('success');
          } else {
            // GOOD HIT
            this.state.score += Math.floor(closest.points / 2) * this.state.multiplier;
            this.state.combo++;
            this.state.goodHits++;
            this.state.maxCombo = Math.max(this.state.maxCombo, this.state.combo);
            this.showFeedback("BIEN !", "#38bdf8");
            sound.play('success');
          }
        } else {
          // Wrong action triggered
          this.triggerMiss();
        }
      }
    }

    triggerMiss() {
      this.state.combo = 0;
      this.state.multiplier = 1;
      this.state.misses++;
      this.state.lives = Math.max(0, this.state.lives - 1);
      this.showFeedback("MANQUÉ !", "#ef4444");
      sound.play('fail');

      if (this.state.lives <= 0) {
        this.finish(false);
      }
    }

    showFeedback(text, color) {
      this.state.lastFeedback = { text, color };
      this.state.feedbackTimer = performance.now() + 650;
    }

    finish(victory = true) {
      this.stop();
      tvPlayer.pausePlayback();

      const isPB = profile.recordGameScore(this.item.id, this.state.score);
      if (victory) sound.play('win');
      else sound.play('fail');

      app.showGameSummary({
        victory,
        score: this.state.score,
        isPB,
        perfectHits: this.state.perfectHits,
        goodHits: this.state.goodHits,
        misses: this.state.misses,
        maxCombo: this.state.maxCombo,
        item: this.item
      });
    }

    render() {
      if (!this.ctx) return;
      const w = this.canvas.width;
      const h = this.canvas.height;
      this.ctx.clearRect(0, 0, w, h);

      const curTime = tvPlayer.getCurrentTime();
      const strikeX = w * 0.35;
      const strikeY = h * 0.72;
      const approachSpeed = 360; // Pixels per second

      // 1. Draw Strike Line & Runway
      this.ctx.strokeStyle = "rgba(255, 255, 255, 0.2)";
      this.ctx.lineWidth = 3;
      this.ctx.beginPath();
      this.ctx.moveTo(strikeX - 80, strikeY + 40);
      this.ctx.lineTo(w, strikeY + 40);
      this.ctx.stroke();

      // Strike Target Ring
      this.ctx.strokeStyle = "rgba(56, 189, 248, 0.9)";
      this.ctx.lineWidth = 4;
      this.ctx.beginPath();
      this.ctx.arc(strikeX, strikeY, 32, 0, Math.PI * 2);
      this.ctx.stroke();

      // 2. Upcoming Action Cues (Only rendered if showOnScreen !== false)
      for (const evt of this.timeline) {
        const diff = evt.time - curTime;

        // Render approaching cues within 2.5s window
        if (diff > -0.35 && diff < 2.5) {
          if (evt.showOnScreen !== false) {
            const cueX = strikeX + (diff * approachSpeed);
            const color = this.getActionColor(evt.action);

            // Shrinking timing ring
            const ringRadius = Math.max(32, 32 + (diff * 35));
            this.ctx.strokeStyle = color;
            this.ctx.lineWidth = 3;
            this.ctx.beginPath();
            this.ctx.arc(cueX, strikeY, ringRadius, 0, Math.PI * 2);
            this.ctx.stroke();

            // Core Action Circle
            this.ctx.fillStyle = color;
            this.ctx.beginPath();
            this.ctx.arc(cueX, strikeY, 26, 0, Math.PI * 2);
            this.ctx.fill();

            // Action Glyphs & Labels
            this.ctx.fillStyle = "#fff";
            this.ctx.font = "bold 13px -apple-system, sans-serif";
            this.ctx.textAlign = "center";
            this.ctx.fillText(this.getActionShortLabel(evt.action), cueX, strikeY + 5);

            // Hint caption below
            this.ctx.font = "bold 14px -apple-system, sans-serif";
            this.ctx.fillStyle = "#f8fafc";
            this.ctx.shadowColor = "rgba(0,0,0,0.8)";
            this.ctx.shadowBlur = 6;
            this.ctx.fillText(evt.hint || evt.action, cueX, strikeY + 52);
            this.ctx.shadowBlur = 0;
            this.ctx.textAlign = "start";
          }
        }

        // Miss evaluation if required event passed window without hit
        if (diff < -0.35 && evt.required && !this.evaluatedEvents.has(evt.id)) {
          this.evaluatedEvents.add(evt.id);
          this.triggerMiss();
        }
      }

      // 3. Draw Player Animated Character Reacting to Action
      this.drawPlayerCharacter(this.ctx, strikeX, strikeY);

      // 4. Pop Feedback ("PERFECT!", "BIEN!", "MANQUÉ!")
      if (this.state.lastFeedback && performance.now() < this.state.feedbackTimer) {
        this.ctx.save();
        this.ctx.font = "bold 46px -apple-system, sans-serif";
        this.ctx.fillStyle = this.state.lastFeedback.color;
        this.ctx.textAlign = "center";
        this.ctx.shadowColor = "rgba(0, 0, 0, 0.9)";
        this.ctx.shadowBlur = 10;
        this.ctx.fillText(this.state.lastFeedback.text, strikeX, strikeY - 90);
        this.ctx.restore();
      }

      // 5. Update DOM Top HUD Counters
      this.updateHUD();
    }

    getActionColor(action) {
      const a = (action || '').toUpperCase();
      if (a.includes('JUMP')) return '#06b6d4';
      if (a.includes('RIGHT')) return '#f97316';
      if (a.includes('LEFT')) return '#eab308';
      if (a.includes('SLIDE')) return '#10b981';
      if (a.includes('SLASH')) return '#ec4899';
      if (a.includes('PUNCH')) return '#ef4444';
      if (a.includes('GO')) return '#22c55e';
      if (a.includes('COUNT')) return '#f59e0b';
      return '#a855f7';
    }

    getActionShortLabel(action) {
      const a = (action || '').toUpperCase();
      if (a.includes('COUNT')) return '3-2-1';
      if (a.includes('SLIDE')) return 'SLIDE';
      if (a.includes('SLASH')) return 'SLASH';
      if (a.includes('PUNCH')) return 'PUNCH';
      return a;
    }

    drawPlayerCharacter(ctx, x, y) {
      ctx.save();
      ctx.translate(x, y);

      const elapsed = (performance.now() - this.state.charAnimTimer) / 1000;
      const isAction = elapsed < 0.45;
      const state = isAction ? this.state.characterState : 'RUNNING';

      const legSwing = Math.sin(performance.now() * 0.015) * 18;

      switch (state) {
        case 'JUMP':
          ctx.translate(0, -60);
          ctx.fillStyle = "#06b6d4";
          break;
        case 'SLIDE_DOWN':
          ctx.translate(0, 30);
          ctx.fillStyle = "#10b981";
          break;
        case 'LEFT':
          ctx.translate(-50, 0);
          ctx.fillStyle = "#eab308";
          break;
        case 'RIGHT':
          ctx.translate(50, 0);
          ctx.fillStyle = "#f97316";
          break;
        case 'SLASH':
          ctx.fillStyle = "#ec4899";
          // Sword arc
          ctx.strokeStyle = "#f472b6";
          ctx.lineWidth = 6;
          ctx.beginPath();
          ctx.arc(15, -25, 45, -0.6, 1.8);
          ctx.stroke();
          break;
        case 'PUNCH':
          ctx.fillStyle = "#ef4444";
          // Fist thrust
          ctx.fillRect(15, -24, 30, 14);
          break;
        default:
          ctx.fillStyle = "#38bdf8";
          break;
      }

      // Head
      ctx.beginPath();
      ctx.arc(0, -50, 16, 0, Math.PI * 2);
      ctx.fill();

      // Torso
      ctx.fillRect(-12, -34, 24, 36);

      // Limbs
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 5;
      ctx.lineCap = "round";

      if (state === 'SLIDE_DOWN') {
        ctx.beginPath();
        ctx.moveTo(-10, 0); ctx.lineTo(30, 12);
        ctx.stroke();
      } else {
        // Legs
        ctx.beginPath();
        ctx.moveTo(-6, 2); ctx.lineTo(-6 - legSwing, 28);
        ctx.moveTo(6, 2); ctx.lineTo(6 + legSwing, 28);
        ctx.stroke();
      }

      ctx.restore();
    }

    updateHUD() {
      const scoreEl = document.getElementById('hud-score-display');
      const heartsEl = document.getElementById('hud-lives-hearts');
      const comboBadge = document.getElementById('hud-combo-container');
      const multVal = document.getElementById('hud-multiplier-val');
      const comboCount = document.getElementById('hud-combo-count');

      if (scoreEl) scoreEl.textContent = this.state.score;
      if (heartsEl) {
        let hearts = '';
        for (let i = 0; i < this.state.lives; i++) hearts += '❤️';
        heartsEl.textContent = hearts || '💀';
      }

      if (comboBadge && multVal && comboCount) {
        if (this.state.combo > 1) {
          comboBadge.style.display = 'inline-block';
          multVal.textContent = this.state.multiplier;
          comboCount.textContent = this.state.combo;
        } else {
          comboBadge.style.display = 'none';
        }
      }
    }
  }

  const gameEngine = new GameEngine();

  // ==========================================================================
  // SECTION 9: RUN ENGINE (STEP INTERVALS, CADENCE, SPEED & TREADMILL SYNC)
  // ==========================================================================
  class RunEngine {
    constructor() {
      this.active = false;
      this.item = null;
      this.stepIntervals = [];
      this.lastStepTime = 0;
      this.speedKmh = 0;
      this.appliedRate = 1.0;
      this.totalSteps = 0;
      this.leftSteps = 0;
      this.rightSteps = 0;
      this.distanceKm = 0;
      this.movingTimeSec = 0;
      this.maxSpeedKmh = 0;
      this.speedSum = 0;
      this.speedSamples = 0;
      this.isPausedByStop = false;
      this.updateInterval = null;

      // Listen to semantic step events
      bus.on('STEP_LEFT', () => this.recordStep('left'));
      bus.on('STEP_RIGHT', () => this.recordStep('right'));
    }

    start(item) {
      this.active = true;
      this.item = item;
      this.stepIntervals = [];
      this.lastStepTime = 0;
      this.speedKmh = 0;
      this.appliedRate = 1.0;
      this.totalSteps = 0;
      this.leftSteps = 0;
      this.rightSteps = 0;
      this.distanceKm = 0;
      this.movingTimeSec = 0;
      this.maxSpeedKmh = 0;
      this.speedSum = 0;
      this.speedSamples = 0;
      this.isPausedByStop = false;

      // Start tick loop at 100ms
      this.updateInterval = setInterval(() => this.tick(), 100);
    }

    stop() {
      this.active = false;
      if (this.updateInterval) {
        clearInterval(this.updateInterval);
        this.updateInterval = null;
      }
    }

    recordStep(foot) {
      if (!this.active) return;
      const now = performance.now();

      // Debounce check
      if (this.lastStepTime > 0) {
        const intervalMs = now - this.lastStepTime;
        if (intervalMs < CONFIG.input.stepDebounceMs) {
          return; // Ignore contact bounce
        }

        // Store step interval
        this.stepIntervals.push(intervalMs);
        if (this.stepIntervals.length > CONFIG.run.cadenceWindowSize) {
          this.stepIntervals.shift();
        }
      }

      this.lastStepTime = now;
      this.totalSteps++;
      if (foot === 'left') this.leftSteps++;
      else this.rightSteps++;

      // Flash foot visual indicator
      this.flashFoot(foot);
      sound.play('stepTick');

      // Add distance
      this.distanceKm += (profile.profile.strideLengthM / 1000);

      // If video was paused because runner had stopped, resume now!
      if (this.isPausedByStop) {
        this.isPausedByStop = false;
        tvPlayer.resumePlayback();
      }
    }

    flashFoot(foot) {
      const el = document.getElementById(foot === 'left' ? 'foot-left-indicator' : 'foot-right-indicator');
      if (el) {
        el.classList.add('flash');
        setTimeout(() => el.classList.remove('flash'), 120);
      }
    }

    tick() {
      if (!this.active) return;
      const now = performance.now();

      // 1. Cadence calculation from median step interval
      let cadencePpm = 0;
      let rawSpeedKmh = 0;

      if (this.stepIntervals.length >= 2) {
        const sorted = [...this.stepIntervals].sort((a, b) => a - b);
        const medianIntervalMs = sorted[Math.floor(sorted.length / 2)];
        if (medianIntervalMs > 0) {
          cadencePpm = Math.round(60000 / medianIntervalMs);
          // Speed = strideLength / (interval in hours)
          const intervalHours = (medianIntervalMs / 1000) / 3600;
          rawSpeedKmh = (profile.profile.strideLengthM / 1000) / intervalHours;
        }
      }

      // 2. Check for runner stop (inactivity > 2.5s)
      if (this.lastStepTime > 0 && (now - this.lastStepTime) > CONFIG.input.stepTimeoutMs) {
        rawSpeedKmh = 0;
        cadencePpm = 0;
        this.stepIntervals = [];

        if (!this.isPausedByStop) {
          this.isPausedByStop = true;
          tvPlayer.pausePlayback();
        }
      }

      // 3. Smooth speed with Exponential Moving Average
      this.speedKmh = this.speedKmh + (rawSpeedKmh - this.speedKmh) * CONFIG.run.speedSmoothingFactor;
      if (this.speedKmh < 0.3) this.speedKmh = 0;

      if (this.speedKmh > 0) {
        this.movingTimeSec += 0.1;
        this.maxSpeedKmh = Math.max(this.maxSpeedKmh, this.speedKmh);
        this.speedSum += this.speedKmh;
        this.speedSamples++;
      }

      // 4. Synchronize YouTube Playback Rate
      const refSpeed = this.item?.raw?.virtualRun?.speedMapping?.referenceSpeedKmh || CONFIG.run.referenceSpeedKmh;
      let targetRate = this.speedKmh > 0 ? (this.speedKmh / refSpeed) : 0.25;
      targetRate = Math.max(CONFIG.run.minPlaybackRate, Math.min(CONFIG.run.maxPlaybackRate, targetRate));

      // Apply with hysteresis to avoid rate flicker
      if (Math.abs(targetRate - this.appliedRate) > 0.1) {
        this.appliedRate = tvPlayer.setPlaybackRate(targetRate);
      }

      // 5. Update Cockpit HUD
      this.updateHUD(cadencePpm);
    }

    updateHUD(cadence) {
      const stepsEl = document.getElementById('run-val-steps');
      const speedEl = document.getElementById('run-val-speed');
      const cadenceEl = document.getElementById('run-val-cadence');
      const distEl = document.getElementById('run-val-distance');
      const timeEl = document.getElementById('run-val-time');
      const calEl = document.getElementById('run-val-calories');
      const progressFill = document.getElementById('hud-progress-fill');

      if (stepsEl) stepsEl.textContent = this.totalSteps;
      if (speedEl) speedEl.textContent = this.speedKmh.toFixed(1);
      if (cadenceEl) cadenceEl.textContent = cadence;
      if (distEl) distEl.textContent = this.distanceKm.toFixed(2);

      if (timeEl) {
        const m = Math.floor(this.movingTimeSec / 60);
        const s = Math.floor(this.movingTimeSec % 60);
        timeEl.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
      }

      // Calories estimate: MET 8.0 * weight * (time / 3600)
      if (calEl) {
        const cal = Math.floor(8.0 * profile.profile.weightKg * (this.movingTimeSec / 3600));
        calEl.textContent = cal;
      }

      // Video Progress Bar
      if (progressFill && this.item) {
        const curTime = tvPlayer.getCurrentTime();
        const start = this.item.trimStart || 0;
        const end = this.item.trimEnd || this.item.durationSeconds;
        const pct = Math.max(0, Math.min(100, ((curTime - start) / (end - start)) * 100));
        progressFill.style.width = pct + '%';
      }
    }

    finish() {
      this.stop();
      tvPlayer.pausePlayback();

      const avgSpeed = this.speedSamples > 0 ? (this.speedSum / this.speedSamples) : 0;
      const isPB = profile.recordRun(this.item.id, this.movingTimeSec, avgSpeed);
      sound.play('win');

      app.showRunSummary({
        item: this.item,
        totalSteps: this.totalSteps,
        leftSteps: this.leftSteps,
        rightSteps: this.rightSteps,
        distanceKm: this.distanceKm,
        movingTimeSec: this.movingTimeSec,
        avgSpeedKmh: avgSpeed,
        maxSpeedKmh: this.maxSpeedKmh,
        calories: Math.floor(8.0 * profile.profile.weightKg * (this.movingTimeSec / 3600)),
        isPB
      });
    }
  }

  const runEngine = new RunEngine();

  // ==========================================================================
  // SECTION 10: APPLICATION CONTROLLER & TV NAVIGATION ROUTING
  // ==========================================================================
  class AppController {
    constructor() {
      this.currentScreen = 'screen-home';
      this.screenHistory = [];
      this.gamesCatalog = [];
      this.runsCatalog = [];
      this.activeActivityItem = null;
      this.keyboardBuffer = "";
      this.isSimulationMode = true;

      // Subscribe to Back and Menu semantic events
      bus.on('BACK', () => this.handleBack());
      bus.on('MENU', () => this.openControlsDialog());
      bus.on('PAUSE', () => this.handlePause());
    }

    async init() {
      setupKeyboardInput();
      setupGamepadInput();
      this.bindUIEvents();

      // Load Content Catalogs
      await this.loadCatalogs();

      // Show Initial Screen Focus
      this.navigateTo('screen-home');
    }

    async loadCatalogs() {
      // 1. Games Catalog
      const baseGames = await ContentLoader.loadCatalog('./games/index.json');
      const customGames = ContentLoader.getCustomItems('game');
      this.gamesCatalog = [...customGames, ...baseGames];
      this.renderGamesGrid();

      // 2. Virtual Runs Catalog
      const baseRuns = await ContentLoader.loadCatalog('./virtual-run/index.json');
      const customRuns = ContentLoader.getCustomItems('virtual_run');
      this.runsCatalog = [...customRuns, ...baseRuns];
      this.renderRunsGrid();
    }

    renderGamesGrid() {
      const container = document.getElementById('games-items-container');
      if (!container) return;
      container.innerHTML = '';

      this.gamesCatalog.forEach(item => {
        const card = document.createElement('div');
        card.className = "catalog-card";
        card.setAttribute('data-focusable', '');
        const best = profile.profile.bestScores?.[item.id] || 0;
        const badgeHtml = item.isCustom
          ? `<span class="catalog-badge" style="background:rgba(56,189,248,0.25); color:var(--focus-ring);">PERSONNALISÉ</span>`
          : `<span class="catalog-badge" style="background:rgba(236,72,153,0.2); color:#f472b6;">NIVEAU ${item.level}</span>`;

        card.innerHTML = `
          <div class="catalog-thumb-wrapper">
            <img class="catalog-thumb" src="${item.thumbnailUrl}" alt="Aperçu vidéo" />
            <span class="catalog-duration-pill">${Math.floor(item.effectiveDurationSeconds)}s</span>
          </div>
          <div class="catalog-info">
            <div class="catalog-title">${this.escape(item.title)}</div>
            <div class="catalog-stats-row">
              ${badgeHtml}
              <span style="font-size:0.95rem; font-weight:700; color:var(--focus-ring);">Record: ${best} pts</span>
            </div>
          </div>
        `;

        card.addEventListener('click', () => {
          this.startActivity(item, 'game');
        });

        container.appendChild(card);
      });

      // Append Custom Import Card
      const importCard = document.createElement('div');
      importCard.className = "catalog-card catalog-card-custom";
      importCard.setAttribute('data-focusable', '');
      importCard.innerHTML = `
        <div style="font-size:2.5rem; margin-bottom:0.5rem; color:var(--focus-ring);">+</div>
        <div style="font-size:1.2rem; font-weight:800; margin-bottom:0.4rem;">+ Charger un Script Jeu</div>
        <div style="font-size:0.85rem; color:var(--text-muted);">Importer un fichier JSON ou lien YouTube</div>
      `;
      importCard.addEventListener('click', () => {
        this.openCustomScriptDialog('game');
      });
      container.appendChild(importCard);
    }

    renderRunsGrid() {
      const container = document.getElementById('runs-items-container');
      if (!container) return;
      container.innerHTML = '';

      this.runsCatalog.forEach(item => {
        const card = document.createElement('div');
        card.className = "catalog-card";
        card.setAttribute('data-focusable', '');
        const route = item.raw?.virtualRun?.route || {};
        const dist = route.totalDistanceKm ? `${route.totalDistanceKm} km` : "Course libre";
        const badgeHtml = item.isCustom
          ? `<span class="catalog-badge" style="background:rgba(56,189,248,0.25); color:var(--focus-ring);">PERSONNALISÉ</span>`
          : `<span class="catalog-badge" style="background:rgba(16,185,129,0.2); color:#34d399;">${this.escape(dist)}</span>`;

        card.innerHTML = `
          <div class="catalog-thumb-wrapper">
            <img class="catalog-thumb" src="${item.thumbnailUrl}" alt="Aperçu parcours" />
            <span class="catalog-duration-pill">${Math.floor(item.effectiveDurationSeconds)}s</span>
          </div>
          <div class="catalog-info">
            <div class="catalog-title">${this.escape(item.title)}</div>
            <div class="catalog-stats-row">
              ${badgeHtml}
              <span style="font-size:0.95rem; color:var(--text-muted);">${this.escape(route.terrain || 'Trail')}</span>
            </div>
          </div>
        `;

        card.addEventListener('click', () => {
          this.startActivity(item, 'virtual_run');
        });

        container.appendChild(card);
      });

      // Append Custom Import Card
      const importCard = document.createElement('div');
      importCard.className = "catalog-card catalog-card-custom";
      importCard.setAttribute('data-focusable', '');
      importCard.innerHTML = `
        <div style="font-size:2.5rem; margin-bottom:0.5rem; color:var(--focus-ring);">+</div>
        <div style="font-size:1.2rem; font-weight:800; margin-bottom:0.4rem;">+ Charger un Script Run</div>
        <div style="font-size:0.85rem; color:var(--text-muted);">Importer un fichier JSON ou lien YouTube</div>
      `;
      importCard.addEventListener('click', () => {
        this.openCustomScriptDialog('virtual_run');
      });
      container.appendChild(importCard);
    }

    escape(str) {
      const div = document.createElement('div');
      div.textContent = str || '';
      return div.innerHTML;
    }

    navigateTo(screenId) {
      if (this.currentScreen === screenId) return;

      document.querySelectorAll('.tv-screen').forEach(s => s.classList.remove('active'));
      const target = document.getElementById(screenId);
      if (target) {
        target.classList.add('active');
        if (this.currentScreen !== 'screen-home' && screenId !== 'screen-home') {
          this.screenHistory.push(this.currentScreen);
        } else if (screenId === 'screen-home') {
          this.screenHistory = [];
        }
        this.currentScreen = screenId;
        nav.restoreScreenFocus(screenId);
        bus.emit('SCREEN_CHANGED', { screen: screenId });
      }
    }

    handleBack() {
      // 1. If any modal dialog is open, close it
      const activeDialog = document.querySelector('.tv-dialog-backdrop.active');
      if (activeDialog) {
        activeDialog.classList.remove('active');
        nav.releaseModal();
        return;
      }

      // 2. If inside video player, open Pause dialog
      const stage = document.getElementById('video-stage');
      if (stage && stage.classList.contains('active')) {
        this.handlePause();
        return;
      }

      // 3. Screen navigation history
      if (this.currentScreen !== 'screen-home') {
        this.navigateTo('screen-home');
      } else {
        // On home screen, confirm exit
        this.openExitDialog();
      }
    }

    handlePause() {
      const stage = document.getElementById('video-stage');
      if (!stage || !stage.classList.contains('active')) return;

      tvPlayer.pausePlayback();
      const dlg = document.getElementById('dialog-pause');
      if (dlg) {
        dlg.classList.add('active');
        nav.trapInModal(dlg);
      }
    }

    openExitDialog() {
      const dlg = document.getElementById('dialog-exit');
      if (dlg) {
        dlg.classList.add('active');
        nav.trapInModal(dlg);
      }
    }

    openControlsDialog() {
      const dlg = document.getElementById('dialog-controls');
      if (dlg) {
        dlg.classList.add('active');
        nav.trapInModal(dlg);
      }
    }

    showToast(message) {
      const root = document.getElementById('tv-toast-container');
      if (!root) return;
      const t = document.createElement('div');
      t.className = "tv-toast";
      t.textContent = message;
      root.appendChild(t);
      setTimeout(() => t.remove(), 2600);
    }

    startActivity(item, type) {
      this.activeActivityItem = item;
      const stage = document.getElementById('video-stage');
      stage.classList.add('active');

      document.getElementById('hud-activity-type').textContent = type === 'game' ? "JEU D'ACTION" : "VIRTUAL RUN";
      document.getElementById('hud-activity-name').textContent = item.title;

      const gameHud = document.getElementById('game-hud-top-stats');
      const runHud = document.getElementById('run-cockpit-hud');
      const prompt = document.getElementById('prestart-prompt-overlay');

      if (type === 'game') {
        gameHud.style.display = 'flex';
        runHud.style.display = 'none';
      } else {
        gameHud.style.display = 'none';
        runHud.style.display = 'flex';
      }

      prompt.style.display = 'flex';

      // Load YouTube Player
      tvPlayer.loadVideo(item, () => {
        // Player is ready
        nav.trapInModal(prompt);
      }, () => {
        // Playback finished
        if (type === 'game') gameEngine.finish(true);
        else runEngine.finish();
      });

      // Bind Start Button
      const btnStart = document.getElementById('btn-prestart-confirm');
      btnStart.onclick = () => {
        sound.play('go');
        prompt.style.display = 'none';
        nav.releaseModal();
        tvPlayer.startPlayback();

        if (type === 'game') {
          gameEngine.start(item);
          bus.emit('GAME_STARTED', { id: item.id });
        } else {
          runEngine.start(item);
          bus.emit('RUN_STARTED', { id: item.id });
        }
      };
    }

    showGameSummary(res) {
      document.getElementById('video-stage').classList.remove('active');
      this.navigateTo('screen-summary');

      document.getElementById('summary-title').textContent = res.victory ? "VICTOIRE !" : "GAME OVER";
      document.getElementById('summary-subtitle').textContent = res.victory
        ? "Parcours franchi avec brio !"
        : "N'abandonnez pas, réessayez pour battre votre record !";
      document.getElementById('summary-trophy').textContent = res.victory ? "🏆" : "💥";

      const grid = document.getElementById('summary-stats-grid');
      grid.innerHTML = `
        <div class="summary-stat-card">
          <span class="summary-stat-val">${res.score}</span>
          <span class="summary-stat-lbl">SCORE FINAL ${res.isPB ? '(NOUVEAU RECORD !)' : ''}</span>
        </div>
        <div class="summary-stat-card">
          <span class="summary-stat-val" style="color:#10b981;">${res.perfectHits}</span>
          <span class="summary-stat-lbl">PERFECT HITS</span>
        </div>
        <div class="summary-stat-card">
          <span class="summary-stat-val" style="color:#38bdf8;">${res.goodHits}</span>
          <span class="summary-stat-lbl">GOOD HITS</span>
        </div>
        <div class="summary-stat-card">
          <span class="summary-stat-val" style="color:#f59e0b;">x${res.maxCombo}</span>
          <span class="summary-stat-lbl">MAX COMBO</span>
        </div>
      `;

      bus.emit('GAME_FINISHED', res);
    }

    showRunSummary(res) {
      document.getElementById('video-stage').classList.remove('active');
      this.navigateTo('screen-summary');

      document.getElementById('summary-title').textContent = "COURSE TERMINÉE !";
      document.getElementById('summary-subtitle').textContent = `Merci et grand bravo pour votre session sur "${res.item.title}" !`;
      document.getElementById('summary-trophy').textContent = "🏅";

      const m = Math.floor(res.movingTimeSec / 60);
      const s = Math.floor(res.movingTimeSec % 60);

      const grid = document.getElementById('summary-stats-grid');
      grid.innerHTML = `
        <div class="summary-stat-card">
          <span class="summary-stat-val">${res.totalSteps}</span>
          <span class="summary-stat-lbl">PAS TOTAUX (L: ${res.leftSteps} / R: ${res.rightSteps})</span>
        </div>
        <div class="summary-stat-card">
          <span class="summary-stat-val">${res.distanceKm.toFixed(2)} km</span>
          <span class="summary-stat-lbl">DISTANCE PARCOURUE</span>
        </div>
        <div class="summary-stat-card">
          <span class="summary-stat-val">${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}</span>
          <span class="summary-stat-lbl">TEMPS TOTAL DE COURSE</span>
        </div>
        <div class="summary-stat-card">
          <span class="summary-stat-val">${res.avgSpeedKmh.toFixed(1)} km/h</span>
          <span class="summary-stat-lbl">VITESSE MOYENNE (MAX: ${res.maxSpeedKmh.toFixed(1)})</span>
        </div>
        <div class="summary-stat-card">
          <span class="summary-stat-val" style="color:#f59e0b;">${res.calories}</span>
          <span class="summary-stat-lbl">CALORIES BRÛLÉES (KCAL)</span>
        </div>
        <div class="summary-stat-card">
          <span class="summary-stat-val" style="color:#a3e635;">${profile.profile.strideLengthM}m</span>
          <span class="summary-stat-lbl">LONGUEUR FOULÉE</span>
        </div>
      `;

      bus.emit('RUN_FINISHED', res);
    }

    bindUIEvents() {
      // Home Cards
      document.getElementById('card-entry-games')?.addEventListener('click', () => this.navigateTo('screen-games-list'));
      document.getElementById('card-entry-runs')?.addEventListener('click', () => this.navigateTo('screen-runs-list'));
      document.getElementById('card-entry-cardio')?.addEventListener('click', () => this.showToast("Bientôt disponible 🔒"));

      // Bottom bar buttons
      document.getElementById('btn-nav-profile')?.addEventListener('click', () => this.navigateTo('screen-profile'));
      document.getElementById('btn-nav-settings')?.addEventListener('click', () => this.navigateTo('screen-settings'));
      document.getElementById('btn-nav-controls')?.addEventListener('click', () => this.openControlsDialog());
      document.getElementById('btn-header-profile')?.addEventListener('click', () => this.navigateTo('screen-profile'));

      // Sound toggle
      document.getElementById('btn-toggle-sound')?.addEventListener('click', () => {
        sound.muted = !sound.muted;
        document.getElementById('label-sound-state').textContent = sound.muted ? "Son: OFF" : "Son: ON";
        document.getElementById('icon-sound-state').setAttribute('stroke', sound.muted ? '#ef4444' : 'currentColor');
        this.showToast(sound.muted ? "Son coupé" : "Son activé");
      });

      // Back buttons on lists
      document.querySelectorAll('.btn-back-to-home').forEach(btn => {
        btn.addEventListener('click', () => this.navigateTo('screen-home'));
      });

      // Profile Stride & Weight
      document.getElementById('btn-stride-minus')?.addEventListener('click', () => profile.setStrideLength(-0.05));
      document.getElementById('btn-stride-plus')?.addEventListener('click', () => profile.setStrideLength(0.05));
      document.getElementById('btn-weight-minus')?.addEventListener('click', () => profile.setWeight(-5));
      document.getElementById('btn-weight-plus')?.addEventListener('click', () => profile.setWeight(5));

      // Theme Buttons
      document.getElementById('btn-theme-kids')?.addEventListener('click', () => { profile.applyTheme('kids'); this.showToast("Thème ENFANTS activé !"); });
      document.getElementById('btn-theme-adult')?.addEventListener('click', () => { profile.applyTheme('adult'); this.showToast("Thème ADULTE activé !"); });
      document.getElementById('btn-theme-pro')?.addEventListener('click', () => { profile.applyTheme('pro'); this.showToast("Thème PRO activé !"); });

      // Settings Calibration
      document.getElementById('btn-calib-minus')?.addEventListener('click', () => {
        profile.profile.calibrationOffsetMs = Math.max(-400, profile.profile.calibrationOffsetMs - 50);
        document.getElementById('label-calib-ms').textContent = `${profile.profile.calibrationOffsetMs} ms`;
        profile.save();
      });
      document.getElementById('btn-calib-plus')?.addEventListener('click', () => {
        profile.profile.calibrationOffsetMs = Math.min(400, profile.profile.calibrationOffsetMs + 50);
        document.getElementById('label-calib-ms').textContent = `${profile.profile.calibrationOffsetMs} ms`;
        profile.save();
      });
      document.getElementById('btn-test-calib-sound')?.addEventListener('click', () => {
        sound.play('countdown');
        this.showToast("Bip de tempo envoyé");
      });

      // Simulation mode toggle
      document.getElementById('btn-toggle-sim-mode')?.addEventListener('click', (e) => {
        this.isSimulationMode = !this.isSimulationMode;
        e.currentTarget.querySelector('span').textContent = this.isSimulationMode ? "Simulation : ACTIVÉE" : "Simulation : DÉSACTIVÉE";
        const ind = document.getElementById('sim-mode-indicator');
        if (ind) ind.style.display = this.isSimulationMode ? 'flex' : 'none';
        this.showToast(this.isSimulationMode ? "Mode simulation activé (Alt+L/R)" : "Mode simulation désactivé");
      });

      // Reset scores
      document.getElementById('btn-reset-scores')?.addEventListener('click', () => {
        profile.profile.bestScores = {};
        profile.profile.bestRuns = {};
        profile.save();
        this.renderGamesGrid();
        this.renderRunsGrid();
        this.showToast("Scores réinitialisés");
      });

      // Summary buttons
      document.getElementById('btn-summary-replay')?.addEventListener('click', () => {
        if (this.activeActivityItem) {
          this.startActivity(this.activeActivityItem, this.activeActivityItem.type);
        }
      });
      document.getElementById('btn-summary-back')?.addEventListener('click', () => {
        this.navigateTo(this.activeActivityItem?.type === 'game' ? 'screen-games-list' : 'screen-runs-list');
      });

      // Pause Dialog Actions
      document.getElementById('btn-pause-resume')?.addEventListener('click', () => {
        document.getElementById('dialog-pause').classList.remove('active');
        nav.releaseModal();
        tvPlayer.resumePlayback();
      });
      document.getElementById('btn-pause-restart')?.addEventListener('click', () => {
        document.getElementById('dialog-pause').classList.remove('active');
        nav.releaseModal();
        if (this.activeActivityItem) {
          this.startActivity(this.activeActivityItem, this.activeActivityItem.type);
        }
      });
      document.getElementById('btn-pause-controls')?.addEventListener('click', () => {
        this.openControlsDialog();
      });
      document.getElementById('btn-pause-quit')?.addEventListener('click', () => {
        document.getElementById('dialog-pause').classList.remove('active');
        nav.releaseModal();
        gameEngine.stop();
        runEngine.stop();
        tvPlayer.destroy();
        document.getElementById('video-stage').classList.remove('active');
        this.navigateTo('screen-home');
      });

      // Exit Dialog Actions
      document.getElementById('btn-exit-cancel')?.addEventListener('click', () => {
        document.getElementById('dialog-exit').classList.remove('active');
        nav.releaseModal();
      });
      document.getElementById('btn-exit-confirm')?.addEventListener('click', () => {
        document.getElementById('dialog-exit').classList.remove('active');
        nav.releaseModal();
        if (window.Android && typeof window.Android.closeApp === 'function') {
          window.Android.closeApp();
        } else {
          this.showToast("Fermeture de l'application TV");
        }
      });

      // Controls Dialog Close
      document.getElementById('btn-close-controls')?.addEventListener('click', () => {
        document.getElementById('dialog-controls').classList.remove('active');
        nav.releaseModal();
      });

      // Error overlay back button
      document.getElementById('btn-player-error-back')?.addEventListener('click', () => {
        document.getElementById('player-error-overlay').style.display = 'none';
        nav.releaseModal();
        tvPlayer.destroy();
        document.getElementById('video-stage').classList.remove('active');
        this.navigateTo(this.activeActivityItem?.type === 'game' ? 'screen-games-list' : 'screen-runs-list');
      });

      // TV On-Screen Keyboard Setup
      this.setupOnScreenKeyboard();

      // Custom Script / YouTube Dialog Setup
      this.setupCustomScriptDialog();

      // Open custom script dialog buttons from headers
      document.getElementById('btn-open-custom-game')?.addEventListener('click', () => {
        this.openCustomScriptDialog('game');
      });
      document.getElementById('btn-open-custom-run')?.addEventListener('click', () => {
        this.openCustomScriptDialog('virtual_run');
      });
    }

    setupOnScreenKeyboard() {
      const grid = document.getElementById('tv-keyboard-grid');
      const preview = document.getElementById('tv-keyboard-input-preview');
      const dialog = document.getElementById('dialog-keyboard');
      if (!grid || !dialog) return;

      const layout = [
        ['A','B','C','D','E','F','G','H','I','J'],
        ['K','L','M','N','O','P','Q','R','S','T'],
        ['U','V','W','X','Y','Z','0','1','2','3'],
        ['4','5','6','7','8','9','-','_','ESPACE','EFFACER']
      ];

      grid.innerHTML = '';
      layout.forEach(row => {
        const rowEl = document.createElement('div');
        rowEl.className = "tv-keyboard-row";
        row.forEach(char => {
          const btn = document.createElement('button');
          btn.className = "tv-key-btn";
          btn.setAttribute('data-focusable', '');
          btn.textContent = char;

          if (char === 'ESPACE') btn.className += " wide-space";
          else if (char === 'EFFACER') btn.className += " wide-2";

          btn.addEventListener('click', () => {
            sound.play('click');
            if (char === 'ESPACE') {
              this.handleKeyboardChar(' ');
            } else if (char === 'EFFACER') {
              this.handleKeyboardBackspace();
            } else {
              this.handleKeyboardChar(char);
            }
          });

          rowEl.appendChild(btn);
        });
        grid.appendChild(rowEl);
      });

      document.getElementById('btn-open-tv-keyboard')?.addEventListener('click', () => {
        this.openTVKeyboard({
          title: "Saisie du Nom de Joueur",
          initialValue: profile.profile.name,
          maxLen: 20,
          onConfirm: (val) => {
            profile.setPlayerName(val);
            this.showToast(`Nom mis à jour : "${val}"`);
          }
        });
      });

      document.getElementById('btn-keyboard-cancel')?.addEventListener('click', () => {
        this.handleKeyboardCancel();
      });

      document.getElementById('btn-keyboard-confirm')?.addEventListener('click', () => {
        this.handleKeyboardConfirm();
      });
    }

    openTVKeyboard({ title, initialValue, onConfirm, maxLen = 32 }) {
      const dialog = document.getElementById('dialog-keyboard');
      const preview = document.getElementById('tv-keyboard-input-preview');
      const titleEl = dialog?.querySelector('.tv-dialog-title');
      if (titleEl) titleEl.textContent = title || "Saisie Clavier";

      this.keyboardBuffer = initialValue || "";
      this.keyboardMaxLen = maxLen;
      this.keyboardOnConfirm = onConfirm;

      if (preview) preview.textContent = this.keyboardBuffer || "...";

      dialog?.classList.add('active');
      nav.trapInModal(dialog);
    }

    handleKeyboardChar(char) {
      if (this.keyboardBuffer.length < (this.keyboardMaxLen || 32)) {
        this.keyboardBuffer += char;
        const preview = document.getElementById('tv-keyboard-input-preview');
        if (preview) preview.textContent = this.keyboardBuffer || "...";
        sound.play('click');
      }
    }

    handleKeyboardBackspace() {
      this.keyboardBuffer = this.keyboardBuffer.slice(0, -1);
      const preview = document.getElementById('tv-keyboard-input-preview');
      if (preview) preview.textContent = this.keyboardBuffer || "...";
      sound.play('click');
    }

    handleKeyboardConfirm() {
      const dialog = document.getElementById('dialog-keyboard');
      dialog?.classList.remove('active');
      nav.releaseModal();
      if (typeof this.keyboardOnConfirm === 'function') {
        this.keyboardOnConfirm(this.keyboardBuffer.trim());
      }
    }

    handleKeyboardCancel() {
      const dialog = document.getElementById('dialog-keyboard');
      dialog?.classList.remove('active');
      nav.releaseModal();
    }

    setupCustomScriptDialog() {
      const dialog = document.getElementById('dialog-custom-script');
      if (!dialog) return;

      this.customScriptType = 'game';
      this.customImportMode = 'yt';
      this.parsedFileData = null;

      // Mode switching tabs
      const setMode = (mode) => {
        this.customImportMode = mode;
        const btnYt = document.getElementById('btn-tab-mode-yt');
        const btnFile = document.getElementById('btn-tab-mode-file');
        const btnRaw = document.getElementById('btn-tab-mode-raw');
        const tabYt = document.getElementById('tab-content-yt');
        const tabFile = document.getElementById('tab-content-file');
        const tabRaw = document.getElementById('tab-content-raw');

        btnYt?.classList.toggle('tv-btn-primary', mode === 'yt');
        btnFile?.classList.toggle('tv-btn-primary', mode === 'file');
        btnRaw?.classList.toggle('tv-btn-primary', mode === 'raw');

        if (tabYt) tabYt.style.display = mode === 'yt' ? 'block' : 'none';
        if (tabFile) tabFile.style.display = mode === 'file' ? 'block' : 'none';
        if (tabRaw) tabRaw.style.display = mode === 'raw' ? 'block' : 'none';

        // Clear error
        const errEl = document.getElementById('custom-script-error-msg');
        if (errEl) errEl.style.display = 'none';
      };

      document.getElementById('btn-tab-mode-yt')?.addEventListener('click', () => setMode('yt'));
      document.getElementById('btn-tab-mode-file')?.addEventListener('click', () => setMode('file'));
      document.getElementById('btn-tab-mode-raw')?.addEventListener('click', () => setMode('raw'));

      // TV keyboard for YouTube ID
      document.getElementById('btn-open-yt-keyboard')?.addEventListener('click', () => {
        const curVal = document.getElementById('custom-yt-input')?.value || "";
        this.openTVKeyboard({
          title: "Saisie de l'ID ou URL YouTube",
          initialValue: curVal,
          maxLen: 80,
          onConfirm: (val) => {
            const input = document.getElementById('custom-yt-input');
            if (input) input.value = val;
          }
        });
      });

      // Quick Presets
      document.getElementById('btn-preset-ninja')?.addEventListener('click', () => {
        const inp = document.getElementById('custom-yt-input');
        const tit = document.getElementById('custom-title-input');
        if (inp) inp.value = "XTgSxQ6ZLM0";
        if (tit) tit.value = "Ninja Parkour Action";
      });
      document.getElementById('btn-preset-alps')?.addEventListener('click', () => {
        const inp = document.getElementById('custom-yt-input');
        const tit = document.getElementById('custom-title-input');
        if (inp) inp.value = "XTgSxQ6ZLM0";
        if (tit) tit.value = "Sentier des Crêtes Alpines";
      });

      // Local JSON file picker
      const fileInput = document.getElementById('custom-file-hidden-input');
      const fileTrigger = document.getElementById('btn-trigger-file-select');
      const fileSelectedName = document.getElementById('custom-file-selected-name');

      fileTrigger?.addEventListener('click', () => fileInput?.click());

      fileInput?.addEventListener('change', (e) => {
        const file = e.target.files?.[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (event) => {
          try {
            const data = JSON.parse(event.target.result);
            this.parsedFileData = data;
            if (fileSelectedName) {
              fileSelectedName.textContent = `✓ Fichier chargé : ${file.name} (${Math.round(file.size / 1024)} Ko)`;
            }
          } catch (err) {
            this.showCustomError("Erreur de parsing JSON : " + err.message);
          }
        };
        reader.readAsText(file);
      });

      // Cancel button
      document.getElementById('btn-custom-cancel')?.addEventListener('click', () => {
        dialog.classList.remove('active');
        nav.releaseModal();
      });

      // Launch & Save button
      document.getElementById('btn-custom-launch')?.addEventListener('click', () => {
        this.submitCustomScript();
      });
    }

    openCustomScriptDialog(type = 'game') {
      this.customScriptType = type;
      const dialog = document.getElementById('dialog-custom-script');
      const titleEl = document.getElementById('custom-dialog-title');
      const errEl = document.getElementById('custom-script-error-msg');
      if (errEl) errEl.style.display = 'none';

      if (titleEl) {
        titleEl.textContent = type === 'game'
          ? "Charger un Script Jeu d'Action Personnalisé"
          : "Charger un Script Virtual Run Personnalisé";
      }

      // Pre-fill raw template based on type
      const rawTextarea = document.getElementById('custom-raw-json-textarea');
      if (rawTextarea) {
        if (type === 'game') {
          rawTextarea.value = JSON.stringify({
            schemaVersion: "1.0",
            type: "game",
            meta: { title: "Course Ninja Défi", difficulty: "normal", level: 2 },
            video: {
              videoId: "XTgSxQ6ZLM0",
              trimStart: 5.0,
              trimEnd: 60.0,
              cuts: [],
              audioMuted: false
            },
            game: {
              rules: { maxLives: 3 },
              timeline: [
                { id: "e1", time: 6.0, action: "STARTING COUNT", showOnScreen: true, points: 50 },
                { id: "e2", time: 9.0, action: "GO", showOnScreen: true, points: 100 },
                { id: "e3", time: 14.0, action: "JUMP", showOnScreen: true, points: 100 },
                { id: "e4", time: 20.0, action: "SLIDE DOWN", showOnScreen: true, points: 100 },
                { id: "e5", time: 27.0, action: "PUNCH", showOnScreen: true, points: 100 },
                { id: "e6", time: 34.0, action: "SLASH", showOnScreen: true, points: 100 },
                { id: "e7", time: 42.0, action: "WIN", showOnScreen: true, points: 200 }
              ]
            }
          }, null, 2);
        } else {
          rawTextarea.value = JSON.stringify({
            schemaVersion: "1.0",
            type: "virtual_run",
            meta: { title: "Parcours Alpin Sprint", difficulty: "normal" },
            video: {
              videoId: "XTgSxQ6ZLM0",
              trimStart: 5.0,
              trimEnd: 85.0,
              cuts: [],
              audioMuted: false
            },
            virtualRun: {
              route: { name: "Sentier Découverte", totalDistanceKm: 2.0 },
              speedMapping: { referenceSpeedKmh: 8.0, minSpeedKmh: 3.0, maxSpeedKmh: 18.0 },
              checkpoints: [
                { time: 25, label: "Point de vue 1", distanceKm: 0.8 },
                { time: 55, label: "Ligne d'arrivée", distanceKm: 2.0 }
              ]
            }
          }, null, 2);
        }
      }

      dialog?.classList.add('active');
      nav.trapInModal(dialog);
    }

    showCustomError(msg) {
      const errEl = document.getElementById('custom-script-error-msg');
      if (errEl) {
        errEl.textContent = msg;
        errEl.style.display = 'block';
      }
      sound.play('fail');
    }

    submitCustomScript() {
      let finalData = null;
      const type = this.customScriptType || 'game';

      if (this.customImportMode === 'yt') {
        const inp = document.getElementById('custom-yt-input')?.value || "";
        const titleInp = document.getElementById('custom-title-input')?.value || "";
        const ytId = ContentLoader.extractYouTubeId(inp);

        if (!ytId) {
          this.showCustomError("Veuillez saisir un lien ou un identifiant YouTube valide (11 caractères).");
          return;
        }

        const title = titleInp.trim() || (type === 'game' ? `Jeu Personnalisé (${ytId})` : `Course Virtuelle (${ytId})`);

        if (type === 'game') {
          finalData = {
            schemaVersion: "1.0",
            type: "game",
            meta: { title, difficulty: "normal", level: 2 },
            video: {
              videoId: ytId,
              title,
              durationSeconds: 90,
              effectiveDurationSeconds: 80,
              trimStart: 3,
              trimEnd: 83,
              cuts: [],
              audioMuted: false
            },
            game: {
              rules: { maxLives: 3, maxMisses: 5 },
              actions: ["STARTING COUNT", "GO", "JUMP", "RIGHT", "LEFT", "SLIDE DOWN", "SLASH", "PUNCH", "END", "WIN"],
              timeline: [
                { id: "c_1", time: 5.0, action: "STARTING COUNT", showOnScreen: true, points: 50, hint: "3.. 2.. 1.. Partez !" },
                { id: "c_2", time: 8.0, action: "GO", showOnScreen: true, points: 100, hint: "C'est parti ! (OK)" },
                { id: "c_3", time: 13.0, action: "JUMP", showOnScreen: true, points: 100, hint: "Sautez ! (Haut / A)" },
                { id: "c_4", time: 18.0, action: "LEFT", showOnScreen: true, points: 100, hint: "À gauche ! (Gauche)" },
                { id: "c_5", time: 24.0, action: "SLIDE DOWN", showOnScreen: true, points: 100, hint: "Glissez ! (Bas)" },
                { id: "c_6", time: 30.0, action: "PUNCH", showOnScreen: true, points: 100, hint: "Frappez ! (F / X)" },
                { id: "c_7", time: 37.0, action: "SLASH", showOnScreen: true, points: 100, hint: "Tranchez ! (D / Y)" },
                { id: "c_8", time: 45.0, action: "RIGHT", showOnScreen: true, points: 100, hint: "À droite ! (Droite)" },
                { id: "c_9", time: 53.0, action: "JUMP", showOnScreen: true, points: 100, hint: "Grand Saut ! (Haut)" },
                { id: "c_10", time: 62.0, action: "PUNCH", showOnScreen: true, points: 100, hint: "Coup de poing final !" },
                { id: "c_11", time: 70.0, action: "END", showOnScreen: true, points: 100, hint: "Ligne d'arrivée !" },
                { id: "c_12", time: 75.0, action: "WIN", showOnScreen: true, points: 200, hint: "Victoire !" }
              ]
            }
          };
        } else {
          finalData = {
            schemaVersion: "1.0",
            type: "virtual_run",
            meta: { title, difficulty: "normal" },
            video: {
              videoId: ytId,
              title,
              durationSeconds: 120,
              effectiveDurationSeconds: 110,
              trimStart: 5,
              trimEnd: 115,
              cuts: [],
              audioMuted: false
            },
            virtualRun: {
              route: { name: title, location: "Parcours Utilisateur", totalDistanceKm: 2.5, terrain: "Route" },
              speedMapping: { referenceSpeedKmh: 8.0, minSpeedKmh: 3.0, maxSpeedKmh: 18.0, videoPlaybackRateMin: 0.25, videoPlaybackRateMax: 2.0 },
              checkpoints: [
                { time: 30, label: "Checkpoint 1", distanceKm: 0.8, message: "Super départ !" },
                { time: 65, label: "Mi-parcours", distanceKm: 1.5, message: "Gardez le rythme !" },
                { time: 100, label: "Sprint final", distanceKm: 2.5, message: "Accélérez pour le chrono !" }
              ]
            }
          };
        }
      } else if (this.customImportMode === 'file') {
        if (!this.parsedFileData) {
          this.showCustomError("Veuillez sélectionner un fichier .json valide.");
          return;
        }
        finalData = this.parsedFileData;
      } else if (this.customImportMode === 'raw') {
        const rawText = document.getElementById('custom-raw-json-textarea')?.value || "";
        try {
          finalData = JSON.parse(rawText);
        } catch (e) {
          this.showCustomError("Erreur de syntaxe JSON : " + e.message);
          return;
        }
      }

      if (!finalData) {
        this.showCustomError("Données de script invalides.");
        return;
      }

      // Normalize & Save
      const filename = `custom_${Date.now()}`;
      const item = ContentLoader.normalizeItem(finalData, filename);
      item.isCustom = true;

      ContentLoader.saveCustomItem(item, type);

      const dialog = document.getElementById('dialog-custom-script');
      dialog?.classList.remove('active');
      nav.releaseModal();

      this.showToast(`Script "${item.title}" importé et enregistré !`);

      // Reload and launch activity immediately!
      this.loadCatalogs();
      setTimeout(() => {
        this.startActivity(item, type);
      }, 350);
    }
  }

  // Initialize on window DOM ready
  const app = new AppController();
  window.addEventListener('DOMContentLoaded', () => {
    app.init();
  });

})();
