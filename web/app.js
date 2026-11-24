const $ = (id) => document.getElementById(id);
const dictionaries = {
  zh: { title:'文件，随手分享。', intro:'拖入文件，复制链接。对方立即开始接收。', drop:'把文件拖到这里', browse:'或点击选择文件', limit:'支持多文件 · 单文件最大 10 GiB', settings:'分享设置', expiry:'保留时间', claims:'最多领取', hour1:'60 分钟', hour2:'2 小时', hour6:'6 小时', hour12:'12 小时', hour24:'24 小时', recent:'最近的空间', empty:'分享过的文件会显示在这里。', receive:'文件已为你准备好。', downloadAll:'下载全部', download:'下载', cancel:'取消下载', copy:'复制链接', copied:'已复制', uploading:'正在上传', ready:'上传完成，可以关闭页面', paused:'上传暂停，点击继续上传', resume:'继续上传', expired:'已过期或领取完毕', remove:'移除记录', files:'个文件', expires:'到期', received:'已领取', waiting:'等待上传', peer:'正在直连传输', server:'正在从服务器接收', retry:'连接中断，正在续传', saved:'下载完成', browserSave:'已交给浏览器下载，请查看浏览器的下载进度。', choose:'请选择原来的文件继续上传。', mismatch:'所选文件与原文件不一致，请选择同名且大小相同的文件。', tooLarge:'单文件不能超过 10 GiB。', failed:'操作失败', cancelled:'已取消', restore:'重新选择原文件后可继续上传', receiving:'正在下载', claimLimit:'领取次数已用完', browserUnavailable:'当前浏览器不支持 P2P，使用服务器传输。', insecure:'请使用 HTTPS 打开，以启用直连和文件保存。' },
  en: { title:'Files, freely shared.', intro:'Drop your files. Copy the link. They can start right away.', drop:'Drop your files here', browse:'or choose files', limit:'Multiple files · Up to 10 GiB per file', settings:'Share settings', expiry:'Keep files for', claims:'Maximum pickups', hour1:'60 minutes', hour2:'2 hours', hour6:'6 hours', hour12:'12 hours', hour24:'24 hours', recent:'Recent spaces', empty:'Your shared files will appear here.', receive:'Your files are here.', downloadAll:'Download all', download:'Download', cancel:'Cancel download', copy:'Copy link', copied:'Copied', uploading:'Uploading', ready:'Uploaded. You can close this page.', paused:'Upload paused. Continue when ready.', resume:'Resume upload', expired:'Expired or pickup limit reached', remove:'Remove', files:'files', expires:'Expires', received:'Pickups', waiting:'Waiting for upload', peer:'Receiving directly', server:'Receiving from server', retry:'Connection interrupted. Resuming…', saved:'Download complete', browserSave:'Download handed to your browser. Check its download progress.', choose:'Choose the original files to resume uploading.', mismatch:'Choose the original files with matching names and sizes.', tooLarge:'Each file must be at most 10 GiB.', failed:'Operation failed', cancelled:'Cancelled', restore:'Choose the original files to resume', receiving:'Downloading', claimLimit:'Pickup limit reached', browserUnavailable:'P2P is unavailable in this browser. Using the server.', insecure:'Open with HTTPS to enable direct transfer and file saving.' }
};
let lang = localStorage.getItem('quickfile.language') || (navigator.language.startsWith('zh') ? 'zh' : 'en');
if (!dictionaries[lang]) lang = 'en';
const t = (key) => dictionaries[lang][key] || key;
let history = JSON.parse(localStorage.getItem('quickfile.spaces') || '[]');
const senders = new Map();
let resumeID = null;
let receivedSpace = null;
let downloadJob = null;
const spaceID = location.pathname.match(/^\/s\/([a-f0-9]{48})$/)?.[1];

