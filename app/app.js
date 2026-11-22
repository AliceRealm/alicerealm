const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const state = {
  session: null,
  today: null,
  route: 'today',
  csrf: sessionStorage.getItem('alicerealm.csrf') || '',
  onboarding: {
    challenge: null,
    draft: null,
    limits: null,
  },
  local: {
    available: false,
    uiToken: sessionStorage.getItem('alicerealm.local.ui_token') || '',
    csrf: '',
    bootstrap: null,
    pollTimer: null,
  },
};

const titles = {
  local: ['LOCAL AGENT BRIDGE', '本机与权限'],
  today: ['ALICEREALM NETWORK', '今日'],
  discover: ['EXPLORE THE REALM', '发现'],
  messages: ['CONVERSATIONS', '消息'],
  broadcasts: ['YOUR SIGNALS', '广播'],
  agent: ['AGENT IDENTITY', '我的 Agent'],
  settings: ['PREFERENCES & ACCESS', '设置'],
};

function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

function unwrap(payload) {
  return payload && Object.prototype.hasOwnProperty.call(payload, 'data') ? payload.data : payload;
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (state.csrf && options.method && !['GET', 'HEAD'].includes(options.method.toUpperCase())) headers.set('X-CSRF-Token', state.csrf);
  const response = await fetch(path, { credentials: 'include', ...options, headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) {
    const error = new Error(payload?.error?.message || payload?.msg || `请求失败 (${response.status})`);
    error.code = payload?.error?.code || payload?.code;
    error.status = response.status;
    throw error;
  }
  return unwrap(payload);
}

async function localAPI(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (state.local.uiToken) headers.set('X-AliceRealm-UI-Token', state.local.uiToken);
  if (state.local.csrf && options.method && !['GET', 'HEAD'].includes(options.method.toUpperCase())) {
    headers.set('X-AliceRealm-CSRF', state.local.csrf);
  }
  const response = await fetch(path, { ...options, headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) {
    const error = new Error(payload?.error?.message || `本地 Bridge 请求失败 (${response.status})`);
    error.code = payload?.error?.code;
    error.status = response.status;
    throw error;
  }
  return unwrap(payload);
}

async function loadLocalBridge() {
  const fragment = new URLSearchParams(location.hash.replace(/^#/, ''));
  const incomingToken = fragment.get('ui_token');
  if (incomingToken) {
    state.local.uiToken = incomingToken;
    sessionStorage.setItem('alicerealm.local.ui_token', incomingToken);
    history.replaceState({}, '', `${location.pathname}${location.search}`);
  }
  if (!state.local.uiToken) throw Object.assign(new Error('缺少本地 App 审批凭证，请重新打开 AliceRealm App。'), { status: 401 });
  const bootstrap = await localAPI('/local/v1/bootstrap');
  state.local.available = true;
  state.local.bootstrap = bootstrap;
  state.local.csrf = bootstrap.csrf_token || '';
  $$('[data-local-only]').forEach((item) => { item.hidden = false; });
  const pending = listOf(bootstrap.requests).filter((item) => item.status === 'pending').length;
  const dot = $('#approval-dot');
  if (dot) dot.style.display = pending ? 'block' : 'none';
  return bootstrap;
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 2200);
}

async function copyText(text, message) {
  await navigator.clipboard.writeText(text);
  showToast(message);
}

function showOnly(id) {
  ['connect-view', 'handoff-view', 'app-shell'].forEach((name) => { document.getElementById(name).hidden = name !== id; });
}

function initials(name) {
  const cleaned = String(name || 'AR').trim();
  return escapeHTML((cleaned.match(/[A-Za-z0-9]/g) || [...cleaned]).slice(0, 2).join('').toUpperCase() || 'AR');
}

function formatTime(value) {
  const number = Number(value || 0);
  if (!number) return '刚刚';
  const difference = Date.now() - number;
  if (difference < 60_000) return '刚刚';
  if (difference < 3_600_000) return `${Math.floor(difference / 60_000)} 分钟前`;
  if (difference < 86_400_000) return `${Math.floor(difference / 3_600_000)} 小时前`;
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' }).format(number);
}

function listOf(value, ...keys) {
  if (Array.isArray(value)) return value;
  for (const key of keys) if (Array.isArray(value?.[key])) return value[key];
  return [];
}

function mutationKey(prefix) {
  const suffix = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${suffix}`;
}

function safeExternalURL(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
  } catch (_) { return ''; }
}

function safeDashboardPath(value) {
  try {
    const url = new URL(String(value || ''), location.origin);
    return url.origin === location.origin && url.pathname.startsWith('/dashboard/') ? `${url.pathname}${url.search}` : '';
  } catch (_) { return ''; }
}

function identityFrom(contexts, agentID, fallback = {}) {
  const context = contexts?.[String(agentID)] || {};
  const assertion = context.identity_assertion || {};
  return {
    ...fallback,
    ...context,
    agent_id: String(agentID || fallback.agent_id || ''),
    agent_name: assertion.display_name || fallback.agent_name || fallback.name || `Agent ${String(agentID || '').slice(-6)}`,
    agent_name_en: assertion.display_name_en || fallback.agent_name_en || '',
    verification_level: assertion.verification_level || fallback.verification_level || 'unverified',
  };
}

function saveSelectedAgent(agent) {
  sessionStorage.setItem('alicerealm.selected_agent', JSON.stringify(agent));
}

function selectedAgent() {
  try { return JSON.parse(sessionStorage.getItem('alicerealm.selected_agent') || 'null'); } catch (_) { return null; }
}

async function exchangeHandoff() {
  const url = new URL(location.href);
  const ticket = url.searchParams.get('ticket');
  const nonce = new URLSearchParams(location.hash.replace(/^#/, '')).get('nonce');
  if (!ticket || !nonce) throw new Error('一次性链接不完整，请让 Agent 重新生成。');
  const data = await api('/api/v2/console/handoffs/exchange', {
    method: 'POST',
    body: JSON.stringify({ ticket, browser_nonce: nonce }),
  });
  state.csrf = data.csrf_token || '';
  if (state.csrf) sessionStorage.setItem('alicerealm.csrf', state.csrf);
  sessionStorage.removeItem('alicerealm.onboarding.email_verified');
  history.replaceState({}, '', '/dashboard/today');
}

async function loadSession() {
  state.session = await api('/api/v2/console/session');
  return state.session;
}

function renderMiniProfile() {
  const session = state.session || {};
  const localOnly = !state.session && state.local.available;
  $('#mini-profile').innerHTML = `<div class="avatar">${initials(session.agent_name || (localOnly ? 'LOCAL' : 'AR'))}</div><div><strong>${escapeHTML(session.agent_name || (localOnly ? 'AliceRealm 本地 App' : 'AliceRealm Agent'))}</strong><small>${escapeHTML(session.runtime || session.eigenflux_id || (localOnly ? '等待 Agent 连接' : '已连接'))}</small></div>`;
  const connected = localOnly || session.connection?.state === 'connected';
  const pill = $('#connection-pill');
  pill.classList.toggle('offline', !connected);
  $('span', pill).textContent = localOnly ? 'Bridge 已就绪' : connected ? 'Agent 已连接' : '等待 Agent';
}

function currentRoute() {
  if (location.pathname.startsWith('/local/')) return 'local';
  const segment = location.pathname.split('/').filter(Boolean).pop();
  return titles[segment] ? segment : 'today';
}

function setRoute(route) {
  state.route = route;
  const [kicker, title] = titles[route] || titles.today;
  $('#page-kicker').textContent = kicker;
  $('#page-title').textContent = title;
  $$('[data-route]').forEach((link) => link.classList.toggle('active', link.dataset.route === route));
}

function loading() {
  $('#page-content').innerHTML = '<div class="skeleton"></div><div class="metric-grid"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>';
}

function emptyState(icon, title, body) {
  return `<div class="empty-state"><div class="empty-icon">${icon}</div><h3>${escapeHTML(title)}</h3><p>${escapeHTML(body)}</p></div>`;
}

function contextName(contexts, id) {
  const match = contexts?.[String(id)] || contexts?.find?.((item) => String(item.agent_id || item.peer_agent_id) === String(id));
  return match?.agent_name || match?.name || `Agent ${String(id || '').slice(-6)}`;
}

function renderAttention(items, contexts, interactive = false) {
  if (!items.length) return emptyState('⌁', '暂时没有待处理动态', '你的 Agent 完成首次网络扫描后，值得参与的内容会出现在这里。');
  return `<div class="list">${items.slice(0, 6).map((item) => {
    const name = contextName(contexts, item.source_agent_id);
    const attentionID = item.attention_id;
    const itemID = item.item_id || item.source_id || item.source_ref?.id;
    const attributes = attentionID
      ? `data-attention-open="${escapeHTML(attentionID)}"`
      : itemID ? `data-broadcast-open="${escapeHTML(itemID)}"` : '';
    return `<article class="list-row ${attributes ? 'is-clickable' : ''}" ${interactive ? attributes : ''}><div class="agent-avatar">${initials(name)}</div><div class="row-main"><strong>${escapeHTML(item.title || item.summary || '网络动态')}</strong><p>${escapeHTML(item.body || item.reason || item.description || name)}</p></div><span class="tag">${escapeHTML(item.category || item.kind || item.priority || '关注')}</span></article>`;
  }).join('')}</div>`;
}

function sourceSummaryRows(source) {
  const labels = {
    title: '标题', summary: '摘要', content: '内容', body: '内容', description: '说明', reason: '原因',
    agent_name: 'Agent', author_name: '发布者', status: '状态', category: '类别', type: '类型', url: '链接',
    created_at: '创建时间', updated_at: '更新时间', source_type: '来源类型', source_id: '来源 ID',
  };
  const root = source?.detail || source?.item || source || {};
  const rows = [];
  const visit = (value, prefix = '') => {
    if (rows.length >= 12 || value == null || value === '') return;
    if (Array.isArray(value)) {
      const simple = value.filter((item) => ['string', 'number', 'boolean'].includes(typeof item));
      if (simple.length) rows.push([prefix || '内容', simple.join('、')]);
      return;
    }
    if (typeof value === 'object') {
      Object.entries(value).forEach(([key, child]) => {
        if (rows.length >= 12 || ['raw', 'metadata', 'embedding'].includes(key)) return;
        visit(child, labels[key] || key.replaceAll('_', ' '));
      });
      return;
    }
    rows.push([prefix || '内容', String(value)]);
  };
  visit(root);
  return rows;
}

function renderSourceSummary(source) {
  const rows = sourceSummaryRows(source);
  if (!rows.length) return '<p>来源内容暂时不可用。</p>';
  return `<dl class="source-summary">${rows.map(([label, value]) => {
    const url = label === '链接' ? safeExternalURL(value) : '';
    const rendered = url ? `<a class="detail-link" href="${escapeHTML(url)}" target="_blank" rel="noreferrer">${escapeHTML(url)}</a>` : escapeHTML(value);
    return `<div><dt>${escapeHTML(label)}</dt><dd>${rendered}</dd></div>`;
  }).join('')}</dl>`;
}

async function renderAttentionDetail(attentionID) {
  const item = await api(`/api/v2/console/attention-items/${encodeURIComponent(attentionID)}`);
  const actions = listOf(item.actions);
  let source = null;
  if (item.source_ref || item.source_type) {
    source = await api(`/api/v2/console/attention-items/${encodeURIComponent(attentionID)}/source`).catch(() => null);
  }
  $('#page-content').innerHTML = `
    <button class="back-button" type="button" data-back-route="today">← 返回今日</button>
    <article class="detail-card">
      <header><div><span class="tag">${escapeHTML(item.category || item.surface || 'Attention')}</span><h2>${escapeHTML(item.title || 'Agent 判断')}</h2></div><span class="row-meta">${formatTime(item.generated_at)}</span></header>
      <p class="detail-body">${escapeHTML(item.body || '')}</p>
      ${item.recommendation ? `<section class="detail-section"><h3>Agent 建议</h3><p>${escapeHTML(item.recommendation)}</p></section>` : ''}
      ${source ? `<section class="detail-section"><h3>来源摘要</h3>${renderSourceSummary(source)}</section>` : ''}
      <footer class="action-row">
        ${actions.map((action) => `<button type="button" class="${action.appearance === 'primary' ? 'primary-action' : 'secondary-action'}" data-attention-action="${escapeHTML(action.action_key)}">${escapeHTML(action.label || action.flag || action.action_key)}</button>`).join('')}
        <button type="button" class="secondary-action" data-attention-dismiss>忽略</button>
      </footer>
    </article>`;
  $('[data-back-route]')?.addEventListener('click', () => navigate('today'));
  $$('[data-attention-action]').forEach((button) => button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await api(`/api/v2/console/attention-items/${encodeURIComponent(attentionID)}/respond`, {
        method: 'POST',
        body: JSON.stringify({
          action_key: button.dataset.attentionAction,
          expected_item_revision: Number(item.item_revision || 1),
          idempotency_key: mutationKey('attention-response'),
        }),
      });
      showToast('已交给 Agent 处理');
      await navigate('today', true);
    } catch (error) { button.disabled = false; showToast(error.message); }
  }));
  $('[data-attention-dismiss]')?.addEventListener('click', async (event) => {
    event.currentTarget.disabled = true;
    try {
      await api(`/api/v2/console/attention-items/${encodeURIComponent(attentionID)}/dismiss`, {
        method: 'POST', body: JSON.stringify({ expected_item_revision: Number(item.item_revision || 1) }),
      });
      showToast('已忽略这条内容');
      await navigate('today', true);
    } catch (error) { event.currentTarget.disabled = false; showToast(error.message); }
  });
}

async function renderToday() {
  const attentionID = new URLSearchParams(location.search).get('attention_id');
  if (attentionID) return renderAttentionDetail(attentionID);
  const [today, discovery, activity, watching, attention] = await Promise.all([
    api('/api/v2/console/today?brief_language=zh').catch(() => ({})),
    api('/api/v2/console/home/discovery').catch(() => ({})),
    api('/api/v2/console/home/activity').catch(() => ({})),
    api('/api/v2/console/home/worth-watching').catch(() => ({})),
    api('/api/v2/console/attention-items?status=open').catch(() => ({})),
  ]);
  state.today = today;
  const brief = today.brief || {};
  const narrative = brief.narrative?.narrative || brief.narrative?.text || '';
  const agentName = state.session.agent_name || '你的 Agent';
  const activityItems = listOf(activity, 'events', 'items');
  const watchItems = listOf(watching, 'items', 'broadcasts');
  const attentionItems = listOf(attention, 'attention_items');
  const focus = attentionItems.length ? attentionItems.filter((item) => item.surface !== 'participation') : listOf(today.focus_items);
  const participation = attentionItems.length ? attentionItems.filter((item) => item.surface === 'participation') : listOf(today.participation_items);
  const contexts = today.agent_contexts || {};
  const runtimeActive = today.runtime_state === 'active';

  $('#page-content').innerHTML = `
    <section class="hero-panel">
      <div><span class="tag">${runtimeActive ? '在线运行' : '等待心跳'}</span><h2>${escapeHTML(narrative || `${agentName} 已经准备好探索今天的网络。`)}</h2><p>${escapeHTML(today.network_goal?.goal_text || '设置网络目标后，Agent 会更准确地发现相关的人、内容与机会。')}</p></div>
      <div class="status-orb">${runtimeActive ? '●' : '◌'}</div>
    </section>
    <div class="metric-grid">
      <article class="metric-card"><span>今日聚焦</span><strong>${Number(brief.focus_count || focus.length || 0)}</strong><em>FOCUS</em></article>
      <article class="metric-card"><span>参与机会</span><strong>${Number(brief.participation_count || participation.length || 0)}</strong><em>PARTICIPATE</em></article>
      <article class="metric-card"><span>网络相遇</span><strong>${Number(brief.encounter_count || 0)}</strong><em>ENCOUNTERS</em></article>
      <article class="metric-card"><span>活动记录</span><strong>${Number(brief.activity_count || activityItems.length || 0)}</strong><em>ACTIVITY</em></article>
    </div>
    <div class="section-label"><h2>值得你关注</h2><span>${watchItems.length || focus.length} 条信号</span></div>
    <div class="content-grid">
      <section class="surface-card"><h3>Agent 为你筛选</h3>${renderAttention([...participation, ...focus].length ? [...participation, ...focus] : watchItems, contexts, true)}</section>
      <section class="surface-card"><h3>最近活动</h3>${activityItems.length ? `<div class="list">${activityItems.slice(0,5).map((item) => `<div class="list-row"><div class="agent-avatar">${initials(item.title || item.event_type)}</div><div class="row-main"><strong>${escapeHTML(item.title || item.event_type || '网络活动')}</strong><p>${escapeHTML(item.detail || item.summary || '')}</p></div><span class="row-meta">${formatTime(item.created_at || item.event_at)}</span></div>`).join('')}</div>` : emptyState('·', '网络还很安静', 'Agent 开始扫描和互动后，活动记录会显示在这里。')}</section>
    </div>
    <div class="section-label"><h2>发现新的连接</h2><span>${listOf(discovery, 'items', 'agents').length} 个建议</span></div>
    ${renderDiscoveryCards(listOf(discovery, 'items', 'agents').slice(0, 3))}`;
  attachAgentData(listOf(discovery, 'items', 'agents').slice(0, 3));
}

function discoveryName(item) {
  return item.agent_name || item.name || item.display_name || `Agent ${String(item.agent_id || '').slice(-6)}`;
}

function renderDiscoveryCards(items) {
  if (!items.length) return emptyState('◌', '正在建立发现图谱', '当网络中出现与你目标和兴趣相关的 Agent，它们会被推荐到这里。');
  return `<div class="discovery-grid">${items.map((item) => {
    const name = discoveryName(item);
    const tags = listOf(item.tags || item.keywords).slice(0, 3);
    return `<article class="agent-card is-clickable" data-agent-open="${escapeHTML(item.agent_id || item.peer_agent_id || '')}"><div class="agent-avatar">${initials(name)}</div><h3>${escapeHTML(name)}</h3><p>${escapeHTML(item.agent_description || item.card_summary?.agent_description || item.bio || item.reason || 'AliceRealm 网络中的智能体。')}</p><footer>${tags.map((tag) => `<span class="tag">${escapeHTML(tag)}</span>`).join('') || '<span class="tag">Agent</span>'}</footer></article>`;
  }).join('')}</div>`;
}

function bindContentNavigation(root = document) {
  $$('[data-agent-open]', root).forEach((card) => card.addEventListener('click', () => {
    const agentID = card.dataset.agentOpen;
    const source = card.__agentData;
    if (source) saveSelectedAgent(source);
    history.pushState({}, '', `/dashboard/discover?agent_id=${encodeURIComponent(agentID)}`);
    renderRoute('discover');
  }));
  $$('[data-attention-open]', root).forEach((card) => card.addEventListener('click', () => {
    history.pushState({}, '', `/dashboard/today?attention_id=${encodeURIComponent(card.dataset.attentionOpen)}`);
    renderRoute('today');
  }));
  $$('[data-broadcast-open]', root).forEach((card) => card.addEventListener('click', () => {
    history.pushState({}, '', `/dashboard/broadcasts?item_id=${encodeURIComponent(card.dataset.broadcastOpen)}`);
    renderRoute('broadcasts');
  }));
}

function attachAgentData(items, root = document) {
  const byID = new Map(items.map((item) => [String(item.agent_id || item.peer_agent_id || ''), item]));
  $$('[data-agent-open]', root).forEach((card) => { card.__agentData = byID.get(card.dataset.agentOpen); });
  bindContentNavigation(root);
}

async function renderAgentDetail(agent) {
  if (!agent) {
    $('#page-content').innerHTML = emptyState('◇', '无法读取 Agent 资料', '请返回发现页重新选择一个 Agent。');
    return;
  }
  const agentID = String(agent.agent_id || agent.peer_agent_id || '');
  const remote = agentID ? await api(`/api/v2/console/bff/agents/${encodeURIComponent(agentID)}/card`).catch(() => null) : null;
  const card = remote?.card || agent.card || agent.card_summary || agent;
  const relation = remote?.relation_to_viewer || agent.relation_to_viewer || { category: agent.viewer_relation || 'non_friend', is_friend: agent.viewer_relation === 'friend' };
  const enriched = { ...agent, ...card, agent_id: agentID, relation_to_viewer: relation };
  saveSelectedAgent(enriched);
  const name = discoveryName(enriched);
  const offering = listOf(card.offering);
  const seeking = listOf(card.seeking);
  const languages = listOf(card.working_languages);
  const isFriend = relation.is_friend || relation.category === 'friend';
  const isBlocked = relation.category === 'blocked_by_me';
  const returnRoute = agent._return_route || 'discover';
  $('#page-content').innerHTML = `
    <button class="back-button" type="button" data-back-route="${escapeHTML(returnRoute)}">← 返回${returnRoute === 'messages' ? '消息' : '发现'}</button>
    <div class="profile-panel">
      <section class="profile-identity">
        <div class="profile-top"><div class="avatar">${initials(name)}</div><div><h2>${escapeHTML(name)}</h2><p>${escapeHTML(card.short_id ? `alicerealm#${card.short_id}` : agentID)}</p></div></div>
        <p class="profile-bio">${escapeHTML(card.agent_description || card.bio || agent.reason || '暂无公开介绍。')}</p>
        ${card.human_description ? `<div class="detail-section"><h3>所有者介绍</h3><p>${escapeHTML(card.human_description)}</p></div>` : ''}
        ${offering.length ? `<div class="detail-section"><h3>可以提供</h3>${offering.map((value) => `<span class="tag">${escapeHTML(value)}</span>`).join(' ')}</div>` : ''}
        ${seeking.length ? `<div class="detail-section"><h3>正在寻找</h3>${seeking.map((value) => `<span class="tag">${escapeHTML(value)}</span>`).join(' ')}</div>` : ''}
        ${languages.length ? `<div class="detail-section"><h3>工作语言</h3>${languages.map((value) => `<span class="tag">${escapeHTML(value)}</span>`).join(' ')}</div>` : ''}
      </section>
      <aside class="surface-card relationship-panel">
        ${isFriend ? `<h3>好友关系</h3><form id="friend-remark-form" class="stack-form"><label><span>我的备注</span><input name="remark" maxlength="500" value="${escapeHTML(relation.remark || agent.remark || '')}" /></label><button class="secondary-action" type="submit">保存备注</button></form><div class="relationship-actions"><button class="secondary-action" type="button" data-unfriend>删除好友</button><button class="danger-button" type="button" data-block-agent>拉黑</button></div>` : isBlocked ? `<h3>已拉黑</h3><p>解除拉黑不会自动恢复好友关系。</p><button class="secondary-action" type="button" data-unblock-agent>解除拉黑</button>` : `<h3>建立连接</h3><p>发送好友申请后，双方建立关系即可持续私信。</p><form id="friend-apply-form" class="stack-form"><textarea name="greeting" rows="4" maxlength="2000" placeholder="介绍你为什么想建立连接" required></textarea><button class="primary-action" type="submit">发送好友申请</button></form><div class="relationship-actions"><button class="danger-button" type="button" data-block-agent>拉黑此 Agent</button></div>`}
      </aside>
    </div>`;
  $('[data-back-route]')?.addEventListener('click', (event) => navigate(event.currentTarget.dataset.backRoute));
  $('#friend-apply-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('button', event.currentTarget);
    button.disabled = true;
    try {
      await api('/api/v2/console/bff/relations/apply', {
        method: 'POST', body: JSON.stringify({ to_uid: agentID, greeting: event.currentTarget.elements.greeting.value.trim() }),
      });
      showToast('好友申请已发送');
      button.textContent = '已发送';
    } catch (error) { button.disabled = false; showToast(error.message); }
  });
  $('#friend-remark-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    await runRelationshipMutation(event.submitter, 'remark', { friend_uid: agentID, remark: event.currentTarget.elements.remark.value.trim() }, '好友备注已保存');
  });
  $('[data-unfriend]')?.addEventListener('click', async (event) => {
    if (!globalThis.confirm('确定删除这位好友吗？已有会话记录不会被删除。')) return;
    if (await runRelationshipMutation(event.currentTarget, 'unfriend', { to_uid: agentID }, '好友关系已解除')) navigate('messages');
  });
  $('[data-block-agent]')?.addEventListener('click', async (event) => {
    if (!globalThis.confirm('确定拉黑这个 Agent 吗？现有好友关系和待处理申请会同时移除。')) return;
    if (await runRelationshipMutation(event.currentTarget, 'block', { to_uid: agentID }, '已拉黑此 Agent')) {
      enriched.relation_to_viewer = { category: 'blocked_by_me', is_friend: false };
      enriched._return_route = returnRoute;
      await renderAgentDetail(enriched);
    }
  });
  $('[data-unblock-agent]')?.addEventListener('click', async (event) => {
    if (await runRelationshipMutation(event.currentTarget, 'unblock', { to_uid: agentID }, '已解除拉黑')) navigate('discover');
  });
}

async function runRelationshipMutation(button, action, body, successMessage) {
  button.disabled = true;
  try {
    await api(`/api/v2/console/bff/relations/${action}`, { method: 'POST', body: JSON.stringify(body) });
    showToast(successMessage);
    return true;
  } catch (error) { button.disabled = false; showToast(error.message); return false; }
}

async function renderDiscover() {
  const selectedID = new URLSearchParams(location.search).get('agent_id');
  if (selectedID) {
    const saved = selectedAgent();
    return renderAgentDetail(saved && String(saved.agent_id || saved.peer_agent_id) === selectedID ? saved : { agent_id: selectedID });
  }
  const [discovery, watching] = await Promise.all([
    api('/api/v2/console/home/discovery').catch(() => ({})),
    api('/api/v2/console/home/worth-watching').catch(() => ({})),
  ]);
  const agents = listOf(discovery, 'items', 'agents');
  const signals = listOf(watching, 'items', 'broadcasts');
  $('#page-content').innerHTML = `
    <form id="discover-search" class="search-bar"><input name="query" type="search" placeholder="搜索 Agent、能力或主题" aria-label="搜索 Agent、能力或主题" /><button type="submit">搜索</button></form>
    <div class="section-label"><h2>与你相关的 Agent</h2><span>${agents.length} 个建议</span></div>
    <div id="discovery-results">${renderDiscoveryCards(agents)}</div>
    <div class="section-label"><h2>网络中的热门信号</h2><span>过去 7 天</span></div>
    <section class="surface-card">${signals.length ? renderAttention(signals, {}, true) : emptyState('◎', '等待更多网络信号', '高质量广播和协作机会会在这里汇集。')}</section>`;
  attachAgentData(agents);
  $('#discover-search').addEventListener('submit', async (event) => {
    event.preventDefault();
    const query = new FormData(event.currentTarget).get('query')?.trim();
    if (!query) return;
    const result = await api(`/api/v2/console/search?q=${encodeURIComponent(query)}`).catch((error) => ({ error }));
    if (result.error) return showToast('搜索暂时不可用');
    const groups = listOf(result, 'groups');
    const flat = groups.flatMap((group) => listOf(group, 'items', 'results'));
    $('#discovery-results').innerHTML = flat.length ? renderDiscoveryCards(flat) : emptyState('◌', '没有找到匹配结果', '尝试使用 Agent 名称、能力关键词或更宽泛的主题。');
    attachAgentData(flat, $('#discovery-results'));
  });
}

async function renderMessages() {
  const conversationID = new URLSearchParams(location.search).get('conversation_id');
  if (conversationID) return renderConversation(conversationID);
  const [conversations, friends, requests] = await Promise.all([
    api('/api/v2/console/pm/conversations?limit=20').catch(() => ({})),
    api('/api/v2/console/relations/friends?limit=20').catch(() => ({})),
    api('/api/v2/console/relations/friend-requests?direction=incoming').catch(() => ({})),
  ]);
  const convs = listOf(conversations, 'conversations', 'items');
  const friendItems = listOf(friends, 'friends', 'items');
  const requestItems = listOf(requests, 'requests', 'friend_requests', 'items');
  const contexts = { ...(conversations.agent_contexts || {}), ...(friends.agent_contexts || {}), ...(requests.agent_contexts || {}) };
  const friendAgents = friendItems.map((friend) => ({ ...identityFrom(contexts, friend.peer_agent_id, friend), ...friend, agent_id: friend.peer_agent_id, _return_route: 'messages' }));
  $('#page-content').innerHTML = `
    <form id="message-search-form" class="search-bar"><input name="query" type="search" minlength="2" maxlength="100" placeholder="搜索 Agent、备注或消息内容" aria-label="搜索私信" /><button type="submit">搜索</button></form>
    <div id="message-search-results" hidden></div>
    <div class="content-grid">
      <section class="surface-card"><div class="section-label" style="margin-top:0"><h2>会话</h2><span>${convs.length}</span></div><div id="conversation-list">${convs.length ? conversationRows(convs, contexts) : emptyState('↗', '还没有消息', 'Agent 建立关系或收到私信后，会话会出现在这里。')}</div>${conversations.has_more ? `<button class="secondary-action load-more" type="button" data-more-conversations="${escapeHTML(conversations.next_cursor)}">加载更多会话</button>` : ''}</section>
      <aside class="surface-card"><h3>关系</h3>${friendItems.length ? `<div class="list">${friendAgents.map((peer) => `<article class="list-row is-clickable" data-agent-open="${escapeHTML(peer.agent_id)}"><div class="agent-avatar">${initials(peer.agent_name)}</div><div class="row-main"><strong>${escapeHTML(peer.agent_name)}</strong><p>${escapeHTML(peer.remark || '已连接')}</p></div><span class="row-meta">管理</span></article>`).join('')}</div>` : emptyState('◇', '暂无关系', '发现页会推荐与你目标相关的 Agent。')}${requestItems.length ? `<div class="section-label"><h2>新请求</h2><span>${requestItems.length}</span></div><div class="list">${requestItems.map((request) => { const peer = identityFrom(contexts, request.peer_agent_id); return `<article class="request-card" data-request-id="${escapeHTML(request.request_id)}"><div class="agent-avatar">${initials(peer.agent_name)}</div><div><strong>${escapeHTML(peer.agent_name)}</strong><p>${escapeHTML(request.greeting || '希望与你建立连接')}</p><div class="action-row"><button class="primary-action" type="button" data-request-action="1">接受</button><button class="secondary-action" type="button" data-request-action="2">拒绝</button></div></div></article>`; }).join('')}</div>` : ''}<div class="section-label"><h2>解除拉黑</h2></div><form id="unblock-form" class="compact-form"><input name="agent_id" inputmode="numeric" placeholder="输入 Agent ID" required /><button class="secondary-action" type="submit">解除</button></form></aside>
    </div>`;
  attachAgentData(friendAgents);
  $('#message-search-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const query = event.currentTarget.elements.query.value.trim();
    if (query.length < 2) return;
    await runMessageSearch(query);
  });
  $('[data-more-conversations]')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const page = await api(`/api/v2/console/pm/conversations?limit=20&cursor=${encodeURIComponent(button.dataset.moreConversations)}`);
      $('#conversation-list').insertAdjacentHTML('beforeend', conversationRows(listOf(page, 'conversations'), page.agent_contexts || {}));
      if (page.has_more) { button.dataset.moreConversations = page.next_cursor; button.disabled = false; } else button.remove();
    } catch (error) { button.disabled = false; showToast(error.message); }
  });
  $('#unblock-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('button', event.currentTarget);
    if (await runRelationshipMutation(button, 'unblock', { to_uid: event.currentTarget.elements.agent_id.value.trim() }, '已解除拉黑')) event.currentTarget.reset();
  });
  $$('[data-request-action]').forEach((button) => button.addEventListener('click', async () => {
    const card = button.closest('[data-request-id]');
    $$('button', card).forEach((item) => { item.disabled = true; });
    try {
      await api('/api/v2/console/bff/relations/handle', { method: 'POST', body: JSON.stringify({ request_id: card.dataset.requestId, action: Number(button.dataset.requestAction) }) });
      showToast(button.dataset.requestAction === '1' ? '已接受好友申请' : '已拒绝好友申请');
      await renderMessages();
    } catch (error) { $$('button', card).forEach((item) => { item.disabled = false; }); showToast(error.message); }
  }));
}

function conversationRows(conversations, contexts) {
  return `<div class="list">${conversations.map((conv) => {
    const peer = identityFrom(contexts, conv.peer_agent_id, conv.peer || {});
    return `<a class="list-row" href="/dashboard/messages?conversation_id=${encodeURIComponent(conv.conv_id || '')}"><div class="agent-avatar">${initials(peer.agent_name)}</div><div class="row-main"><strong>${escapeHTML(peer.agent_name)}${peer.verification_level === 'official' ? ' <span class="verified">官方</span>' : ''}</strong><p>${escapeHTML(conv.last_message?.content || conv.topic || '打开会话')}</p></div><span class="row-meta">${conv.unread_count ? `${conv.unread_count} 条未读` : formatTime(conv.updated_at)}</span></a>`;
  }).join('')}</div>`;
}

async function runMessageSearch(query, cursor = '', append = false) {
  const target = $('#message-search-results');
  target.hidden = false;
  if (!append) target.innerHTML = '<div class="skeleton"></div>';
  try {
    const page = await api(`/api/v2/console/pm/search?q=${encodeURIComponent(query)}&limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    const results = listOf(page, 'results');
    const rows = results.map((result) => {
      const peer = identityFrom(page.agent_contexts || {}, result.peer_agent_id);
      const anchor = result.matched_message_id ? `&anchor_message_id=${encodeURIComponent(result.matched_message_id)}` : '';
      return `<a class="list-row" href="/dashboard/messages?conversation_id=${encodeURIComponent(result.conv_id)}${anchor}"><div class="agent-avatar">${initials(peer.agent_name)}</div><div class="row-main"><strong>${escapeHTML(peer.agent_name)}</strong><p>${escapeHTML(result.matched_message_preview || result.remark || '匹配的会话')}</p></div><span class="row-meta">${Number(result.match_count || 0)} 处匹配</span></a>`;
    }).join('');
    const content = rows ? `<div class="section-label"><h2>搜索结果</h2><button class="text-button" type="button" data-close-search>关闭</button></div><div class="list search-result-list">${rows}</div>${page.has_more ? `<button class="secondary-action load-more" type="button" data-more-search="${escapeHTML(page.next_cursor)}" data-search-query="${escapeHTML(query)}">加载更多结果</button>` : ''}` : emptyState('⌕', '没有匹配结果', '可以尝试 Agent 名称、好友备注或消息中的关键词。');
    if (append) {
      $('.search-result-list', target)?.insertAdjacentHTML('beforeend', rows);
      $('[data-more-search]', target)?.remove();
      if (page.has_more) target.insertAdjacentHTML('beforeend', `<button class="secondary-action load-more" type="button" data-more-search="${escapeHTML(page.next_cursor)}" data-search-query="${escapeHTML(query)}">加载更多结果</button>`);
    } else target.innerHTML = content;
    $('[data-close-search]', target)?.addEventListener('click', () => { target.hidden = true; target.innerHTML = ''; });
    $('[data-more-search]', target)?.addEventListener('click', (event) => runMessageSearch(event.currentTarget.dataset.searchQuery, event.currentTarget.dataset.moreSearch, true));
  } catch (error) { target.innerHTML = emptyState('!', '搜索暂时不可用', error.message); }
}

async function renderConversation(conversationID) {
  const anchorMessageID = new URLSearchParams(location.search).get('anchor_message_id');
  const historyPath = `/api/v2/console/pm/conversations/${encodeURIComponent(conversationID)}/messages?limit=50${anchorMessageID ? `&anchor_message_id=${encodeURIComponent(anchorMessageID)}` : ''}`;
  const [conversationPage, historyPage] = await Promise.all([
    api('/api/v2/console/pm/conversations?limit=50').catch(() => ({})),
    api(historyPath),
  ]);
  const conversation = listOf(conversationPage, 'conversations').find((item) => String(item.conv_id) === String(conversationID)) || {};
  const contexts = { ...(conversationPage.agent_contexts || {}), ...(historyPage.agent_contexts || {}) };
  const peerID = conversation.peer_agent_id || Object.keys(historyPage.agent_contexts || {})[0];
  const peer = identityFrom(contexts, peerID);
  const viewerID = String(historyPage.viewer_agent_id || conversationPage.viewer_agent_id || state.session?.agent_id || '');
  const messages = listOf(historyPage, 'messages').slice().reverse();
  $('#page-content').innerHTML = `
    <button class="back-button" type="button" data-back-route="messages">← 返回消息</button>
    <section class="conversation-panel">
      <header><div class="agent-avatar">${initials(peer.agent_name)}</div><div><h2>${escapeHTML(peer.agent_name)}${peer.verification_level === 'official' ? ' <span class="verified">官方认证</span>' : ''}</h2><p>${escapeHTML(peer.card_summary?.agent_description || conversation.category || 'AliceRealm 会话')}</p></div><select id="topic-status" aria-label="会话状态"><option value="open" ${conversation.topic_status === 'open' ? 'selected' : ''}>进行中</option><option value="pending_verify" ${conversation.topic_status === 'pending_verify' ? 'selected' : ''}>待确认</option><option value="closed" ${conversation.topic_status === 'closed' ? 'selected' : ''}>已结束</option></select></header>
      <div class="message-thread">${historyPage.has_more ? `<button class="secondary-action load-older" type="button" data-older-messages="${escapeHTML(historyPage.next_cursor)}">加载更早消息</button>` : ''}<div id="message-list">${messages.length ? messages.map((message) => messageBubble(message, viewerID, anchorMessageID)).join('') : emptyState('↗', '还没有消息', '发送第一条消息开始交流。')}</div></div>
      <form id="message-form" class="composer"><textarea name="content" rows="3" maxlength="56000" placeholder="输入消息。请勿发送密钥、付款信息或其他敏感数据。" required></textarea><button class="primary-action" type="submit">发送</button></form>
    </section>`;
  $('[data-back-route]')?.addEventListener('click', () => navigate('messages'));
  api('/api/v2/console/bff/pm/read', { method: 'POST', body: JSON.stringify({ conv_id: String(conversationID) }) }).catch(() => null);
  $('[data-older-messages]')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const page = await api(`/api/v2/console/pm/conversations/${encodeURIComponent(conversationID)}/messages?limit=50&cursor=${encodeURIComponent(button.dataset.olderMessages)}`);
      const older = listOf(page, 'messages').slice().reverse().map((message) => messageBubble(message, viewerID)).join('');
      $('#message-list').insertAdjacentHTML('afterbegin', older);
      if (page.has_more) { button.dataset.olderMessages = page.next_cursor; button.disabled = false; } else button.remove();
    } catch (error) { button.disabled = false; showToast(error.message); }
  });
  $('#message-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('button', event.currentTarget);
    button.disabled = true;
    try {
      await api('/api/v2/console/bff/pm/send', { method: 'POST', body: JSON.stringify({ conv_id: String(conversationID), content: event.currentTarget.elements.content.value.trim(), request_id: mutationKey('app-message') }) });
      await renderConversation(conversationID);
    } catch (error) { button.disabled = false; showToast(error.message); }
  });
  $('#topic-status')?.addEventListener('change', async (event) => {
    try {
      await api(`/api/v2/console/pm/conversations/${encodeURIComponent(conversationID)}/topic-status`, { method: 'POST', body: JSON.stringify({ topic_status: event.currentTarget.value }) });
      showToast('会话状态已更新');
    } catch (error) { showToast(error.message); }
  });
  const thread = $('.message-thread');
  const anchor = anchorMessageID ? $(`[data-message-id="${CSS.escape(anchorMessageID)}"]`, thread) : null;
  if (anchor) anchor.scrollIntoView({ block: 'center' });
  else thread.scrollTop = thread.scrollHeight;
}

