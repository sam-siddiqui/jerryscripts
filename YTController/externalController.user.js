// ==UserScript==
// @name          YouTube - External Controller
// @namespace     Violentmonkey Scripts
// @version       1.0.0
// @author        SAS, anhkhoakz
// @description   Controls a designated primary YouTube tab using global hotkeys from a local Python server.
// @include     http*://*.youtube.com/*
// @include     http*://youtube.com/*
// @include     http*://*.youtu.be/*
// @include     http*://youtu.be/*
// @run-at       document-start
// @require http://localhost:8000/static/socket-4_0_0.io.min.js
// @grant         none
// ==/UserScript==

// --- Global Variables ---
let playerEl; // Stores the YouTube video player element

// --- WebSocket Configuration ---
// IMPORTANT: Ensure this URL matches your Python server's host and port.
const wsUrl = 'http://localhost:8000'; // <--- CRITICAL CHANGE: This should be the base URL for Socket.IO client
let socket; // Stores the Socket.IO connection (was WebSocket)
let isServerConnected = false; // <--- NEW: Track server connection status
let connectionAttemptTimer = null; // <--- NEW: For managing periodic checks

// --- Primary Tab Control Logic ---
// Loads the 'isPrimaryTab' state from browser's local storage to persist it across sessions.
let isPrimaryTab = localStorage.getItem('youtube_primary_tab_external') === 'true'; // Using a distinct localStorage key

/**
 * Updates the text and style of the primary control toggle button.
 * @param {HTMLElement} button - The button element to update.
 */
function updateToggleButtonText(button) {
    button.textContent = `External Control: ${isPrimaryTab ? 'PRIMARY' : 'OFF'}`;
    button.style.backgroundColor = isPrimaryTab ? '#4CAF50' : '#f44336'; // Green for primary, Red for off
    button.style.color = 'white';
    button.style.border = 'none';
    button.style.padding = '5px 10px';
    button.style.borderRadius = '5px';
    button.style.cursor = 'pointer';
    button.style.marginLeft = '10px'; // Add some space if the other button exists
}

/**
 * Creates and appends the "Primary Control" toggle button to the page.
 * Manages its state and persistence in localStorage.
 */
function createPrimaryToggleButton() {
    const toggleButton = document.createElement('button');
    toggleButton.style.cssText = `
        position: fixed;
        top: 10px;
        right: 10px;
        z-index: 99998; /* Lower z-index than the other script's button if it also places one here */
        font-size: 14px;
        opacity: 0.8;
        transition: opacity 0.3s ease;
    `;
    updateToggleButtonText(toggleButton); // Set initial state and style

    toggleButton.addEventListener('click', () => {
        isPrimaryTab = !isPrimaryTab;
        localStorage.setItem('youtube_primary_tab_external', isPrimaryTab); // Save state to localStorage
        updateToggleButtonText(toggleButton); // Update button appearance
        console.log(`External Controller: This YouTube tab is now ${isPrimaryTab ? 'PRIMARY' : 'NOT PRIMARY'} for external control.`);
    });

    // Add hover effect for better UX
    toggleButton.addEventListener('mouseover', () => toggleButton.style.opacity = '1');
    toggleButton.addEventListener('mouseout', () => toggleButton.style.opacity = '0.8');

    // Find a good place to append it. If the other script also adds one, adjust right position.
    const existingButton = document.querySelector('button[style*="top: 10px"][style*="right:"]');
    if (existingButton) {
        toggleButton.style.right = (existingButton.offsetWidth + 20) + 'px';
        existingButton.parentNode.insertBefore(toggleButton, existingButton);
    } else {
        toggleButton.style.right = '10px';
        document.body.appendChild(toggleButton);
    }
}

// --- Helper Functions ---
/**
 * Finds an HTML element using a CSS selector, waiting for it to appear if necessary.
 * @param {string} selector - The CSS selector for the element.
 * @returns {Promise<HTMLElement>} A promise that resolves with the found element.
 */
function findElement(selector) {
    return new Promise(function(resolve) {
        if (document.querySelector(selector)) {
            return resolve(document.querySelector(selector));
        }
        const observer = new MutationObserver(function(mutations) {
            if (document.querySelector(selector)) {
                resolve(document.querySelector(selector));
                observer.disconnect();
            }
        });
        observer.observe(document, {
            childList: true,
            subtree: true
        });
    });
}

