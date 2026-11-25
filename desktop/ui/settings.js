import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

const badge = document.querySelector('#version-badge');
const state = document.querySelector('#update-state');
const notes = document.querySelector('#release-notes');
const checkButton = document.querySelector('#check-update');
const installButton = document.querySelector('#install-update');
const progressWrap = document.querySelector('#progress-wrap');
const progressBar = document.querySelector('#progress-bar');
const progressCopy = document.querySelector('#progress-copy');

let latestStatus = null;

function renderStatus(status) {
  latestStatus = status;
  badge.textContent = `当前版本 ${status.current_version}`;
  state.className = 'update-state';
  notes.hidden = true;
  installButton.hidden = true;
  if (status.available) {
    state.textContent = `发现新版本 ${status.latest_version}`;
    state.classList.add('available');
    notes.textContent = status.notes || '此版本包含 AliceRealm 桌面端改进。';
    notes.hidden = false;
    installButton.hidden = false;
  } else {
    state.textContent = '你正在使用最新版本。';
  }
}

async function checkForUpdate() {
  checkButton.disabled = true;
  installButton.disabled = true;
  state.className = 'update-state';
  state.textContent = '正在检查官方更新…';
  try {
    renderStatus(await invoke('desktop_update_status'));
  } catch (error) {
    state.textContent = `暂时无法检查更新：${String(error)}`;
    state.classList.add('error');
  } finally {
    checkButton.disabled = false;
    installButton.disabled = false;
  }
}

checkButton.addEventListener('click', checkForUpdate);
installButton.addEventListener('click', async () => {
  if (!latestStatus?.available) return;
  checkButton.disabled = true;
  installButton.disabled = true;
  progressWrap.hidden = false;
  state.className = 'update-state available';
  state.textContent = `正在安装 ${latestStatus.latest_version}，请不要关闭 AliceRealm。`;
  try {
    await invoke('install_desktop_update');
  } catch (error) {
    state.textContent = `更新失败：${String(error)}`;
    state.className = 'update-state error';
    checkButton.disabled = false;
    installButton.disabled = false;
  }
});

const stopProgress = await listen('desktop-update-progress', (event) => {
  const downloaded = Number(event.payload?.downloaded || 0);
  const total = Number(event.payload?.total || 0);
  if (total > 0) {
    const percent = Math.min(100, Math.round(downloaded * 100 / total));
    progressBar.style.width = `${percent}%`;
    progressCopy.textContent = `已下载 ${percent}%`;
  } else if (event.payload?.state === 'downloaded') {
    progressBar.style.width = '100%';
    progressCopy.textContent = '下载完成，正在验证签名并启动安装程序…';
  } else {
    progressCopy.textContent = '正在下载更新…';
  }
});

const stopAvailable = await listen('desktop-update-available', (event) => renderStatus(event.payload));
window.addEventListener('beforeunload', () => { stopProgress(); stopAvailable(); }, { once: true });

await checkForUpdate();