function translate() {
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  $('language').textContent = lang === 'zh' ? 'English' : '简体中文';
  renderHistory();
  if (receivedSpace) renderReceiver();
}
$('language').onclick = () => { lang = lang === 'zh' ? 'en' : 'zh'; localStorage.setItem('quickfile.language', lang); translate(); };
const size = (n) => n < 1024 ? `${n} B` : `${(n / 1024 ** Math.floor(Math.log(n) / Math.log(1024))).toFixed(1)} ${['B','KiB','MiB','GiB'][Math.floor(Math.log(n) / Math.log(1024))]}`;
const link = (id) => `${location.origin}/s/${id}`;
function message(text, error = false) { $('message').textContent = text; $('message').classList.toggle('error', error); }
function saveHistory() { localStorage.setItem('quickfile.spaces', JSON.stringify(history)); }
function token() { return [...crypto.getRandomValues(new Uint8Array(24))].map((v) => v.toString(16).padStart(2,'0')).join(''); }
function element(tag, className, text) { const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = text; return el; }
function button(text, action, className = 'secondary small') { const el = element('button', className, text); el.type = 'button'; el.onclick = action; return el; }
async function api(path, { method = 'GET', body, credential, signal } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (credential) headers.Authorization = `Bearer ${credential}`;
  const response = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal, cache:'no-store' });
  if (!response.ok) { const data = await response.json().catch(() => ({})); const error = new Error(data.error || `HTTP ${response.status}`); error.status = response.status; throw error; }
  return response.status === 204 ? null : response.json();
}
function updateRecord(id, changes) { const record = history.find((s) => s.id === id); if (record) { Object.assign(record, changes); saveHistory(); renderHistory(); } }
function renderHistory() {
  $('history').replaceChildren();
  $('empty-history').hidden = history.length > 0;
  for (const record of history) {
    const card = element('article','space-card');
    const heading = element('div','space-heading');
    const name = element('div','space-name'); const a = element('a','',record.files.length === 1 ? record.files[0].name : `${record.files.length} ${t('files')}`); a.href = link(record.id); name.append(a);
    const copy = button(t('copy'), async () => { try { await navigator.clipboard.writeText(link(record.id)); copy.textContent = t('copied'); } catch (err) { message(`${t('failed')}: ${err.message}`,true); } });
    const expired = record.expired || Date.now() >= Date.parse(record.expires);
    copy.disabled = expired;
    heading.append(name,copy); card.append(heading);
    card.append(element('div','space-meta',`${size(record.files.reduce((n,f) => n + f.size,0))} · ${t('expires')} ${new Date(record.expires).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en')}`));
    const total = record.files.reduce((n,f) => n + f.size,0), uploaded = record.files.reduce((n,f) => n + f.uploaded,0);
    const active = senders.get(record.id);
    const status = expired ? t('expired') : uploaded >= total ? t('ready') : active?.running ? `${t('uploading')} ${Math.floor(uploaded / total * 100)}%` : t('paused');
    card.append(element('div','space-meta',status));
    if (!expired && uploaded < total) { const progress = element('progress'); progress.max = total; progress.value = uploaded; card.append(progress); }
    const actions = element('div','actions');
    if (!expired && uploaded < total && !active?.running) actions.append(button(t('resume'), () => { if (active) uploadSpace(record,active.files); else { resumeID = record.id; message(t('choose')); $('files').click(); } }));
    if (expired) actions.append(button(t('remove'),() => { history = history.filter((s) => s.id !== record.id); saveHistory(); renderHistory(); },'quiet'));
    card.append(actions); $('history').append(card);
  }
}

$('dropzone').onclick = () => { resumeID = null; $('files').click(); };
$('dropzone').ondragover = (event) => { event.preventDefault(); $('dropzone').classList.add('dragging'); };
$('dropzone').ondragleave = () => $('dropzone').classList.remove('dragging');
$('dropzone').ondrop = (event) => { event.preventDefault(); $('dropzone').classList.remove('dragging'); resumeID = null; chooseFiles([...event.dataTransfer.files]); };
$('files').onchange = () => { const files = [...$('files').files]; $('files').value = ''; chooseFiles(files); };

