import { ContextGuard, StaleContextError, identityKey, resolveContextIdentity } from './context.mjs';

const API_ROOT = '/api/plugins/trio-second-life';
const POSITION_KEY = 'trio-second-life:orb-position:v1';
const guard = new ContextGuard();
let mounted = false;
let save = null;
let activeIdentityKey = '';
let currentView = 'farm';
let panelElements = null;

class ApiError extends Error {
  constructor(status, code, details) { super(code); this.status = status; this.code = code; this.details = details; }
}

function currentIdentity() {
  return resolveContextIdentity(SillyTavern.getContext());
}

async function api(path, options = {}) {
  const context = SillyTavern.getContext();
  const baseHeaders = typeof context.getRequestHeaders === 'function' ? context.getRequestHeaders() : {};
  const { signal = guard.signal, ...fetchOptions } = options;
  const response = await fetch(API_ROOT + path, {
    credentials: 'same-origin',
    ...fetchOptions,
    signal,
    headers: { 'Content-Type': 'application/json', ...baseHeaders, ...(fetchOptions.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, body.error || 'HTTP_' + response.status, body.details);
  return body;
}

async function ensureSave() {
  const identity = currentIdentity();
  if (!identity) throw new ApiError(409, 'NO_ACTIVE_CHAT');
  const key = identityKey(identity);
  if (save && activeIdentityKey === key) return save;
  const token = guard.capture(key);
  const initialized = await api('/saves/initialize', { method: 'POST', body: JSON.stringify(identity), signal: token.signal });
  guard.assertCurrent(token, identityKey(currentIdentity()));
  save = initialized;
  activeIdentityKey = key;
  return save;
}

function renderShell() {
  const root = document.createElement('section');
  root.id = 'trio-second-life-root';
  const menu = [['farm','牧场'], ['bag','背包'], ['home','家'], ['map','地图'], ['people','人物'], ['settings','设置']]
    .map(([view, name]) => '<button data-view="' + view + '">' + name + '</button>').join('');
  root.innerHTML = '<button class="tsl-orb" type="button" aria-label="打开三个村庄管理器">🌱</button>'
    + '<aside class="tsl-panel" hidden><header><strong>三个村庄：第二人生</strong><button class="tsl-close" type="button">×</button></header>'
    + '<nav>' + menu + '</nav><main><p>请选择一个有效聊天。</p></main>'
    + '<footer>资料状态：<b>DEMO</b> · 不发送或修改聊天消息</footer></aside>';
  document.body.append(root);
  const orb = root.querySelector('.tsl-orb');
  const panel = root.querySelector('.tsl-panel');
  const main = root.querySelector('main');
  panelElements = { root, orb, panel, main };
  restorePosition(root);
  root.querySelector('.tsl-close').addEventListener('click', () => { panel.hidden = true; });
  orb.addEventListener('click', async () => {
    if (orb.dataset.dragged === 'true') { orb.dataset.dragged = 'false'; return; }
    panel.hidden = !panel.hidden;
    if (!panel.hidden) { positionPanel(); await refreshCurrentView(); }
  });
  root.querySelector('nav').addEventListener('click', async event => {
    const button = event.target.closest('button[data-view]');
    if (!button) return;
    currentView = button.dataset.view;
    await refreshCurrentView();
  });
  makeDraggable(root, orb);
  addEventListener('resize', () => { constrainRoot(root); positionPanel(); });
}

async function refreshCurrentView() {
  if (!panelElements || panelElements.panel.hidden) return;
  const { main } = panelElements;
  try {
    await ensureSave();
    if (currentView === 'farm') await showFarm(main);
    else if (currentView === 'bag') await showInventory(main, 'bag');
    else if (currentView === 'home') await showInventory(main, 'home_storage');
    else main.innerHTML = '<h3>' + ({ map: '地图', people: '人物', settings: '设置' }[currentView] || '功能') + '</h3><p><b>未实现</b>：此菜单尚未接入正式业务接口。</p>';
  } catch (error) {
    if (error instanceof StaleContextError || error.name === 'AbortError') return;
    main.innerHTML = error.code === 'NO_ACTIVE_CHAT' ? '<p>当前没有有效聊天，经营操作已禁用。</p>' : '<p>连接失败：' + escapeHtml(error.code || error.message) + '</p>';
  }
  positionPanel();
}

async function showFarm(main) {
  const localSave = await ensureSave();
  const key = activeIdentityKey;
  const token = guard.capture(key);
  const world = await api('/world/current?saveId=' + encodeURIComponent(localSave.saveId), { signal: token.signal });
  guard.assertCurrent(token, activeIdentityKey);
  save = world;
  const hour = String(Math.floor(world.clock.minute_of_day / 60)).padStart(2, '0');
  const minute = String(world.clock.minute_of_day % 60).padStart(2, '0');
  const season = { spring: '春', summer: '夏', autumn: '秋', winter: '冬' }[world.clock.season] || world.clock.season;
  main.innerHTML = '<h3>牧场</h3><p>第 ' + world.clock.year + ' 年 ' + season + ' ' + world.clock.day + ' 日 ' + hour + ':' + minute + '</p>'
    + '<p>已浇水 ' + world.farm.watered + ' / ' + world.farm.planted + '</p>'
    + '<button class="tsl-primary">一键浇水</button><div class="tsl-result" aria-live="polite"></div>';
  main.querySelector('.tsl-primary').addEventListener('click', async event => {
    const button = event.currentTarget;
    const operationSave = save;
    const operationKey = activeIdentityKey;
    const operationToken = guard.capture(operationKey);
    button.disabled = true;
    try {
      const preview = await api('/farm/actions/preview', { method: 'POST', body: JSON.stringify({ saveId: operationSave.saveId }), signal: operationToken.signal });
      guard.assertCurrent(operationToken, activeIdentityKey);
      const result = await api('/farm/actions/commit', { method: 'POST', body: JSON.stringify({ saveId: operationSave.saveId, expectedRevision: operationSave.revision, operationId: crypto.randomUUID(), action: 'water_all' }), signal: operationToken.signal });
      guard.assertCurrent(operationToken, activeIdentityKey);
      main.querySelector('.tsl-result').textContent = preview.affected
        ? '已浇水 ' + result.affected + ' 格，游戏时间 +' + result.timeCostMinutes + ' 分钟。'
        : '今天已经浇过水，没有重复耗时。';
      save.revision = result.revision;
      setTimeout(() => { if (operationKey === activeIdentityKey) showFarm(main); }, 500);
    } catch (error) { await handleOperationError(error); }
    finally { button.disabled = false; }
  });
}

async function showInventory(main, container) {
  const localSave = await ensureSave();
  const key = activeIdentityKey;
  const token = guard.capture(key);
  const [world, items] = await Promise.all([
    api('/world/current?saveId=' + encodeURIComponent(localSave.saveId), { signal: token.signal }),
    api('/inventory?saveId=' + encodeURIComponent(localSave.saveId), { signal: token.signal }),
  ]);
  guard.assertCurrent(token, activeIdentityKey);
  save = world;
  const visible = items.filter(item => item.container === container);
  const destination = container === 'bag' ? 'home_storage' : 'bag';
  const actionLabel = container === 'bag' ? '存入仓库' : '取到背包';
  main.innerHTML = '<h3>' + (container === 'bag' ? '背包' : '家中仓库') + '</h3><p>当前位置：' + escapeHtml(world.clock.location_id) + '</p>'
    + (visible.length ? visible.map(item => '<div class="tsl-item"><span>' + escapeHtml(item.itemId) + ' × ' + item.quantity + ' <small>[' + item.sourceStatus.toUpperCase() + ']</small></span>'
      + '<span class="tsl-transfer"><input type="number" min="1" max="' + item.quantity + '" value="1" aria-label="转移数量"><button data-item="' + escapeHtml(item.itemId) + '" data-from="' + container + '" data-to="' + destination + '">' + actionLabel + '</button></span></div>').join('') : '<p>空</p>');
  main.querySelectorAll('.tsl-transfer button').forEach(button => button.addEventListener('click', async () => {
    const input = button.parentElement.querySelector('input');
    const quantity = Number(input.value);
    const operationSave = save;
    const operationKey = activeIdentityKey;
    const operationToken = guard.capture(operationKey);
    button.disabled = true;
    try {
      const result = await api('/inventory/move', { method: 'POST', body: JSON.stringify({
        saveId: operationSave.saveId,
        expectedRevision: operationSave.revision,
        operationId: crypto.randomUUID(),
        from: button.dataset.from,
        to: button.dataset.to,
        itemId: button.dataset.item,
        quantity,
      }), signal: operationToken.signal });
      guard.assertCurrent(operationToken, activeIdentityKey);
      save.revision = result.revision;
      toastr.success('已转移 ' + quantity + ' 个物品。');
      await showInventory(main, container);
    } catch (error) { await handleOperationError(error); }
    finally { button.disabled = false; }
  }));
}

async function handleOperationError(error) {
  if (error instanceof StaleContextError || error.name === 'AbortError') return;
  if (error.code === 'REVISION_CONFLICT') {
    save = null;
    toastr.warning('另一设备已更新存档，正在刷新，请重新操作。');
    await refreshCurrentView();
    return;
  }
  const messages = {
    HOME_STORAGE_REQUIRES_HOME_LOCATION: '只有在家中才能使用仓库。',
    INSUFFICIENT_QUANTITY: '物品数量不足。',
    STACK_LIMIT_EXCEEDED: '目标格超过堆叠上限。',
    OPERATION_ID_CONFLICT: '操作编号冲突，请刷新后重试。',
  };
  toastr.error(messages[error.code] || ('操作失败：' + (error.code || error.message)));
}

function onChatChanged() {
  guard.invalidate();
  save = null;
  activeIdentityKey = '';
  if (panelElements && !panelElements.panel.hidden) {
    panelElements.main.innerHTML = '<p>聊天已切换，正在载入对应存档……</p>';
    void refreshCurrentView();
  }
}

function makeDraggable(root, orb) {
  let drag = null;
  orb.addEventListener('pointerdown', event => {
    drag = { x: event.clientX, y: event.clientY, left: root.offsetLeft, top: root.offsetTop, moved: false };
    orb.setPointerCapture(event.pointerId);
  });
  orb.addEventListener('pointermove', event => {
    if (!drag) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 6) drag.moved = true;
    root.style.left = Math.max(8, Math.min(innerWidth - 58, drag.left + dx)) + 'px';
    root.style.top = Math.max(8, Math.min(innerHeight - 58, drag.top + dy)) + 'px';
    root.style.right = 'auto'; root.style.bottom = 'auto';
    positionPanel();
  });
  orb.addEventListener('pointerup', () => {
    if (!drag) return;
    root.style.left = (root.offsetLeft < innerWidth / 2 ? 8 : innerWidth - 58) + 'px';
    orb.dataset.dragged = drag.moved ? 'true' : 'false';
    localStorage.setItem(POSITION_KEY, JSON.stringify({ left: root.offsetLeft, top: root.offsetTop }));
    drag = null;
    positionPanel();
  });
}

function restorePosition(root) {
  try {
    const saved = JSON.parse(localStorage.getItem(POSITION_KEY) || 'null');
    if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
      root.style.left = saved.left + 'px'; root.style.top = saved.top + 'px'; root.style.right = 'auto'; root.style.bottom = 'auto';
    }
  } catch { localStorage.removeItem(POSITION_KEY); }
  constrainRoot(root);
}

function constrainRoot(root) {
  if (!root.style.left) return;
  root.style.left = Math.max(8, Math.min(innerWidth - 58, root.offsetLeft)) + 'px';
  root.style.top = Math.max(8, Math.min(innerHeight - 58, root.offsetTop)) + 'px';
}

function positionPanel() {
  if (!panelElements || panelElements.panel.hidden) return;
  const { orb, panel } = panelElements;
  const rect = orb.getBoundingClientRect();
  const width = Math.min(360, innerWidth - 24);
  panel.style.width = width + 'px';
  panel.style.left = Math.max(8, Math.min(innerWidth - width - 8, rect.right - width)) + 'px';
  const height = Math.min(panel.scrollHeight, innerHeight * 0.7, 620);
  const top = rect.top > innerHeight / 2 ? rect.top - height - 8 : rect.bottom + 8;
  panel.style.top = Math.max(8, Math.min(innerHeight - height - 8, top)) + 'px';
}

function escapeHtml(value) { const node = document.createElement('span'); node.textContent = String(value); return node.innerHTML; }

export function activate() {
  if (mounted || document.getElementById('trio-second-life-root')) return;
  mounted = true;
  renderShell();
  const context = SillyTavern.getContext();
  if (context.eventSource && context.event_types?.CHAT_CHANGED) context.eventSource.on(context.event_types.CHAT_CHANGED, onChatChanged);
  console.log('[TrioSecondLife] UI loaded with chat-isolated storage and no generation hooks');
}

