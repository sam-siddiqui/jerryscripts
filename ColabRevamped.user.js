// ==UserScript==
// @name         Colab Interactive Tiling Manager
// @namespace    http://tampermonkey.net/
// @version      0.1
// @description  Adds drag-to-resize functionality to Colab cells for a Masonry/Grid layout.
// @author       Gemini, SS
// @match        https://colab.research.google.com/drive/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // --- Configuration and Selectors ---
    const GRID_COLUMNS = 4;
    const GRID_ROWS = 20;
    const minHeightSpan = 2;
    const eachRowHeight = '20px';
    const minCellHeight = '300px';
    const GAP = 15; // Must match the CSS gap value
    const RESIZE_HANDLE_CSS_CLASS_NAME = 'colab-tiling-handle'

    const NOTEBOOK_CONTAINER_SELECTOR = '.notebook-cell-list';
    const CELL_SELECTOR = '.cell';
    const EXECUTION_CONTAINER_SELECTOR = '.cell-execution-container'
    const CODE_CELL_GUTTER_SELECTOR = '.cell-gutter'
    const CODE_CELL_OVERLAY_SELECTOR = '.main-content';
    const CODE_CELL_CONTAINER_SELECTOR = '.cell-contents'
    const RESIZE_SPAN_CSS_NAME_PART = 'colab-span'
    const CODE_RUN_BUTTON_SELECTOR = 'colab-run-button'

    // Global drag variables
    let currentCell = null;
    let startX, startWidth, startColSpan;

    // --- STATE MANAGEMENT ---
    const cellStateMap = new WeakMap();       // We use a WeakMap so if Colab deletes the cell object, we don't leak memory
    const saveTimers = new WeakMap();         // Tracks debounce timers per cell
    const DEBOUNCE_MS = 2000;
    const STATE_FLOW_BROKEN_CSS_NAME = 'state-flow-broken'
    const STATE_LAST_RUN_CSS_NAME = 'state-last-run'
    const STATE_LOCAL_STALE_CSS_NAME = 'state-local-stale'
    const getIdFromEl = (cellElement) => cellElement.id.replace('cell-', '')


    // --- Core Persistence Functions (Option A: Model Modification) ---

    /**
     * Finds the Colab cell object by its DOM ID and updates its metadata for persistence.
     * @param {string} cellId - The unique ID of the cell (e.g., '2nJN4S3gX85m').
     * @param {object} layoutData - The custom layout data (e.g., {columnSpan: 2}).
     */
    function saveLayoutToModel(cellId, layoutData) {
        try {
            const notebook = window.colab?.global?.notebook;
            if (!notebook?.cells) return;

            // Find the specific cell object in the in-memory array
            const cell = notebook.cells.find(c => c.cellId === cellId);

            if (cell && cell.model) {
                const metadata = cell.model.metadata;

                // Write to the custom metadata field
                metadata.tiling_config = metadata.tiling_config || {};
                Object.assign(metadata.tiling_config, {...metadata.tiling_config, ...layoutData});

                // Note: Simply changing the metadata object usually signals Colab to update
                // the notebook's internal dirty state, ensuring it saves on autosave/Ctrl+S.
            }
        } catch (e) {
            console.error("[Tiling] Error saving layout to Colab model:", e);
        }
         console.log(`[Tiling] Saved layoutData ${Object.values(layoutData)} for ${cellId}.`);
    }

    /**
     * Reads the saved tiling configuration from the model and applies the grid-column span CSS.
     * @param {HTMLElement} cellElement - The DOM element of the cell.
     * @param {string} cellId - The unique ID of the cell.
     */
    function applySavedLayout(cellElement, cellId) {
        try {
            const notebook = window.colab?.global?.notebook;
            if (!notebook?.cells) return 1;

            const cell = notebook.cells.find(c => c.cellId === cellId);

            if (cell && cell.model?.metadata?.tiling_config) {
                const columnSpan = cell.model.metadata.tiling_config.columnSpan;
                const rowSpan = cell.model.metadata.tiling_config.rowSpan;

                // Apply colSpan
                if (typeof columnSpan === 'number' && columnSpan > 1 && columnSpan <= GRID_COLUMNS) {
                    // Remove existing and apply new class
                    for(let i = 2; i <= GRID_COLUMNS; i++) {
                        cellElement.classList.remove(`colab-span-${i}`);
                    }
                    cellElement.classList.add(`colab-span-${columnSpan}`);
                }

                // Apply rowSpan
                if (typeof rowSpan === 'number' && rowSpan > 1) {
                    cellElement.style.gridRow = `span ${Math.max(minCellHeight, rowSpan)}`;
                }
            }
        } catch (e) {
            console.warn("[Tiling] Could not apply saved layout (likely no config found).", e);
        }
    }

    /**
     * Finds the Colab cell object by its DOM ID and updates its metadata for persistence.
     * @param {string} cellId - The unique ID of the cell (e.g., '2nJN4S3gX85m').
     * @param {object} stateData - The custom state data (e.g., {columnSpan: 2}).
     */
    function saveStateToModel(cellModel, stateData) {
        try {
            if (!cellModel) {return;}
            // Clear existing timer for this cell
            if (saveTimers.has(cellModel)) {
                clearTimeout(saveTimers.get(cellModel));
            }

            // Set a new timer (Debounce)
            const timerId = setTimeout(() => {
                try {
                    // We only need to save 'lastEdit'. 'lastRun' is managed by Colab.
                    const dataToSave = { lastEdit: stateData.lastEdit };

                    const metadata = cellModel.metadata;
                    // Initialize metadata bucket if missing
                    metadata.state_config = metadata.state_config || {};

                    // Write data
                    Object.assign(metadata.state_config, dataToSave);

                    // Trigger Colab's dirty check (optional, usually modifying metadata is enough)
                    console.log(`[State] Persisted edit time for ${cellModel.id}`);
                } catch (e) {
                    console.error("[State] DebouncedFn: Error saving state to model:", e);
                }
            }, DEBOUNCE_MS);

            saveTimers.set(cellModel, timerId);
        } catch (e) {
            console.error("[State] Error saving state to Colab model:", e);
        }
    }

    /**
     * Reads our custom state from the Colab Model.
     * returns { lastEdit: number }
     */
    function loadStateFromModel(cellModel) {
        if (!cellModel || !cellModel.metadata) return { lastEdit: 0 };

        // 1. Get our custom "Last Edit" time
        const savedState = cellModel.metadata.state_config || {};

        // 2. Get Colab's native "Last Run" time (This is always persisted by Google)
        const execInfo = cellModel.metadata.executionInfo || {};
        const nativeLastRun = execInfo.timestamp || 0;

        return {
            lastEdit: savedState.lastEdit || 0,
            lastRun: nativeLastRun,
            attached: false // Flag to ensure we attach listeners
        };
    }

    function syncCellListeners(notebook) {
        notebook.cells.forEach(cell => {
            if (!cell.model || cell.model.type !== 'code') return;

            // If we haven't mapped this cell object in RAM yet...
            if (!cellStateMap.has(cell.model)) {

                // A. LOAD FROM MODEL (The Persistence Fix)
                const persistedState = loadStateFromModel(cell.model);
                persistedState.attached = true;

                // Store in RAM for fast access
                cellStateMap.set(cell.model, persistedState);

                // B. ATTACH LISTENER
                if (cell.model.textModel) {
                    cell.model.textModel.onDidChangeContent(() => {
                        const state = cellStateMap.get(cell.model);
                        const now = Date.now();

                        // 1. Update RAM immediately (Fast UI update)
                        state.lastEdit = now;

                        // 2. Queue Persistence (Debounced)
                        saveStateToModel(cell.model, state);
                    });
                }
            }
        });
    }

    function updateVisuals(cell, state, isLastRun) {
        const el = cell.element_;
        if (!el) return;

        // 1. Local Stale (Amber)
        if (state.lastEdit > state.lastRun) el.classList.add(STATE_LOCAL_STALE_CSS_NAME);
        else el.classList.remove(STATE_LOCAL_STALE_CSS_NAME);

        // 2. Flow Broken (Purple)
        if (state.flowBroken) el.classList.add(STATE_FLOW_BROKEN_CSS_NAME);
        else el.classList.remove(STATE_FLOW_BROKEN_CSS_NAME);

        // 3. Last Run (Blue)
        if (isLastRun) el.classList.add(STATE_LAST_RUN_CSS_NAME);
        else el.classList.remove(STATE_LAST_RUN_CSS_NAME);
    }

    function updateFlowState(notebook) {
        const cells = notebook.cells;
        let maxExecTimeAbove = 0;
        let globalLastRunTime = 0;
        let globalLastRunId = null;

        // Pass 1: Calc Flow
        cells.forEach(cell => {
            if (!cell.model || cell.model.type !== 'code') return;
            const state = cellStateMap.get(cell.model);
            if (!state) return;

            // Always sync 'lastRun' from the live metadata (Colab updates this for us)
            const execInfo = cell.model.metadata.executionInfo;
            if (execInfo && execInfo.timestamp) {
                state.lastRun = execInfo.timestamp;
            }

            // Global Tracker
            if (state.lastRun > globalLastRunTime) {
                globalLastRunTime = state.lastRun;
                globalLastRunId = cell.model.id;
            }

            // Waterfall Logic
            state.flowBroken = (state.lastRun > 0 && state.lastRun < maxExecTimeAbove);

            if (state.lastRun > maxExecTimeAbove) {
                maxExecTimeAbove = state.lastRun;
            }
        });

        // Pass 2: Render and save
        cells.forEach(cell => {
            if (!cell.model || cell.model.type !== 'code') return;
            const state = cellStateMap.get(cell.model);
            if (state) {
                const isLastRun = (cell.model.id === globalLastRunId);
                updateVisuals(cell, state, isLastRun);
                // console.log(`${cell.model.id} (${isLastRun}): ${state}`)
            }

            saveStateToModel()
        });
    }

    function updateCellHeighSpan(cellElement, save) {
          const rowHeight = GRID_ROWS; // Must match the CSS grid-auto-rows value
          const gap = GAP;       // Must match the CSS gap value
         // 1. Measure the content height
          // We look at the children because the .cell itself might be stretched by the grid
          const contentHeight = cellElement.scrollHeight;

          // 2. Calculate how many rows this cell needs
          // Formula: (Height + Gap) / (RowHeight + Gap)
          const newSpan = Math.ceil((contentHeight + gap) / (rowHeight + gap));

          // 3. Apply the span
          cellElement.style.gridRow = `span ${newSpan}`;

          // 4. Save to Model
          const cellId = getIdFromEl(cellElement);
          if (save) saveLayoutToModel(cellId, { rowSpan: newSpan });
    }

    function updateCellSpans(save = false) {
        const notebookContainer = document.querySelector(NOTEBOOK_CONTAINER_SELECTOR);
        const cells = notebookContainer.querySelectorAll(CELL_SELECTOR);

        cells.forEach(cell => {
            updateCellHeighSpan(cell, save);
            window.dispatchEvent(new Event('resize'));
        });
        console.log("[Tiling] Updated Cell Heights");

    }

    // --- Drag and Resize Logic ---

    function getContainerWidth() {
        return document.querySelector(NOTEBOOK_CONTAINER_SELECTOR)?.offsetWidth || 1000;
    }

    function resizeWidth(e) {
        if (!currentCell) return;

        const deltaX = e.clientX - startX;
        const containerWidth = getContainerWidth();

        // Calculate the effective width of one column segment (column width + gap)
        const oneColWidth = (containerWidth - ((GRID_COLUMNS - 1) * GAP)) / GRID_COLUMNS;
        const segmentWidth = oneColWidth + GAP;

        const newWidth = startWidth + deltaX;
        let newSpan = Math.round(newWidth / segmentWidth);
        newSpan = Math.max(1, Math.min(newSpan, GRID_COLUMNS)); // Clamp between 1 and 4

        if (newSpan !== startColSpan) {
            // 1. Update DOM Classes
            for(let i = 2; i <= GRID_COLUMNS; i++) {
                currentCell.classList.remove(`${RESIZE_SPAN_CSS_NAME_PART}-${i}`);
            }
            if ((newSpan < GRID_COLUMNS)) {
                currentCell.classList.add(`${RESIZE_SPAN_CSS_NAME_PART}-${newSpan}`);
            }

            // 2. Update Persistence Model
            const cellId = getIdFromEl(currentCell);
            saveLayoutToModel(cellId, { columnSpan: newSpan });

            // 3. Reset starting points for smooth snap
            startX = e.clientX;
            // Recalculate width after the class change for accurate snapping
            startWidth = currentCell.offsetWidth;
            startColSpan = newSpan;
            updateCellHeighSpan(currentCell, true)
        }

        window.dispatchEvent(new Event('resize'));
    }

    function initResize(e) {
        e.preventDefault();
        currentCell = e.target.closest(CELL_SELECTOR);
        if (!currentCell) return;

        startX = e.clientX;
        startWidth = currentCell.offsetWidth;

        // Read current span from classes
        let span = 1;
        for(let i = 2; i <= GRID_COLUMNS; i++) {
            if(currentCell.classList.contains(`${RESIZE_SPAN_CSS_NAME_PART}-${i}`)) {
                span = i;
            }
        }
        startColSpan = span;

        document.addEventListener('mousemove', resizeWidth);
        document.addEventListener('mouseup', stopResize);
        currentCell.style.userSelect = 'none'; // Prevent text selection during drag
    }

    function stopResize() {
        document.removeEventListener('mousemove', resizeWidth);
        document.removeEventListener('mouseup', stopResize);
        if (currentCell) {
            currentCell.style.userSelect = '';
        }
        updateCellHeighSpan(currentCell, true);
        currentCell = null;
    }


    // --- DOM Injection and Observer ---

    function attachHandleAndPersistence(cellElement) {
        // Only process cells that haven't been processed before
        if (cellElement.querySelector(`.${RESIZE_HANDLE_CSS_CLASS_NAME}`)) return;

        const cellId = getIdFromEl(cellElement);

        // 1. **Apply Saved Layout**
        // This must run before creating the handle to ensure the initial size is correct
        applySavedLayout(cellElement, cellId);

        // 2. **Inject Resize Handle**
        const handle = document.createElement('div');
        handle.className = RESIZE_HANDLE_CSS_CLASS_NAME;
        cellElement.querySelector(CODE_CELL_CONTAINER_SELECTOR).appendChild(handle);

        // 3. **Attach Drag/Resize Listeners**
        handle.addEventListener('mousedown', initResize);

        window.dispatchEvent(new Event('resize'));
    }

    function observeCells() {
        const notebookContainer = document.querySelector(NOTEBOOK_CONTAINER_SELECTOR);
        if (!notebookContainer) {
            // Notebook not fully loaded, try again in 500ms
            setTimeout(observeCells, 500);
            return;
        }
        const notebookModel = window.colab?.global?.notebook;
        if (!notebookModel) {
            setTimeout(observeCells, 500);
            return;
        }

        // Process existing cells
        notebookContainer.querySelectorAll(CELL_SELECTOR).forEach(attachHandleAndPersistence);
        updateCellSpans();

        // Observe future cell additions (new cells, cells moved, etc.)
        const observer = new MutationObserver((mutationsList, observer) => {
            for (const mutation of mutationsList) {
                if (mutation.type === 'childList') {
                    mutation.addedNodes.forEach(node => {
                        // Ensure it's an element node and matches the cell selector
                        if (node.nodeType === 1 && node.matches(CELL_SELECTOR)) {
                            attachHandleAndPersistence(node);
                            syncCellListeners(notebookModel);
                        }
                    });
                }
                if (mutation.type === 'attributes' && mutation.target.matches(CELL_SELECTOR)) {
                    console.log("Some attribute changed");
                    applySavedLayout(mutation.target, getIdFromEl(mutation.target.id))

                    if(mutation.attributeName === 'class') {
                      console.log("A cell had a class change!");
                      if (mutation.target.classList.contains('running')) {
                            console.log("A cell just ran!");
                      }
                      if (mutation.target.classList.contains('pending')) {
                            console.log("A cell will run!");
                      }
                    }
                }
            }
        });

        // Start observing the main container for new cells
        observer.observe(notebookContainer, { childList: true, subtree: false });
        console.log("[Tiling] Mutation Observer active.");

        // Initial Sync
        syncCellListeners(colab.global.notebook);

        // Run the "Waterfall" Check loop
        setInterval(() => updateFlowState(colab.global.notebook), 1000);
        console.log("[State] State Observer active.");
        stopOnNaN();
    }

    /**
     * Stops the currently executing cell in Google Colab if "nan" is detected
     * in any code cell output (including simple prints).
     *
     * @param {number} interval The polling interval in milliseconds (e.g., 500ms).
     */
    function stopOnNaN(interval = 500) {
        if (window.nanMonitor) {
            clearInterval(window.nanMonitor);
        }

        // Selector for text output containers in running cells
        const outputSelectors = [
            `${CELL_SELECTOR}.running > output-content colab-static-output-renderer`, // Printed text/stream output
            `${CELL_SELECTOR}.running .output-content`                           // General output container (as a fallback)
        ];

        window.nanMonitor = setInterval(() => {
            let nanDetected = false;

            // 1. Check outputs in currently running cells
            for (const selector of outputSelectors) {
                const outputs = document.querySelectorAll(selector);
                for (const output of outputs) {
                    // Check the output's text content for "nan" (case-insensitive)
                    // Using textContent is much faster than checking the console log
                    if (output.textContent.toLowerCase().includes('nan')) {
                        nanDetected = true;
                        break;
                    }
                }
                if (nanDetected) break; // Exit output selector loop
            }

            if (nanDetected) {
                console.warn('🚨 NaN value detected in a cell output. Attempting to stop execution.');

                // 2. Find the currently running cell and its Stop button
                // The CodeMirror-cursor only exists in the currently running cell
                const runningCell = document.querySelector(`${CELL_SELECTOR}.running`);

                if (runningCell) {
                   const stopButton = runningCell?.querySelector(CODE_RUN_BUTTON_SELECTOR);

                    if (stopButton) {
                        stopButton.click();
                        console.log('✅ Successfully triggered the cell STOP button.');
                    } else {
                        window.alert('Could not find or click the STOP button. Manually stop the cell.');
                    }
                } else {
                     console.error('⚠️ NaN detected, but no running cell found. Execution may have already stopped or UI state is complex.');
                }

                // 3. Always stop the monitoring interval after a detection event
                clearInterval(window.nanMonitor);
                console.log('Monitor stopped. Use stopOnNaN(500) to restart it.');
            }
        }, interval);
        console.log(`NaN monitor started, checking every ${interval}ms. Use clearInterval(window.nanMonitor) to stop it manually.`);
    }

    function initialize() {
        // 1. Inject the necessary CSS for the Grid Layout and Handle
        const style = document.createElement('style');
        style.textContent = `
            /* Colab Tiling Manager CSS */

            /*1. Limit the width of the main content wrapper (Viewport Fix) */
            .panel-ui-refresh.notebook-content-background {
                width: 100% !important;
                min-width: unset !important;
                /* Crucial:Remove Colab's minimum width constraint */
                margin: 0 auto !important;
            }

            .markdown {
                max-width: unset !important;
            }
            ${NOTEBOOK_CONTAINER_SELECTOR} {
                display: grid !important;
                grid-template-columns: repeat(${GRID_COLUMNS}, 1fr) !important;
                gap: ${GAP}px !important;


                grid-auto-rows: ${eachRowHeight} !important;      /* NEW: Create tiny base rows */


                grid-auto-flow: dense !important;                 /* NEW: Attempt to fill holes if a small cell fits earlier */

                align-items: start !important;
            }
            ${CELL_SELECTOR} {
                grid-column: span ${GRID_COLUMNS} !important;     /* Default span */

                grid-row: span ${minHeightSpan};                  /* Default to a reasonable minimum height */

                position: relative;                               /* Crucial for positioning the handle */

                padding: 0px 5px !important;                      /* Optional: reduce the padding/margin Colab usually adds to the side */

                min-width: 0 !important;
                min-height: ${minCellHeight};                     /* Adjust min-height for visual clarity */

            }

            .inputarea.horizontal.layout.code > .editor.flex.lazy-editor {
              width: 100% ;
            }
            .inputarea.horizontal.layout.code {
              display: flex !important;
              flex-direction: column !important;
            }
            .cell-gutter, ${EXECUTION_CONTAINER_SELECTOR} {
              height: 40px;
              width: 100% ;
            }
            ${EXECUTION_CONTAINER_SELECTOR} {
              left: 50px !important;
            }

            /* Span Classes for Persistence */
            .${RESIZE_SPAN_CSS_NAME_PART}-1 { grid-column: span 1 !important; }
            .${RESIZE_SPAN_CSS_NAME_PART}-2 { grid-column: span 2 !important; }
            .${RESIZE_SPAN_CSS_NAME_PART}-3 { grid-column: span 3 !important; }
            .${RESIZE_SPAN_CSS_NAME_PART}-4 { grid-column: span 4 !important; }

            .${RESIZE_HANDLE_CSS_CLASS_NAME} {
                position: absolute;
                bottom: 0;
                right: 0;
                width: 5px;
                height: 100%;
                background-color: #007bff;
                cursor: col-resize; /* Horizontal resize cursor */
                z-index: 1000;
                opacity: 0.3;
                border-top-right-radius: 5px;
                border-bottom-right-radius: 5px;
                transition: opacity 0.2s;
            }
            .${RESIZE_HANDLE_CSS_CLASS_NAME}:hover {
                opacity: 0.8;
            }

            /* 1. LOCAL STALE (Edited > Ran) - Amber Strip */
            ${CELL_SELECTOR}.${STATE_LOCAL_STALE_CSS_NAME} ${CODE_CELL_GUTTER_SELECTOR} {
                border-bottom: 4px solid #f59e0b !important; /* Amber warning color */
                background-color: rgba(245, 158, 11, 0.1); /* Very faint amber tint */
            }
            ${CELL_SELECTOR}.${STATE_LOCAL_STALE_CSS_NAME} .monaco-editor::after {
                content: "";
                position: absolute;
                top: 0; left: 0; right: 0; bottom: 0;
                background-color: rgba(245, 158, 11, 0.1); /* Amber tint */
                pointer-events: none;
                z-index: 10;
            }
            /* 2. FLOW BROKEN (Upstream is newer than me) - Purple Strip */
            /* This warns: "The variables above me might have changed!" */
            ${CELL_SELECTOR}.${STATE_FLOW_BROKEN_CSS_NAME}::after {
                content: "";
                position: absolute;
                left: 2%; top: 0;
                width: 96%;
                height: 5px;
                background-color: #9c27b0; /* Purple */
                border-bottom-left-radius: 5px;
                border-bottom-right-radius: 5px;
                z-index: 100;
                opacity: 0.6;
            }

            @keyframes revolving-glow-animation {
              0%   { box-shadow: 0 0 10px rgba(0, 150, 255, 0.8), 0 0 20px rgba(0, 150, 255, 0.6); }
              50%  { box-shadow: 0 0 25px rgba(0, 150, 255, 1), 0 0 40px rgba(0, 150, 255, 0.8); }
              100% { box-shadow: 0 0 10px rgba(0, 150, 255, 0.8), 0 0 20px rgba(0, 150, 255, 0.6); }
            }

            /* 3. LAST RUN - Revoling Blue Border */
            ${CELL_SELECTOR}.${STATE_LAST_RUN_CSS_NAME} ${CODE_CELL_OVERLAY_SELECTOR}, ${CELL_SELECTOR}.${STATE_LAST_RUN_CSS_NAME}.focused ${CODE_CELL_OVERLAY_SELECTOR}  {
                /* Use a minimal outline/border for a base */
                outline: 2px solid #0096ff !important;
                outline-offset: 2px; /* Push the outline slightly out */
                outline-radius: 15px;

                /* Start the animation */
                animation: revolving-glow-animation 5s ease-in-out infinite alternate;
                /* Use the box-shadow property to create the pulsating/revolving effect */
                box-shadow: 0 0 10px rgba(0, 150, 255, 0.8);
            }
        `;
        document.head.appendChild(style);
        console.log("[Tiling] CSS Injected.");

        // 2. Start the cell observation loop
        observeCells();
    }

    // Wait for the window load event to ensure all Colab JS has run
    window.addEventListener('load', initialize);

})();
