// ==UserScript==
// @name         LLM Conversation Exporter
// @namespace    http://tampermonkey.net/
// @version      1.2.1
// @description  Extracts the conversation using a failsafe text-search anchor.
// @author       SS, Gemini
// @match        https://gemini.google.com/*
// @match        https://chat.openai.com/*
// @match        https://chatgpt.com/*
// @downloadURL  https://raw.githubusercontent.com/sam-siddiqui/jerryscripts/refs/heads/master/LLMConversationExporter.user.js
// @updateURL    https://raw.githubusercontent.com/sam-siddiqui/jerryscripts/refs/heads/master/LLMConversationExporter.user.js
// @grant        GM_setValue
// @grant        GM_getValue
// ==/UserScript==

(function () {
  "use strict";

  // LLM Customizer
  // --- [CONFIGURATION] ---

  // 1. STATIC INSTRUCTIONS
  //    The permanent "System Prompt" describing who the AI is.
  const InstructionsPrefix = `[SYSTEM INSTRUCTION:`;
  const Suffix = `]`;
  const ContextPrefix = `[MEMORY / CONTEXT:`;
  const UserMessagePrefix = `[USER MESSAGE]:`;
  let SYSTEM_INSTRUCTIONS = `You are a helpful AI assistant.
Answer concisely and accurately.
  `;

  // 2. DYNAMIC CONTEXT
  let DYNAMIC_CONTEXT = ``;

  let systemInstructions = InstructionsPrefix + SYSTEM_INSTRUCTIONS + Suffix;
  let dynamicContext = ContextPrefix + DYNAMIC_CONTEXT + Suffix;

  // 3. INJECTION MODE
  let INJECTION_MODE = 'EVERY_MESSAGE'; // Options: 'EVERY_MESSAGE' | 'FIRST_MESSAGE_ONLY'

  // 4. LIMITS
  const MAX_INSTRUCTION_SIZE = 4096; // Reserve ~4k for instructions
  const HARD_CRASH_LIMIT = 36000;    // The server rejects payloads > ~36.6k

  // Internal State
  const ogSend = XMLHttpRequest.prototype.send;
  let shouldInject = true;
  const STORAGE_KEY_SYSTEM = 'gemini_custom_system';
  const instructions_input_id = 'ctx-system-input';
  const context_input_id = 'ctx-memory-input';
  const counter_input_id = 'ctx-usage-counter';
  const STORAGE_KEY_CONTEXT = 'gemini_custom_context';

  // --- [VALIDATION] ---
  const totalInstructionSize = systemInstructions.length + dynamicContext.length;
  if (totalInstructionSize > MAX_INSTRUCTION_SIZE) {
    console.error(`[ContextInjector] CONFIG ERROR: Instructions are too long! (${totalInstructionSize}/${MAX_INSTRUCTION_SIZE})`);
    shouldInject = false;
  } else {
    console.log(`[ContextInjector] Config Valid. Instructions size: ${totalInstructionSize} chars.`);
  }

  function createConfigurationModal(instructions_id, context_id, counter_id) {
    const container = document.createElement('div');

    // 1. Header
    const header = document.createElement('h2');
    header.textContent = 'Gemini Context Configuration';
    Object.assign(header.style, { margin: '0 0 10px 0', fontSize: '1.5rem' });
    container.appendChild(header);

    // 2. Static Instructions Section
    const staticDiv = document.createElement('div');
    const staticLabel = document.createElement('label');
    staticLabel.textContent = 'Static Instructions (Persona)';
    Object.assign(staticLabel.style, { display: 'block', marginBottom: '5px', fontWeight: 'bold', color: '#8ab4f8' });

    const staticTextarea = document.createElement('textarea');
    staticTextarea.id = instructions_id;
    staticTextarea.rows = 5;
    Object.assign(staticTextarea.style, {
      width: '100%', background: '#2b2d30', color: '#fff', border: '1px solid #444746',
      borderRadius: '6px', padding: '10px', resize: 'vertical', fontFamily: 'monospace'
    });

    staticDiv.append(staticLabel, staticTextarea);
    container.appendChild(staticDiv);

    // 3. Dynamic Context Section
    const dynamicDiv = document.createElement('div');
    const dynamicLabel = document.createElement('label');
    dynamicLabel.textContent = 'Dynamic Context (Memory)';
    Object.assign(dynamicLabel.style, { display: 'block', marginBottom: '5px', fontWeight: 'bold', color: '#8ab4f8' });

    const dynamicTextarea = document.createElement('textarea');
    dynamicTextarea.id = context_id;
    dynamicTextarea.rows = 5;
    Object.assign(dynamicTextarea.style, {
      width: '100%', background: '#2b2d30', color: '#fff', border: '1px solid #444746',
      borderRadius: '6px', padding: '10px', resize: 'vertical', fontFamily: 'monospace'
    });

    dynamicDiv.append(dynamicLabel, dynamicTextarea);
    container.appendChild(dynamicDiv);

    // 4. Counter Info
    const counterDiv = document.createElement('div');
    counterDiv.textContent = 'Context Usage: ';
    Object.assign(counterDiv.style, { fontSize: '0.85rem', color: '#c4c7c5' });

    const counterSpan = document.createElement('span');
    counterSpan.id = counter_id;
    counterSpan.textContent = '0';
    counterDiv.append(counterSpan, ' / 4000 chars (approx safe limit)');
    container.appendChild(counterDiv);

    // 5. Button Row
    const btnRow = document.createElement('div');
    Object.assign(btnRow.style, { display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '10px' });

    const cancelBtn = document.createElement('button');
    cancelBtn.id = 'ctx-cancel-btn';
    cancelBtn.textContent = 'Cancel';
    Object.assign(cancelBtn.style, { padding: '8px 16px', borderRadius: '18px', border: 'none', background: 'transparent', color: '#e3e3e3', cursor: 'pointer' });

    const saveBtn = document.createElement('button');
    saveBtn.id = 'ctx-save-btn';
    saveBtn.textContent = 'Save & Close';
    Object.assign(saveBtn.style, { padding: '8px 16px', borderRadius: '18px', border: 'none', background: '#8ab4f8', color: '#000', fontWeight: 'bold', cursor: 'pointer' });

    btnRow.append(cancelBtn, saveBtn);
    container.appendChild(btnRow);

    return container;
  }

  function toggleModal() {
    const modal = document.getElementById('gemini-ctx-modal');
    const isHidden = modal.style.display === 'none';
    if (isHidden) {
      // Load current values from Storage before showing
      document.getElementById('ctx-system-input').value = localStorage.getItem(STORAGE_KEY_SYSTEM) || SYSTEM_INSTRUCTIONS;
      document.getElementById('ctx-memory-input').value = localStorage.getItem(STORAGE_KEY_CONTEXT) || DYNAMIC_CONTEXT;
      // Trigger input event to update counter
      document.getElementById('ctx-system-input').dispatchEvent(new Event('input'));

      modal.style.display = 'block';
    } else {
      modal.style.display = 'none';
    }
  }

  function createUI() {
    // 1. Floating Trigger Button
    const btn = document.createElement('button');
    btn.innerText = "⚙️";
    btn.type = "button"
    btn.title = "Configure Gemini Context";
    Object.assign(btn.style, {
      position: 'fixed',
      top: '15px',
      right: '80px', // Left of the user profile usually
      zIndex: '9999',
      backgroundColor: '#1e1f20', // Gemini Dark Gray
      color: '#e3e3e3',
      border: '1px solid #444746',
      borderRadius: '50%',
      width: '40px',
      height: '40px',
      cursor: 'pointer',
      fontSize: '20px',
      boxShadow: '0 2px 5px rgba(0,0,0,0.3)'
    });

    btn.onmouseover = () => { btn.style.backgroundColor = '#333537'; }
    btn.onmouseout = () => { btn.style.backgroundColor = '#1e1f20'; }
    btn.onclick = () => { toggleModal() };

    document.body.appendChild(btn);

    // 2. The Modal Overlay
    const overlay = document.createElement('div');
    overlay.id = 'gemini-ctx-modal';
    Object.assign(overlay.style, {
      display: 'none',
      position: 'fixed',
      top: '0', left: '0', width: '100%', height: '100%',
      backgroundColor: 'rgba(0,0,0,0.6)',
      zIndex: '10000',
      justifyContent: 'center',
      alignItems: 'center',
      fontFamily: 'Google Sans, Roboto, sans-serif'
    });

    // 3. The Modal Content
    const modal = createConfigurationModal(instructions_input_id, context_input_id, counter_input_id);
    Object.assign(modal.style, {
      backgroundColor: '#1e1f20',
      color: '#e3e3e3',
      padding: '25px',
      borderRadius: '12px',
      width: '600px',
      maxWidth: '90%',
      boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
      display: 'flex',
      flexDirection: 'column',
      gap: '15px'
    });

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // --- Event Listeners ---
    document.getElementById('ctx-cancel-btn').onclick = toggleModal;
    document.getElementById('ctx-save-btn').onclick = saveSettings;

    // Live Character Count
    const sysInput = document.getElementById(instructions_input_id);
    const memInput = document.getElementById(context_input_id);
    const counter = document.getElementById(counter_input_id);

    function updateCount() {
      const total = (sysInput.value || "").length + (memInput.value || "").length;
      counter.innerText = total;
      counter.style.color = total > 4000 ? '#ff8bcb' : '#c4c7c5';
    }

    sysInput.oninput = updateCount;
    memInput.oninput = updateCount;
  }

  function saveSettings() {
    const sysVal = document.getElementById(instructions_input_id).value;
    const memVal = document.getElementById(context_input_id).value;

    localStorage.setItem(STORAGE_KEY_SYSTEM, sysVal);
    localStorage.setItem(STORAGE_KEY_CONTEXT, memVal);

    toggleModal();
    console.log("[ContextManager] Settings Saved.");
  }

  // --- [THE INTERCEPTOR] ---
  XMLHttpRequest.prototype.send = function (body) {
    if (
      shouldInject &&                                         // Check if we should inject based on mode
      window.location.hostname === 'gemini.google.com' &&     // Currently only supporting Gemini
      typeof body === 'string' &&                             // We only care about string bodies (POST requests)
      body.includes('f.req')                                  // that look like Gemini traffic ('f.req')
    ) {
      try {
        // --- STEP 1: DECODE ---
        let decodedBody = decodeURIComponent(body);
        let splitIndex = decodedBody.indexOf("]&") + 1;

        // Isolate the JSON part
        let requestPart = decodedBody.slice(0, splitIndex);
        let cleanJson = requestPart.startsWith('f.req=') ? requestPart.slice(6) : requestPart;

        // --- STEP 2: PARSE ---
        let outerArray = JSON.parse(cleanJson);
        // The payload is a stringified JSON inside index 1
        let innerData = JSON.parse(outerArray[1]);

        // --- STEP 3: MODIFY ---
        // Locate the user prompt (Standard location: innerData[0][0])
        if (Array.isArray(innerData) && innerData[0] && innerData[0][0]) {
          let originalUserMsg = innerData[0][0];

          // Prevent double-injection (e.g., if the browser retries the request)
          // We check for a unique signature from our instructions
          if (!originalUserMsg.includes(InstructionsPrefix)) {

            // Combine Components
            let currInstructions = InstructionsPrefix + ( localStorage.getItem(STORAGE_KEY_SYSTEM) || SYSTEM_INSTRUCTIONS ) + Suffix;
            let currContext = ContextPrefix + ( localStorage.getItem(STORAGE_KEY_CONTEXT) || DYNAMIC_CONTEXT ) + Suffix;
            let injectionPayload = `${currInstructions}\n${currContext}\n\n${UserMessagePrefix}\n`;
            let combinedLength = injectionPayload.length + originalUserMsg.length;

            // --- STEP 4: SAFETY CHECK & TRUNCATION ---
            let finalUserMsg = originalUserMsg;

            if (combinedLength > HARD_CRASH_LIMIT) {
              // Calculate remaining space for user
              let spaceForUser = HARD_CRASH_LIMIT - injectionPayload.length;

              if (spaceForUser < 100) {
                console.error("[ContextInjector] Critical: Instructions leave no room for user message.");
              } else {
                console.warn(`[ContextInjector] Message too large (${combinedLength}). Truncating user input to ${spaceForUser} chars.`);
                finalUserMsg = originalUserMsg.substring(0, spaceForUser) + "\n...[TRUNCATED]";
              }
            }

            // Apply the Injection
            innerData[0][0] = injectionPayload + finalUserMsg;

            // Update State
            if (INJECTION_MODE === 'FIRST_MESSAGE_ONLY') {
              shouldInject = false;
              console.log("[ContextInjector] First message injected. Disabling future injections.");
            } else {
              shouldInject = true;
              console.log("[ContextInjector] Injected context into current message.");
            }
          }
        }

        // --- STEP 5: RE-PACK ---
        outerArray[1] = JSON.stringify(innerData);
        let outerBody = JSON.stringify(outerArray);
        let encodedBody = encodeURIComponent(outerBody);

        // Re-assemble the full body string
        body = "f.req=" + encodedBody + decodedBody.slice(splitIndex);
      } catch (error) {
        // FAIL SAFE: 
        // This ensures the user's original message still goes through, just without context.
        console.error("[ContextInjector] Injection Failed (Sending Original):", error);
      }
    }

    // Pass the (possibly modified) body to the real XMLHttpRequest
    return ogSend.apply(this, [body]);
  };

  console.log(`[ContextInjector] Loaded. Mode: ${INJECTION_MODE}`);

  // --- Helper Function: Text Search ---
  /**
   * Searches the DOM for a visible element containing the given text.
   * @param {string} searchText - The text content to search for.
   * @returns {HTMLElement | null} The first matching element or null.
   */
  function findNodeByText(searchText) {
    console.log(`Searching the structure by given Text ${searchText}\n`);
    // Create a TreeWalker to traverse only visible text nodes
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node) => {
          // Filter out nodes that are empty or within hidden elements
          if (node.nodeValue.trim().length > 0) {
            return NodeFilter.FILTER_ACCEPT;
          }
          return NodeFilter.FILTER_REJECT;
        },
      },
      false
    );

    let node;
    while ((node = walker.nextNode())) {
      if (node.nodeValue.trim().includes(searchText.trim())) {
        // Return the element that contains the text node
        return node.parentElement;
      }
    }
    return null;
  }

  function getConversationContainers(turnSelector) {
    let turnContainers = document.querySelectorAll(turnSelector);

    // --- FAILSAVE LOGIC ---
    if (turnContainers.length === 0) {
      // Extract the first query from the conversation
      const initialQuery = prompt(
        "Could not find conversation using the default selector. Please paste the **exact, visible text** of your **very first query** in the conversation below:",
        ""
      );

      if (!initialQuery) {
        alert("Extraction cancelled.");
        return;
      }

      // Step 2: Find the element containing the text
      const anchorElement = findNodeByText(initialQuery);

      if (!anchorElement) {
        alert(
          "Could not find any element containing that text. Extraction failed."
        );
        return;
      }

      // Step 3: Heuristic: Find the closest common ancestor with role="listitem"
      // This is a common pattern for repeated items in a list.
      const newTurnContainer = anchorElement.closest('[role="listitem"]');

      if (!newTurnContainer) {
        alert(
          "Found the text, but couldn't determine the conversation block structure. Extraction failed."
        );
        return;
      }

      // If we found one, we assume all turns use the same parent pattern
      turnContainers =
        newTurnContainer.parentElement.querySelectorAll(turnSelector);
    }
    return turnContainers;
  }

  function formatMessageContent(text) {
    // Clean up extra whitespace
    let formatted = text.trim().replace(/\n{3,}/g, "\n\n");

    // Format code blocks
    formatted = formatted.replace(
      /```(\w+)?\n([\s\S]*?)\n```/g,
      (match, lang, code) => {
        return `\`\`\`${lang || ""}\n${code.trim()}\n\`\`\``;
      }
    );

    return formatted;
  }

  function formatConversationText(role, conversationText) {
    let textContent = formatMessageContent(conversationText);

    if (textContent) {
      // Use simple Markdown-like formatting for structure
      textContent = `**${role}:**\n${textContent}\n\n---\n\n`;
    } else {
      textContent = `**${role}:{Could not extract text}**\n\n---\n\n`;
    }
    return textContent;
  }

  function extractConversationText_Gemini(turnContainers) {
    let conversationText = "";

    // Step 2: Extract text from each turn
    turnContainers.forEach((container) => {
      // Find all direct children that hold message content (usually a div/component for user and one for model)
      const messages = container.querySelectorAll(
        "user-query, response-container"
      );

      const userMessage = container.querySelector("user-query");
      // Get the visible text content
      conversationText += formatConversationText(
        "👤 User",
        userMessage.innerText
      );

      const geminiResponse = container.querySelector("response-container");
      // Get the visible text content
      conversationText += formatConversationText(
        "🤖 Gemini",
        geminiResponse.innerText
      );
    });

    return conversationText;
  }

  // Function specific to the **ChatGPT** interface
  function extractConversationText_ChatGPT(turnContainers) {
    let conversationText = "";

    if (turnContainers.length === 0) {
      return ""; // Return empty string if no turns found
    }

    turnContainers.forEach((article) => {
      // The role is stored in the 'data-turn' attribute: 'user' or 'assistant'
      const role = article.getAttribute("data-turn");
      let roleName = "";
      let contentElement = null;

      if (role === "user") {
        roleName = "👤 ";
        // In ChatGPT, the user content is often directly within the article
        contentElement = article.textContent; // Or a general content container if markdown is unavailable
      } else if (role === "assistant") {
        roleName = "🤖 ";
        // Assistant response content is usually in a specific container
        // The actual class might change, but this is a common one:
        contentElement = article.textContent;
      }

      if (contentElement) {
        // Use innerText as you did before, but be aware of the need to clean up the content structure
        const text = contentElement;
        conversationText += formatConversationText(roleName, text);
      } else if (role) {
        // Fallback for turns where the text structure isn't as expected, but the role is known.
        const text = article.textContent;
        conversationText += formatConversationText(roleName, text);
      }
    });

    return conversationText;
  }

  function createFileContent(conversationText) {
    let content = `# Chat Conversation Export\n\n`;
    let currDate = new Date().toISOString().slice(0, 10);
    content += `**Date:** ${currDate}\n\n---\n\n`;
    content += conversationText;

    return content;
  }

  function createFileName() {
    let fileName;
    if (
      window.currConversationTopic &&
      window.currConversationTopic.trim() !== ""
    ) {
      fileName = window.currConversationTopic;
    } else {
      const userInput = prompt(
        "What is the conversation about? (This will be used for the filename)"
      );
      if (userInput) {
        // Clean the input by removing special characters and extra spaces
        fileName = userInput
          .trim()
          .replace(/[^a-zA-Z0-9\s-]/g, "") // Remove special characters except spaces and hyphens
          .replace(/\s+/g, " ") // Replace multiple spaces with single space
          .replace(/\s/g, "_"); // Replace spaces with underscores
        // Store for future use
        window.currConversationTopic = fileName;
      } else {
        // If user cancels the prompt, return an empty string for failure
        fileName = "";
      }
    }
    return fileName;
  }

  function getActiveExtractor(hostname) {
    switch (hostname) {
      case "gemini.google.com":
        return {
          extractor: extractConversationText_Gemini,
          turnSelector: GEMINI_TURN_SELECTOR,
        };
      case "chatgpt.com":
        return {
          extractor: extractConversationText_ChatGPT,
          turnSelector: CHATGPT_TURN_SELECTOR,
        };
      default:
        return {
          extractor: () => {
            alert("Unsupported site.");
            return "";
          },
          turnSelector: "",
        };
    }
  }

  // --- Main Extraction Function ---
  function extractAndDownload(conversationExtractor, turnSelector, extension) {
    // Step 1: Select all conversation turn containers.
    const turnContainers = getConversationContainers(turnSelector);

    if (turnContainers.length === 0) {
      alert(
        "The text search helped find a single turn, but the script couldn't select all turns based on the new structure. Extraction failed."
      );
      return;
    }

    alert(
      `Found ${turnContainers.length} conversation turns using the anchor element's structure! Proceeding with extraction.`
    );

    // Step 2: Extract text from each turn
    let conversationText = conversationExtractor(turnContainers);
    console.log(`Conversation extracted: ${conversationText}`);

    // if (conversationText.length < 50) {
    //   alert(
    //     "Extracted text is too short or empty. The selector might be wrong, or the conversation wasn't loaded."
    //   );
    //   return;
    // }

    // Step 3: Add any needed filler
    let mdContent = createFileContent(conversationText);
    console.log("File content created.");

    // Step 4: Download the file as a .md

    let filename = createFileName();
    filename += extension;
    if (!filename) {
      alert("Topic is required. Extraction cancelled.");
      return;
    }
    let element = document.createElement("a");
    element.setAttribute(
      "href",
      "data:text/markdown;charset=utf-8," + encodeURIComponent(mdContent)
    );
    element.setAttribute("download", filename);
    console.log("File created.");
    console.log("Filename: " + filename);

    // Simulate a click to trigger the download
    element.style.display = "none";
    document.body.appendChild(element);
    element.click();
    document.body.removeChild(element);

    alert(
      `Conversation exported successfully to ${filename}! Open with any text editor to view.`
    );
  }

  // Calculate turns based on platform
  function calculateTurnCount(selector) {
    const containers = document.querySelectorAll(selector);
    if (!containers.length) return 0;

    // For ChatGPT, each container is one turn
    if (
      window.location.hostname.includes("chatgpt.com") ||
      window.location.hostname.includes("chat.openai.com")
    ) {
      return containers.length;
    }
    // For Gemini, each container has both user and model response
    return containers.length * 2;
  }

  // --- Safety Guard ---
  function activateSafetyGuard(turnSelector) {
    const turnCount = calculateTurnCount(turnSelector);

    if (turnCount >= MIN_TURNS_FOR_GUARD) {
      console.log(
        `Conversation has ${turnCount} turns. Activating Safety Guard.`
      );

      // 1. Before Unload Confirmation
      const handleBeforeUnload = function (e) {
        const message = `WARNING! This ${turnCount}-turn conversation is long. Are you sure you want to leave?`;
        e.preventDefault();
        e.returnValue = message; // Standard for most browsers
        return message; // For some older browsers
      };

      // 2. Keyboard Shortcut Prevention
      const handleKeyDown = function (e) {
        if (!e.ctrlKey) return;

        if (e.key === "r" || e.key === "R" || e.keyCode === 82) {
          // Ctrl+R
          if (
            confirm(
              `Reload this page? You have a ${turnCount}-turn conversation that will be lost.`
            )
          ) {
            window.removeEventListener("beforeunload", handleBeforeUnload);
            window.location.reload();
          }
          e.preventDefault();
          e.stopPropagation();
        } else if (e.key === "w" || e.key === "W" || e.keyCode === 87) {
          // Ctrl+W
          if (
            confirm(
              `Close this tab? You have a ${turnCount}-turn conversation that will be lost.`
            )
          ) {
            window.removeEventListener("beforeunload", handleBeforeUnload);
            window.close();
          }
          e.preventDefault();
          e.stopPropagation();
        }
      };

      // Add event listeners
      window.addEventListener("beforeunload", handleBeforeUnload);
      document.addEventListener("keydown", handleKeyDown, true);

      // Return cleanup function in case you want to remove the guard later
      return () => {
        window.removeEventListener("beforeunload", handleBeforeUnload);
        document.removeEventListener("keydown", handleKeyDown, true);
      };
    }
    return () => { }; // No-op cleanup function
  }

  // --- Script Initialization ---
  let currConversationTopic = "";
  let hasCheckedForConversation = false;
  let addedButtonContainer = false;
  let extension = ".md";
  const MIN_TURNS_FOR_GUARD = 20;
  const GEMINI_TURN_SELECTOR = ".conversation-container";
  const CHATGPT_TURN_SELECTOR = 'article[data-testid^="conversation-turn-"]';
  // At the top level, get the extractor and selector
  const { extractor, turnSelector } = getActiveExtractor(
    window.location.hostname
  );

  // Initialize the safety guard
  let cleanupSafetyGuard = () => { };

  // Create a button to trigger the export
  const exportButton = document.createElement("button");
  exportButton.innerText = `Export Conversation (${extension})`;
  exportButton.style.cssText = `
        z-index: 9999;
        padding: 8px 12px;
        background-color: #4285F4;
        color: white;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        font-weight: bold;
        box-shadow: 0 2px 4px rgba(0,0,0,0.2);
    `;
  exportButton.onclick = () =>
    extractAndDownload(extractor, turnSelector, extension);

  // Create a button to trigger the import
  const importButton = document.createElement("button");
  importButton.innerText = `Import Conversation (${extension})`;
  importButton.style.cssText = `
        padding: 8px 12px;
        background-color: #4285F4;
        color: white;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        font-weight: bold;
        box-shadow: 0 2px 4px rgba(0,0,0,0.2);
    `;
  importButton.onclick = () => {
    alert("Import not implemented yet.");
  };

  const buttonsContainer = document.createElement("div");
  // buttonsContainer.appendChild(exportButton);
  buttonsContainer.appendChild(importButton);
  buttonsContainer.style.cssText = `
    position: fixed;
    right: 40%;
    top: 10px;
    z-index: 9999;
  `;

  const swapButtons = () => {
    buttonsContainer.removeChild(importButton);
    buttonsContainer.appendChild(exportButton);
  };

  function setupConversationObserver(turnSelector) {
    // Capture the conversation container
    const conversationContainer =
      document.querySelector(turnSelector)?.parentElement;
    if (!conversationContainer) {
      return false;
    }

    // Attach the conversationObserver to check when new messages are added
    console.log("Found Conversation Container");
    new MutationObserver(() => {
      // Activate the safety guard if needed
      console.log("Checking safety guard");
      cleanupSafetyGuard =
        activateSafetyGuard(turnSelector) || cleanupSafetyGuard;

      // Only check and swap once
      if (!hasCheckedForConversation) {
        const turnCount = calculateTurnCount(turnSelector);
        if (turnCount > 0) {
          hasCheckedForConversation = true;
          swapButtons();
        }
      }
    }).observe(conversationContainer, { childList: true, subtree: true });

    return true;
  }

  // Wait for the body to be available
  new MutationObserver((mutations, observer) => {
    if (document.body) {
      if (!addedButtonContainer) {
        document.body.appendChild(buttonsContainer);
        addedButtonContainer = true;
        // Initialize UI on load
        createUI();
      }

      // Try to set up conversation observer
      if (setupConversationObserver(turnSelector)) {
        observer.disconnect(); // Stop observing once we're set up
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