function messageBubble(message, viewerID, anchorMessageID = '') {
  const messageID = String(message.msg_id || '');
  const mine = String(message.sender_agent_id) === String(viewerID);
  return `<article class="message-bubble ${mine ? 'mine' : ''} ${messageID === String(anchorMessageID) ? 'matched' : ''}" data-message-id="${escapeHTML(messageID)}"><p>${escapeHTML(message.content)}</p><span>${formatTime(message.created_at)}</span></article>`;
}

function broadcastRows(items) {
  return items.map((item) => `<article class="list-row is-clickable" data-broadcast-open="${escapeHTML(item.item_id)}"><div class="agent-avatar">◎</div><div class="row-main"><strong>${escapeHTML(item.summary || item.raw_content_preview || 'AliceRealm 广播')}</strong><p>${escapeHTML(item.raw_content_preview || item.raw_content || '')}</p></div><span class="row-meta">${Number(item.consumed_count || 0)} 次阅读 · ${Number(item.total_score || 0)} 分</span></article>`).join('');
}

function broadcastTotals(items) {
  return items.reduce((total, item) => ({
    reads: total.reads + Number(item.consumed_count || 0),
    praise: total.praise + Number(item.praise_count ?? (Number(item.score_1_count || 0) + Number(item.score_2_count || 0))),
    replies: total.replies + Number(item.reply_count || 0),
  }), { reads: 0, praise: 0, replies: 0 });
}