async function chooseFiles(files) {
  if (!files.length) return;
  try {
    if (files.some((f) => f.size > 10 * 1024 ** 3)) throw new Error(t('tooLarge'));
    if (resumeID) {
      const record = history.find((s) => s.id === resumeID);
      const matched = record.files.map((f) => files.find((v) => v.name === f.name && v.size === f.size));
      if (matched.some((v) => !v)) throw new Error(t('mismatch'));
      resumeID = null; await uploadSpace(record,matched); return;
    }
    $('dropzone').disabled = true;
    const data = await api('/api/spaces', { method:'POST', body:{ files: files.map((f) => ({name:f.name,size:f.size})), hours:Number($('hours').value), maxDownloads:Number($('claims').value) } });
    const record = { ...data.space, owner:data.owner };
    history.unshift(record); saveHistory(); renderHistory();
    message('');
    await uploadSpace(record,files);
  } catch (err) { message(`${t('failed')}: ${err.message}`,true); }
  finally { $('dropzone').disabled = false; }
}

async function uploadSpace(record,files) {
  let sender = senders.get(record.id);
  if (!sender) { sender = {files,running:false,signal:null}; senders.set(record.id,sender); }
  if (sender.running) return;
  sender.files = files; sender.running = true; renderHistory();
  try {
    const fresh = await api(`/api/spaces/${record.id}`); Object.assign(record,fresh);
    if (!sender.signal) sender.signal = new PeerLink(record.id,'sender',record.owner,files);
    let nextFile = 0;
    async function worker() {
      while (nextFile < files.length) {
        const index = nextFile++, file = files[index];
        while (record.files[index].uploaded < file.size) {
          const offset = record.files[index].uploaded;
          const part = file.slice(offset, Math.min(offset + 4 * 1024 ** 2,file.size));
          let response;
          try { response = await fetch(`/api/spaces/${record.id}/files/${index}`, { method:'PATCH', headers:{Authorization:`Bearer ${record.owner}`,'Upload-Offset':String(offset)}, body:part }); }
          catch (err) { throw new Error(`${t('paused')}: ${err.message}`); }
          const data = await response.json();
          if (response.status === 409) { record.files[index].uploaded = data.uploaded; continue; }
          if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
          record.files[index].uploaded = data.uploaded; saveHistory(); renderHistory();
        }
      }
    }
    const results = await Promise.allSettled([worker(),worker()]);
    const failed = results.find((r) => r.status === 'rejected');
    if (failed) throw failed.reason;
  } catch (err) { if (err.status === 410) record.expired = true; message(`${t('failed')}: ${err.message}`,true); }
  finally { sender.running = false; saveHistory(); renderHistory(); }
}

