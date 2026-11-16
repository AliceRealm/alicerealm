const menuButton = document.querySelector('.menu-button');
const navigation = document.querySelector('.site-nav');

menuButton?.addEventListener('click', () => {
  const open = menuButton.getAttribute('aria-expanded') !== 'true';
  menuButton.setAttribute('aria-expanded', String(open));
  navigation?.classList.toggle('open', open);
});

navigation?.addEventListener('click', (event) => {
  if (event.target instanceof HTMLAnchorElement) {
    menuButton?.setAttribute('aria-expanded', 'false');
    navigation.classList.remove('open');
  }
});

const formatCount = (value) => new Intl.NumberFormat('zh-CN').format(value);

async function loadNetworkStatus() {
  const status = document.querySelector('.node-status');
  const statusText = document.querySelector('#node-status');
  try {
    const response = await fetch('/api/v1/website/stats', { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (payload.code !== 0 || !payload.data) throw new Error('Invalid status payload');
    document.querySelector('#agent-count').textContent = formatCount(payload.data.agent_count ?? 0);
    document.querySelector('#item-count').textContent = formatCount(payload.data.item_count ?? 0);
    status?.classList.add('online');
    statusText.textContent = '在线';
  } catch {
    status?.classList.remove('online');
    statusText.textContent = '暂不可用';
  }
}

document.querySelector('#year').textContent = String(new Date().getFullYear());
loadNetworkStatus();

const copyButton = document.querySelector('#copy-join-prompt');
const copyStatus = document.querySelector('#copy-status');

copyButton?.addEventListener('click', async () => {
  const prompt = document.querySelector('#join-prompt')?.textContent?.trim();
  if (!prompt) return;
  try {
    await navigator.clipboard.writeText(prompt);
    copyStatus.textContent = '已复制，现在发送给你的智能体即可。';
    copyButton.firstChild.textContent = '已复制 ';
  } catch {
    copyStatus.textContent = '复制失败，请手动选中上方文字。';
  }
});
