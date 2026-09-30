import { ContextGuard, StaleContextError, createOperationId, ensureContextBinding, getTrioCardMetadata, identityKey } from './context.mjs';

const API_ROOT = '/api/plugins/trio-second-life';
const POSITION_KEY = 'trio-second-life:orb-position:v1';
const guard = new ContextGuard();
let mounted = false;
let save = null;
let activeIdentityKey = '';
let currentView = 'farm';
let panelElements = null;
let narrativeSyncQueue = Promise.resolve();

class ApiError extends Error {
  constructor(status, code, details) { super(code); this.status = status; this.code = code; this.details = details; }
}

function currentIdentity() {
  return ensureContextBinding(SillyTavern.getContext())?.identity ?? null;
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
  const context = SillyTavern.getContext();
  const bindingResult = ensureContextBinding(context);
  const identity = bindingResult?.identity;
  if (!identity) throw new ApiError(409, getTrioCardMetadata(context) ? 'CHAT_ID_UNAVAILABLE' : 'TRIO_CARD_NOT_ACTIVE');
  const key = identityKey(identity);
  if (save && activeIdentityKey === key) return save;
  const token = guard.capture(key);
  if (bindingResult.changed) await context.saveMetadata?.();
  const initialized = await api('/saves/initialize', { method: 'POST', body: JSON.stringify(identity), signal: token.signal });
  guard.assertCurrent(token, identityKey(currentIdentity()));
  const liveContext = SillyTavern.getContext();
  const liveBinding = ensureContextBinding(liveContext);
  if (!liveBinding || identityKey(liveBinding.identity) !== key) throw new StaleContextError();
  liveBinding.binding.save_id = initialized.saveId;
  liveBinding.binding.last_server_revision = initialized.revision;
  await liveContext.saveMetadata?.();
  save = initialized;
  activeIdentityKey = key;
  return save;
}

async function persistRevision(revision) {
  const context = SillyTavern.getContext();
  const bindingResult = ensureContextBinding(context);
  if (!bindingResult || identityKey(bindingResult.identity) !== activeIdentityKey) return;
  bindingResult.binding.last_server_revision = revision;
  await context.saveMetadata?.();
}

function enqueueNarrativeSync(task) {
  narrativeSyncQueue = narrativeSyncQueue.then(task, task).catch(error => {
    if (!(error instanceof StaleContextError) && error?.name !== 'AbortError') console.warn('[TrioSecondLife] narrative state sync failed:', error?.code || error?.message);
  });
}

async function syncNarrativeMessage(messageId, expectedKey) {
  const context = SillyTavern.getContext();
  const bindingResult = ensureContextBinding(context);
  if (!bindingResult || identityKey(bindingResult.identity) !== expectedKey || !Number.isInteger(Number(messageId))) return;
  const message = context.chat?.[Number(messageId)];
  if (!message || message.is_user || message.is_system) return;
  const localSave = await ensureSave();
  const key = activeIdentityKey;
  const token = guard.capture(key);
  const swipeId = Number.isInteger(message.swipe_id) && message.swipe_id >= 0 ? message.swipe_id : 0;
  const result = await api('/narrative/time/sync', {
    method: 'POST',
    body: JSON.stringify({ saveId: localSave.saveId, messageId: Number(messageId), swipeId, text: String(message.mes || '') }),
    signal: token.signal,
  });
  guard.assertCurrent(token, activeIdentityKey);
  save.revision = result.revision;
  await persistRevision(result.revision);
  if (result.applied && panelElements && !panelElements.panel.hidden) await refreshCurrentView();
}