class PeerLink {
  constructor(id,role,credential,files = null) {
    this.id=id; this.role=role; this.credential=credential; this.files=files;
    this.connections=new Map(); this.pending=new Map(); this.serial=0; this.closed=false; this.channel=null;
    if (!globalThis.RTCPeerConnection) { console.info(t('browserUnavailable')); return; }
    this.open();
  }
  open() {
    const url = new URL(`/api/spaces/${this.id}/ws`,location.origin); url.protocol=location.protocol==='https:'?'wss:':'ws:'; url.searchParams.set('role',this.role); url.searchParams.set('token',this.credential);
    this.ws = new WebSocket(url);
    this.ws.onmessage = (event) => this.signal(JSON.parse(event.data)).catch((err) => console.warn('P2P signaling:',err));
    this.ws.onclose = () => { if (!this.closed) this.reconnect=setTimeout(() => this.open(),3000); };
    this.ws.onerror = () => console.warn('P2P signaling disconnected; stored transfer remains available.');
  }
  send(type,peer,data) { if (this.ws?.readyState===WebSocket.OPEN) this.ws.send(JSON.stringify({type,peer,data})); }
  connection(peer,offer = false) {
    if (this.connections.has(peer)) return this.connections.get(peer);
    const pc = new RTCPeerConnection({iceServers:[{urls:'stun:stun.l.google.com:19302'}]});
    pc.queuedICE=[]; this.connections.set(peer,pc);
    pc.onicecandidate = (e) => { if (e.candidate) this.send('ice',peer,e.candidate); };
    pc.onconnectionstatechange = () => { if (['failed','closed'].includes(pc.connectionState)) { this.connections.delete(peer); pc.close(); } };
    if (offer) this.attach(pc.createDataChannel('file'));
    else pc.ondatachannel = (e) => this.attach(e.channel);
    return pc;
  }
  async signal(msg) {
    if (msg.type==='peer' && this.role==='sender') {
      const old=this.connections.get(msg.peer); if (old) { old.close(); this.connections.delete(msg.peer); }
      const pc=this.connection(msg.peer,true); await pc.setLocalDescription(await pc.createOffer()); this.send('offer',msg.peer,pc.localDescription); return;
    }
    const pc=this.connection(msg.peer);
    if (msg.type==='ice') { if (pc.remoteDescription) await pc.addIceCandidate(msg.data); else pc.queuedICE.push(msg.data); return; }
    if (msg.type==='offer' || msg.type==='answer') {
      await pc.setRemoteDescription(msg.data);
      for (const ice of pc.queuedICE.splice(0)) await pc.addIceCandidate(ice);
      if (msg.type==='offer') { await pc.setLocalDescription(await pc.createAnswer()); this.send('answer',msg.peer,pc.localDescription); }
    }
  }
  attach(channel) {
    channel.binaryType='arraybuffer'; channel.bufferedAmountLowThreshold=256*1024;
    if (this.role!=='sender') {
      channel.onopen=() => { this.channel=channel; };
      channel.onclose=() => { if (this.channel===channel) this.channel=null; for (const p of this.pending.values()) p.reject(new Error('P2P connection closed')); this.pending.clear(); };
    }
    channel.onmessage=async (event) => {
      try {
        if (this.role==='sender') { await this.provide(channel,JSON.parse(event.data)); return; }
        if (typeof event.data==='string') { const msg=JSON.parse(event.data); const p=this.pending.get(msg.id); if (p) { this.pending.delete(msg.id); p.reject(new Error(msg.error)); } return; }
        const frame=new DataView(event.data); const id=frame.getUint32(0), offset=frame.getUint32(4); const p=this.pending.get(id); if (!p) return;
        const data=new Uint8Array(event.data,8);
        if (offset!==p.received || offset+data.byteLength>p.bytes.length) throw new Error('Invalid P2P block');
        p.bytes.set(data,offset); p.received+=data.byteLength;
        if (p.received===p.bytes.length) { this.pending.delete(id); p.resolve(p.bytes); }
      } catch (err) { console.warn('P2P transfer:',err); channel.close(); }
    };
  }
  async provide(channel,msg) {
    const file=this.files?.[msg.file];
    if (!file || !Number.isInteger(msg.id) || !Number.isSafeInteger(msg.offset) || !Number.isSafeInteger(msg.length) || msg.offset<0 || msg.length<=0 || msg.length>1024**2 || msg.offset+msg.length>file.size) { channel.close(); return; }
    const data=new Uint8Array(await file.slice(msg.offset,msg.offset+msg.length).arrayBuffer());
    for (let offset=0;offset<data.length;offset+=16384) {
      if (channel.readyState!=='open') return;
      if (channel.bufferedAmount>1024**2) await new Promise((resolve,reject) => { const ready=() => { cleanup(); resolve(); }; const closed=() => { cleanup(); reject(new Error('P2P closed')); }; const cleanup=() => { channel.removeEventListener('bufferedamountlow',ready); channel.removeEventListener('close',closed); }; channel.addEventListener('bufferedamountlow',ready,{once:true}); channel.addEventListener('close',closed,{once:true}); });
      const part=data.subarray(offset,offset+16384), frame=new ArrayBuffer(part.length+8); const view=new DataView(frame); view.setUint32(0,msg.id); view.setUint32(4,offset); new Uint8Array(frame,8).set(part); channel.send(frame);
    }
  }
  block(file,offset,length,signal) {
    if (this.channel?.readyState!=='open') return null;
    const id=++this.serial;
    return new Promise((resolve,reject) => {
      const abort=() => { this.pending.delete(id); reject(signal.reason); };
      const timer=setTimeout(() => { this.pending.delete(id); signal.removeEventListener('abort',abort); reject(new Error('P2P block timed out')); this.channel?.close(); },15000);
      const cleanup=() => { clearTimeout(timer); signal.removeEventListener('abort',abort); };
      this.pending.set(id,{bytes:new Uint8Array(length),received:0,resolve:(v) => {cleanup();resolve(v);},reject:(e) => {cleanup();reject(e);}});
      signal.addEventListener('abort',abort,{once:true});
      this.channel.send(JSON.stringify({id,file,offset,length}));
    });
  }
  close() { this.closed=true; clearTimeout(this.reconnect); this.ws?.close(); for (const pc of this.connections.values()) pc.close(); }
}

