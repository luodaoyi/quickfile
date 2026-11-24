import { startGalaxy } from "./background.js";
import { PeerLink } from "./peer.js";

const $ = (id) => document.getElementById(id);
const dictionaries = {
  zh: {
    title: "文件，随手分享。",
    intro: "拖入文件，复制链接。对方立即开始接收。",
    drop: "把文件拖到这里",
    browse: "或点击选择文件",
    limit: "支持多文件 · 单文件最大 10 GiB",
    settings: "分享设置",
    expiry: "保留时间",
    claims: "最多领取",
    hour1: "60 分钟",
    hour2: "2 小时",
    hour6: "6 小时",
    hour12: "12 小时",
    hour24: "24 小时",
    recent: "最近的空间",
    empty: "分享过的文件会显示在这里。",
    receive: "文件已为你准备好。",
    downloadAll: "下载全部",
    download: "下载",
    cancel: "取消下载",
    copy: "复制链接",
    copied: "已复制",
    uploading: "正在上传",
    ready: "上传完成，可以关闭页面",
    paused: "上传暂停，点击继续上传",
    resume: "继续上传",
    expired: "已过期或领取完毕",
    remove: "移除记录",
    files: "个文件",
    expires: "到期",
    received: "已领取",
    waiting: "等待上传",
    peer: "正在直连传输",
    server: "正在从服务器接收",
    retry: "连接中断，正在续传",
    saved: "下载完成",
    browserSave: "已交给浏览器下载，请查看浏览器的下载进度。",
    choose: "请选择原来的文件继续上传。",
    mismatch: "所选文件与原文件不一致，请选择同名且大小相同的文件。",
    tooLarge: "单文件不能超过 10 GiB。",
    failed: "操作失败",
    cancelled: "已取消",
    restore: "重新选择原文件后可继续上传",
    receiving: "正在下载",
    claimLimit: "领取次数已用完",
    browserUnavailable: "当前浏览器不支持 P2P，使用服务器传输。",
    insecure: "请使用 HTTPS 打开，以启用直连和文件保存。",
  },
  en: {
    title: "Files, freely shared.",
    intro: "Drop your files. Copy the link. They can start right away.",
    drop: "Drop your files here",
    browse: "or choose files",
    limit: "Multiple files · Up to 10 GiB per file",
    settings: "Share settings",
    expiry: "Keep files for",
    claims: "Maximum pickups",
    hour1: "60 minutes",
    hour2: "2 hours",
    hour6: "6 hours",
    hour12: "12 hours",
    hour24: "24 hours",
    recent: "Recent spaces",
    empty: "Your shared files will appear here.",
    receive: "Your files are here.",
    downloadAll: "Download all",
    download: "Download",
    cancel: "Cancel download",
    copy: "Copy link",
    copied: "Copied",
    uploading: "Uploading",
    ready: "Uploaded. You can close this page.",
    paused: "Upload paused. Continue when ready.",
    resume: "Resume upload",
    expired: "Expired or pickup limit reached",
    remove: "Remove",
    files: "files",
    expires: "Expires",
    received: "Pickups",
    waiting: "Waiting for upload",
    peer: "Receiving directly",
    server: "Receiving from server",
    retry: "Connection interrupted. Resuming…",
    saved: "Download complete",
    browserSave:
      "Download handed to your browser. Check its download progress.",
    choose: "Choose the original files to resume uploading.",
    mismatch: "Choose the original files with matching names and sizes.",
    tooLarge: "Each file must be at most 10 GiB.",
    failed: "Operation failed",
    cancelled: "Cancelled",
    restore: "Choose the original files to resume",
    receiving: "Downloading",
    claimLimit: "Pickup limit reached",
    browserUnavailable: "P2P is unavailable in this browser. Using the server.",
    insecure: "Open with HTTPS to enable direct transfer and file saving.",
  },
};
Object.assign(dictionaries.zh, {
  selectFiles: "选择文件",
  selectFolder: "选择文件夹",
  filesReady: "文件已准备就绪！",
  copyToShare: "复制链接以分享文件",
  sendMore: "发送更多文件",
  share: "分享",
  showQR: "展示二维码",
  scanToDownload: "扫码下载",
  uploadingHelp: "无需等待！文件接收者可在上传完成之前就开始下载。",
  completeHelp: "文件已上传完成，现在可以关闭此页面。",
  shareLink: "分享链接",
  pickFiles: "选择要发送的文件",
  dropHelp: "或者将文件拖到这里",
  uploadLimit: "文件最大可达 10 GiB",
  emptyTitle: "简单、私密的文件共享",
  emptyIntro:
    "拖入文件即可分享链接，对方无需等待上传完成。文件在 24 小时或 100 次领取后自动删除。",
  done: "完成",
  open: "打开",
  expireAfter: "后到期",
  orAfter: "或在",
  pickups: "次领取后到期",
});
Object.assign(dictionaries.en, {
  selectFiles: "Select files",
  selectFolder: "Select a folder",
  filesReady: "Your files are ready to share!",
  copyToShare: "Copy the link to share your files",
  sendMore: "Send more files",
  share: "Share",
  showQR: "Show QR code",
  scanToDownload: "Scan to download",
  uploadingHelp:
    "No need to wait! Your recipient can start downloading before this finishes.",
  completeHelp: "Your files are uploaded. You can close this page now.",
  shareLink: "Share link",
  pickFiles: "Select files to send",
  dropHelp: "Or drag stuff here",
  uploadLimit: "Send up to 10 GiB",
  emptyTitle: "Simple, private file sharing",
  emptyIntro:
    "Share a link as soon as you choose your files. Downloads can start right away. Files expire after 24 hours or 100 pickups.",
  done: "Done",
  open: "Open",
  expireAfter: "",
  orAfter: "or after",
  pickups: "pickups",
});
let lang =
  localStorage.getItem("quickfile.language") ||
  (navigator.language.startsWith("zh") ? "zh" : "en");
