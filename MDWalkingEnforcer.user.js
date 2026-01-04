// ==UserScript==
// @name         Youtube Mobile Looper + Walking Enforcer
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Improved YouTube loop + MD walking enforcer
// @author       SS, Taylor Wright, Gemini
// @match        https://m.youtube.com/*
// @icon         https://www.google.com/s2/favicons?domain=youtube.com
// @grant        none
// @run-at       document-idle
// @downloadURL  
// @updateURL    
// ==/UserScript==

(function () {
    'use strict';

    // =================================================================
    // ⚠️ WALKING ENFORCER CONFIGURATION (Calibration Required!) ⚠️
    // =================================================================
    const TARGET_SPM = 125;           // Target Steps Per Minute for fast walking
    const ACCEL_THRESHOLD = 12.0;     // m/s^2: Minimum magnitude for a step (start test value)
    const PEAK_TIMEOUT_MS = 300;      // ms: Minimum time between counted steps
    const MIN_CHECK_MS = 2000;        // ms: Shortest interval for cadence check
    const MAX_CHECK_MS = 5000;       // ms: Longest interval for cadence check
    const SLOWDOWN_RATE = 0.9;        // Playback slowdown rate when cadence is too low
    const logFunction = console.log.bind(console);

    // --- Global State Variables for Enforcer ---
    let stepCount = 0;
    let lastPeakTime = 0;
    let lastMagnitude = 0;
    let timeOfLastCheck = Date.now();
    let isEnforcerActive = false;
    let checkTimerId = null; // To store the setTimeout ID for stopping/starting

    // =================================================================
    // 🎶 ORIGINAL LOOPER LOGIC AND UI 🎶
    // =================================================================

    // Append CSS
    document.querySelector('head').insertAdjacentHTML('beforeend',
        `<style>
            .loopBtns{
                position: fixed;
                z-index: 5;
                top: 15px;
                left: 130px;
                font-weight: 900;
                color: white;
                font-size: 1.2em;
            }
        </style>`
    );

    // Declare variables and create elements
    let loopButtonIcon = "<span>▶︎</span>"; let loopButtonText = "Single ";
    let unLoopButtonIcon = "<span style='color:red'> ⟳ </span>"; let unLoopButtonText = "Looping ";
    const HTML5PlayerSelector = '.html5-main-video';

    function createButton(type) {
        if (type !== 'loop' && type !== 'unloop') return null;
        let button = document.createElement("BUTTON");
        button.innerHTML = (type === 'loop') ? `${loopButtonText}${loopButtonIcon}` : `${unLoopButtonText}${unLoopButtonIcon}`;
        button.className = "loopBtns";
        return button;
    }

    function hideElement(el) { el.style.display = "none"; }
    function showElement(el) { el.style.display = "block"; }

    let loopBtn = createButton('loop');
    let unLoopBtn = createButton('unloop');
    let appendTo = document.querySelector('body');
    let url = location.href;

    // Detect if entry point is NOT m.youtube.com/watch
    function hideButtonsIfNotYouTube() {
        if (window.location.href.split('/')[3].substring(0, 5) !== "watch") {
            hideElement(unLoopBtn);
            hideElement(loopBtn);
        }
    }
    hideButtonsIfNotYouTube();
    hideElement(unLoopBtn);

    appendTo.appendChild(loopBtn);
    appendTo.appendChild(unLoopBtn);

    // --- Button Event Listeners ---
    loopBtn.addEventListener("click", () => {
        if (!document.querySelector(HTML5PlayerSelector)) return; // Safety check

        document.querySelector(HTML5PlayerSelector).loop = true;
        showElement(unLoopBtn);
        hideElement(loopBtn);

        // ** 🔑 Start the Walking Enforcer when loop is active 🔑 **
        startEnforcer();
    });

    unLoopBtn.addEventListener("click", () => {
        if (!document.querySelector(HTML5PlayerSelector)) return; // Safety check

        document.querySelector(HTML5PlayerSelector).loop = false;
        hideElement(unLoopBtn);
        showElement(loopBtn);

        // ** 🔑 Stop the Walking Enforcer when loop is deactivated 🔑 **
        stopEnforcer();
        // Ensure playback rate is reset when stopping
        document.querySelector(HTML5PlayerSelector).playbackRate = 1.0;
    });

    // --- Mutation Observers (Loop State and Search Bar) ---
    // (Your original loopStateObserver and searchStateObserver functions remain unchanged)

    let loopStateObserver = () => {
        const targetNode = document.querySelector('#player');
        const config = { attributes: true, childList: true, subtree: true };
        const callback = function (mutationsList, observer) {
            for (const mutation of mutationsList) {
                if (mutation.type === 'attributes' && mutation.attributeName === "src") {
                    console.log('video source changed; checking if url changed');
                    if (url !== location.href) {
                        document.querySelector(HTML5PlayerSelector).loop = false;
                        hideElement(unLoopBtn);
                        showElement(loopBtn);
                        url = location.href;
                        console.log('updating loop button');
                        // ** 🔑 Stop enforcer if video changes (i.e., new video loaded) 🔑 **
                        stopEnforcer();
                    }
                    hideButtonsIfNotYouTube();
                }
            }
        };
        const observer = new MutationObserver(callback);
        if (targetNode) observer.observe(targetNode, config);
    };

    let searchStateObserver = () => {
        const targetNode = document.querySelector('ytm-mobile-topbar-renderer');
        const config = { attributes: true, childList: true, subtree: true };
        const callback = function (mutationsList, observer) {
            for (const mutation of mutationsList) {
                if (mutation.attributeName == "data-mode") {
                    if (document.querySelector('.mobile-topbar-header').dataset.mode === "searching") {
                        console.log('search mode open');
                        unLoopBtn.style.zIndex = 2;
                        loopBtn.style.zIndex = 2;
                    } else {
                        console.log('search mode close');
                        unLoopBtn.style.zIndex = 5;
                        loopBtn.style.zIndex = 5;
                    }
                }
            }
        };
        const observer = new MutationObserver(callback);
        if (targetNode) observer.observe(targetNode, config);
    };

    // Call the observers
    loopStateObserver();
    searchStateObserver();


    // =================================================================
    // 👟 WALKING ENFORCER CORE FUNCTIONS 👟
    // =================================================================

    // --- Step Counting Logic ---
    function handleMotion(event) {
        if (!isEnforcerActive) return; // Only process motion data when needed

        const { x, y, z } = event.accelerationIncludingGravity;
        const currentMagnitude = Math.sqrt(x * x + y * y + z * z);

        if (currentMagnitude > lastMagnitude &&
            currentMagnitude > ACCEL_THRESHOLD &&
            (Date.now() - lastPeakTime > PEAK_TIMEOUT_MS)) {
            stepCount++;
            lastPeakTime = Date.now();
        }

        lastMagnitude = currentMagnitude;
    }

    // --- Control and Timing Logic ---
    function setNextCheck() {
        if (!isEnforcerActive) {
            if (checkTimerId) clearTimeout(checkTimerId);
            return;
        }
        const nextCheckDuration = Math.random() * (MAX_CHECK_MS - MIN_CHECK_MS) + MIN_CHECK_MS;
        logFunction(`[ENFORCER] Scheduling next check in: ${Math.round(nextCheckDuration / 1000)}s`);
        checkTimerId = setTimeout(checkCadenceAndControlMusic, nextCheckDuration);
    }

    function checkCadenceAndControlMusic() {
        if (!isEnforcerActive || !document.querySelector(HTML5PlayerSelector)) {
            stopEnforcer();
            return;
        }

        const timeElapsedMs = Date.now() - timeOfLastCheck;
        // Steps Per Minute Calculation
        const cadence = (stepCount / (timeElapsedMs / 60000));

        if (cadence < TARGET_SPM) {
            // ENFORCEMENT: SLOW DOWN
            let currPlaybackRate = document.querySelector(HTML5PlayerSelector).playbackRate;
            document.querySelector(HTML5PlayerSelector).playbackRate = Number((SLOWDOWN_RATE * currPlaybackRate).toFixed(2));
            logFunction(`[ENFORCER] Cadence LOW: ${cadence.toFixed(1)} SPM. Slowing ${SLOWDOWN_RATE}x.`);
        } else {
            // REWARD: NORMAL SPEED
            document.querySelector(HTML5PlayerSelector).playbackRate = 1.0;
            logFunction(`[ENFORCER] Cadence OK: ${cadence.toFixed(1)} SPM. Maintaining 1.0x speed.`);
        }

        // Reset and schedule the next check
        stepCount = 0;
        timeOfLastCheck = Date.now();
        setNextCheck();
    }

    function startEnforcer() {
        if (isEnforcerActive) return; // Already running

        logFunction("[ENFORCER] Starting motion detection and enforcement.");
        isEnforcerActive = true;

        // Reset state
        stepCount = 0;
        timeOfLastCheck = Date.now();

        // Start listening to the accelerometer
        if (window.DeviceMotionEvent) {
             window.addEventListener('devicemotion', handleMotion, true);
        }

        // Start the randomized checking cycle
        setNextCheck();
    }

    function stopEnforcer() {
        if (!isEnforcerActive) return; // Already stopped

        logFunction("[ENFORCER] Stopping enforcement.");
        isEnforcerActive = false;

        // Clear the scheduled check timer
        if (checkTimerId) {
            clearTimeout(checkTimerId);
            checkTimerId = null;
        }

        // Remove the motion listener to save battery (optional but good practice)
        if (window.DeviceMotionEvent) {
             window.removeEventListener('devicemotion', handleMotion, true);
        }
    }

    // --- Final Initialization Step ---
    // Start listening for device motion events, but only process data when isEnforcerActive is true.
    if (window.DeviceMotionEvent) {
        // Add the listener once, and let isEnforcerActive control processing in handleMotion
        window.addEventListener('devicemotion', handleMotion, true);
        logFunction("[ENFORCER] DeviceMotionEvent listener attached.");
    } else {
        logFunction("[ENFORCER] DeviceMotionEvent not supported. Walking enforcement disabled.");
    }
})();