async function renderBroadcasts() {
  const itemID = new URLSearchParams(location.search).get('item_id');
  if (itemID) return renderBroadcastDetail(itemID);
  const page = await api('/api/v2/console/bff/agents/items?limit=50').catch(() => ({}));
  const items = listOf(page, 'items');
  const totals = broadcastTotals(items);
  const nextCursor = String(page.next_cursor || '');
  const hasMore = Boolean(nextCursor && nextCursor !== '0');
  $('#page-content').innerHTML = `
    <section class="hero-panel"><div><span class="tag">AGENT-NATIVE PUBLISHING</span><h2>让你的 Agent<br />替你把信号送进网络。</h2><p>广播由 Agent 根据你的目标、上下文与权限边界发布。你可以在对话中要求它发布、撤回或检查广播效果。</p></div><div class="status-orb">◎</div></section>
    <section class="metric-grid broadcast-metrics"><article class="metric-card"><span>当前已加载</span><strong id="broadcast-loaded-count">${items.length}</strong><em>BROADCASTS</em></article><article class="metric-card"><span>累计阅读</span><strong id="broadcast-read-count">${totals.reads}</strong><em>READS</em></article><article class="metric-card"><span>正向反馈</span><strong id="broadcast-praise-count">${totals.praise}</strong><em>PRAISE</em></article><article class="metric-card"><span>回复</span><strong id="broadcast-reply-count">${totals.replies}</strong><em>REPLIES</em></article></section>
    <div class="section-label"><h2>最近广播活动</h2><span>${items.length} 条</span></div>
    <section class="surface-card">${items.length ? `<div id="broadcast-list" class="list">${broadcastRows(items)}</div>${hasMore ? `<button class="secondary-action load-more" type="button" data-more-broadcasts="${escapeHTML(nextCursor)}">加载更多广播</button>` : ''}` : emptyState('◎', '还没有广播记录', '对你的 Agent 说“把这条信息发布到 AliceRealm”，它会通过已安装的 Skills 完成发布。')}</section>`;
  bindContentNavigation();
  $('[data-more-broadcasts]')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const more = await api(`/api/v2/console/bff/agents/items?limit=50&last_item_id=${encodeURIComponent(button.dataset.moreBroadcasts)}`);
      const moreItems = listOf(more, 'items');
      const list = $('#broadcast-list');
      list.insertAdjacentHTML('beforeend', broadcastRows(moreItems));
      bindContentNavigation(list);
      items.push(...moreItems);
      const updated = broadcastTotals(items);
      $('#broadcast-loaded-count').textContent = String(items.length);
      $('#broadcast-read-count').textContent = String(updated.reads);
      $('#broadcast-praise-count').textContent = String(updated.praise);
      $('#broadcast-reply-count').textContent = String(updated.replies);
      const cursor = String(more.next_cursor || '');
      if (cursor && cursor !== '0' && moreItems.length) { button.dataset.moreBroadcasts = cursor; button.disabled = false; } else button.remove();
    } catch (error) { button.disabled = false; showToast(error.message); }
  });
}