if (!dictionaries[lang]) lang = "en";
const t = (key) => dictionaries[lang][key] || key;
let history = JSON.parse(localStorage.getItem("quickfile.spaces") || "[]");
const senders = new Map();
let resumeID = null;
let sharingID = null;
let galaxy;
let copiedID = null;
let receivedSpace = null;
let downloadJob = null;
const spaceID = location.pathname.match(/^\/s\/([a-f0-9]{48})$/)?.[1];

function translate() {
  document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  $("language").querySelector("span").textContent =
    lang === "zh" ? "简体中文" : "English";
  $("settings-open").setAttribute("aria-label", t("settings"));
  $("settings-open").title = t("settings");
  $("share-link").setAttribute("aria-label", t("shareLink"));
  renderHistory();
  if (receivedSpace) renderReceiver();
}
$("language").onclick = () => {
  lang = lang === "zh" ? "en" : "zh";
  localStorage.setItem("quickfile.language", lang);
  translate();
};
const size = (n) =>
  n < 1024
    ? `${n} B`
    : `${(n / 1024 ** Math.floor(Math.log(n) / Math.log(1024))).toFixed(1)} ${["B", "KiB", "MiB", "GiB"][Math.floor(Math.log(n) / Math.log(1024))]}`;
const link = (id) => `${location.origin}/s/${id}`;
function message(text, error = false) {
  $("message").textContent = text;
  $("message").classList.toggle("error", error);
}
function saveHistory() {
  localStorage.setItem("quickfile.spaces", JSON.stringify(history));
}
function token() {
  return [...crypto.getRandomValues(new Uint8Array(24))]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
}
function element(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}
function button(text, action, className = "secondary small") {
  const el = element("button", className, text);
  el.type = "button";
  el.onclick = action;
  return el;
}
async function api(path, { method = "GET", body, credential, signal } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (credential) headers.Authorization = `Bearer ${credential}`;
  const response = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
    cache: "no-store",
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const error = new Error(data.error || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.status === 204 ? null : response.json();
}
function updateRecord(id, changes) {
  const record = history.find((s) => s.id === id);
  if (record) {
    Object.assign(record, changes);
    saveHistory();
    renderHistory();
  }
}
function icon(name) {
  const paths = {
    file: '<path d="M14 2H5v20h16V9z"/><path d="M14 2v7h7"/>',
    copy: '<rect x="9" y="8" width="12" height="14" rx="2"/><path d="M15 8V4a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4"/>',
    open: '<path d="M15 3h6v6m0-6L10 14"/><path d="M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    folder: '<path d="M3 7V4h6l3 3h9v3M3 10h19l-4 10H2z"/>',
    share: '<path d="M14 3l7 6-7 6V11C7 11 4 15 3 19V9h6"/>',
    qr: '<path d="M3 3h6v6H3zM15 3h6v6h-6zM3 15h6v6H3zM15 15h3v3h3v3h-6zM21 12v3M12 3v9H3M12 15v6"/>',
  };
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = paths[name];
  return svg;
}
function showShare(record) {
  sharingID = record.id;
  $("send-view").hidden = true;
  $("share-view").hidden = false;
  $("send-more").hidden = false;
  message("");
  renderShare();
  $("share-title").focus({ preventScroll: true });
}
function renderShare() {
  if (!sharingID) return;
  const record = history.find((s) => s.id === sharingID);
  const total = record.files.reduce((sum, f) => sum + f.size, 0);
  const uploaded = uploadBytes(record);
  const expired = record.expired || Date.now() >= Date.parse(record.expires);
  const running = !!senders.get(record.id)?.running;
  const complete = record.files.every((f) => f.uploaded >= f.size);
  const hours = Math.max(
    1,
    Math.ceil((Date.parse(record.expires) - Date.now()) / 3600000),
  );
  const remaining = Math.max(0, record.maxDownloads - record.downloads);
  $("share-link").value = link(record.id);
  $("copy-link").disabled = expired;
  $("copy-link").querySelector("span").textContent = t(
    copiedID === record.id ? "copied" : "copy",
  );
  $("native-share").hidden = !navigator.share;
  $("native-share").disabled = expired;
  $("show-qr").disabled = expired;
  $("share-expiry").textContent = expired
    ? t("expired")
    : lang === "zh"
      ? `您的文件将在 ${hours} 小时后或 ${remaining} 次领取后删除`
      : `Your files expire in ${hours} hours or after ${remaining} pickups`;
  $("upload-status").textContent = expired
    ? t("expired")
    : complete
      ? t("ready")
      : running
        ? `${t("uploading")} ${Math.floor((uploaded / total) * 100)}%`
        : t("paused");
  $("upload-progress").value = total ? uploaded / total : 1;
  $("upload-help").textContent = expired
    ? ""
    : complete
      ? t("completeHelp")
      : running
        ? t("uploadingHelp")
        : t("restore");
  $("resume-upload").hidden = expired || complete || running;
  $("share-view").dataset.state = expired
    ? "expired"
    : complete
      ? "complete"
      : running
        ? "uploading"
        : "paused";
}
function resumeUpload(record) {
  showShare(record);
  const active = senders.get(record.id);
  if (active) uploadSpace(record, active.files);
  else {
    resumeID = record.id;
    message(t("choose"));
    $("files").click();
  }
}
$("send-more").onclick = () => {
  sharingID = null;
  $("share-view").hidden = true;
  $("send-view").hidden = false;
  $("send-more").hidden = true;
  message("");
  $("choose-files").focus();
};
$("share-link").onclick = () => $("share-link").select();
$("copy-link").onclick = async () => {
  try {
    await navigator.clipboard.writeText(link(sharingID));
    copiedID = sharingID;
    renderShare();
  } catch (err) {
    message(`${t("failed")}: ${err.message}`, true);
  }
};
$("native-share").onclick = async () => {
  try {
    await navigator.share({ title: "Quickfile", url: link(sharingID) });
  } catch (err) {
    if (err.name !== "AbortError") message(err.message, true);
  }
};
$("show-qr").onclick = () => {
  try {
    const qr = qrcodegen.QrCode.encodeText(
      link(sharingID),
      qrcodegen.QrCode.Ecc.MEDIUM,
    );
    const canvas = element("canvas");
    const scale = 6,
      border = 4;
    canvas.width = canvas.height = (qr.size + border * 2) * scale;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#000";
    for (let y = 0; y < qr.size; y++)
      for (let x = 0; x < qr.size; x++)
        if (qr.getModule(x, y))
          ctx.fillRect(
            (x + border) * scale,
            (y + border) * scale,
            scale,
            scale,
          );
    $("qr-code").replaceChildren(canvas);
    $("qr-dialog").showModal();
  } catch (err) {
    message(err.message, true);
  }
};
$("resume-upload").onclick = () =>
  resumeUpload(history.find((s) => s.id === sharingID));
function renderHistory() {
  renderShare();
  $("history").replaceChildren();
  $("empty-history").hidden = history.length > 0;
  for (const record of history) {
    const card = element("article", "space-card");
    card.dataset.space = record.id;
    const heading = element("div", "space-heading");
    const fileIcon = icon("file");
    fileIcon.classList.add("file-icon");
    const file = element("div", "space-file");
    const name = element(
      "div",
      "space-name",
      record.files.map((f) => f.name).join(", "),
    );
    name.title = name.textContent;
    file.append(
      name,
      element(
        "div",
        "space-size",
        size(record.files.reduce((sum, f) => sum + f.size, 0)),
      ),
    );
    const remove = button(
      "",
      () => {
        history = history.filter((s) => s.id !== record.id);
        saveHistory();
        renderHistory();
      },
      "icon-button space-remove",
    );
    remove.setAttribute("aria-label", t("remove"));
    remove.title = t("remove");
    remove.append(icon("close"));
    heading.append(fileIcon, file, remove);
    card.append(heading);
    const expired = record.expired || Date.now() >= Date.parse(record.expires);
    const remaining = Math.max(0, record.maxDownloads - record.downloads);
    const hours = Math.max(
      1,
      Math.ceil((Date.parse(record.expires) - Date.now()) / 3600000),
    );
    const expiryText =
      lang === "zh"
        ? `在 ${hours} 小时后或 ${remaining} 次领取后到期`
        : `Expires in ${hours} hours or after ${remaining} pickups`;
    card.append(
      element("div", "space-meta", expired ? t("expired") : expiryText),
    );
    const total = record.files.reduce((sum, f) => sum + f.size, 0);
    const uploaded = uploadBytes(record);
    const active = senders.get(record.id);
    const status =
      !expired && uploaded < total
        ? active?.running
          ? `${t("uploading")} ${Math.floor((uploaded / total) * 100)}%`
          : t("paused")
        : "";
    card.append(element("div", "space-status", status));
    if (!expired && uploaded < total) {
      const progress = element("progress");
      progress.max = total;
      progress.value = uploaded;
      card.append(progress);
    }
    const actions = element("div", "actions");
    const open = element("a", "secondary small");
    open.href = link(record.id);
    open.target = "_blank";
    open.rel = "noopener";
    open.onclick = (event) => {
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)
        return;
      event.preventDefault();
      showShare(record);
    };
    open.append(icon("open"), element("span", "", t("open")));
    actions.append(open);
    if (!expired && uploaded < total && !active?.running)
      actions.append(button(t("resume"), () => resumeUpload(record)));
    const copy = button("", async () => {
      try {
        await navigator.clipboard.writeText(link(record.id));
        copy.querySelector("span").textContent = t("copied");
      } catch (err) {
        message(`${t("failed")}: ${err.message}`, true);
      }
    });
    copy.append(icon("copy"), element("span", "", t("copy")));
    copy.disabled = expired;
    actions.append(copy);
    card.append(actions);
    $("history").append(card);
  }
}