function renderReceiver() {
  const sp=receivedSpace;
  $('receive-info').textContent=`${sp.files.length} ${t('files')} · ${size(sp.files.reduce((n,f) => n+f.size,0))} · ${t('received')} ${sp.downloads}/${sp.maxDownloads}`;
  $('receive-files').replaceChildren();
  sp.files.forEach((file,index) => {
    const row=element('div','file-row'), info=element('div','file-info'); info.append(element('div','file-name',file.name));
    info.append(element('div','file-size',`${size(file.size)}${file.uploaded<file.size ? ` · ${t('uploading')} ${Math.floor(file.uploaded/file.size*100)}%` : ''}`));
    const download=button(t('download'),() => downloadFile(index)); download.disabled=!!downloadJob; row.append(info,download); $('receive-files').append(row);
  });
  $('download-all').hidden=sp.files.length<2; $('download-all').disabled=!!downloadJob;
}
async function refreshReceiver() {
  try { receivedSpace=await api(`/api/spaces/${spaceID}`); renderReceiver(); }
  catch(err) { message(err.status===410?t('expired'):err.message,true); if(err.status===410) { clearInterval(receiverPoll); $('download-all').disabled=true; $('receive-files').querySelectorAll('button').forEach((b) => b.disabled=true); } }
}
let receiverPoll;
async function beginJob() {
  if(downloadJob) throw new Error(t('receiving'));
  const job={token:token(),abort:new AbortController(),peer:null,heartbeat:null};
  downloadJob=job; renderReceiver(); $('cancel-download').hidden=false;
  try { await api(`/api/spaces/${spaceID}/claims`,{method:'POST',body:{token:job.token}}); }
  catch(err) { downloadJob=null; $('cancel-download').hidden=true; renderReceiver(); throw err; }
  job.heartbeat=setInterval(() => api(`/api/spaces/${spaceID}/heartbeat`,{method:'POST',credential:job.token,signal:job.abort.signal}).catch((err) => { if(!job.abort.signal.aborted) { console.warn('Claim heartbeat:',err); if(err.status===410) job.abort.abort(err); } }),20000);
  job.peer=new PeerLink(spaceID,'receiver',job.token);
  return job;
}
async function endJob(job,completed) {
  clearInterval(job.heartbeat); job.peer?.close();
  if(completed) { try { await api(`/api/spaces/${spaceID}/complete`,{method:'POST',credential:job.token}); } catch(err) { console.warn('Complete pickup:',err); message(err.message,true); } }
  downloadJob=null; $('cancel-download').hidden=true; renderReceiver();
}
$('cancel-download').onclick=() => downloadJob?.abort.abort(new DOMException(t('cancelled'),'AbortError'));