async function truncateNarrativeMessages(firstDeletedMessageId, expectedKey) {
  const context = SillyTavern.getContext();
  const bindingResult = ensureContextBinding(context);
  if (!bindingResult || identityKey(bindingResult.identity) !== expectedKey || !Number.isInteger(Number(firstDeletedMessageId))) return;
  const localSave = await ensureSave();
  const key = activeIdentityKey;
  const token = guard.capture(key);
  const result = await api('/narrative/time/truncate', {
    method: 'POST',
    body: JSON.stringify({ saveId: localSave.saveId, firstDeletedMessageId: Number(firstDeletedMessageId) }),
    signal: token.signal,
  });
  guard.assertCurrent(token, activeIdentityKey);
  save.revision = result.revision;
  await persistRevision(result.revision);
  if (result.applied && panelElements && !panelElements.panel.hidden) await refreshCurrentView();
}

async function trioSecondLifeGenerationInterceptor(chat, _contextSize, _abort, _type) {
  const context = SillyTavern.getContext();
  const bindingResult = ensureContextBinding(context);
  if (!bindingResult) return;
  const key = identityKey(bindingResult.identity);
  const token = guard.capture(key);
  try {
    if (bindingResult.changed) await context.saveMetadata?.();
    let currentSave = save && activeIdentityKey === key ? save : null;
    if (!currentSave) {
      currentSave = await api('/saves/initialize', {
        method: 'POST', body: JSON.stringify(bindingResult.identity), signal: token.signal,
      });
      guard.assertCurrent(token, identityKey(currentIdentity()));
      const liveContext = SillyTavern.getContext();
      const liveBinding = ensureContextBinding(liveContext);
      if (!liveBinding || identityKey(liveBinding.identity) !== key) return;
      liveBinding.binding.save_id = currentSave.saveId;
      liveBinding.binding.last_server_revision = currentSave.revision;
      await liveContext.saveMetadata?.();
      save = currentSave;
      activeIdentityKey = key;
    }
    const result = await api('/runtime?saveId=' + encodeURIComponent(currentSave.saveId), { signal: token.signal });
    guard.assertCurrent(token, identityKey(currentIdentity()));
    if (result.runtime) chat.push({ is_system: true, mes: result.runtime, name: 'Trio Second Life Runtime', extra: {} });
  } catch (error) {
    if (!(error instanceof StaleContextError) && error.name !== 'AbortError') {
      console.warn('[TrioSecondLife] runtime unavailable; generation continues without dynamic state.');
    }
  }
}

globalThis.trioSecondLifeGenerationInterceptor = trioSecondLifeGenerationInterceptor;