function closeFileMenu() {
  $("file-menu").hidden = true;
  $("choose-files").setAttribute("aria-expanded", "false");
}
$("choose-files").onclick = () => {
  const opening = $("file-menu").hidden;
  $("file-menu").hidden = !opening;
  $("choose-files").setAttribute("aria-expanded", String(opening));
  if (opening) $("pick-files").focus();
};
$("pick-files").onclick = () => {
  closeFileMenu();
  resumeID = null;
  $("files").click();
};
$("pick-folder").onclick = () => {
  closeFileMenu();
  resumeID = null;
  $("folder").click();
};
$("pick-files").prepend(icon("copy"));
$("pick-folder").prepend(icon("folder"));
$("copy-link").prepend(icon("copy"));
$("native-share").prepend(icon("share"));
$("show-qr").prepend(icon("qr"));
document.addEventListener("click", (event) => {
  if (!event.target.closest(".upload-center")) closeFileMenu();
});
document.addEventListener("keydown", (event) => {
  if ($("file-menu").hidden) return;
  if (event.key === "Escape") {
    closeFileMenu();
    $("choose-files").focus();
  } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    (document.activeElement === $("pick-files")
      ? $("pick-folder")
      : $("pick-files")
    ).focus();
  }
});
$("settings-open").onclick = () => $("share-settings").showModal();
$("dropzone").ondragover = (event) => {
  event.preventDefault();
  $("dropzone").classList.add("dragging");
};
$("dropzone").ondragleave = () => $("dropzone").classList.remove("dragging");
$("dropzone").ondrop = (event) => {
  event.preventDefault();
  $("dropzone").classList.remove("dragging");
  resumeID = null;
  chooseFiles([...event.dataTransfer.files]);
};
$("folder").onchange = () => {
  const files = [...$("folder").files];
  $("folder").value = "";
  chooseFiles(files);
};
$("files").onchange = () => {
  const files = [...$("files").files];
  $("files").value = "";
  chooseFiles(files);
};