// --- Socket.IO Connection Logic (Updated from raw WebSocket) ---
/**
 * Establishes and manages the Socket.IO connection to the local Python server.
 * Includes automatic reconnection logic (handled by Socket.IO client).
 */
function connectWebSocket() { // Function name remains, but logic changes
    // Check if the Socket.IO client library is loaded by checking for the 'io' global object
    if (typeof io === 'undefined') {
        console.error('External Controller: Socket.IO client library not loaded. Retrying in 3 seconds...');
        setTimeout(connectWebSocket, 3000); // Retry after a short delay
        return;
    }

    socket = io(wsUrl, { // <--- Use io() to connect to the Socket.IO server
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000, // 1 second
        reconnectionDelayMax: 5000, // 5 seconds
        timeout: 20000, // 20 seconds for connection attempt
        transports: ['websocket', 'polling'] // Prefer websocket, fallback to polling
    });

    socket.on('connect', function() {
        console.log('External Controller: Socket.IO connected to local server.');
        // No manual 'socket.send('40/socket.io/');' needed here. The Socket.IO client handles the handshake.
    });

    socket.on('command_to_browser', function(data) { // <--- Listen for the custom event 'command_to_browser'
        if (data && data.action) {
            if (isPrimaryTab) { // ONLY EXECUTE IF THIS TAB IS MARKED AS PRIMARY
                console.log('External Controller: Primary tab received command:', data.action);
                if (playerEl) {
                    switch (data.action) {
                        case 'toggle_play_pause':
                            if (playerEl.paused) {
                                playerEl.play();
                            } else {
                                playerEl.pause();
                            }
                            break;
                        case 'rewind':
                            playerEl.currentTime = Math.max(0, playerEl.currentTime - 5); // Rewind 5 seconds
                            console.log('External Controller: Rewinding 5 seconds.');
                            break;
                        case 'forward':
                            playerEl.currentTime = Math.min(playerEl.duration, playerEl.currentTime + 5); // Forward 5 seconds
                            console.log('External Controller: Forwarding 5 seconds.');
                            break;
                        case 'next_video':
                            const nextKeyEv = new KeyboardEvent('keydown', {
                                key: 'N',
                                code: 'KeyN',
                                shiftKey: true,
                                bubbles: true,
                                cancelable: true
                            });
                            document.dispatchEvent(nextKeyEv);
                            console.log('External Controller: Triggered next video.');
                            break;
                        case 'volume_up':
                            playerEl.volume = Math.min(1, playerEl.volume + 0.05);
                            console.log('External Controller: Volume:', playerEl.volume.toFixed(2));
                            break;
                        case 'volume_down':
                            playerEl.volume = Math.max(0, playerEl.volume - 0.05);
                            console.log('External Controller: Volume:', playerEl.volume.toFixed(2));
                            break;
                        case 'mute_unmute':
                            playerEl.muted = !playerEl.muted;
                            console.log('External Controller: Muted/Unmuted.');
                        default:
                            console.warn('External Controller: Unknown command received:', data.action);
                    }
                } else {
                    console.warn('External Controller: YouTube player element not found, cannot execute command.');
                }
            } else {
                // This tab is not marked as primary, so it ignores external commands.
                // console.log('External Controller: Not primary tab, ignoring command:', data.action); // Uncomment for debugging if needed
            }
        }
    });

    socket.on('disconnect', function() { // <--- Socket.IO disconnect event
        console.warn('External Controller: Socket.IO disconnected from local server.');
        // The Socket.IO client's reconnection logic handles automatic retries.
    });

    socket.on('connect_error', function(error) { // <--- Socket.IO connection error event
        console.error('External Controller: Socket.IO connection error:', error);
    });
}

// --- Main Initialization Logic ---
// This code runs once the script is injected into a YouTube page.
findElement("#player #movie_player video").then(function(player) {
    playerEl = player; // Assign the found video player element

    createPrimaryToggleButton(); // Add the button to control primary tab status
    connectWebSocket();          // Start the Socket.IO connection

}).catch(error => {
    console.error("External Controller: Could not find YouTube player element. External control may not function.", error);
});
