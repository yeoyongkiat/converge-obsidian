import { App, Plugin, PluginSettingTab, Setting, ItemView, WorkspaceLeaf, TFile, Notice, MarkdownRenderer } from "obsidian";

// ============================================================================
// TYPES
// ============================================================================

interface ConvergeSettings {
  apiEndpoint: string;
  apiKey: string;
  modelName: string;
  userName: string;
  systemPrompt: string;
  maxTokens: number;
  exportFolder: string;
}

interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

const DEFAULT_SETTINGS: ConvergeSettings = {
  apiEndpoint: "https://api.openai.com/v1/chat/completions",
  apiKey: "",
  modelName: "gpt-4o-mini",
  userName: "",
  systemPrompt: "You are a friendly and helpful assistant. Be warm and personable in your responses while remaining professional. Address the user by name when appropriate. Answer questions based on the provided context from the user's notes, and feel free to offer additional insights or suggestions that might be helpful.",
  maxTokens: 100000,
  exportFolder: "Converge Chats",
};

// Estimate tokens (~4 chars per token for English)
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const VIEW_TYPE_CHAT = "converge-chat-view";

// ============================================================================
// MAIN PLUGIN
// ============================================================================

export default class ConvergePlugin extends Plugin {
  settings: ConvergeSettings;

  async onload() {
    await this.loadSettings();

    this.registerView(VIEW_TYPE_CHAT, (leaf) => new ChatView(leaf, this));

    this.addRibbonIcon("message-circle", "Open Converge Chat", () => {
      this.activateChatView();
    });

    this.addCommand({
      id: "open-chat",
      name: "Open chat panel",
      callback: () => this.activateChatView(),
    });

    this.addSettingTab(new ConvergeSettingTab(this.app, this));
  }