async function chooseFiles(files) {
  if (!files.length) return;
  try {
    if (files.some((f) => f.size > 10 * 1024 ** 3))
      throw new Error(t("tooLarge"));
    if (resumeID) {
      const record = history.find((s) => s.id === resumeID);
      const matched = record.files.map((f) =>
        files.find((v) => v.name === f.name && v.size === f.size),
      );
      if (matched.some((v) => !v)) throw new Error(t("mismatch"));
      resumeID = null;
      showShare(record);
      await uploadSpace(record, matched);
      return;
    }
    $("choose-files").disabled = true;
    galaxy?.setWarp(true);
    const data = await api("/api/spaces", {
      method: "POST",
      body: {
        files: files.map((f) => ({ name: f.name, size: f.size })),
        hours: Number($("hours").value),
        maxDownloads: Number($("claims").value),
      },
    });
    const record = { ...data.space, owner: data.owner };
    history.unshift(record);
    saveHistory();
    renderHistory();
    $("choose-files").disabled = false;
    message("");
    showShare(record);
    await uploadSpace(record, files);
  } catch (err) {
    if (![...senders.values()].some((s) => s.running)) galaxy?.setWarp(false);
    message(`${t("failed")}: ${err.message}`, true);
  } finally {
    $("choose-files").disabled = false;
  }
}