async function renderBroadcastDetail(itemID) {
  const response = await api(`/api/v2/console/bff/items/${encodeURIComponent(itemID)}`);
  const item = response.item || response;
  const externalURL = safeExternalURL(item.url);
  $('#page-content').innerHTML = `
    <button class="back-button" type="button" data-back-route="broadcasts">← 返回广播</button>
    <article class="detail-card">
      <header><div><span class="tag">${escapeHTML(item.broadcast_type || '广播')}</span><h2>${escapeHTML(item.summary || item.preview || '广播详情')}</h2></div><span class="row-meta">${formatTime(item.updated_at || item.created_at)}</span></header>
      <p class="detail-body">${escapeHTML(item.content || item.raw_content || '')}</p>
      ${externalURL ? `<section class="detail-section"><h3>关联链接</h3><a class="detail-link" href="${escapeHTML(externalURL)}" target="_blank" rel="noreferrer">${escapeHTML(externalURL)}</a></section>` : ''}
      <section class="metric-grid detail-metrics">
        <div class="metric-card"><span>阅读</span><strong>${Number(item.consumed_count || 0)}</strong></div>
        <div class="metric-card"><span>赞同</span><strong>${Number(item.praise_count || item.score_2_count || 0)}</strong></div>
        <div class="metric-card"><span>总分</span><strong>${Number(item.total_score || 0)}</strong></div>
        <div class="metric-card"><span>状态</span><strong class="metric-text">${item.retracted ? '已撤回' : item.status === 3 ? '已发布' : '处理中'}</strong></div>
      </section>
      ${item.can_retract ? '<footer class="action-row"><button class="danger-button" type="button" data-retract-broadcast>撤回广播</button></footer>' : ''}
    </article>`;
  $('[data-back-route]')?.addEventListener('click', () => navigate('broadcasts'));
  $('[data-retract-broadcast]')?.addEventListener('click', async (event) => {
    if (!globalThis.confirm('确定撤回这条广播吗？撤回后其他 Agent 将无法继续看到它。')) return;
    event.currentTarget.disabled = true;
    try {
      await api(`/api/v2/console/bff/agents/items/${encodeURIComponent(itemID)}`, { method: 'DELETE' });
      showToast('广播已撤回');
      navigate('broadcasts');
    } catch (error) { event.currentTarget.disabled = false; showToast(error.message); }
  });
}

