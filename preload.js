const { contextBridge, ipcRenderer, webUtils } = require('electron');

// What the window remembers. Loaded in one go before the page runs, and every change is sent to the
// main process and written to disk before the call returns (ui-store.js), so nothing is lost if the app
// is killed a moment later. Replaces the page's own localStorage, which is flushed late.
const memory = new Map(Object.entries(ipcRenderer.sendSync('store:load') || {}));
try {
  // Anything the old storage held is moved across once.
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith('mw:')) continue;
    const v = localStorage.getItem(k);
    if (v !== null && !memory.has(k) && ipcRenderer.sendSync('store:set', k, v)) memory.set(k, v);
    localStorage.removeItem(k);
  }
} catch { /* no old storage to move */ }
contextBridge.exposeInMainWorld('mwStore', {
  getItem: (k) => (memory.has(k) ? memory.get(k) : null),
  setItem: (k, v) => {
    const value = String(v);
    if (memory.get(k) === value) return;
    if (ipcRenderer.sendSync('store:set', k, value)) memory.set(k, value);
  },
  removeItem: (k) => {
    if (!memory.has(k)) return;
    if (ipcRenderer.sendSync('store:remove', k)) memory.delete(k);
  },
});

contextBridge.exposeInMainWorld('mw', {
  platform: process.platform,
  onWindowSquare: (cb) => ipcRenderer.on('window:square', (_e, square) => cb(square)),
  cliState: () => ipcRenderer.invoke('cli:state'),
  cliInstall: () => ipcRenderer.invoke('cli:install'),
  close: () => ipcRenderer.send('window:close'),
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  openExternal: (url) => ipcRenderer.send('link:open', url),
  openFile: (filePath, line) => ipcRenderer.invoke('file:open', filePath, line),
  openWith: (full, how) => ipcRenderer.invoke('file:openWith', full, how),
  checkPaths: (list) => ipcRenderer.invoke('paths:check', list),

  getInitialState: () => ipcRenderer.invoke('app:init'),
  openProject: () => ipcRenderer.invoke('project:open'),
  switchProject: (cwd) => ipcRenderer.invoke('project:switchTo', cwd),
  newSession: () => ipcRenderer.invoke('session:new'),
  switchSession: (id) => ipcRenderer.invoke('session:switch', id),
  renameProject: (cwd, name) => ipcRenderer.invoke('project:rename', cwd, name),
  forgetProject: (cwd) => ipcRenderer.invoke('project:forget', cwd),
  sessionReplay: () => ipcRenderer.invoke('session:replay'),
  pinSession: (id, pinned) => ipcRenderer.invoke('session:pin', id, pinned),
  renameSession: (id, name) => ipcRenderer.invoke('session:rename', id, name),

  chatSend: (text, filePaths, pastes, marathon) => ipcRenderer.send('chat:send', { text, filePaths, pastes, marathon: !!marathon }),
  marathonGet: () => ipcRenderer.invoke('marathon:get'),
  marathonResume: () => ipcRenderer.invoke('marathon:resume'),
  marathonClear: () => ipcRenderer.invoke('marathon:clear'),
  peekFile: (filePath) => ipcRenderer.invoke('file:peek', filePath),
  saveTempFile: (name, bytes) => ipcRenderer.invoke('file:saveTemp', { name, bytes }),
  chatCancel: () => ipcRenderer.send('chat:cancel'),
  chatContinue: () => ipcRenderer.invoke('chat:continue'),
  onChatEvent: (cb) => {
    const listener = (_event, data) => cb(data);
    ipcRenderer.on('chat:event', listener);
    return () => ipcRenderer.removeListener('chat:event', listener);
  },
  feedGet: () => ipcRenderer.invoke('feed:get'),
  feedRefresh: () => ipcRenderer.invoke('feed:refresh'),
  feedMarkRead: (ids) => ipcRenderer.invoke('feed:markRead', ids),
  onFeedUpdated: (cb) => {
    const listener = (_event, data) => cb(data);
    ipcRenderer.on('feed:updated', listener);
    return () => ipcRenderer.removeListener('feed:updated', listener);
  },
  updateGet: () => ipcRenderer.invoke('update:get'),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateStart: () => ipcRenderer.invoke('update:start'),
  updateRestart: () => ipcRenderer.invoke('update:restart'),
  onUpdateChanged: (cb) => {
    const listener = (_event, data) => cb(data);
    ipcRenderer.on('update:changed', listener);
    return () => ipcRenderer.removeListener('update:changed', listener);
  },
  approvalRespond: (id, choice) => ipcRenderer.send('approval:respond', { id, choice }),

  listShells: () => ipcRenderer.invoke('shells:list'),
  runStatus: () => ipcRenderer.invoke('run:status'),
  getPrefs: () => ipcRenderer.invoke('prefs:get'),
  contextFill: () => ipcRenderer.invoke('context:get'),
  compactNow: () => ipcRenderer.invoke('context:compact'),
  queuePull: () => ipcRenderer.invoke('queue:pull'),
  queueSendNow: () => ipcRenderer.invoke('queue:sendNow'),
  getAnalytics: () => ipcRenderer.invoke('analytics:get'),
  setAnalytics: (on) => ipcRenderer.invoke('analytics:set', on),
  feedbackInfo: () => ipcRenderer.invoke('feedback:info'),
  sendFeedback: (text) => ipcRenderer.invoke('feedback:send', text),
  setPrefs: (next) => ipcRenderer.invoke('prefs:set', next),
  getUserNotes: () => ipcRenderer.invoke('notes:get'),
  saveUserNotes: (text) => ipcRenderer.invoke('notes:save', text),
  pickUserNotes: () => ipcRenderer.invoke('notes:pick'),
  runToggle: () => ipcRenderer.invoke('run:toggle'),
  runSet: (command, dir) => ipcRenderer.invoke('run:set', { command, dir }),
  runClear: () => ipcRenderer.invoke('run:clear'),
  killShell: (id) => ipcRenderer.invoke('shells:kill', id),
  shellLog: (id) => ipcRenderer.invoke('shells:log', id),
  onShellsChanged: (cb) => {
    const listener = (_event, list) => cb(list);
    ipcRenderer.on('shells:changed', listener);
    return () => ipcRenderer.removeListener('shells:changed', listener);
  },

  listProviders: () => ipcRenderer.invoke('providers:list'),
  modelPicker: (providerId) => ipcRenderer.invoke('models:picker', providerId),
  providerDetail: (id) => ipcRenderer.invoke('providers:detail', id),
  providerKeys: (id) => ipcRenderer.invoke('keys:get', id),
  permissions: (cwd) => ipcRenderer.invoke('perm:get', cwd),
  getDraft: (cwd) => ipcRenderer.invoke('draft:get', cwd),
  rewindPoints: () => ipcRenderer.invoke('rewind:points'),
  recording: (live) => ipcRenderer.invoke('rec:get', live),
  rewindTo: (at, mode) => ipcRenderer.invoke('rewind:to', { at, mode }),
  setDraft: (cwd, draft) => ipcRenderer.invoke('draft:set', { cwd, draft }),
  setDraftSync: (cwd, draft) => ipcRenderer.sendSync('draft:setSync', { cwd, draft }),
  quickTabs: () => ipcRenderer.invoke('qt:get'),
  setQuickTabs: (pins) => ipcRenderer.invoke('qt:set', pins),
  rsList: (cwd) => ipcRenderer.invoke('rs:list', cwd),
  rsRead: (file, cwd) => ipcRenderer.invoke('rs:read', { file, cwd }),
  rsImport: (files, scope, cwd) => ipcRenderer.invoke('rs:import', { files, scope, cwd }),
  rsAction: (action, args = {}) => ipcRenderer.invoke('rs:act', { action, ...args }),
  permAction: (action, args = {}) => ipcRenderer.invoke('perm:act', { action, ...args }),
  permPick: (cwd, folder) => ipcRenderer.invoke('perm:pick', { cwd, folder }),
  ctxGet: (cwd) => ipcRenderer.invoke('ctx:get', cwd),
  ctxAction: (action, args = {}) => ipcRenderer.invoke('ctx:act', { action, ...args }),
  spendGet: (force) => ipcRenderer.invoke('spend:get', { force }),
  limitsGet: (force) => ipcRenderer.invoke('limits:get', { force }),
  limitsSave: (patch) => ipcRenderer.invoke('limits:save', patch),
  limitsAnalyze: (input) => ipcRenderer.invoke('limits:analyze', input),
  mcpList: () => ipcRenderer.invoke('mcp:list'),
  mcpDetail: (name) => ipcRenderer.invoke('mcp:detail', name),
  mcpAction: (action, args = {}) => ipcRenderer.invoke('mcp:act', { action, ...args }),
  onMcpChanged: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('mcp:changed', listener);
    return () => ipcRenderer.removeListener('mcp:changed', listener);
  },
  onMcpSignInUrl: (cb) => {
    const listener = (_event, data) => cb(data);
    ipcRenderer.on('mcp:signInUrl', listener);
    return () => ipcRenderer.removeListener('mcp:signInUrl', listener);
  },
  keyAction: (id, action, args = {}) => ipcRenderer.invoke('keys:act', { id, action, ...args }),
  setProviderKey: (apiKeyEnv, key) => ipcRenderer.invoke('providers:setKey', { apiKeyEnv, key }),
  clearProviderKey: (apiKeyEnv) => ipcRenderer.invoke('providers:clearKey', apiKeyEnv),
  setModel: (modelId) => ipcRenderer.invoke('model:set', modelId),
  setThinking: (level) => ipcRenderer.invoke('thinking:set', level),
  listModes: () => ipcRenderer.invoke('mode:list'),
  setMode: (id) => ipcRenderer.invoke('mode:set', id),

  // A <input type=file>'s File object carries no real filesystem path in the
  // renderer (Electron strips it for security) — this is the one sanctioned way
  // to get it back, so attachments can be resolved to real ImageRefs in main.js.
  pathForFile: (file) => webUtils.getPathForFile(file),
});