function renderShell() {
  const root = document.createElement('section');
  root.id = 'trio-second-life-root';
  const menu = [['farm','农田'], ['animals','畜牧'], ['bag','背包'], ['home','仓库'], ['shop','商店'], ['map','地图'], ['people','人物'], ['settings','设置']]
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
    else if (currentView === 'animals') await showAnimals(main);
    else if (currentView === 'bag') await showInventory(main, 'bag');
    else if (currentView === 'home') await showInventory(main, 'home_storage');
    else if (currentView === 'shop') await showShops(main);
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
  const [world, plots] = await Promise.all([
    api('/world/current?saveId=' + encodeURIComponent(localSave.saveId), { signal: token.signal }),
    api('/farm/plots?saveId=' + encodeURIComponent(localSave.saveId), { signal: token.signal }),
  ]);
  guard.assertCurrent(token, activeIdentityKey);
  save = world;
  const hour = String(Math.floor(world.clock.minute_of_day / 60)).padStart(2, '0');
  const minute = String(world.clock.minute_of_day % 60).padStart(2, '0');
  const season = { spring: '春', summer: '夏', autumn: '秋', winter: '冬' }[world.clock.season] || world.clock.season;
  const cropNames = { demo_turnip: 'DEMO 芜菁' };
  const plantedCount = plots.filter(plot => Number(plot.planted) === 1).length;
  const wateredCount = plots.filter(plot => Number(plot.watered) === 1).length;
  const selectedPlot = plots[0];
  const renderPlot = (plot, index) => {
    const planted = Number(plot.planted) === 1;
    const cropName = cropNames[plot.cropId] || (planted ? escapeHtml(plot.cropId || '作物待识别') : '空地');
    const state = planted ? (Number(plot.watered) === 1 ? '今日已浇' : '待浇水') : '未种植';
    return '<button type="button" class="tsl-plot ' + (Number(plot.watered) === 1 ? 'is-watered' : '') + '" data-plot-index="' + index + '" aria-pressed="' + (plot === selectedPlot) + '" title="地块 ' + (index + 1) + ' · ' + cropName + ' · ' + state + '">'
      + '<span class="tsl-plot-number">' + String(index + 1).padStart(2, '0') + '</span>'
      + '<span class="tsl-plot-crop">' + (planted ? '芽' : '+') + '</span><strong>' + cropName + '</strong><small>' + state + '</small></button>';
  };
  const plotMarkup = plots.map(renderPlot).join('');
  const renderPlotDetail = plot => {
    if (!plot) return '<p>暂无地块记录。</p>';
    const planted = Number(plot.planted) === 1;
    const cropName = cropNames[plot.cropId] || (planted ? escapeHtml(plot.cropId || '作物待识别') : '空地');
    const state = planted ? (Number(plot.watered) === 1 ? '今日已浇水' : '今天尚未浇水') : '尚未种植';
    return '<strong>地块 ' + escapeHtml(plot.tileId) + '</strong><span>' + cropName + '</span><small>' + state + ' · 数据来源：' + escapeHtml(plot.sourceStatus).toUpperCase() + '</small>';
  };
  main.innerHTML = '<section class="tsl-farm-heading"><div><span class="tsl-kicker">牧场记录</span><h3>农田</h3></div><span class="tsl-demo-mark">DEMO</span></section>'
    + '<div class="tsl-clock-strip"><strong>第 ' + world.clock.year + ' 年 ' + season + ' ' + world.clock.day + ' 日</strong><span>' + hour + ':' + minute + '</span><span>牧场 · ' + plots.length + ' 格</span></div>'
    + '<div class="tsl-farm-summary"><div><strong>' + plantedCount + '</strong><span>已种植</span></div><div><strong>' + wateredCount + '</strong><span>今日已浇</span></div><div><strong>' + (plantedCount - wateredCount) + '</strong><span>待浇水</span></div><div><strong>' + (plots.length - plantedCount) + '</strong><span>空地</span></div></div>'
    + '<div class="tsl-plot-heading"><h4>田地</h4><span>选择地块查看记录</span></div>'
    + '<div class="tsl-plot-grid">' + plotMarkup + '</div>'
    + '<section class="tsl-plot-detail" aria-live="polite">' + renderPlotDetail(selectedPlot) + '</section>'
    + '<div class="tsl-farm-actions"><button class="tsl-primary">一键浇水</button><div class="tsl-result" aria-live="polite"></div></div>';
  main.querySelectorAll('.tsl-plot').forEach(button => button.addEventListener('click', () => {
    const plot = plots[Number(button.dataset.plotIndex)];
    main.querySelectorAll('.tsl-plot').forEach(tile => tile.setAttribute('aria-pressed', String(tile === button)));
    main.querySelector('.tsl-plot-detail').innerHTML = renderPlotDetail(plot);
  }));
  main.querySelector('.tsl-primary').addEventListener('click', async event => {
    const button = event.currentTarget;
    const operationSave = save;
    const operationKey = activeIdentityKey;
    const operationToken = guard.capture(operationKey);
    button.disabled = true;
    try {
      const result = await api('/farm/actions/commit', { method: 'POST', body: JSON.stringify({ saveId: operationSave.saveId, expectedRevision: operationSave.revision, operationId: createOperationId(), action: 'water_all' }), signal: operationToken.signal });
      guard.assertCurrent(operationToken, activeIdentityKey);
      main.querySelector('.tsl-result').textContent = result.affected
        ? '已浇水 ' + result.affected + ' 格。此操作不推进叙事时间。'
        : '今天已经浇过水。';
      save.revision = result.revision;
      await persistRevision(result.revision);
      setTimeout(() => { if (operationKey === activeIdentityKey) showFarm(main); }, 500);
    } catch (error) { await handleOperationError(error); }
    finally { button.disabled = false; }
  });
}