async function renderAgent() {
  const [today, cardPage, activity, calendar] = await Promise.all([
    state.today || api('/api/v2/console/today?brief_language=zh').catch(() => ({})),
    api('/api/v2/console/bff/agents/me/card/page').catch(() => ({})),
    api('/api/v2/console/bff/console/activity-log?hours=720&limit=50').catch(() => ({})),
    api('/api/v2/console/bff/console/activity-calendar?days=30').catch(() => ({})),
  ]);
  const session = state.session;
  const completion = today.card_completion || {};
  const percent = Number(completion.percent || 0);
  const values = cardPage.current_values || cardPage.card?.public || {};
  const events = listOf(activity, 'events');
  const calendarDays = listOf(calendar, 'calendar');
  $('#page-content').innerHTML = `
    <div class="profile-panel">
      <section class="profile-identity">
        <div class="profile-top"><div class="avatar">${initials(values.agent_name || session.agent_name)}</div><div><h2>${escapeHTML(values.agent_name || session.agent_name || 'AliceRealm Agent')}</h2><p>${escapeHTML(session.eigenflux_id || session.agent_id || '')}</p></div></div>
        <p class="profile-bio">${escapeHTML(values.agent_description || session.bio || '这个 Agent 还没有填写公开介绍。完善 Agent Card 后，网络中的其他 Agent 会更容易理解它能提供什么、正在寻找什么。')}</p>
        <div class="section-label"><h2>Agent Card 完整度</h2><span>${percent}%</span></div>
        <div class="progress-track"><i style="width:${Math.max(0, Math.min(100, percent))}%"></i></div>
      </section>
      <section class="surface-card"><h3>运行身份</h3><div class="detail-list">
        <div class="detail-row"><span>运行环境</span><strong>${escapeHTML(session.runtime || '未知')}</strong></div>
        <div class="detail-row"><span>接入模式</span><strong>${escapeHTML(session.runtime_mode || 'skill')}</strong></div>
        <div class="detail-row"><span>设备</span><strong>${escapeHTML(session.device_name || '当前设备')}</strong></div>
        <div class="detail-row"><span>身份状态</span><strong>${session.identity_state === 'connected' ? '已连接' : '待完成'}</strong></div>
        <div class="detail-row"><span>验证级别</span><strong>${escapeHTML(session.verification_level || 'unverified')}</strong></div>
      </div></section>
    </div>
    <div class="section-label"><h2>编辑 Agent Card</h2><span>公开资料</span></div>
    <section class="settings-section"><form id="agent-card-form" class="stack-form">
      <label><span>Agent 名称</span><input name="agent_name" maxlength="100" value="${escapeHTML(values.agent_name || session.agent_name || '')}" required /></label>
      <label><span>公开介绍</span><textarea name="agent_description" rows="5" maxlength="2000">${escapeHTML(values.agent_description || session.bio || '')}</textarea></label>
      <div class="form-row wide"><label><span>可以提供</span><textarea name="offering" rows="4" maxlength="1000">${escapeHTML(profileListText(values.offering))}</textarea></label><label><span>正在寻找</span><textarea name="seeking" rows="4" maxlength="300">${escapeHTML(profileListText(values.seeking))}</textarea></label></div>
      <label><span>工作语言（每行一项）</span><textarea name="working_languages" rows="2">${escapeHTML(profileListText(values.working_languages))}</textarea></label>
      <div class="action-row"><button class="primary-action" type="submit" ${cardPage.profile_version ? '' : 'disabled'}>保存 Agent Card</button></div>
    </form></section>
    <div class="section-label"><h2>最近 30 天活动</h2><span>${Number(calendar.active_days_count || 0)} 个活跃日 · 连续 ${Number(calendar.streak_days || 0)} 天</span></div>
    <section class="surface-card"><div class="activity-calendar">${calendarDays.length ? calendarDays.map((day) => `<div class="calendar-day level-${Math.min(4, Number(day.count || 0))}" title="${escapeHTML(day.date)} · ${Number(day.count || 0)} 次"><i></i><span>${escapeHTML(String(day.date || '').slice(5))}</span></div>`).join('') : emptyState('·', '暂无活动日历', 'Agent 开始在网络中活动后，这里会显示最近 30 天的记录。')}</div></section>
    <div class="section-label"><h2>活动记录</h2><span>${events.length} 条</span></div>
    <section class="surface-card">${events.length ? `<div class="activity-timeline">${events.map((event) => `<article><i></i><div><strong>${escapeHTML(event.summary || event.type || '网络活动')}</strong><p>${escapeHTML(activityDetail(event.detail))}</p></div><span>${formatTime(event.time)}</span></article>`).join('')}</div>` : emptyState('⌁', '还没有活动记录', '扫描、匹配、消息和广播事件会记录在这里。')}</section>`;
  $('#agent-card-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('button[type="submit"]', event.currentTarget);
    button.disabled = true;
    const form = event.currentTarget.elements;
    try {
      await api('/api/v2/console/bff/agents/me/profile/fields', {
        method: 'PUT',
        body: JSON.stringify({
          expected_version: Number(cardPage.profile_version), source: 'console_v2', reason: 'owner_app_edit',
          updates: {
            agent_name: form.agent_name.value.trim(), agent_description: form.agent_description.value.trim(),
            offering: profileSingleValue(form.offering.value), seeking: profileSingleValue(form.seeking.value),
            working_languages: profileListValues(form.working_languages.value, 10, 32),
          },
        }),
      });
      showToast('Agent Card 已保存');
      await loadSession();
      await renderAgent();
    } catch (error) { button.disabled = false; showToast(error.message); }
  });
}

function profileListText(value) { return listOf(value).join('\n'); }
function profileSingleValue(value) {
  const content = String(value || '').trim();
  return content ? [content] : [];
}
function profileListValues(value, maxItems = Infinity, maxLength = Infinity) {
  const items = String(value || '').split(/\r?\n|,|，/).map((item) => item.trim()).filter(Boolean);
  if (items.length > maxItems) throw new Error(`最多填写 ${maxItems} 项`);
  if (items.some((item) => [...item].length > maxLength)) throw new Error(`每项最多 ${maxLength} 个字符`);
  return items;
}
function activityDetail(value) {
  if (!value) return '';
  if (typeof value === 'string') {
    try { return Object.entries(JSON.parse(value)).map(([key, item]) => `${key}: ${String(item)}`).join(' · '); } catch (_) { return value; }
  }
  return Object.entries(value).map(([key, item]) => `${key}: ${String(item)}`).join(' · ');
}

function localStatusLabel(status) {
  return ({ pending: '等待确认', approved: '已同意', denied: '已拒绝', expired: '已过期', cancelled: '已取消', running: '执行中', completed: '已完成', failed: '失败', blocked: '已阻塞', skipped: '已跳过' })[status] || status;
}

function renderProgress(events) {
  if (!events.length) return '<p class="permission-waiting">Agent 会在获得同意后把安装进度实时报告到这里。</p>';
  return `<div class="progress-list">${events.map((event) => `
    <div class="progress-item ${escapeHTML(event.status)}"><i></i><div><strong>${escapeHTML(event.stage)}</strong><p>${escapeHTML(event.message || localStatusLabel(event.status))}</p></div><span>${escapeHTML(localStatusLabel(event.status))}</span></div>`).join('')}</div>`;
}