  async activateChatView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_CHAT)[0];

    if (!leaf) {
      const rightLeaf = workspace.getRightLeaf(false);
      if (rightLeaf) {
        leaf = rightLeaf;
        await leaf.setViewState({ type: VIEW_TYPE_CHAT, active: true });
      }
    }

    if (leaf) {
      workspace.revealLeaf(leaf);
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

// ============================================================================
// CHAT VIEW
// ============================================================================

class ChatView extends ItemView {
  plugin: ConvergePlugin;
  messages: ChatMessage[] = [];
  contextNotes: TFile[] = [];
  chatContainer: HTMLElement;
  inputEl: HTMLTextAreaElement;
  contextList: HTMLElement;
  sendBtn: HTMLButtonElement;
  tokenDisplay: HTMLElement;
  isLoading: boolean = false;

  constructor(leaf: WorkspaceLeaf, plugin: ConvergePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_CHAT;
  }

  getDisplayText(): string {
    return "Converge Chat";
  }

  getIcon(): string {
    return "message-circle";
  }

  async onOpen() {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("converge-container");

    // Chat messages container (top, takes remaining space)
    this.chatContainer = container.createDiv({ cls: "converge-chat-container" });

    // Bottom section (context + input)
    const bottomSection = container.createDiv({ cls: "converge-bottom-section" });

    // Context section (drop zone for notes) - just above input
    const contextSection = bottomSection.createDiv({ cls: "converge-context-section" });
    contextSection.createEl("div", { text: "Context Notes", cls: "converge-section-title" });
    this.contextList = contextSection.createDiv({ cls: "converge-context-list" });
    this.contextList.createEl("div", { text: "Drag notes here to add context", cls: "converge-drop-hint" });

    // Set up drop zone
    this.setupDropZone(contextSection);

    // Input section
    const inputSection = bottomSection.createDiv({ cls: "converge-input-section" });
    this.inputEl = inputSection.createEl("textarea", {
      cls: "converge-input",
      attr: { placeholder: "Type your message...", rows: "3" },
    });

    const buttonRow = inputSection.createDiv({ cls: "converge-button-row" });
    this.tokenDisplay = buttonRow.createEl("span", { cls: "converge-token-display" });
    const buttonGroup = buttonRow.createDiv({ cls: "converge-button-group" });
    const exportBtn = buttonGroup.createEl("button", { text: "Export", cls: "converge-export-btn" });
    const clearBtn = buttonGroup.createEl("button", { text: "Clear", cls: "converge-clear-btn" });
    this.sendBtn = buttonGroup.createEl("button", { text: "Send", cls: "converge-send-btn" });

    this.sendBtn.onclick = () => this.sendMessage();
    clearBtn.onclick = () => this.clearChat();
    exportBtn.onclick = () => this.exportChat();

    this.inputEl.onkeydown = (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        this.sendMessage();
      }
    };

    // Render initial state (shows welcome message)
    this.renderMessages();
  }

  setupDropZone(dropZone: HTMLElement) {
    dropZone.ondragover = (e) => {
      e.preventDefault();
      dropZone.addClass("converge-drag-over");
    };

    dropZone.ondragleave = () => {
      dropZone.removeClass("converge-drag-over");
    };

    dropZone.ondrop = async (e) => {
      e.preventDefault();
      dropZone.removeClass("converge-drag-over");

      let filePath = e.dataTransfer?.getData("text/plain");

      // Obsidian passes obsidian:// URLs - extract the file path
      if (filePath && filePath.startsWith("obsidian://")) {
        try {
          const url = new URL(filePath);
          const fileParam = url.searchParams.get("file");
          if (fileParam) {
            // URL decode the path (e.g., %2F -> /, %20 -> space)
            filePath = decodeURIComponent(fileParam);
          }
        } catch (err) {
          console.error("Failed to parse obsidian URL:", err);
        }
      }

      // Add .md extension if missing (Obsidian URLs often omit it)
      if (filePath && !filePath.endsWith(".md")) {
        filePath = filePath + ".md";
      }

      if (!filePath) {
        new Notice("Could not get file path from drop.");
        return;
      }

      const file = this.app.vault.getAbstractFileByPath(filePath);

      if (file instanceof TFile && file.extension === "md") {
        if (!this.contextNotes.find((f) => f.path === file.path)) {
          this.contextNotes.push(file);
          this.renderContextList();
          new Notice(`Added: ${file.basename}`);
        }
      } else {
        new Notice(`File not found: ${filePath}`);
      }
    };
  }

  renderContextList() {
    this.contextList.empty();

    if (this.contextNotes.length === 0) {
      this.contextList.createEl("div", { text: "Drag notes here to add context", cls: "converge-drop-hint" });
      this.updateTokenDisplay();
      return;
    }

    for (const file of this.contextNotes) {
      const item = this.contextList.createDiv({ cls: "converge-context-item" });
      item.createEl("span", { text: file.basename, cls: "converge-context-name" });
      const removeBtn = item.createEl("span", { text: "×", cls: "converge-context-remove" });
      removeBtn.onclick = () => {
        this.contextNotes = this.contextNotes.filter((f) => f.path !== file.path);
        this.renderContextList();
      };
    }
    this.updateTokenDisplay();
  }

  async sendMessage() {
    const userInput = this.inputEl.value.trim();
    if (!userInput || this.isLoading) return;

    if (!this.plugin.settings.apiKey) {
      new Notice("Please configure your API key in settings");
      return;
    }

    // Set loading state
    this.isLoading = true;
    this.setLoadingState(true);

    // Add user message
    this.messages.push({ role: "user", content: userInput });
    this.renderMessages();
    this.inputEl.value = "";

    // Build context from notes
    let contextText = "";
    for (const file of this.contextNotes) {
      const content = await this.app.vault.cachedRead(file);
      contextText += `\n\n--- ${file.basename} ---\n${content}`;
    }

    // Build messages array for API
    const apiMessages: ChatMessage[] = [];

    // System prompt with context and user name
    let systemContent = this.plugin.settings.systemPrompt;
    const userName = this.plugin.settings.userName;
    if (userName) {
      systemContent += `\n\nThe user's name is ${userName}.`;
    }
    if (contextText) {
      systemContent += `\n\nContext from user's notes:${contextText}`;
    }
    apiMessages.push({ role: "system", content: systemContent });

    // Add conversation history
    apiMessages.push(...this.messages);

    // Call API
    try {
      const response = await this.callLLM(apiMessages);
      this.messages.push({ role: "assistant", content: response });
    } catch (error) {
      new Notice(`Error: ${error.message}`);
      this.messages.pop(); // Remove failed user message
    } finally {
      this.isLoading = false;
      this.setLoadingState(false);
      this.renderMessages();
    }
  }

  setLoadingState(loading: boolean) {
    this.sendBtn.disabled = loading;
    this.inputEl.disabled = loading;
    this.sendBtn.setText(loading ? "Sending..." : "Send");

    if (loading) {
      this.sendBtn.addClass("converge-loading");
    } else {
      this.sendBtn.removeClass("converge-loading");
    }
  }

  async callLLM(messages: ChatMessage[]): Promise<string> {
    const { apiEndpoint, apiKey, modelName } = this.plugin.settings;

    console.log("=== API Request Debug ===");
    console.log("Endpoint:", apiEndpoint);
    console.log("Model:", modelName);
    console.log("API Key (first 10 chars):", apiKey.substring(0, 10) + "...");

    const response = await fetch(apiEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "HTTP-Referer": "https://github.com/converge-obsidian",
        "X-Title": "Converge Obsidian Plugin",
      },
      body: JSON.stringify({
        model: modelName,
        messages: messages,
        stream: false,
      }),
    });

    console.log("Response status:", response.status);
    console.log("Response headers:", Object.fromEntries(response.headers.entries()));

    const responseText = await response.text();
    console.log("Response body (first 500 chars):", responseText.substring(0, 500));

    if (!response.ok) {
      console.error("API error response:", responseText);
      throw new Error(`API error ${response.status}: ${responseText.substring(0, 200)}`);
    }

    try {
      const data = JSON.parse(responseText);
      return data.choices[0].message.content;
    } catch (parseError) {
      console.error("Failed to parse response:", responseText);
      throw new Error(`Invalid JSON response: ${responseText.substring(0, 100)}`);
    }
  }

  renderMessages() {
    this.chatContainer.empty();

    // Show empty state with logo when no messages
    if (this.messages.length === 0 && !this.isLoading) {
      const emptyState = this.chatContainer.createDiv({ cls: "converge-empty-state" });
      const userName = this.plugin.settings.userName;
      const greeting = userName ? `Hi ${userName}!` : "Welcome!";

      emptyState.innerHTML = `
        <svg class="converge-logo" viewBox="0 0 1005 277" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M832 101L882.555 146.708C886.056 149.521 891.889 153.037 898.889 153.388C915.692 153.388 931.296 153.505 937 153.388M937 153.388L908.611 127.018M937 153.388L908.611 178" stroke="currentColor" stroke-width="18" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M167.655 163.792C169.112 163.792 170.336 164.317 171.327 165.366L181.729 176.468C176.601 182.995 170.219 187.948 162.585 191.328C155.009 194.709 145.976 196.399 135.486 196.399C125.986 196.399 117.449 194.796 109.873 191.591C102.297 188.327 95.8568 183.811 90.5535 178.041C85.2502 172.272 81.1708 165.424 78.3152 157.498C75.4596 149.572 74.0318 140.918 74.0318 131.535C74.0318 125.241 74.702 119.268 76.0423 113.615C77.441 107.904 79.4516 102.659 82.0741 97.88C84.6966 93.1012 87.8436 88.7886 91.5151 84.9423C95.2449 81.096 99.4409 77.8324 104.103 75.1516C108.765 72.4126 113.836 70.3437 119.314 68.945C124.85 67.4881 130.736 66.7596 136.972 66.7596C141.634 66.7596 146.034 67.1676 150.172 67.9835C154.368 68.7994 158.272 69.9358 161.886 71.3927C165.499 72.8497 168.821 74.6271 171.851 76.7251C174.94 78.7649 177.708 81.0086 180.156 83.4562L171.327 95.5197C170.802 96.2774 170.132 96.9475 169.316 97.5303C168.5 98.1131 167.393 98.4045 165.994 98.4045C164.596 98.4045 163.168 97.9091 161.711 96.9184C160.312 95.9277 158.564 94.8204 156.466 93.5966C154.426 92.3727 151.833 91.2655 148.686 90.2747C145.597 89.284 141.663 88.7886 136.884 88.7886C131.581 88.7886 126.715 89.7502 122.286 91.6734C117.857 93.5966 114.039 96.3939 110.834 100.065C107.687 103.679 105.24 108.137 103.491 113.44C101.743 118.743 100.869 124.775 100.869 131.535C100.869 138.354 101.801 144.444 103.666 149.806C105.589 155.109 108.183 159.596 111.446 163.268C114.768 166.939 118.614 169.737 122.985 171.66C127.414 173.525 132.135 174.457 137.147 174.457C140.119 174.457 142.8 174.311 145.189 174.02C147.637 173.729 149.88 173.233 151.92 172.534C154.018 171.835 155.97 170.931 157.777 169.824C159.642 168.717 161.507 167.318 163.372 165.628C164.013 165.103 164.683 164.666 165.382 164.317C166.082 163.967 166.839 163.792 167.655 163.792ZM231.983 103.475C238.743 103.475 244.891 104.553 250.428 106.709C255.964 108.865 260.714 111.954 264.677 115.975C268.64 119.938 271.699 124.775 273.856 130.486C276.012 136.198 277.09 142.637 277.09 149.806C277.09 156.974 276.012 163.443 273.856 169.212C271.699 174.923 268.64 179.789 264.677 183.811C260.714 187.832 255.964 190.921 250.428 193.077C244.891 195.233 238.743 196.311 231.983 196.311C225.164 196.311 218.958 195.233 213.363 193.077C207.827 190.921 203.077 187.832 199.114 183.811C195.151 179.789 192.063 174.923 189.848 169.212C187.692 163.443 186.614 156.974 186.614 149.806C186.614 142.637 187.692 136.198 189.848 130.486C192.063 124.775 195.151 119.938 199.114 115.975C203.077 111.954 207.827 108.865 213.363 106.709C218.958 104.553 225.164 103.475 231.983 103.475ZM231.983 178.216C238.86 178.216 243.959 175.856 247.281 171.135C250.603 166.356 252.264 159.276 252.264 149.893C252.264 140.569 250.603 133.546 247.281 128.826C243.959 124.047 238.86 121.657 231.983 121.657C224.931 121.657 219.745 124.047 216.423 128.826C213.101 133.546 211.44 140.569 211.44 149.893C211.44 159.276 213.101 166.356 216.423 171.135C219.745 175.856 224.931 178.216 231.983 178.216ZM314.618 115.363C316.424 113.615 318.289 112.012 320.212 110.555C322.194 109.098 324.263 107.845 326.419 106.796C328.633 105.747 330.994 104.932 333.5 104.349C336.064 103.766 338.832 103.475 341.804 103.475C346.7 103.475 351.041 104.32 354.829 106.01C358.617 107.7 361.794 110.06 364.358 113.091C366.98 116.121 368.933 119.734 370.215 123.93C371.555 128.126 372.225 132.73 372.225 137.742V195H348.186V137.742C348.186 132.73 347.02 128.855 344.689 126.116C342.358 123.318 338.92 121.92 334.374 121.92C330.994 121.92 327.818 122.648 324.845 124.105C321.873 125.562 319.047 127.602 316.366 130.224V195H292.239V104.873H307.1C310.13 104.873 312.141 106.272 313.132 109.069L314.618 115.363ZM472.346 104.873L436.942 195H415.088L379.684 104.873H399.703C401.451 104.873 402.908 105.281 404.074 106.097C405.239 106.913 406.055 107.962 406.521 109.244L421.644 153.827C422.635 156.857 423.509 159.829 424.267 162.743C425.025 165.599 425.695 168.484 426.278 171.397C426.919 168.484 427.618 165.599 428.376 162.743C429.191 159.829 430.124 156.857 431.173 153.827L446.82 109.244C447.228 107.962 448.015 106.913 449.181 106.097C450.346 105.281 451.716 104.873 453.289 104.873H472.346ZM536.877 139.316C536.877 136.81 536.528 134.42 535.828 132.147C535.187 129.875 534.138 127.864 532.681 126.116C531.225 124.367 529.389 122.998 527.174 122.007C524.96 120.958 522.308 120.434 519.219 120.434C513.45 120.434 508.933 122.065 505.67 125.329C502.406 128.592 500.279 133.255 499.288 139.316H536.877ZM498.939 153.652C499.696 162.102 502.086 168.28 506.107 172.184C510.186 176.089 515.49 178.041 522.017 178.041C525.338 178.041 528.194 177.662 530.583 176.905C533.031 176.089 535.158 175.215 536.965 174.282C538.83 173.292 540.491 172.417 541.948 171.66C543.463 170.844 544.949 170.436 546.406 170.436C548.271 170.436 549.728 171.135 550.777 172.534L557.77 181.276C555.206 184.248 552.379 186.725 549.291 188.706C546.202 190.629 542.997 192.174 539.675 193.339C536.353 194.446 533.002 195.204 529.622 195.612C526.242 196.078 522.978 196.311 519.831 196.311C513.537 196.311 507.651 195.291 502.173 193.252C496.753 191.154 492.004 188.094 487.924 184.073C483.903 179.993 480.727 174.952 478.396 168.95C476.065 162.947 474.899 155.983 474.899 148.057C474.899 141.938 475.89 136.169 477.871 130.749C479.911 125.329 482.825 120.608 486.613 116.587C490.401 112.566 495.005 109.39 500.425 107.059C505.845 104.669 511.964 103.475 518.782 103.475C524.552 103.475 529.855 104.407 534.692 106.272C539.587 108.079 543.783 110.73 547.28 114.227C550.835 117.724 553.574 122.036 555.497 127.165C557.479 132.235 558.469 138.033 558.469 144.561C558.469 146.367 558.382 147.853 558.207 149.019C558.032 150.184 557.741 151.117 557.333 151.816C556.925 152.515 556.371 153.011 555.672 153.302C554.973 153.535 554.069 153.652 552.962 153.652H498.939ZM596.082 119.734C598.937 114.606 602.23 110.555 605.96 107.583C609.69 104.611 614.061 103.125 619.072 103.125C623.152 103.125 626.474 104.087 629.038 106.01L627.464 123.843C627.173 125.008 626.707 125.824 626.066 126.29C625.483 126.698 624.667 126.902 623.618 126.902C622.686 126.902 621.345 126.786 619.597 126.553C617.849 126.261 616.217 126.116 614.702 126.116C612.487 126.116 610.506 126.436 608.757 127.077C607.067 127.718 605.552 128.622 604.212 129.787C602.871 130.953 601.647 132.38 600.54 134.071C599.491 135.761 598.5 137.684 597.568 139.84V195H573.441V104.873H587.69C590.138 104.873 591.828 105.31 592.76 106.185C593.692 107.059 594.363 108.574 594.771 110.73L596.082 119.734ZM672.401 146.571C677.354 146.571 680.997 145.318 683.328 142.812C685.717 140.306 686.912 137.072 686.912 133.109C686.912 128.971 685.717 125.737 683.328 123.406C680.997 121.016 677.354 119.822 672.401 119.822C667.447 119.822 663.805 121.016 661.474 123.406C659.143 125.737 657.977 128.971 657.977 133.109C657.977 137.014 659.143 140.248 661.474 142.812C663.863 145.318 667.505 146.571 672.401 146.571ZM695.217 198.672C695.217 197.098 694.721 195.816 693.73 194.825C692.74 193.834 691.399 193.048 689.709 192.465C688.077 191.882 686.125 191.474 683.852 191.241C681.579 190.95 679.161 190.746 676.597 190.629C674.033 190.454 671.381 190.309 668.642 190.192C665.903 190.076 663.222 189.872 660.599 189.58C658.56 190.804 656.87 192.261 655.529 193.951C654.247 195.583 653.606 197.448 653.606 199.546C653.606 201.003 653.927 202.343 654.568 203.567C655.267 204.791 656.403 205.84 657.977 206.714C659.55 207.588 661.619 208.258 664.184 208.724C666.748 209.249 669.953 209.511 673.799 209.511C677.762 209.511 681.113 209.249 683.852 208.724C686.591 208.2 688.806 207.442 690.496 206.452C692.186 205.519 693.381 204.383 694.08 203.042C694.838 201.702 695.217 200.245 695.217 198.672ZM719.169 107.845V116.675C719.169 118.073 718.761 119.181 717.945 119.996C717.187 120.812 715.905 121.424 714.099 121.832L706.756 123.318C707.746 126.174 708.242 129.233 708.242 132.497C708.242 136.984 707.309 141.035 705.444 144.648C703.638 148.203 701.132 151.262 697.926 153.827C694.721 156.333 690.933 158.285 686.562 159.684C682.191 161.024 677.471 161.694 672.401 161.694C669.195 161.694 666.194 161.432 663.397 160.907C660.949 162.423 659.725 164.084 659.725 165.89C659.725 167.58 660.541 168.804 662.173 169.562C663.863 170.319 666.048 170.873 668.729 171.223C671.468 171.514 674.557 171.718 677.995 171.835C681.492 171.893 685.018 172.068 688.573 172.359C692.186 172.65 695.712 173.175 699.15 173.933C702.647 174.632 705.736 175.827 708.416 177.517C711.155 179.148 713.341 181.334 714.973 184.073C716.663 186.812 717.508 190.338 717.508 194.65C717.508 198.672 716.517 202.576 714.536 206.364C712.554 210.152 709.669 213.532 705.881 216.505C702.152 219.477 697.548 221.866 692.07 223.673C686.591 225.479 680.356 226.383 673.362 226.383C666.427 226.383 660.395 225.712 655.267 224.372C650.197 223.09 645.972 221.342 642.592 219.127C639.27 216.971 636.793 214.465 635.161 211.609C633.529 208.754 632.714 205.781 632.714 202.693C632.714 198.672 633.937 195.262 636.385 192.465C638.833 189.668 642.213 187.424 646.525 185.734C644.253 184.452 642.417 182.791 641.018 180.751C639.678 178.653 639.008 175.943 639.008 172.621C639.008 169.941 639.969 167.114 641.892 164.142C643.874 161.17 646.904 158.693 650.984 156.711C646.38 154.264 642.737 151 640.057 146.921C637.376 142.783 636.035 137.975 636.035 132.497C636.035 128.01 636.939 123.959 638.745 120.346C640.61 116.733 643.174 113.673 646.438 111.167C649.702 108.603 653.548 106.651 657.977 105.31C662.406 103.97 667.214 103.3 672.401 103.3C680.093 103.3 686.883 104.815 692.769 107.845H719.169ZM787.176 139.316C787.176 136.81 786.827 134.42 786.127 132.147C785.486 129.875 784.437 127.864 782.98 126.116C781.523 124.367 779.688 122.998 777.473 122.007C775.258 120.958 772.607 120.434 769.518 120.434C763.749 120.434 759.232 122.065 755.968 125.329C752.705 128.592 750.578 133.255 749.587 139.316H787.176ZM749.237 153.652C749.995 162.102 752.384 168.28 756.406 172.184C760.485 176.089 765.788 178.041 772.315 178.041C775.637 178.041 778.493 177.662 780.882 176.905C783.33 176.089 785.457 175.215 787.264 174.282C789.129 173.292 790.789 172.417 792.246 171.66C793.762 170.844 795.248 170.436 796.705 170.436C798.57 170.436 800.026 171.135 801.075 172.534L808.069 181.276C805.505 184.248 802.678 186.725 799.589 188.706C796.501 190.629 793.295 192.174 789.974 193.339C786.652 194.446 783.301 195.204 779.921 195.612C776.541 196.078 773.277 196.311 770.13 196.311C763.836 196.311 757.95 195.291 752.472 193.252C747.052 191.154 742.302 188.094 738.223 184.073C734.202 179.993 731.026 174.952 728.694 168.95C726.363 162.947 725.198 155.983 725.198 148.057C725.198 141.938 726.188 136.169 728.17 130.749C730.21 125.329 733.124 120.608 736.912 116.587C740.7 112.566 745.304 109.39 750.723 107.059C756.143 104.669 762.262 103.475 769.081 103.475C774.85 103.475 780.154 104.407 784.991 106.272C789.886 108.079 794.082 110.73 797.579 114.227C801.134 117.724 803.873 122.036 805.796 127.165C807.777 132.235 808.768 138.033 808.768 144.561C808.768 146.367 808.681 147.853 808.506 149.019C808.331 150.184 808.04 151.117 807.632 151.816C807.224 152.515 806.67 153.011 805.971 153.302C805.271 153.535 804.368 153.652 803.261 153.652H749.237Z" fill="currentColor"/>
          <line x1="832.388" y1="192.235" x2="860.66" y2="163.963" stroke="currentColor" stroke-width="18" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <span class="converge-version">v1.0</span>
        <p class="converge-greeting">${greeting}</p>
        <p class="converge-empty-hint">Drag notes to add context, then start chatting.</p>
      `;
      return;
    }

    for (const msg of this.messages) {
      const msgEl = this.chatContainer.createDiv({
        cls: `converge-message converge-message-${msg.role}`,
      });

      const contentEl = msgEl.createDiv({ cls: "converge-message-content" });

      // Render markdown for assistant messages
      if (msg.role === "assistant") {
        MarkdownRenderer.render(this.app, msg.content, contentEl, "", this.plugin);
      } else {
        contentEl.setText(msg.content);
      }
    }

    // Show loading indicator
    if (this.isLoading) {
      const loadingEl = this.chatContainer.createDiv({
        cls: "converge-message converge-message-assistant converge-loading-message",
      });
      const dotsEl = loadingEl.createDiv({ cls: "converge-loading-dots" });
      dotsEl.createSpan({ cls: "converge-dot" });
      dotsEl.createSpan({ cls: "converge-dot" });
      dotsEl.createSpan({ cls: "converge-dot" });
    }

    // Scroll to bottom
    this.chatContainer.scrollTop = this.chatContainer.scrollHeight;

    // Update token counter
    this.updateTokenDisplay();
  }

  async updateTokenDisplay() {
    // Calculate tokens from messages
    let totalText = this.plugin.settings.systemPrompt;
    if (this.plugin.settings.userName) {
      totalText += `\n\nThe user's name is ${this.plugin.settings.userName}.`;
    }

    // Add context notes
    for (const file of this.contextNotes) {
      const content = await this.app.vault.cachedRead(file);
      totalText += `\n\n--- ${file.basename} ---\n${content}`;
    }

    // Add messages
    for (const msg of this.messages) {
      totalText += msg.content;
    }

    const tokens = estimateTokens(totalText);
    const maxTokens = this.plugin.settings.maxTokens;
    const percentage = (tokens / maxTokens) * 100;

    // Format display
    const tokensFormatted = tokens.toLocaleString();
    const maxFormatted = maxTokens.toLocaleString();
    this.tokenDisplay.setText(`~${tokensFormatted} / ${maxFormatted} tokens`);

    // Color based on usage
    this.tokenDisplay.removeClass("converge-tokens-warning", "converge-tokens-danger");
    if (percentage >= 95) {
      this.tokenDisplay.addClass("converge-tokens-danger");
    } else if (percentage >= 80) {
      this.tokenDisplay.addClass("converge-tokens-warning");
    }
  }

  async exportChat() {
    if (this.messages.length === 0) {
      new Notice("No messages to export");
      return;
    }

    // Build markdown content
    const timestamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
    const fileName = `chat-${timestamp}.md`;
    const folderPath = this.plugin.settings.exportFolder;

    let content = `# Converge Chat Export\n\n`;
    content += `**Exported:** ${new Date().toLocaleString()}\n\n`;

    if (this.contextNotes.length > 0) {
      content += `**Context Notes:** ${this.contextNotes.map(f => f.basename).join(", ")}\n\n`;
    }

    content += `---\n\n`;

    for (const msg of this.messages) {
      const role = msg.role === "user" ? "**You**" : "**Converge**";
      content += `${role}:\n\n${msg.content}\n\n---\n\n`;
    }

    // Ensure folder exists
    const folder = this.app.vault.getAbstractFileByPath(folderPath);
    if (!folder) {
      await this.app.vault.createFolder(folderPath);
    }

    // Create file
    const filePath = `${folderPath}/${fileName}`;
    await this.app.vault.create(filePath, content);
    new Notice(`Chat exported to ${filePath}`);
  }

  clearChat() {
    this.messages = [];
    this.renderMessages();
  }

  async onClose() {
    // Cleanup if needed
  }
}