function uploadBytes(record) {
  const pending = senders.get(record.id)?.pending;
  return record.files.reduce(
    (sum, f, index) => sum + f.uploaded + (pending?.get(index) || 0),
    0,
  );
}
function updateUploadProgress(record) {
  renderShare();
  const card = document.querySelector(`[data-space="${record.id}"]`);
  if (!card) return;
  const total = record.files.reduce((n, f) => n + f.size, 0);
  const uploaded = uploadBytes(record);
  card.querySelector(".space-status").textContent =
    `${t("uploading")} ${Math.floor((uploaded / total) * 100)}%`;
  const progress = card.querySelector("progress");
  if (progress) progress.value = uploaded;
}

async function uploadSpace(record, files) {
  let sender = senders.get(record.id);
  if (!sender) {
    sender = { files, running: false, signal: null, pending: new Map() };
    senders.set(record.id, sender);
  }
  if (sender.running) return;
  sender.files = files;
  sender.running = true;
  galaxy?.setWarp(true);
  renderHistory();
  try {
    const fresh = await api(`/api/spaces/${record.id}`);
    Object.assign(record, fresh);
    if (!sender.signal)
      sender.signal = new PeerLink(
        record.id,
        "sender",
        record.owner,
        record.expires,
        files,
      );
    let nextFile = 0;
    async function worker() {
      while (nextFile < files.length) {
        const index = nextFile++,
          file = files[index];
        while (record.files[index].uploaded < file.size) {
          const offset = record.files[index].uploaded;
          const part = file.slice(
            offset,
            Math.min(offset + 4 * 1024 ** 2, file.size),
          );
          const data = await new Promise((resolve, reject) => {
            const request = new XMLHttpRequest();
            request.open("PATCH", `/api/spaces/${record.id}/files/${index}`);
            request.setRequestHeader("Authorization", `Bearer ${record.owner}`);
            request.setRequestHeader("Upload-Offset", String(offset));
            request.responseType = "json";
            request.upload.onprogress = (event) => {
              sender.pending.set(index, event.loaded);
              updateUploadProgress(record);
            };
            request.onerror = () => {
              sender.pending.delete(index);
              reject(new Error(t("paused")));
            };
            request.onload = () => {
              sender.pending.delete(index);
              if (
                (request.status >= 200 && request.status < 300) ||
                request.status === 409
              )
                resolve(request.response);
              else {
                const err = new Error(
                  request.response?.error || `HTTP ${request.status}`,
                );
                err.status = request.status;
                reject(err);
              }
            };
            request.send(part);
          });
          record.files[index].uploaded = data.uploaded;
          saveHistory();
          updateUploadProgress(record);
        }
      }
    }
    const results = await Promise.allSettled([worker(), worker()]);
    const failed = results.find((r) => r.status === "rejected");
    if (failed) throw failed.reason;
  } catch (err) {
    if (err.status === 410) record.expired = true;
    if (![...senders.values()].some((s) => s !== sender && s.running))
      galaxy?.setWarp(false);
    message(`${t("failed")}: ${err.message}`, true);
  } finally {
    sender.running = false;
    sender.pending.clear();
    saveHistory();
    renderHistory();
  }
}

