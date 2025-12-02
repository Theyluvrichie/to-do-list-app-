/* ========= Data store ========= */
      const store = {
        tasks: [],
        seq: 1,
        settings: { reminders: false },
      };

      function save() {
        localStorage.setItem("focusflow", JSON.stringify(store));
      }
      function load() {
        const raw = localStorage.getItem("focusflow");
        if (raw) {
          const s = JSON.parse(raw);
          Object.assign(store, s);
        }
      }
      load();

      /* ========= Utilities ========= */
      const $ = (sel) => document.querySelector(sel);
      function uid() {
        return (store.seq++).toString().padStart(4, "0");
      }
      function now() {
        return new Date();
      }
      function toLocalISO(d) {
        const tzOffset = d.getTimezoneOffset() * 60000;
        return new Date(d - tzOffset).toISOString().slice(0, 16);
      }
      function parseTags(str) {
        return (str || "")
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean)
          .map((t) => t.replace(/^#/, ""));
      }
      function humanDue(due) {
        if (!due) return "";
        const d = new Date(due);
        const diff = d - new Date();
        const days = Math.floor(diff / (24 * 3600 * 1000));
        const time = d.toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        });
        return `${d.toLocaleDateString()} ${time}${
          diff < 0
            ? " (overdue)"
            : days === 0
            ? " (today)"
            : days === 1
            ? " (tomorrow)"
            : ""
        }`;
      }

      /* ========= Natural language parsing (basic) =========
   Supports: "today", "tomorrow", "in X days", "next week",
   explicit time "3pm" / "15:00", day-of-month "on 1st", weekdays "Mon"
   tags: "#tag", priority words: "critical/high/medium/low"
*/
      function parseQuick(title) {
        let t = title;
        const meta = {
          due: null,
          tags: [],
          priority: null,
        };

        // Tags: #tag
        meta.tags = [...t.matchAll(/#([\w-]+)/g)].map((m) => m[1]);
        t = t.replace(/#([\w-]+)/g, "").trim();

        // Priority words
        if (/\bcritical\b/i.test(t)) meta.priority = "P0";
        else if (/\bhigh\b/i.test(t)) meta.priority = "P1";
        else if (/\bmedium\b/i.test(t)) meta.priority = "P2";
        else if (/\blow\b/i.test(t)) meta.priority = "P3";

        // Time "3pm" / "15:00"
        const timeMatch = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
        let hours = null,
          minutes = 0;
        if (timeMatch) {
          hours = parseInt(timeMatch[1], 10);
          minutes = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
          const ampm = timeMatch[3] ? timeMatch[3].toLowerCase() : "";
          if (ampm === "pm" && hours < 12) hours += 12;
          if (ampm === "am" && hours === 12) hours = 0;
          t = t.replace(timeMatch[0], "").trim();
        }

        // Relative day keywords
        let base = new Date();
        if (/\btoday\b/i.test(t)) {
          /* no change */ t = t.replace(/\btoday\b/i, "").trim();
        } else if (/\btomorrow\b/i.test(t)) {
          base.setDate(base.getDate() + 1);
          t = t.replace(/\btomorrow\b/i, "").trim();
        } else if (/in\s+(\d+)\s+days?/i.test(t)) {
          const m = t.match(/in\s+(\d+)\s+days?/i);
          base.setDate(base.getDate() + parseInt(m[1], 10));
          t = t.replace(m[0], "").trim();
        } else if (/\bnext week\b/i.test(t)) {
          base.setDate(base.getDate() + 7);
          t = t.replace(/\bnext week\b/i, "").trim();
        } else if (/\bon\s+(\d{1,2})(st|nd|rd|th)?\b/i.test(t)) {
          const m = t.match(/\bon\s+(\d{1,2})(st|nd|rd|th)?\b/i);
          const day = parseInt(m[1], 10);
          base.setDate(day);
          t = t.replace(m[0], "").trim();
        } else if (/\b(mon|tue|wed|thu|fri|sat|sun)\b/i.test(t)) {
          const map = {
            sun: 0,
            mon: 1,
            tue: 2,
            wed: 3,
            thu: 4,
            fri: 5,
            sat: 6,
          };
          const m = t.match(/\b(mon|tue|wed|thu|fri|sat|sun)\b/i);
          const target = map[m[1].toLowerCase()];
          const diff = (target + 7 - base.getDay()) % 7 || 7;
          base.setDate(base.getDate() + diff);
          t = t.replace(m[0], "").trim();
        }

        if (hours !== null) {
          base.setHours(hours, minutes, 0, 0);
          meta.due = base.toISOString();
        } else if (
          (base !== null &&
            /\btoday\b|\btomorrow\b|in\s+\d+\s+days|next week|on\s+\d{1,2}/i.test(
              title
            )) ||
          timeMatch
        ) {
          // default to 9am when date parsed but no time
          base.setHours(9, 0, 0, 0);
          meta.due = base.toISOString();
        }

        return {
          cleanTitle: t.trim().replace(/\s+/g, " ").replace(/\s+$/, ""),
          meta,
        };
      }

      /* ========= Create & update ========= */
      function createTask(payload) {
        const id = uid();
        const t = {
          id,
          title: payload.title?.trim() || "(untitled)",
          desc: payload.desc || "",
          list: payload.list || "Inbox",
          tags: payload.tags || [],
          priority: payload.priority || "P3",
          due: payload.due || null,
          estimate: payload.estimate || null,
          repeat: payload.repeat || "",
          color: payload.color || "#3b82f6",
          deps: payload.deps || [],
          status: payload.status || "todo", // todo | doing | done | blocked
          createdAt: new Date().toISOString(),
          completedAt: null,
          expanded: false,
        };
        store.tasks.push(t);
        save();
        scheduleReminder(t);
        renderAll();
        return t;
      }

      function updateTask(id, patch) {
        const t = store.tasks.find((x) => x.id === id);
        if (!t) return;
        Object.assign(t, patch);
        if (patch.status === "done" && !t.completedAt)
          t.completedAt = new Date().toISOString();
        if (patch.status !== "done") t.completedAt = null;
        save();
        renderAll();
      }

      function deleteTask(id) {
        store.tasks = store.tasks.filter((t) => t.id !== id);
        save();
        renderAll();
      }

      /* ========= Reminders (Notifications API) ========= */
      function enableReminders() {
        Notification.requestPermission().then((p) => {
          store.settings.reminders = p === "granted";
          save();
          alert(
            store.settings.reminders
              ? "Reminders enabled."
              : "Notifications blocked or denied."
          );
        });
      }

      function scheduleReminder(task) {
        // lightweight check loop runs every minute; here we do nothing per task
      }

      setInterval(() => {
        if (!store.settings.reminders) return;
        const nowTs = Date.now();
        store.tasks.forEach((t) => {
          if (!t.due || t.status === "done") return;
          const dueTs = new Date(t.due).getTime();
          // Notify within the last 1 minute before due time
          if (dueTs - nowTs <= 60000 && dueTs - nowTs > 0 && !t.__notified) {
            new Notification("Upcoming task", {
              body: `${t.title} at ${humanDue(t.due)}`,
            });
            t.__notified = true;
            save();
          }
          // Overdue nudge
          if (nowTs - dueTs > 0 && !t.__overdueNotified) {
            new Notification("Overdue task", {
              body: `${t.title} is overdue.`,
            });
            t.__overdueNotified = true;
            save();
          }
        });
      }, 60000);

      /* ========= Voice input (Web Speech API) ========= */
      function startVoice() {
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SR)
          return alert("Speech recognition not supported in this browser.");
        const r = new SR();
        r.lang = "en-US";
        r.interimResults = false;
        r.maxAlternatives = 1;
        r.onresult = (e) => {
          const text = e.results[0][0].transcript;
          const { cleanTitle, meta } = parseQuick(text);
          createTask({
            title: cleanTitle || text,
            desc: "",
            list: "Inbox",
            tags: meta.tags,
            priority: meta.priority || "P2",
            due: meta.due,
          });
        };
        r.onerror = () => alert("Voice input error.");
        r.start();
      }

      /* ========= Rendering ========= */
      function renderAll() {
        renderBoard();
        renderStats();
        renderInsights();
        renderCalendar();
      }

      function applyFilters(list) {
        const q = $("#searchInput").value.trim().toLowerCase();
        const fList = $("#filterList").value;
        const fPrio = $("#filterPriority").value;
        const fStatus = $("#filterStatus").value;
        const fDue = $("#filterDue").value;

        return list.filter((t) => {
          const hay = [t.title, t.desc, t.tags.join(" "), t.list]
            .join(" ")
            .toLowerCase();
          if (q && !hay.includes(q)) return false;
          if (fList && t.list !== fList) return false;
          if (fPrio && t.priority !== fPrio) return false;
          if (fStatus && t.status !== fStatus) return false;
          if (fDue) {
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const endWeek = new Date(today);
            endWeek.setDate(today.getDate() + 7);
            const due = t.due ? new Date(t.due) : null;
            if (
              fDue === "overdue" &&
              !(due && due < now() && t.status !== "done")
            )
              return false;
            if (
              fDue === "today" &&
              !(due && due.toDateString() === now().toDateString())
            )
              return false;
            if (fDue === "week" && !(due && due >= today && due <= endWeek))
              return false;
          }
          return true;
        });
      }

      function sortTasks(list) {
        const mode = $("#sortSelect").value;
        const prioRank = { P0: 0, P1: 1, P2: 2, P3: 3 };
        return list.slice().sort((a, b) => {
          if (mode === "priority")
            return prioRank[a.priority] - prioRank[b.priority];
          if (mode === "dueAsc")
            return (
              (a.due ? new Date(a.due).getTime() : Infinity) -
              (b.due ? new Date(b.due).getTime() : Infinity)
            );
          if (mode === "dueDesc")
            return (
              (b.due ? new Date(b.due).getTime() : -Infinity) -
              (a.due ? new Date(a.due).getTime() : -Infinity)
            );
          if (mode === "created")
            return new Date(a.createdAt) - new Date(b.createdAt);
          return 0;
        });
      }

      function renderBoard() {
        document.querySelectorAll(".column").forEach((col) => {
          col.querySelectorAll(".task").forEach((el) => el.remove());
          const status = col.getAttribute("data-status");
          const tasks = sortTasks(
            applyFilters(store.tasks.filter((t) => t.status === status))
          );
          if (tasks.length === 0) {
            col.querySelector(".empty")?.classList.remove("hidden");
          } else {
            col.querySelector(".empty")?.classList.add("hidden");
          }
          tasks.forEach((t) => col.appendChild(taskElement(t)));
        });
      }

      function taskElement(t) {
        const el = document.createElement("div");
        el.className = "task";
        el.draggable = true;
        el.dataset.id = t.id;
        el.innerHTML = `
    <header style="border:none;">
      <div style="display:flex;align-items:center;gap:8px;">
        <span class="colorDot" style="background:${t.color}"></span>
        <strong class="title" title="Double‑click to edit">${escapeHtml(
          t.title
        )}</strong>
        <span class="chip" style="cursor:pointer;" title="Copy ID">#${
          t.id
        }</span>
      </div>
      <div class="actions">
        <span class="badge ${badgeClass(t)}">${badgeText(t)}</span>
        <button class="btn secondary act-done">${
          t.status === "done" ? " Undo" : " Done"
        }</button>
        <button class="btn secondary act-edit"> Edit</button>
        <button class="btn secondary act-delete" style="color:var(--danger);border-color:var(--danger);"> Delete</button>
      </div>
    </header>
    <div class="meta" style="display:${t.expanded ? "block" : "none"};">
      <div class="tags">${t.tags
        .map((tt) => `<span class="tag">#${escapeHtml(tt)}</span>`)
        .join("")}</div>
      <div style="color:var(--muted);font-size:12px;margin-top:4px;">
        <span>List: ${escapeHtml(t.list)}</span> •
        <span>Priority: ${t.priority}</span> •
        <span>Due: ${t.due ? escapeHtml(humanDue(t.due)) : "—"}</span> •
        <span>Estimate: ${t.estimate ? `${t.estimate}h` : "—"}</span> •
        <span>Repeat: ${t.repeat || "—"}</span>
      </div>
      <div style="margin-top:6px;">${
        t.desc
          ? escapeHtml(t.desc)
          : '<span style="color:var(--muted)">No description</span>'
      }</div>
      <div style="margin-top:6px;color:var(--muted);font-size:12px;">
        Dependencies: ${
          t.deps.length ? t.deps.map((d) => `#${d}`).join(", ") : "None"
        }
      </div>
    </div>
  `;

        // interactions
        const idChip = el.querySelector(".chip");
        idChip.addEventListener("click", () => {
          navigator.clipboard
            .writeText(t.id)
            .then(() => (idChip.textContent = "Copied!"));
          setTimeout(() => (idChip.textContent = "#" + t.id), 1000);
        });

        el.querySelector(".title").addEventListener("dblclick", () => {
          const n = prompt("Edit title", t.title);
          if (n !== null) updateTask(t.id, { title: n.trim() || t.title });
        });

        el.querySelector(".act-done").addEventListener("click", () => {
          const nxt = t.status === "done" ? "todo" : "done";
          updateTask(t.id, { status: nxt });
          // handle recurring: create next occurrence when marking done
          if (nxt === "done" && t.repeat && t.due) {
            const d = new Date(t.due);
            if (t.repeat === "daily") d.setDate(d.getDate() + 1);
            if (t.repeat === "weekly") d.setDate(d.getDate() + 7);
            if (t.repeat === "monthly") d.setMonth(d.getMonth() + 1);
            createTask({
              ...t,
              id: undefined,
              title: t.title,
              due: d.toISOString(),
              status: "todo",
            });
          }
        });

        el.querySelector(".act-edit").addEventListener("click", () =>
          openEditDialog(t)
        );
        el.querySelector(".act-delete").addEventListener("click", () => {
          if (confirm("Delete this task?")) deleteTask(t.id);
        });

        // toggle meta
        el.addEventListener("click", (e) => {
          if (e.target.closest(".actions")) return;
          updateTask(t.id, { expanded: !t.expanded });
        });

        // drag & drop
        el.addEventListener("dragstart", () => {
          el.classList.add("dragging");
        });
        el.addEventListener("dragend", () => {
          el.classList.remove("dragging");
        });

        return el;
      }

      function badgeClass(t) {
        if (t.status === "blocked") return "warn";
        if (t.due && new Date(t.due) < now() && t.status !== "done")
          return "danger";
        return "";
      }
      function badgeText(t) {
        if (t.status === "done") return "Done";
        if (t.status === "doing") return "In progress";
        if (t.status === "blocked") {
          const unmet = t.deps.filter((d) => {
            const dt = store.tasks.find((x) => x.id === d);
            return dt && dt.status !== "done";
          }).length;
          return `Blocked (${unmet})`;
        }
        return t.priority;
      }

      function escapeHtml(s) {
        return String(s).replace(
          /[&<>"']/g,
          (m) =>
            ({
              "&": "&amp;",
              "<": "&lt;",
              ">": "&gt;",
              '"': "&quot;",
              "'": "&#39;",
            }[m])
        );
      }

      /* ========= Column DnD ========= */
      document.querySelectorAll(".column").forEach((col) => {
        col.addEventListener("dragover", (e) => {
          e.preventDefault();
          const dragging = document.querySelector(".task.dragging");
          if (dragging) col.appendChild(dragging);
        });
        col.addEventListener("drop", (e) => {
          const dragging = document.querySelector(".task.dragging");
          if (!dragging) return;
          const id = dragging.dataset.id;
          const newStatus = col.getAttribute("data-status");
          if (newStatus === "done") {
            updateTask(id, { status: "done" });
          } else {
            updateTask(id, { status: newStatus });
          }
        });
      });

      /* ========= Calendar ========= */
      let calRefDate = new Date();
      function renderCalendar() {
        const grid = $("#calGrid");
        grid.innerHTML = "";
        const y = calRefDate.getFullYear();
        const m = calRefDate.getMonth();
        $("#calTitle").textContent = `${calRefDate.toLocaleString(undefined, {
          month: "long",
        })} ${y}`;
        const first = new Date(y, m, 1);
        const startDay = first.getDay();
        const daysInMonth = new Date(y, m + 1, 0).getDate();
        for (let i = 0; i < startDay; i++) {
          const cell = document.createElement("div");
          cell.className = "cell";
          grid.appendChild(cell);
        }
        for (let d = 1; d <= daysInMonth; d++) {
          const cell = document.createElement("div");
          cell.className = "cell";
          const date = new Date(y, m, d);
          const header = document.createElement("div");
          header.className = "date";
          header.textContent =
            date.toLocaleDateString(undefined, { weekday: "short" }) + " " + d;
          cell.appendChild(header);

          applyFilters(store.tasks)
            .filter(
              (t) =>
                t.due && new Date(t.due).toDateString() === date.toDateString()
            )
            .sort((a, b) => new Date(a.due) - new Date(b.due))
            .slice(0, 5)
            .forEach((t) => {
              const pill = document.createElement("span");
              pill.className = "pill";
              pill.style.borderColor = t.color;
              pill.textContent = `${t.title} (${new Date(
                t.due
              ).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })})`;
              pill.title = `#${t.id} • ${t.priority}`;
              pill.addEventListener("click", () =>
                alert(
                  `${t.title}\nDue: ${humanDue(t.due)}\nPriority: ${
                    t.priority
                  }\nList: ${t.list}`
                )
              );
              cell.appendChild(pill);
            });

          grid.appendChild(cell);
        }
      }

      /* ========= Stats & insights ========= */
      function renderStats() {
        const total = store.tasks.length;
        const done = store.tasks.filter((t) => t.status === "done").length;
        const overdue = store.tasks.filter(
          (t) => t.due && new Date(t.due) < now() && t.status !== "done"
        ).length;
        const focus = store.tasks.filter(
          (t) => ["P0", "P1"].includes(t.priority) && t.status !== "done"
        ).length;

        $("#statTotal").textContent = total;
        $("#statDone").textContent = done;
        $("#statOverdue").textContent = overdue;
        $("#statFocus").textContent = focus;

        $("#barTotal").style.width = `${total ? 100 : 0}%`;
        $("#barDone").style.width = `${
          total ? Math.round((done / Math.max(1, total)) * 100) : 0
        }%`;
        $("#barOverdue").style.width = `${
          total ? Math.round((overdue / Math.max(1, total)) * 100) : 0
        }%`;
        $("#barFocus").style.width = `${
          total ? Math.round((focus / Math.max(1, total)) * 100) : 0
        }%`;
      }

      function renderInsights() {
        const chips = $("#insightChips");
        chips.innerHTML = "";
        const today = new Date().toDateString();
        const todayTasks = store.tasks.filter(
          (t) =>
            t.due &&
            new Date(t.due).toDateString() === today &&
            t.status !== "done"
        );
        const overdue = store.tasks.filter(
          (t) => t.due && new Date(t.due) < now() && t.status !== "done"
        );
        const longRunning = store.tasks
          .filter((t) => t.estimate && t.estimate >= 2 && t.status !== "done")
          .slice(0, 3);

        addChip(chips, `Today: ${todayTasks.length} task(s)`);
        addChip(chips, `Overdue: ${overdue.length}`);
        if (longRunning.length)
          addChip(
            chips,
            `Deep work candidates: ${longRunning
              .map((t) => t.title)
              .join(", ")}`
          );
        const blocked = store.tasks.filter(
          (t) => t.status === "blocked"
        ).length;
        if (blocked) addChip(chips, `Blocked: ${blocked}`);
      }
      function addChip(container, text) {
        const c = document.createElement("span");
        c.className = "chip";
        c.textContent = text;
        container.appendChild(c);
      }

      /* ========= Edit dialog (prompt-based for simplicity) ========= */
      function openEditDialog(t) {
        const title = prompt("Title", t.title);
        if (title === null) return;
        const desc = prompt("Description", t.desc ?? "");
        if (desc === null) return;
        const list = prompt("List (Inbox/Work/Personal/Errands)", t.list);
        if (list === null) return;
        const priority = prompt("Priority (P0/P1/P2/P3)", t.priority);
        if (priority === null) return;
        const dueStr = prompt(
          "Due (datetime-local, e.g., 2025-11-27T15:00)",
          t.due ? toLocalISO(new Date(t.due)) : ""
        );
        if (dueStr === null) return;
        const estimate = prompt("Estimate (hours)", t.estimate ?? "");
        if (estimate === null) return;
        const repeat = prompt(
          'Repeat (daily/weekly/monthly/"")',
          t.repeat ?? ""
        );
        if (repeat === null) return;
        const color = prompt("Color (hex)", t.color);
        if (color === null) return;
        const tags = prompt("Tags (comma-separated)", t.tags.join(","));
        if (tags === null) return;
        const deps = prompt(
          "Dependencies (IDs comma-separated)",
          t.deps.join(",")
        );
        if (deps === null) return;

        updateTask(t.id, {
          title: title.trim() || t.title,
          desc: desc,
          list: list || t.list,
          priority: ["P0", "P1", "P2", "P3"].includes(priority)
            ? priority
            : t.priority,
          due: dueStr ? new Date(dueStr).toISOString() : null,
          estimate: estimate ? parseFloat(estimate) : null,
          repeat: ["daily", "weekly", "monthly"].includes(repeat) ? repeat : "",
          color: color || t.color,
          tags: parseTags(tags),
          deps: (deps || "")
            .split(",")
            .map((d) => d.trim())
            .filter(Boolean),
        });
      }

      /* ========= Events ========= */
      $("#createBtn").addEventListener("click", () => {
        const title = $("#titleInput").value.trim();
        const { cleanTitle, meta } = parseQuick(title);
        createTask({
          title: cleanTitle || title,
          desc: $("#descInput").value.trim(),
          list: $("#listInput").value,
          tags: [...parseTags($("#tagsInput").value), ...meta.tags],
          priority: $("#priorityInput").value || meta.priority || "P3",
          due: $("#dueInput").value
            ? new Date($("#dueInput").value).toISOString()
            : meta.due || null,
          estimate: $("#estimateInput").value
            ? parseFloat($("#estimateInput").value)
            : null,
          repeat: $("#repeatInput").value,
          color: $("#colorInput").value,
          deps: ($("#depsInput").value || "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          status: "todo",
        });
        // reset inputs
        $("#titleInput").value = "";
        $("#descInput").value = "";
        $("#tagsInput").value = "";
        $("#estimateInput").value = "";
        $("#depsInput").value = "";
      });

      $("#addQuickBtn").addEventListener("click", () => {
        const text = prompt("Quick add (natural language)");
        if (!text) return;
        const { cleanTitle, meta } = parseQuick(text);
        createTask({
          title: cleanTitle || text,
          desc: "",
          list: "Inbox",
          tags: meta.tags,
          priority: meta.priority || "P2",
          due: meta.due,
        });
      });

      $("#resetFiltersBtn").addEventListener("click", () => {
        $("#searchInput").value = "";
        $("#filterList").value = "";
        $("#filterPriority").value = "";
        $("#filterStatus").value = "";
        $("#filterDue").value = "";
        renderAll();
      });

      [
        "searchInput",
        "filterList",
        "filterPriority",
        "filterStatus",
        "filterDue",
        "sortSelect",
      ].forEach((id) => {
        document.getElementById(id).addEventListener("input", renderAll);
      });

      $("#expandAllBtn").addEventListener("click", () => {
        store.tasks.forEach((t) => (t.expanded = true));
        save();
        renderAll();
      });
      $("#collapseAllBtn").addEventListener("click", () => {
        store.tasks.forEach((t) => (t.expanded = false));
        save();
        renderAll();
      });

      $("#voiceBtn").addEventListener("click", startVoice);
      $("#notifyBtn").addEventListener("click", enableReminders);

      $("#clearBtn").addEventListener("click", () => {
        if (!confirm("Clear all tasks and reset?")) return;
        store.tasks = [];
        store.seq = 1;
        save();
        renderAll();
      });

      $("#exportBtn").addEventListener("click", () => {
        const blob = new Blob([JSON.stringify(store, null, 2)], {
          type: "application/json",
        });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "focusflow-backup.json";
        a.click();
      });

      $("#importBtn").addEventListener("click", async () => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "application/json";
        input.onchange = async () => {
          const file = input.files[0];
          if (!file) return;
          const text = await file.text();
          try {
            const data = JSON.parse(text);
            if (!data.tasks) throw new Error("Invalid backup file");
            Object.assign(store, data);
            save();
            renderAll();
            alert("Import successful.");
          } catch (e) {
            alert("Import failed: " + e.message);
          }
        };
        input.click();
      });

      /* ========= Calendar nav ========= */
      $("#prevMonth").addEventListener("click", () => {
        calRefDate.setMonth(calRefDate.getMonth() - 1);
        renderCalendar();
      });
      $("#nextMonth").addEventListener("click", () => {
        calRefDate.setMonth(calRefDate.getMonth() + 1);
        renderCalendar();
      });
      $("#todayMonth").addEventListener("click", () => {
        calRefDate = new Date();
        renderCalendar();
      });

      /* Initial render */
      renderAll();