// ============================================================================
// SETTINGS TAB
// ============================================================================

class ConvergeSettingTab extends PluginSettingTab {
  plugin: ConvergePlugin;

  constructor(app: App, plugin: ConvergePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Converge Settings" });

    new Setting(containerEl)
      .setName("API Endpoint")
      .setDesc("OpenAI-compatible chat completions endpoint")
      .addText((text) =>
        text
          .setPlaceholder("https://api.openai.com/v1/chat/completions")
          .setValue(this.plugin.settings.apiEndpoint)
          .onChange((value) => {
            this.plugin.settings.apiEndpoint = value;
          })
      );

    new Setting(containerEl)
      .setName("API Key")
      .setDesc("Your API key (stored locally)")
      .addText((text) => {
        text
          .setPlaceholder("sk-...")
          .setValue(this.plugin.settings.apiKey)
          .onChange((value) => {
            this.plugin.settings.apiKey = value;
          });
        text.inputEl.type = "password";
      });

    new Setting(containerEl)
      .setName("Model Name")
      .setDesc("Model identifier to use")
      .addText((text) =>
        text
          .setPlaceholder("gpt-4o-mini")
          .setValue(this.plugin.settings.modelName)
          .onChange((value) => {
            this.plugin.settings.modelName = value;
          })
      );

    new Setting(containerEl)
      .setName("Your Name")
      .setDesc("How the assistant should address you")
      .addText((text) =>
        text
          .setPlaceholder("e.g., Yong Kiat")
          .setValue(this.plugin.settings.userName)
          .onChange((value) => {
            this.plugin.settings.userName = value;
          })
      );

    new Setting(containerEl)
      .setName("System Prompt")
      .setDesc("Instructions for the assistant")
      .addTextArea((text) => {
        text
          .setPlaceholder("You are a helpful assistant...")
          .setValue(this.plugin.settings.systemPrompt)
          .onChange((value) => {
            this.plugin.settings.systemPrompt = value;
          });
        text.inputEl.rows = 4;
        text.inputEl.cols = 50;
      });

    new Setting(containerEl)
      .setName("Max Context Tokens")
      .setDesc("Maximum tokens for the model context window (for the token counter)")
      .addText((text) =>
        text
          .setPlaceholder("100000")
          .setValue(String(this.plugin.settings.maxTokens))
          .onChange((value) => {
            const num = parseInt(value);
            if (!isNaN(num) && num > 0) {
              this.plugin.settings.maxTokens = num;
            }
          })
      );

    new Setting(containerEl)
      .setName("Export Folder")
      .setDesc("Folder path where chat exports will be saved")
      .addText((text) =>
        text
          .setPlaceholder("Converge Chats")
          .setValue(this.plugin.settings.exportFolder)
          .onChange((value) => {
            this.plugin.settings.exportFolder = value;
          })
      );

    // Save button
    new Setting(containerEl)
      .addButton((btn) =>
        btn
          .setButtonText("Save Settings")
          .setCta()
          .onClick(async () => {
            await this.plugin.saveSettings();
            new Notice("Settings saved");
          })
      );
  }
}