function renderReceiver() {
  const sp = receivedSpace;
  $("receive-info").textContent =
    `${sp.files.length} ${t("files")} · ${size(sp.files.reduce((n, f) => n + f.size, 0))} · ${t("received")} ${sp.downloads}/${sp.maxDownloads}`;
  $("receive-files").replaceChildren();
  sp.files.forEach((file, index) => {
    const row = element("div", "file-row"),
      info = element("div", "file-info");
    info.append(element("div", "file-name", file.name));
    info.append(
      element(
        "div",
        "file-size",
        `${size(file.size)}${file.uploaded < file.size ? ` · ${t("uploading")} ${Math.floor((file.uploaded / file.size) * 100)}%` : ""}`,
      ),
    );
    const download = button(t("download"), () => downloadFile(index));
    download.disabled = !!downloadJob;
    row.append(info, download);
    $("receive-files").append(row);
  });
  $("download-all").hidden = false;
  $("download-all").textContent =
    sp.files.length === 1 ? t("download") : t("downloadAll");
  $("download-all").disabled = !!downloadJob;
}
async function refreshReceiver() {
  try {
    receivedSpace = await api(`/api/spaces/${spaceID}`);
    renderReceiver();
  } catch (err) {
    message(err.status === 410 ? t("expired") : err.message, true);
    if (err.status === 410) {
      clearInterval(receiverPoll);
      $("download-all").disabled = true;
      $("receive-files")
        .querySelectorAll("button")
        .forEach((b) => (b.disabled = true));
    }
  }
}
let receiverPoll;
async function beginJob() {
  if (downloadJob) throw new Error(t("receiving"));
  const job = {
    token: token(),
    abort: new AbortController(),
    peer: null,
    heartbeat: null,
  };
  downloadJob = job;
  renderReceiver();
  $("cancel-download").hidden = false;
  try {
    await api(`/api/spaces/${spaceID}/claims`, {
      method: "POST",
      body: { token: job.token },
    });
  } catch (err) {
    downloadJob = null;
    $("cancel-download").hidden = true;
    renderReceiver();
    throw err;
  }
  job.heartbeat = setInterval(
    () =>
      api(`/api/spaces/${spaceID}/heartbeat`, {
        method: "POST",
        credential: job.token,
        signal: job.abort.signal,
      }).catch((err) => {
        if (!job.abort.signal.aborted) {
          console.warn("Claim heartbeat:", err);
          if (err.status === 410) job.abort.abort(err);
        }
      }),
    20000,
  );
  job.peer = new PeerLink(
    spaceID,
    "receiver",
    job.token,
    receivedSpace.expires,
  );
  return job;
}
async function endJob(job, completed) {
  clearInterval(job.heartbeat);
  job.peer?.close();
  if (completed) {
    try {
      await api(`/api/spaces/${spaceID}/complete`, {
        method: "POST",
        credential: job.token,
      });
    } catch (err) {
      console.warn("Complete pickup:", err);
      message(err.message, true);
    }
  }
  downloadJob = null;
  $("cancel-download").hidden = true;
  renderReceiver();
}
$("cancel-download").onclick = () =>
  downloadJob?.abort.abort(new DOMException(t("cancelled"), "AbortError"));