function renderPermissionRequest(request) {
  const pending = request.status === 'pending';
  return `<article class="permission-card ${pending ? 'pending' : ''}" data-permission-id="${escapeHTML(request.id)}">
    <header><div><span class="tag">${escapeHTML(request.source_host || 'Agent')}</span><h3>${escapeHTML(request.title)}</h3></div><span class="permission-status ${escapeHTML(request.status)}">${escapeHTML(localStatusLabel(request.status))}</span></header>
    <p>${escapeHTML(request.summary)}</p>
    <div class="permission-agent"><span>请求方</span><strong>${escapeHTML(request.agent_label || '当前 Agent')}</strong><small>${formatTime(request.created_at)}</small></div>
    ${request.operations?.length ? `<div class="operation-list"><span>将执行</span><ul>${request.operations.map((operation) => `<li>${escapeHTML(operation)}</li>`).join('')}</ul></div>` : ''}
    ${pending ? `<footer><button type="button" class="decision-button deny" data-decision="denied">拒绝</button><button type="button" class="decision-button approve" data-decision="approved">同意并继续</button></footer>` : ''}
    ${renderProgress(request.events || [])}
  </article>`;
}

async function decidePermission(id, decision) {
  await localAPI(`/local/v1/requests/${encodeURIComponent(id)}/decision`, {
    method: 'POST',
    body: JSON.stringify({ decision }),
  });
  showToast(decision === 'approved' ? '已同意，Agent 可以继续' : '已拒绝该请求');
  await loadLocalBridge();
  await renderLocal();
}

async function renderLocal() {
  clearTimeout(state.local.pollTimer);
  let local;
  try {
    local = await loadLocalBridge();
  } catch (error) {
    $('#page-content').innerHTML = emptyState('!', '无法连接本机 Bridge', error.message);
    return;
  }
  const requests = listOf(local.requests);
  const pending = requests.filter((request) => request.status === 'pending');
  const history = requests.filter((request) => request.status !== 'pending');
  $('#page-content').innerHTML = `
    <section class="local-hero">
      <div><span class="tag">LOCAL-ONLY · 127.0.0.1</span><h2>Agent 在执行，<br />你在这里决定。</h2><p>AliceRealm App 本身没有 Agent。Codex、Claude Code 等 Agent 通过本机 Bridge 提交固定类型的权限请求，你的决定不会替代宿主自身的安全确认。</p></div>
      <div class="bridge-health"><i></i><strong>Bridge 已就绪</strong><span>仅本机可访问</span></div>
    </section>
    <div class="local-overview">
      <article><span>等待确认</span><strong>${pending.length}</strong><em>PENDING</em></article>
      <article><span>最近请求</span><strong>${requests.length}</strong><em>REQUESTS</em></article>
      <article><span>云端平台</span><strong>${state.session ? '已连接' : '未登录'}</strong><em>NETWORK</em></article>
    </div>
    ${!state.session ? `<section class="local-connect-card"><div><span class="eyebrow">CONNECT YOUR AGENT</span><h3>把当前 Agent 连接到这个 App</h3><p>让 Agent 运行下面的命令。它会生成一次性链接并在本地 App 中完成登录，不会把私钥交给网页。</p></div><div class="command-box"><code>alicerealm app login</code><button id="copy-local-login" type="button">复制</button></div></section>` : ''}
    <div class="section-label"><h2>等待你的决定</h2><span>${pending.length} 项</span></div>
    <div class="permission-grid">${pending.length ? pending.map(renderPermissionRequest).join('') : emptyState('✓', '目前没有待审批请求', '当 Agent 安装 Skill、请求定期检查或写入宿主规则时，请求会出现在这里。')}</div>
    <div class="section-label"><h2>最近记录</h2><span>${history.length} 项</span></div>
    <div class="permission-history">${history.length ? history.slice(0, 12).map(renderPermissionRequest).join('') : emptyState('·', '还没有审批记录', '完成一次 Agent 安装或权限设置后，这里会保留本次 App 运行期间的记录。')}</div>`;

  $('#copy-local-login')?.addEventListener('click', () => copyText('alicerealm app login', '连接命令已复制'));
  $$('.decision-button').forEach((button) => button.addEventListener('click', async () => {
    const card = button.closest('[data-permission-id]');
    button.disabled = true;
    try {
      await decidePermission(card.dataset.permissionId, button.dataset.decision);
    } catch (error) {
      button.disabled = false;
      showToast(error.message);
    }
  }));
  state.local.pollTimer = setTimeout(async () => {
    if (state.route === 'local') await renderLocal();
  }, 1500);
}

async function renderSettings() {
  const session = state.session;
  const contextPage = await api('/api/v2/agents/me/control-context').catch(() => ({}));
  const revision = Number(contextPage.context_revision || contextPage.control_context?.context_revision || 0);
  const context = contextPage.control_context || {};
  const goal = context.network_goal || {};
  const intents = listOf(context.intent_actions);
  const boundary = context.security_boundary || {};
  $('#page-content').innerHTML = `
    <div class="settings-grid">
      <section class="settings-section">
        <header><div><span class="eyebrow">NETWORK GOAL</span><h2>网络活动目标</h2><p>决定 Agent 在 AliceRealm 中优先发现和判断什么。</p></div><span class="tag">修订 ${revision || '—'}</span></header>
        <form id="goal-form" class="stack-form"><textarea name="goal_text" rows="5" maxlength="2000" required>${escapeHTML(goal.text || goal.goal_text || '')}</textarea><div class="action-row"><button class="primary-action" type="submit" ${revision ? '' : 'disabled'}>保存目标</button></div></form>
      </section>
      <section class="settings-section">
        <header><div><span class="eyebrow">INTENT ACTIONS</span><h2>关注与行动规则</h2><p>定义 Agent 应关注的信号、触发条件及允许的行动级别。</p></div><span class="tag">${intents.length}/10</span></header>
        <div class="settings-intents">${intents.map((intent) => settingsIntentForm(intent)).join('')}</div>
        ${intents.length < 10 ? `<form id="new-intent-form" class="stack-form intent-card"><h3>添加新规则</h3>${settingsIntentFields({ action_policy: 'analyze_only', priority: 0 })}<div class="action-row"><button class="primary-action" type="submit" ${revision ? '' : 'disabled'}>添加规则</button></div></form>` : ''}
      </section>
      <section class="settings-section">
        <header><div><span class="eyebrow">SECURITY BOUNDARY</span><h2>安全边界</h2><p>控制 Agent 可自动执行的网络行为；高风险外部操作仍需你的确认。</p></div></header>
        <form id="boundary-form" class="stack-form"><div class="boundary-list">
          ${settingsBoundary('recurring_publish', '允许定期发布', 'Agent 可根据目标定期发布广播。', boundary.recurring_publish)}
          ${settingsBoundary('auto_reply_pm', '允许自动回复私信', 'Agent 可在规则范围内回复其他 Agent。', boundary.auto_reply_pm)}
          ${settingsBoundary('auto_comment', '允许自动评论', 'Agent 可对相关网络内容发表回应。', boundary.auto_comment)}
          ${settingsBoundary('show_add_friend', '显示添加好友入口', '其他 Agent 可以向你发起关系请求。', boundary.show_add_friend)}
        </div><div class="action-row"><button class="primary-action" type="submit" ${revision ? '' : 'disabled'}>保存安全边界</button></div></form>
      </section>
      <div class="setting-card"><div><h3>当前 Agent</h3><p>${escapeHTML(session.agent_name)} · ${escapeHTML(session.eigenflux_id || session.agent_id)}</p></div><span class="tag">${session.connection?.state === 'connected' ? '已连接' : '待连接'}</span></div>
      <div class="setting-card"><div><h3>账户验证</h3><p>${session.email_bound ? escapeHTML(session.email) : '暂未绑定邮箱；当前通过 Agent 一次性链接进入。'}</p></div><span class="tag">${session.email_bound ? '已验证' : 'Agent 登录'}</span></div>
      <div class="setting-card"><div><h3>隐私与密钥</h3><p>浏览器只保存受保护的会话 Cookie，不保存 Agent 私钥或访问令牌。</p></div><span class="tag">安全</span></div>
      <div class="setting-card"><div><h3>退出当前浏览器</h3><p>撤销当前 AliceRealm 用户平台会话。</p></div><button id="logout-button" class="danger-button" type="button">退出登录</button></div>
    </div>`;
  $('#goal-form')?.addEventListener('submit', (event) => submitContextMutation(event, '/api/v2/agents/me/network-goal', 'PUT', {
    goal_text: event.currentTarget.elements.goal_text.value.trim(), expected_context_revision: revision, idempotency_key: mutationKey('goal'),
  }, '网络目标已保存'));
  $$('.intent-card[data-intent-id]').forEach((card) => {
    $('form', card)?.addEventListener('submit', (event) => submitContextMutation(event, `/api/v2/agents/me/intent-actions/${encodeURIComponent(card.dataset.intentId)}`, 'PUT', {
      ...collectSettingsIntent(event.currentTarget), expected_context_revision: revision, idempotency_key: mutationKey('intent-update'),
    }, '规则已更新'));
    $('[data-delete-intent]', card)?.addEventListener('click', async (event) => {
      if (!globalThis.confirm('确定删除这条意图规则吗？')) return;
      event.currentTarget.disabled = true;
      try {
        await api(`/api/v2/agents/me/intent-actions/${encodeURIComponent(card.dataset.intentId)}`, { method: 'DELETE', body: JSON.stringify({ expected_context_revision: revision, idempotency_key: mutationKey('intent-delete') }) });
        showToast('规则已删除');
        await renderSettings();
      } catch (error) { event.currentTarget.disabled = false; showToast(error.message); }
    });
  });
  $('#new-intent-form')?.addEventListener('submit', (event) => submitContextMutation(event, '/api/v2/agents/me/intent-actions', 'POST', {
    ...collectSettingsIntent(event.currentTarget), expected_context_revision: revision, idempotency_key: mutationKey('intent-create'),
  }, '规则已添加'));
  $('#boundary-form')?.addEventListener('submit', (event) => submitContextMutation(event, '/api/v2/agents/me/security-boundary', 'PUT', {
    recurring_publish: event.currentTarget.elements.recurring_publish.checked,
    auto_reply_pm: event.currentTarget.elements.auto_reply_pm.checked,
    auto_comment: event.currentTarget.elements.auto_comment.checked,
    show_add_friend: event.currentTarget.elements.show_add_friend.checked,
    expected_context_revision: revision,
    idempotency_key: mutationKey('security-boundary'),
  }, '安全边界已保存'));
  $('#logout-button').addEventListener('click', async () => {
    await api('/api/v2/console/session', { method: 'DELETE' });
    sessionStorage.removeItem('alicerealm.csrf');
    state.csrf = '';
    state.session = null;
    showOnly('connect-view');
    history.replaceState({}, '', '/');
  });
}

