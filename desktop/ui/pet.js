import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { PetStateMachine, parsePetEnvelope } from './pet-state.js';

const pet = document.querySelector('#pet');
const status = document.querySelector('#pet-status');
const symbol = document.querySelector('#pet-symbol');
const confirmation = document.querySelector('#pet-action-confirmation');
const actionCopy = document.querySelector('#pet-action-copy');
const confirmAction = document.querySelector('#pet-action-confirm');
const cancelAction = document.querySelector('#pet-action-cancel');

const machine = new PetStateMachine((view) => {
  pet.dataset.state = view.state;
  status.textContent = view.status;
  symbol.textContent = view.symbol;
  status.classList.toggle('visible', view.state !== 'idle' && view.state !== 'offline');
}, {
  onComplete: async (interaction) => {
    if (!/^\d+$/.test(interaction.interactionId)) return;
    try {
      await invoke('ack_pet_interaction', { interactionId: interaction.interactionId });
    } catch (_) {
      status.textContent = '互动确认失败，连接恢复后将重新接收';
      status.classList.add('visible');
    }
  },
});

const unlisten = await Promise.all([
  listen('pet-interaction', (event) => {
    try {
      machine.enqueue(parsePetEnvelope(event.payload));
    } catch (_) {
      status.textContent = '收到无法识别的桌宠事件';
      status.classList.add('visible');
    }
  }),
  listen('pet-connection', (event) => {
    const connected = event.payload?.state === 'connected';
    machine.setConnected(connected);
    if (event.payload?.message) {
      status.textContent = event.payload.message;
      status.classList.toggle('visible', !connected);
    }
  }),
  listen('pet-action-request', (event) => {
    const labels = { wave: '挥手', high_five: '击掌', visit_request: '邀请串门', visit_accept: '接受串门', visit_decline: '拒绝串门', gift: '送礼物', emote: '发送心情' };
    const action = labels[event.payload?.event_type] || '互动';
    actionCopy.textContent = `向 Agent ${event.payload?.receiver_agent_id || '未知'} ${action}？`;
    confirmation.hidden = false;
  }),
  listen('pet-action-resolved', () => { confirmation.hidden = true; }),
]);

confirmAction.addEventListener('click', async () => {
  confirmAction.disabled = true;
  try {
    await invoke('confirm_pet_action');
    confirmation.hidden = true;
  } catch (error) {
    status.textContent = String(error || '桌宠互动发送失败');
    status.classList.add('visible');
  } finally { confirmAction.disabled = false; }
});

cancelAction.addEventListener('click', async () => {
  cancelAction.disabled = true;
  try { await invoke('cancel_pet_action'); } finally {
    confirmation.hidden = true;
    cancelAction.disabled = false;
  }
});

pet.addEventListener('click', () => {
  machine.react('wave', '你好，我是 AliceRealm 桌宠');
});

window.addEventListener('beforeunload', () => {
  machine.dispose();
  for (const stop of unlisten) stop();
}, { once: true });