async function downloadFile(index) {
  const file = receivedSpace.files[index];
  let writer, job;
  try {
    if (window.showSaveFilePicker) {
      const handle = await showSaveFilePicker({ suggestedName: file.name });
      writer = await handle.createWritable();
    }
    job = await beginJob();
    if (!writer) {
      nativeDownload(
        `/api/spaces/${spaceID}/files/${index}?claim=${job.token}&native=1`,
      );
      $("download-status").textContent = t("browserSave");
      await endJob(job, false);
      return;
    }
    let next = 0,
      received = 0;
    $("download-progress").hidden = false;
    $("download-progress").value = 0;
    async function worker() {
      while (next < file.size) {
        if (job.abort.signal.aborted) throw job.abort.signal.reason;
        const offset = next,
          length = Math.min(1024 ** 2, file.size - offset);
        next += length;
        const bytes = await fetchBlock(job, index, offset, length);
        await writer.write({ type: "write", position: offset, data: bytes });
        received += length;
        $("download-progress").value = file.size ? received / file.size : 1;
      }
    }
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () => worker()),
    );
    const failure = results.find((r) => r.status === "rejected");
    if (failure) throw failure.reason;
    await writer.close();
    writer = null;
    $("download-status").textContent = t("saved");
    await endJob(job, true);
    job = null;
  } catch (err) {
    if (writer) {
      await writer.abort().catch((e) => console.warn("Abort file save:", e));
    }
    if (job) await endJob(job, false);
    $("download-status").textContent =
      err.name === "AbortError"
        ? t("cancelled")
        : `${t("failed")}: ${err.message}`;
  }
}

async function fetchBlock(job, index, offset, length) {
  const direct = job.peer.block(index, offset, length, job.abort.signal);
  if (direct) {
    try {
      const bytes = await direct;
      $("download-status").textContent = t("peer");
      return bytes;
    } catch (err) {
      if (job.abort.signal.aborted) throw err;
      console.warn(
        "Direct transfer interrupted; resuming from stored bytes:",
        err,
      );
    }
  }
  while (!job.abort.signal.aborted) {
    try {
      $("download-status").textContent = t("server");
      const response = await fetch(`/api/spaces/${spaceID}/files/${index}`, {
        headers: {
          Authorization: `Bearer ${job.token}`,
          Range: `bytes=${offset}-${offset + length - 1}`,
        },
        signal: AbortSignal.any([job.abort.signal, AbortSignal.timeout(90000)]),
        cache: "no-store",
      });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }
      const data = new Uint8Array(await response.arrayBuffer());
      if (data.length !== length) throw new Error("Incomplete download block");
      return data;
    } catch (err) {
      if (job.abort.signal.aborted) throw job.abort.signal.reason;
      if (err.status && err.status < 500) {
        job.abort.abort(err);
        throw err;
      }
      console.warn("Stored download retry:", err);
      $("download-status").textContent = t("retry");
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
  throw job.abort.signal.reason;
}
function nativeDownload(url) {
  const frame = element("iframe", "download-frame");
  frame.src = url;
  document.body.append(frame);
}
$("download-all").onclick = async () => {
  if (receivedSpace.files.length === 1) {
    await downloadFile(0);
    return;
  }
  let job;
  try {
    job = await beginJob();
    nativeDownload(
      `/api/spaces/${spaceID}/archive?claim=${job.token}&native=1`,
    );
    $("download-status").textContent = t("browserSave");
    await endJob(job, false);
  } catch (err) {
    if (job) await endJob(job, false);
    message(err.message, true);
  }
};

window.addEventListener("beforeunload", (event) => {
  if ([...senders.values()].some((s) => s.running) || downloadJob) {
    event.preventDefault();
    event.returnValue = "";
  }
});
translate();
startGalaxy($("galaxy"))
  .then((background) => {
    galaxy = background;
    galaxy.setWarp([...senders.values()].some((s) => s.running));
  })
  .catch((err) => {
    console.error("Galaxy background:", err);
    message(err.message, true);
  });
if (spaceID) {
  $("send-view").hidden = true;
  $("receive-view").hidden = false;
  await refreshReceiver();
  receiverPoll = setInterval(refreshReceiver, 2500);
} else {
  for (const record of history) {
    if (Date.parse(record.expires) > Date.now())
      api(`/api/spaces/${record.id}`)
        .then((sp) => updateRecord(record.id, sp))
        .catch((err) => {
          if (err.status === 410) updateRecord(record.id, { expired: true });
          else console.warn("Refresh saved space:", err);
        });
  }
}