async function showAnimals(main) {
  const localSave = await ensureSave();
  const key = activeIdentityKey;
  const token = guard.capture(key);
  const [world, animals] = await Promise.all([
    api('/world/current?saveId=' + encodeURIComponent(localSave.saveId), { signal: token.signal }),
    api('/animals?saveId=' + encodeURIComponent(localSave.saveId), { signal: token.signal }),
  ]);
  guard.assertCurrent(token, activeIdentityKey);
  save = world;
  const animalMarkup = animals.map(animal => '<article class="tsl-animal-card"><div class="tsl-animal-sprite" aria-hidden="true"><span></span></div>'
    + '<div class="tsl-animal-info"><span class="tsl-kicker">测试动物 · ' + escapeHtml(animal.speciesId) + '</span><h4>' + escapeHtml(animal.name) + '</h4>'
    + '<p><span class="' + (animal.fedToday ? 'is-done' : '') + '">' + (animal.fedToday ? '✓' : '○') + ' 已喂食</span>'
    + '<span class="' + (animal.pettedToday ? 'is-done' : '') + '">' + (animal.pettedToday ? '✓' : '○') + ' 已抚摸</span></p></div>'
    + '<div class="tsl-animal-actions"><button data-animal="' + escapeHtml(animal.animalId) + '" data-action="feed"' + (animal.fedToday ? ' disabled' : '') + '>喂食</button>'
    + '<button data-animal="' + escapeHtml(animal.animalId) + '" data-action="pet"' + (animal.pettedToday ? ' disabled' : '') + '>抚摸</button>'
    + '<button data-animal="' + escapeHtml(animal.animalId) + '" data-action="care_all"' + (animal.fedToday && animal.pettedToday ? ' disabled' : '') + '>全部照料</button></div></article>').join('');
  main.innerHTML = '<section class="tsl-farm-heading"><div><span class="tsl-kicker">牧场记录</span><h3>畜牧</h3></div><span class="tsl-demo-mark">DEMO</span></section>'
    + '<section class="tsl-barn-scene" aria-label="像素畜舍测试画面"><div class="tsl-barn-window"></div><div class="tsl-trough"></div><div class="tsl-hay"></div></section>'
    + '<div class="tsl-plot-heading"><h4>动物名册</h4><span>照料操作不推进叙事时间</span></div>'
    + '<div class="tsl-animal-list">' + (animalMarkup || '<p>畜舍为空。</p>') + '</div><div class="tsl-result" aria-live="polite"></div>';
  main.querySelectorAll('.tsl-animal-actions button').forEach(button => button.addEventListener('click', async () => {
    const operationSave = save;
    const operationKey = activeIdentityKey;
    const operationToken = guard.capture(operationKey);
    button.disabled = true;
    try {
      const result = await api('/animals/actions/commit', { method: 'POST', body: JSON.stringify({
        saveId: operationSave.saveId,
        expectedRevision: operationSave.revision,
        operationId: createOperationId(),
        animalId: button.dataset.animal,
        action: button.dataset.action,
      }), signal: operationToken.signal });
      guard.assertCurrent(operationToken, activeIdentityKey);
      save.revision = result.revision;
      await persistRevision(result.revision);
      await showAnimals(main);
    } catch (error) { await handleOperationError(error); button.disabled = false; }
  }));
}

