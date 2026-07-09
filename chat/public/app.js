/* mxgpt chat UI — vanilla JS, streams answers over SSE, renders mermaid + logs. */
(() => {
  const chat = document.getElementById("chat");
  const welcome = document.getElementById("welcome");
  const form = document.getElementById("form");
  const input = document.getElementById("input");
  const send = document.getElementById("send");
  const meta = document.getElementById("meta");
  const logsEl = document.getElementById("logs");
  const logBadge = document.getElementById("log-badge");

  /** Conversation history sent with each request. */
  const history = [];
  let busy = false;
  let activeTab = "chat";
  let unseenLogs = 0;

  /* ----------------------------- helpers ----------------------------- */

  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /** Minimal, safe markdown: fenced code, mermaid diagrams, inline code, bold, paragraphs. */
  function renderMarkdown(text) {
    const parts = text.split(/```/);
    let html = "";
    parts.forEach((part, i) => {
      if (i % 2 === 1) {
        const m = part.match(/^([a-zA-Z0-9_-]*)\r?\n?([\s\S]*)$/);
        const lang = (m ? m[1] : "").toLowerCase();
        const body = m ? m[2] : part;
        if (lang === "mermaid") {
          html +=
            `<div class="mermaid-block" data-code="${encodeURIComponent(body)}">` +
            `<div class="mermaid-render"></div>` +
            `<div class="mermaid-pending">📊 Generating diagram…</div>` +
            `</div>`;
          return;
        }
        html += `<pre><code>${escapeHtml(body)}</code></pre>`;
      } else {
        let p = escapeHtml(part);
        p = p.replace(/`([^`]+)`/g, "<code>$1</code>");
        p = p.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
        p = p
          .split(/\n{2,}/)
          .map((para) => `<p>${para.replace(/\n/g, "<br>")}</p>`)
          .join("");
        html += p;
      }
    });
    return html;
  }

  function scrollToBottom() {
    chat.scrollTop = chat.scrollHeight;
  }

  function addMessage(role) {
    if (welcome) welcome.style.display = "none";
    const wrap = document.createElement("div");
    wrap.className = `msg ${role}`;
    wrap.innerHTML = `
      <div class="avatar">${role === "user" ? "🧑" : "🧩"}</div>
      <div class="body">
        <div class="role">${role === "user" ? "You" : "mxgpt"}</div>
      </div>`;
    chat.appendChild(wrap);
    scrollToBottom();
    return wrap.querySelector(".body");
  }

  /* ------------------------------- logs ------------------------------ */

  function addLog(level, text) {
    const empty = logsEl.querySelector(".logs-empty");
    if (empty) empty.remove();
    const row = document.createElement("div");
    row.className = `log log-${level}`;
    const time = new Date().toLocaleTimeString();
    row.innerHTML =
      `<span class="log-time">${time}</span>` +
      `<span class="log-level">${level}</span>` +
      `<span class="log-text"></span>`;
    row.querySelector(".log-text").textContent = text;
    logsEl.appendChild(row);
    logsEl.scrollTop = logsEl.scrollHeight;
    if (activeTab !== "logs") {
      unseenLogs += 1;
      logBadge.hidden = false;
      logBadge.textContent = String(unseenLogs);
    }
  }

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      activeTab = tab.dataset.tab;
      document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
      document.getElementById("view-chat").classList.toggle("active", activeTab === "chat");
      document.getElementById("view-logs").classList.toggle("active", activeTab === "logs");
      if (activeTab === "logs") {
        unseenLogs = 0;
        logBadge.hidden = true;
      }
    });
  });
  document.getElementById("clear-logs").addEventListener("click", () => {
    logsEl.innerHTML = '<div class="logs-empty">Cleared.</div>';
  });

  /* ----------------------------- diagrams ---------------------------- */

  let mermaidReady = false;
  function initMermaid() {
    if (mermaidReady || !window.mermaid) return;
    window.mermaid.initialize({
      startOnLoad: false,
      theme: "dark",
      securityLevel: "strict",
      flowchart: { useMaxWidth: true },
      er: { useMaxWidth: true },
    });
    mermaidReady = true;
  }

  async function renderDiagrams(container) {
    if (!window.mermaid) return;
    initMermaid();
    const blocks = container.querySelectorAll(".mermaid-block");
    for (const block of blocks) {
      if (block.dataset.rendered) continue;
      const code = decodeURIComponent(block.dataset.code || "").trim();
      if (!code) continue;
      const target = block.querySelector(".mermaid-render");
      const pending = block.querySelector(".mermaid-pending");
      block.dataset.rendered = "1";
      try {
        const id = "mmd-" + Math.random().toString(36).slice(2);
        const { svg } = await window.mermaid.render(id, code);
        target.innerHTML = svg;
        if (pending) pending.remove();
        addDiagramToolbar(block, code);
      } catch (err) {
        if (pending) pending.remove();
        target.innerHTML = `<pre><code>${escapeHtml(code)}</code></pre>`;
        const note = document.createElement("div");
        note.className = "mermaid-error";
        note.textContent = "⚠ Couldn't render this diagram: " + (err && err.message);
        block.appendChild(note);
      }
    }
  }

  function addDiagramToolbar(block, code) {
    const bar = document.createElement("div");
    bar.className = "diagram-bar";
    const expand = document.createElement("button");
    expand.textContent = "⤢ Expand";
    expand.onclick = () => openLightbox(block.querySelector(".mermaid-render").innerHTML);
    const source = document.createElement("button");
    source.textContent = "</> Source";
    let showing = false;
    let pre = null;
    source.onclick = () => {
      showing = !showing;
      if (showing) {
        pre = document.createElement("pre");
        pre.className = "diagram-source";
        pre.innerHTML = `<code>${escapeHtml(code)}</code>`;
        block.appendChild(pre);
        source.textContent = "</> Hide source";
      } else if (pre) {
        pre.remove();
        source.textContent = "</> Source";
      }
    };
    bar.append(expand, source);
    block.prepend(bar);
  }

  /* ----------------------------- lightbox ---------------------------- */

  const lightbox = document.getElementById("lightbox");
  const lightboxStage = document.getElementById("lightbox-stage");
  function openLightbox(svgHtml) {
    lightboxStage.innerHTML = svgHtml;
    lightbox.hidden = false;
  }
  function closeLightbox() {
    lightbox.hidden = true;
    lightboxStage.innerHTML = "";
  }
  document.getElementById("lightbox-close").addEventListener("click", closeLightbox);
  lightbox.addEventListener("click", (e) => {
    if (e.target === lightbox) closeLightbox();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !lightbox.hidden) closeLightbox();
  });

  /* ------------------------------ sending ----------------------------- */

  async function ask(question) {
    if (busy || !question.trim()) return;
    busy = true;
    send.disabled = true;

    const userBody = addMessage("user");
    const uc = document.createElement("div");
    uc.className = "content";
    uc.textContent = question;
    userBody.appendChild(uc);
    history.push({ role: "user", content: question });

    // Assistant message: a live "thinking" indicator + the streamed answer.
    const body = addMessage("assistant");
    const live = document.createElement("div");
    live.className = "thinking";
    live.innerHTML =
      `<span class="spinner"></span>` +
      `<span class="thinking-text">Analyzing your Mendix model…</span>`;
    body.appendChild(live);
    const answerEl = document.createElement("div");
    answerEl.className = "content";
    body.appendChild(answerEl);

    const setStatus = (s) => {
      const t = live.querySelector(".thinking-text");
      if (t) t.textContent = s;
    };
    let answer = "";
    const renderAnswer = () => {
      answerEl.innerHTML = renderMarkdown(answer);
      scrollToBottom();
    };

    try {
      const resp = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, history: history.slice(0, -1) }),
      });

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() || "";
        for (const ev of events) {
          const line = ev.replace(/^data: /, "").trim();
          if (!line) continue;
          let msg;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          if (msg.type === "token") {
            answer += msg.text;
            renderAnswer();
          } else if (msg.type === "status") {
            setStatus(msg.text);
          } else if (msg.type === "log") {
            addLog(msg.level || "info", msg.text);
          } else if (msg.type === "error") {
            const e = document.createElement("div");
            e.className = "error";
            e.textContent = msg.text;
            answerEl.appendChild(e);
          }
        }
      }
    } catch (err) {
      const e = document.createElement("div");
      e.className = "error";
      e.textContent = "Connection error: " + err.message;
      answerEl.appendChild(e);
    } finally {
      live.remove();
      answerEl.innerHTML = renderMarkdown(answer) || answerEl.innerHTML;
      renderDiagrams(answerEl);
      if (answer.trim()) history.push({ role: "assistant", content: answer });
      busy = false;
      send.disabled = false;
      input.focus();
    }
  }

  /* ------------------------------ events ------------------------------ */

  function autosize() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 200) + "px";
  }

  input.addEventListener("input", autosize);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const q = input.value;
    input.value = "";
    autosize();
    ask(q);
  });

  document.querySelectorAll(".example").forEach((btn) => {
    btn.addEventListener("click", () => {
      ask(btn.textContent);
    });
  });

  /* ------------------------------ startup ----------------------------- */

  fetch("/api/info")
    .then((r) => r.json())
    .then((info) => {
      meta.innerHTML = `
        <span class="pill">📁 ${info.projectFile}</span>
        <span class="pill">🧠 ${info.provider}</span>
        ${info.mxcli ? "" : '<span class="pill warn">⚠ mxcli not found</span>'}`;
      addLog("info", `Connected. Provider: ${info.provider}. Project: ${info.projectFile}.`);
    })
    .catch(() => {});
})();