async function downloadFile(index) {
  const file=receivedSpace.files[index]; let writer,job;
  try {
    if(window.showSaveFilePicker) { const handle=await showSaveFilePicker({suggestedName:file.name}); writer=await handle.createWritable(); }
    job=await beginJob();
    if(!writer) { nativeDownload(`/api/spaces/${spaceID}/files/${index}?claim=${job.token}&native=1`); $('download-status').textContent=t('browserSave'); await endJob(job,false); return; }
    let next=0,received=0;
    $('download-progress').hidden=false; $('download-progress').value=0;
    async function worker() {
      while(next<file.size) {
        if(job.abort.signal.aborted) throw job.abort.signal.reason;
        const offset=next,length=Math.min(1024**2,file.size-offset); next+=length;
        const bytes=await fetchBlock(job,index,offset,length);
        await writer.write({type:'write',position:offset,data:bytes}); received+=length;
        $('download-progress').value=file.size?received/file.size:1;
      }
    }
    const results=await Promise.allSettled(Array.from({length:4},() => worker()));
    const failure=results.find((r) => r.status==='rejected'); if(failure) throw failure.reason;
    await writer.close(); writer=null; $('download-status').textContent=t('saved'); await endJob(job,true); job=null;
  } catch(err) { if(writer) { await writer.abort().catch((e) => console.warn('Abort file save:',e)); } if(job) await endJob(job,false); $('download-status').textContent=err.name==='AbortError'?t('cancelled'):`${t('failed')}: ${err.message}`; }
}

async function fetchBlock(job,index,offset,length) {
  const direct=job.peer.block(index,offset,length,job.abort.signal);
  if(direct) { try { const bytes=await direct; $('download-status').textContent=t('peer'); return bytes; } catch(err) { if(job.abort.signal.aborted) throw err; console.warn('Direct transfer interrupted; resuming from stored bytes:',err); } }
  while(!job.abort.signal.aborted) {
    try {
      $('download-status').textContent=t('server');
      const response=await fetch(`/api/spaces/${spaceID}/files/${index}`,{headers:{Authorization:`Bearer ${job.token}`,Range:`bytes=${offset}-${offset+length-1}`},signal:AbortSignal.any([job.abort.signal,AbortSignal.timeout(90000)]),cache:'no-store'});
      if(!response.ok) { const error=new Error(`HTTP ${response.status}`); error.status=response.status; throw error; }
      const data=new Uint8Array(await response.arrayBuffer()); if(data.length!==length) throw new Error('Incomplete download block'); return data;
    } catch(err) {
      if(job.abort.signal.aborted) throw job.abort.signal.reason;
      if(err.status && err.status<500) { job.abort.abort(err); throw err; }
      console.warn('Stored download retry:',err); $('download-status').textContent=t('retry');
      await new Promise((resolve) => setTimeout(resolve,1500));
    }
  }
  throw job.abort.signal.reason;
}
function nativeDownload(url) { const frame=element('iframe','download-frame'); frame.src=url; document.body.append(frame); }
$('download-all').onclick=async () => {
  let job;
  try { job=await beginJob(); nativeDownload(`/api/spaces/${spaceID}/archive?claim=${job.token}&native=1`); $('download-status').textContent=t('browserSave'); await endJob(job,false); }
  catch(err) { if(job) await endJob(job,false); message(err.message,true); }
};

window.addEventListener('beforeunload',(event) => { if([...senders.values()].some((s) => s.running)||downloadJob) { event.preventDefault(); event.returnValue=''; } });
translate();
if(spaceID) { $('send-view').hidden=true; $('receive-view').hidden=false; await refreshReceiver(); receiverPoll=setInterval(refreshReceiver,2500); }
else { for(const record of history) { if(Date.parse(record.expires)>Date.now()) api(`/api/spaces/${record.id}`).then((sp) => updateRecord(record.id,sp)).catch((err) => { if(err.status===410) updateRecord(record.id,{expired:true}); else console.warn('Refresh saved space:',err); }); } }