async function showShops(main) {
  const localSave = await ensureSave();
  const key = activeIdentityKey;
  const token = guard.capture(key);
  const [world, shops] = await Promise.all([
    api('/world/current?saveId=' + encodeURIComponent(localSave.saveId), { signal: token.signal }),
    api('/shops/status?saveId=' + encodeURIComponent(localSave.saveId), { signal: token.signal }),
  ]);
  guard.assertCurrent(token, activeIdentityKey);
  save = world;
  const time = String(Math.floor(world.clock.minute_of_day / 60)).padStart(2, '0') + ':' + String(world.clock.minute_of_day % 60).padStart(2, '0');
  main.innerHTML = '<section class="tsl-farm-heading"><div><span class="tsl-kicker">叙事时间 · ' + time + '</span><h3>商店</h3></div><span class="tsl-demo-mark">DEMO 日程</span></section>'
    + '<section class="tsl-shop-scene"><div class="tsl-shop-awning"></div><div class="tsl-shop-shelf"><i></i><i></i><i></i></div></section>'
    + shops.map(shop => '<article class="tsl-shop-row"><div><strong>' + escapeHtml(shop.name) + '</strong><small>' + escapeHtml(shop.opensAt) + ' - ' + escapeHtml(shop.closesAt) + '</small></div>'
      + '<span class="' + (shop.isOpen ? 'is-open' : 'is-closed') + '">' + (shop.isOpen ? '营业中' : '已打烊') + '</span></article>').join('')
    + '<p class="tsl-source-note">营业状态只读取正文确认后的统一时钟；当前日程为测试数据，尚未作为原作资料发布。</p>';
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
        operationId: createOperationId(),
        from: button.dataset.from,
        to: button.dataset.to,
        itemId: button.dataset.item,
        quantity,
      }), signal: operationToken.signal });
      guard.assertCurrent(operationToken, activeIdentityKey);
      save.revision = result.revision;
      await persistRevision(result.revision);
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
  syncCardMode();
  if (panelElements && !panelElements.panel.hidden) {
    panelElements.main.innerHTML = '<p>聊天已切换，正在载入对应存档……</p>';
    void refreshCurrentView();
  }
}

function syncCardMode() {
  if (!panelElements) return;
  const enabled = Boolean(getTrioCardMetadata(SillyTavern.getContext()));
  panelElements.orb.hidden = !enabled;
  if (!enabled) {
    panelElements.panel.hidden = true;
    save = null;
    activeIdentityKey = '';
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
  const width = Math.min(620, innerWidth - 24);
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
  if (context.eventSource && context.event_types?.CHARACTER_EDITED) context.eventSource.on(context.event_types.CHARACTER_EDITED, onChatChanged);
  if (context.eventSource && context.event_types?.APP_READY) context.eventSource.on(context.event_types.APP_READY, syncCardMode);
  if (context.eventSource && context.event_types?.MESSAGE_RECEIVED) context.eventSource.on(context.event_types.MESSAGE_RECEIVED, messageId => {
    const expectedKey = identityKey(currentIdentity()); enqueueNarrativeSync(() => syncNarrativeMessage(messageId, expectedKey));
  });
  if (context.eventSource && context.event_types?.MESSAGE_SWIPED) context.eventSource.on(context.event_types.MESSAGE_SWIPED, messageId => {
    const expectedKey = identityKey(currentIdentity()); enqueueNarrativeSync(() => syncNarrativeMessage(messageId, expectedKey));
  });
  if (context.eventSource && context.event_types?.MESSAGE_EDITED) context.eventSource.on(context.event_types.MESSAGE_EDITED, messageId => {
    const expectedKey = identityKey(currentIdentity()); enqueueNarrativeSync(() => syncNarrativeMessage(messageId, expectedKey));
  });
  if (context.eventSource && context.event_types?.MESSAGE_DELETED) context.eventSource.on(context.event_types.MESSAGE_DELETED, firstDeletedMessageId => {
    const expectedKey = identityKey(currentIdentity()); enqueueNarrativeSync(() => truncateNarrativeMessages(firstDeletedMessageId, expectedKey));
  });
  syncCardMode();
  console.log('[TrioSecondLife] card-aware UI, runtime chores, and narrative clock ledger loaded');
}