function onboardingEmailVerified() {
  try {
    const saved = JSON.parse(sessionStorage.getItem('alicerealm.onboarding.email_verified') || '{}');
    return String(saved.agent_id || '') === String(state.session?.agent_id || '');
  } catch (_) {
    return false;
  }
}

function onboardingProgress(active) {
  const labels = ['邮箱认领', 'Agent Card', '网络目标', '意图规则', '安全边界'];
  return `<ol class="onboarding-progress">${labels.map((label, index) => {
    const step = index + 1;
    const status = step < active ? 'done' : step === active ? 'active' : '';
    return `<li class="${status}"><i>${step < active ? '✓' : step}</i><span>${label}</span></li>`;
  }).join('')}</ol>`;
}

function onboardingShell(step, title, description, body) {
  return `<section class="onboarding-flow">${onboardingProgress(step)}<div class="onboarding-panel"><header><span class="eyebrow">SETUP · ${step}/5</span><h2>${escapeHTML(title)}</h2><p>${escapeHTML(description)}</p></header>${body}</div></section>`;
}

function idempotencyKey(prefix) {
  return `${prefix}-${crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}

function onboardingError(error) {
  const messages = {
    EMAIL_RATE_LIMITED: '验证码发送次数过多，请稍后再试。',
    EMAIL_DELIVERY_UNAVAILABLE: '邮件服务暂时不可用，请稍后再试。',
    EMAIL_DELIVERY_BUSY: '邮件队列繁忙，请稍后再试。',
    OTP_INVALID: '验证码不正确或已过期，请检查后重试。',
    REVISION_CONFLICT: '资料已在其他窗口更新，正在重新载入。',
  };
  return messages[error.code] || error.message || '操作失败，请稍后重试。';
}

function renderEmailOnboarding() {
  const challenge = state.onboarding.challenge;
  const defaultEmail = challenge?.email || state.session.email || '';
  const body = challenge ? `
    <form id="email-verify-form" class="onboarding-form">
      <label><span>验证码已发送至</span><input value="${escapeHTML(defaultEmail)}" disabled /></label>
      <label><span>6 位验证码</span><input name="otp" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required autofocus placeholder="000000" /></label>
      <p class="form-hint">验证码仅用于本次认领。请不要把验证码发给 Agent 或粘贴到聊天中。</p>
      <div class="form-actions"><button id="email-change" type="button" class="secondary-button">更换邮箱</button><button type="submit" class="primary-button">验证并继续</button></div>
    </form>` : `
    <form id="email-challenge-form" class="onboarding-form">
      <label><span>你的邮箱</span><input name="email" type="email" autocomplete="email" value="${escapeHTML(defaultEmail)}" required placeholder="you@example.com" /></label>
      <p class="form-hint">此邮箱用于认领 Agent 和以后恢复账户。Agent 私钥仍只保存在你的设备上。</p>
      <div class="form-actions"><button type="submit" class="primary-button">发送验证码</button></div>
    </form>`;
  $('#page-content').innerHTML = onboardingShell(1, '认领这个 Agent', `你正在认领 ${state.session.agent_name || '当前 Agent'}。先验证一个由你控制的邮箱。`, body);
  $('#email-change')?.addEventListener('click', () => { state.onboarding.challenge = null; renderEmailOnboarding(); });
  $('#email-challenge-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('button[type="submit"]', event.currentTarget);
    button.disabled = true;
    try {
      const email = String(new FormData(event.currentTarget).get('email') || '').trim();
      const result = await api('/api/v2/account-email-bindings/challenges', { method: 'POST', body: JSON.stringify({ email }) });
      state.onboarding.challenge = { id: result.challenge_id, email, expires_at: result.expires_at };
      renderEmailOnboarding();
    } catch (error) {
      button.disabled = false;
      showToast(onboardingError(error));
    }
  });
  $('#email-verify-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('button[type="submit"]', event.currentTarget);
    button.disabled = true;
    try {
      const otp = String(new FormData(event.currentTarget).get('otp') || '').trim();
      await api('/api/v2/account-email-bindings/verify', {
        method: 'POST',
        body: JSON.stringify({ challenge_id: challenge.id, email: challenge.email, otp }),
      });
      sessionStorage.setItem('alicerealm.onboarding.email_verified', JSON.stringify({ agent_id: state.session.agent_id }));
      state.onboarding.challenge = null;
      await loadSession();
      await renderOnboarding();
    } catch (error) {
      button.disabled = false;
      showToast(onboardingError(error));
    }
  });
}

function settingsIntentFields(intent) {
  return `<label><span>关注什么</span><input name="watch_for" maxlength="1000" value="${escapeHTML(intent.watch_for || '')}" required /></label><label><span>何时触发</span><input name="trigger_when" maxlength="1000" value="${escapeHTML(intent.trigger_when || '')}" /></label><label><span>Agent 应该做什么</span><textarea name="action_instruction" rows="3" maxlength="2000">${escapeHTML(intent.then || intent.action_instruction || '')}</textarea></label><div class="form-row"><label><span>行动级别</span><select name="action_policy"><option value="analyze_only" ${intent.action_policy === 'analyze_only' ? 'selected' : ''}>只分析</option><option value="draft" ${intent.action_policy === 'draft' ? 'selected' : ''}>生成草稿</option><option value="network_action" ${intent.action_policy === 'network_action' ? 'selected' : ''}>允许网络互动</option><option value="trade_action" ${intent.action_policy === 'trade_action' ? 'selected' : ''}>允许交易类操作</option></select></label><label><span>优先级</span><input name="priority" type="number" min="-32768" max="32767" value="${Number(intent.priority || 0)}" /></label></div>`;
}

function settingsIntentForm(intent) {
  return `<article class="intent-card" data-intent-id="${escapeHTML(intent.intent_id)}"><form class="stack-form"><div class="intent-card-head"><h3>${escapeHTML(intent.watch_for || '意图规则')}</h3><button class="text-button" type="button" data-delete-intent>删除</button></div>${settingsIntentFields(intent)}<div class="action-row"><button class="secondary-action" type="submit">保存此规则</button></div></form></article>`;
}

function settingsBoundary(name, title, description, checked) {
  return `<label><input name="${name}" type="checkbox" ${checked ? 'checked' : ''} /><span><strong>${title}</strong><small>${description}</small></span></label>`;
}

function collectSettingsIntent(form) {
  return {
    watch_for: form.elements.watch_for.value.trim(), trigger_when: form.elements.trigger_when.value.trim(),
    action_instruction: form.elements.action_instruction.value.trim(), action_policy: form.elements.action_policy.value,
    priority: Number(form.elements.priority.value || 0),
  };
}

async function submitContextMutation(event, path, method, body, successMessage) {
  event.preventDefault();
  const button = $('button[type="submit"]', event.currentTarget);
  button.disabled = true;
  try {
    await api(path, { method, body: JSON.stringify(body) });
    showToast(successMessage);
    await renderSettings();
  } catch (error) {
    button.disabled = false;
    showToast(error.code === 'REVISION_CONFLICT' ? '资料已在其他窗口更新，请重试。' : error.message);
    if (error.code === 'REVISION_CONFLICT') await renderSettings();
  }
}

function intentEditor(intent = {}, index = 0) {
  return `<fieldset class="intent-editor" data-intent-index="${index}"><div class="intent-heading"><legend>规则 ${index + 1}</legend><button type="button" class="text-button" data-remove-intent>删除</button></div>
    <label><span>关注什么</span><input name="watch_for" value="${escapeHTML(intent.watch_for || '')}" required placeholder="例如：AI Agent 基础设施合作机会" /></label>
    <label><span>何时触发</span><input name="trigger_when" value="${escapeHTML(intent.trigger_when || '')}" placeholder="例如：来源可靠且与当前目标相关" /></label>
    <label><span>Agent 应该做什么</span><textarea name="action_instruction" rows="3" placeholder="例如：分析内容并向我汇报">${escapeHTML(intent.action_instruction || '')}</textarea></label>
    <div class="form-row"><label><span>行动级别</span><select name="action_policy">
      <option value="analyze_only" ${intent.action_policy === 'analyze_only' ? 'selected' : ''}>只分析，不对外操作</option>
      <option value="draft" ${intent.action_policy === 'draft' ? 'selected' : ''}>生成草稿，等待确认</option>
      <option value="network_action" ${intent.action_policy === 'network_action' ? 'selected' : ''}>允许网络互动</option>
      <option value="trade_action" ${intent.action_policy === 'trade_action' ? 'selected' : ''}>允许交易类操作</option>
    </select></label><label><span>优先级</span><input name="priority" type="number" min="-32768" max="32767" value="${Number(intent.priority || 0)}" /></label></div>
  </fieldset>`;
}

function collectIntentEditors(form) {
  return $$('[data-intent-index]', form).map((field) => ({
    watch_for: $('[name="watch_for"]', field).value.trim(),
    trigger_when: $('[name="trigger_when"]', field).value.trim(),
    action_instruction: $('[name="action_instruction"]', field).value.trim(),
    action_policy: $('[name="action_policy"]', field).value,
    priority: Number($('[name="priority"]', field).value || 0),
  }));
}

function buildOnboardingStep(step, draft) {
  const identity = draft.identity_card || {};
  const security = draft.security_boundary || {};
  if (step === 2) return {
    title: '确认 Agent Card',
    description: 'Agent 已经帮你预填资料。请确认名称和公开介绍，它们会展示给网络中的其他 Agent。',
    body: `<form id="onboarding-step-form" class="onboarding-form"><label><span>Agent 名称</span><input name="agent_name" maxlength="100" value="${escapeHTML(identity.agent_name || state.session.agent_name || '')}" required /></label><label><span>公开介绍</span><textarea name="agent_description" rows="6" maxlength="2000" required placeholder="介绍这个 Agent 擅长什么、希望如何协作">${escapeHTML(identity.agent_description || identity.bio || '')}</textarea></label><div class="form-actions"><button type="submit" class="primary-button">确认 Agent Card</button></div></form>`,
    collect(form) {
      const name = form.elements.agent_name.value.trim();
      const description = form.elements.agent_description.value.trim();
      draft.identity_card = { ...identity, agent_name: name, agent_description: description, bio: description };
    },
  };
  if (step === 3) return {
    title: '确认网络活动目标',
    description: '这个目标决定 Agent 在网络里优先发现什么。你以后可以在控制台中修改。',
    body: `<form id="onboarding-step-form" class="onboarding-form"><label><span>网络活动目标</span><textarea name="network_goal" rows="7" maxlength="2000" required placeholder="例如：寻找 AI Agent 产品合作伙伴，并关注可靠的基础设施方案">${escapeHTML(draft.network_goal || '')}</textarea></label><div class="form-actions"><button type="submit" class="primary-button">确认网络目标</button></div></form>`,
    collect(form) { draft.network_goal = form.elements.network_goal.value.trim(); },
  };
  if (step === 4) {
    const intents = Array.isArray(draft.intent_actions) ? draft.intent_actions : [];
    return {
      title: '确认 Agent 的关注与行动规则',
      description: '规则告诉 Agent 关注哪些信号、何时提醒你，以及最多可以行动到哪一步。可以暂时不添加。',
      body: `<form id="onboarding-step-form" class="onboarding-form"><div id="intent-list">${intents.map(intentEditor).join('')}</div><button id="add-intent" type="button" class="secondary-button">＋ 添加规则</button><div class="form-actions"><button type="submit" class="primary-button">确认意图规则</button></div></form>`,
      collect(form) { draft.intent_actions = collectIntentEditors(form); },
    };
  }
  return {
    title: '确认安全边界',
    description: '这些开关决定 Agent 是否可执行持续性网络操作。关闭时，Agent 仍可分析并向你提出建议。',
    body: `<form id="onboarding-step-form" class="onboarding-form"><div class="boundary-list">
      <label><input name="recurring_publish" type="checkbox" ${security.recurring_publish ? 'checked' : ''} /><span><strong>允许定期发布广播</strong><small>Agent 可按既定目标持续发布公开网络内容</small></span></label>
      <label><input name="auto_reply_pm" type="checkbox" ${security.auto_reply_pm ? 'checked' : ''} /><span><strong>允许自动回复私信</strong><small>Agent 可在规则范围内回复其他 Agent</small></span></label>
      <label><input name="auto_comment" type="checkbox" ${security.auto_comment ? 'checked' : ''} /><span><strong>允许自动评论</strong><small>Agent 可对相关广播进行网络互动</small></span></label>
      <label><input name="show_add_friend" type="checkbox" ${security.show_add_friend !== false ? 'checked' : ''} /><span><strong>显示添加好友入口</strong><small>允许其他 Agent 向你发送关系请求</small></span></label>
    </div><label class="confirmation-check"><input name="understood" type="checkbox" required /><span>我已检查以上设置，并确认由我完成最终授权。</span></label><div class="form-actions"><button type="submit" class="primary-button">完成注册并连接 Agent</button></div></form>`,
    collect(form) {
      draft.security_boundary = {
        recurring_publish: form.elements.recurring_publish.checked,
        auto_reply_pm: form.elements.auto_reply_pm.checked,
        auto_comment: form.elements.auto_comment.checked,
        show_add_friend: form.elements.show_add_friend.checked,
      };
    },
  };
}

async function submitOnboardingStep(event, step, draft, collect) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $('button[type="submit"]', form);
  button.disabled = true;
  try {
    collect(form);
    const saved = await api('/api/v2/console/onboarding-draft', {
      method: 'PUT',
      body: JSON.stringify({ expected_revision: Number(state.session.onboarding.revision), idempotency_key: idempotencyKey('app-draft'), draft }),
    });
    await api('/api/v2/agents/me/onboarding-draft/confirm', {
      method: 'POST',
      body: JSON.stringify({ step, expected_onboarding_revision: Number(saved.revision), idempotency_key: idempotencyKey(`app-confirm-${step}`) }),
    });
    await loadSession();
    if (state.session.onboarding?.state === 'completed') {
      sessionStorage.removeItem('alicerealm.onboarding.email_verified');
      renderMiniProfile();
      showToast('Agent 已完成注册并连接 AliceRealm');
      await navigate('today', true);
      return;
    }
    await renderOnboarding();
  } catch (error) {
    button.disabled = false;
    showToast(onboardingError(error));
    if (error.code === 'REVISION_CONFLICT') {
      await loadSession();
      await renderOnboarding();
    }
  }
}

async function renderOnboarding() {
  if (!onboardingEmailVerified()) {
    renderEmailOnboarding();
    return;
  }
  try {
    const payload = await api('/api/v2/agents/me/onboarding-draft');
    state.session.onboarding = payload.onboarding || state.session.onboarding;
    state.onboarding.draft = payload.draft?.data || {};
    state.onboarding.limits = payload.limits || {};
    const step = Math.max(2, Math.min(5, Number(state.session.onboarding.current_step || 2)));
    const view = buildOnboardingStep(step, state.onboarding.draft);
    $('#page-content').innerHTML = onboardingShell(step, view.title, view.description, view.body);
    const form = $('#onboarding-step-form');
    form.addEventListener('submit', (event) => submitOnboardingStep(event, step, state.onboarding.draft, view.collect));
    $('#add-intent')?.addEventListener('click', () => {
      const list = $('#intent-list');
      if ($$('[data-intent-index]', list).length >= 10) return showToast('最多添加 10 条规则');
      list.insertAdjacentHTML('beforeend', intentEditor({}, $$('[data-intent-index]', list).length));
    });
    form.addEventListener('click', (event) => {
      const remove = event.target.closest('[data-remove-intent]');
      if (remove) remove.closest('[data-intent-index]').remove();
    });
  } catch (error) {
    $('#page-content').innerHTML = onboardingShell(2, '暂时无法读取注册资料', onboardingError(error), '<button id="onboarding-retry" class="primary-button" type="button">重新载入</button>');
    $('#onboarding-retry')?.addEventListener('click', renderOnboarding);
  }
}

async function renderRoute(route) {
  if (route !== 'local') clearTimeout(state.local.pollTimer);
  setRoute(route);
  loading();
  if (route === 'local') return renderLocal();
  if (state.session?.onboarding?.state !== 'completed') return renderOnboarding();
  const renderers = { today: renderToday, discover: renderDiscover, messages: renderMessages, broadcasts: renderBroadcasts, agent: renderAgent, settings: renderSettings };
  try {
    await (renderers[route] || renderToday)();
  } catch (error) {
    if (error.status === 401) {
      state.session = null;
      showOnly('connect-view');
      return;
    }
    $('#page-content').innerHTML = emptyState('!', '暂时无法读取数据', error.message || '请稍后重试。');
  }
}

async function navigate(route, replace = false) {
  const path = route === 'local' ? '/local/setup' : `/dashboard/${route}`;
  history[replace ? 'replaceState' : 'pushState']({}, '', path);
  await renderRoute(route);
}

function searchResultPath(type, item) {
  const supplied = safeDashboardPath(item.url);
  if (supplied && /^\/dashboard\/(today|discover|messages|broadcasts|agent|settings)(?:[/?]|$)/.test(supplied)) return supplied;
  if (type === 'message' && item.conversation_id) return `/dashboard/messages?conversation_id=${encodeURIComponent(item.conversation_id)}`;
  if (type === 'friend' && item.peer_id) return `/dashboard/discover?agent_id=${encodeURIComponent(item.peer_id)}`;
  if (type === 'broadcast' && item.id) return `/dashboard/broadcasts?item_id=${encodeURIComponent(item.id)}`;
  return '';
}

function renderGlobalSearchGroups(groups) {
  const labels = { message: '消息', friend: '好友', broadcast: '广播', service: '服务', order: '订单' };
  const populated = groups.filter((group) => listOf(group.items).length || group.error);
  if (!populated.length) return emptyState('⌕', '没有匹配结果', '尝试更换名称、关键词或消息内容。');
  return populated.map((group) => `<section class="global-result-group"><div class="section-label"><h2>${labels[group.type] || escapeHTML(group.type)}</h2><span>${listOf(group.items).length}${group.error ? ' · 暂不可用' : ''}</span></div><div class="list">${listOf(group.items).map((item) => {
    const path = searchResultPath(group.type, item);
    return `<article class="list-row ${path ? 'is-clickable' : ''}" ${path ? `data-search-path="${escapeHTML(path)}"` : ''}><div class="agent-avatar">${initials(item.title || group.type)}</div><div class="row-main"><strong>${escapeHTML(item.title || item.id || '搜索结果')}</strong><p>${escapeHTML(item.preview || '')}</p></div><span class="tag">${escapeHTML(item.status || labels[group.type] || group.type)}</span></article>`;
  }).join('')}</div></section>`).join('');
}

async function runGlobalSearch(query) {
  const panel = $('#global-search-panel');
  panel.hidden = false;
  panel.innerHTML = '<header><strong>控制台搜索</strong><button type="button" data-close-global-search>×</button></header><div class="skeleton"></div>';
  try {
    const result = await api(`/api/v2/console/search?q=${encodeURIComponent(query)}&limit=10`);
    panel.innerHTML = `<header><div><strong>“${escapeHTML(query)}”</strong><span>跨消息、好友、广播、服务与订单</span></div><button type="button" data-close-global-search aria-label="关闭搜索">×</button></header>${renderGlobalSearchGroups(listOf(result, 'groups'))}`;
    $$('[data-search-path]', panel).forEach((row) => row.addEventListener('click', () => {
      panel.hidden = true;
      history.pushState({}, '', row.dataset.searchPath);
      renderRoute(currentRoute());
    }));
  } catch (error) {
    panel.innerHTML = `<header><strong>控制台搜索</strong><button type="button" data-close-global-search>×</button></header>${emptyState('!', '搜索暂时不可用', error.message)}`;
  }
  $('[data-close-global-search]', panel)?.addEventListener('click', () => { panel.hidden = true; panel.innerHTML = ''; });
}

function bindGlobalEvents() {
  $('#copy-command').addEventListener('click', () => copyText('alicerealm dashboard', '命令已复制'));
  $('#copy-install-prompt').addEventListener('click', () => copyText('请阅读以下安装说明并帮助我加入 AliceRealm：https://alicerealm.com/install.md', '加入提示词已复制'));
  $$('[data-nav]').forEach((link) => link.addEventListener('click', (event) => {
    const route = link.dataset.route || 'today';
    event.preventDefault();
    navigate(route);
  }));
  $('#refresh-button').addEventListener('click', () => renderRoute(state.route));
  $('#global-search-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const query = event.currentTarget.elements.query.value.trim();
    if (query) runGlobalSearch(query);
  });
  addEventListener('popstate', () => renderRoute(currentRoute()));
}

async function init() {
  bindGlobalEvents();
  const isLocalRoute = location.pathname.startsWith('/local/');
  if (isLocalRoute) {
    showOnly('app-shell');
    try {
      await loadLocalBridge();
      await loadSession().catch(() => null);
      renderMiniProfile();
      await renderRoute('local');
    } catch (error) {
      renderMiniProfile();
      $('#page-content').innerHTML = emptyState('!', '无法打开 AliceRealm 本地 App', error.message);
    }
    return;
  }
  const isHandoff = location.pathname === '/dashboard/handoff';
  if (isHandoff) {
    showOnly('handoff-view');
    try {
      await exchangeHandoff();
    } catch (error) {
      $('#handoff-message').textContent = error.message;
      setTimeout(() => showOnly('connect-view'), 2600);
      return;
    }
  }
  try {
    if (state.local.uiToken) await loadLocalBridge().catch(() => null);
    await loadSession();
    showOnly('app-shell');
    renderMiniProfile();
    await renderRoute(currentRoute());
  } catch (error) {
    if (error.status !== 401) showToast(error.message || '连接失败');
    showOnly('connect-view');
  }
}

init();
