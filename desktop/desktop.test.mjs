import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PET_INTERACTIONS, PetStateMachine, parsePetEnvelope } from './ui/pet-state.js';

const config = JSON.parse(await readFile(new URL('./src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
const capability = JSON.parse(await readFile(new URL('./src-tauri/capabilities/pet.json', import.meta.url), 'utf8'));
const rust = await readFile(new URL('./src-tauri/src/lib.rs', import.meta.url), 'utf8');
const petHTML = await readFile(new URL('./ui/pet.html', import.meta.url), 'utf8');
const petJS = await readFile(new URL('./ui/pet.js', import.meta.url), 'utf8');

test('desktop has one remote Dashboard and one isolated local pet window', () => {
  const windows = Object.fromEntries(config.app.windows.map((window) => [window.label, window]));
  assert.equal(windows.main.url, 'https://app.alicerealm.com/dashboard/today');
  assert.equal(windows.pet.url, 'pet.html');
  assert.equal(windows.pet.transparent, true);
  assert.equal(windows.pet.alwaysOnTop, true);
  assert.equal(windows.pet.skipTaskbar, true);
});

test('remote Dashboard receives no native capability', () => {
  assert.deepEqual(capability.windows, ['pet']);
  assert.equal(capability.local, true);
  assert.notEqual(config.app.withGlobalTauri, true);
  assert.ok(!JSON.stringify(capability).includes('main'));
  assert.match(config.app.security.csp, /connect-src 'none'/);
});

test('tray owns dashboard, pet visibility, passthrough, and explicit quit', () => {
  for (const command of ['dashboard', 'pair_device', 'show_pet', 'hide_pet', 'pet_interactive', 'pet_passthrough', 'quit']) {
    assert.match(rust, new RegExp(`"${command}"`));
  }
  assert.match(rust, /set_ignore_cursor_events/);
  assert.match(rust, /tauri_plugin_single_instance/);
  assert.match(rust, /"main" \| "pet"/);
});

test('desktop pairing keeps the device token out of URLs and renderer events', () => {
  assert.match(rust, /keyring::Entry/);
  assert.match(rust, /PairingSecretPrefix|pairing_secret/);
  assert.match(rust, /wss:\/\/stream\.alicerealm\.com\/api\/v2\/pet\/events\/ws/);
  assert.match(rust, /window\.emit\("pet-interaction", value\)/);
  assert.doesNotMatch(rust, /emit\([^\n]*device_token/);
  assert.match(rust, /ack_pet_interaction/);
});

test('pet renderer remains a local drag surface with no remote scripts', () => {
  assert.match(petHTML, /data-tauri-drag-region/);
  assert.doesNotMatch(petHTML, /https?:\/\//);
  assert.match(petJS, /textContent/);
  assert.doesNotMatch(petJS, /innerHTML/);
});

test('pet protocol accepts only the seven server interaction types', () => {
  assert.deepEqual(Object.keys(PET_INTERACTIONS), [
    'wave',
    'high_five',
    'visit_request',
    'visit_accept',
    'visit_decline',
    'gift',
    'emote',
  ]);
  const interaction = parsePetEnvelope({
    type: 'pet.interaction',
    data: {
      interaction_id: '123',
      sender_agent_id: '45',
      receiver_agent_id: '67',
      event_type: 'wave',
      payload: { message: '<b>hello</b>' },
    },
  });
  assert.equal(interaction.eventType, 'wave');
  assert.equal(interaction.message, '<b>hello</b>');
  assert.throws(() => parsePetEnvelope({ type: 'pet.command', data: {} }), /unsupported/);
  assert.throws(() => parsePetEnvelope({
    type: 'pet.interaction',
    data: {
      interaction_id: '1',
      sender_agent_id: '2',
      receiver_agent_id: '3',
      event_type: 'run_script',
    },
  }), /unsupported/);
});

test('pet state machine queues events and suppresses replay duplicates', () => {
  const tasks = [];
  const states = [];
  const completed = [];
  const machine = new PetStateMachine((view) => states.push(view.state), {
    schedule: (task) => {
      tasks.push(task);
      return task;
    },
    cancelSchedule: () => {},
    onComplete: (interaction) => completed.push(interaction.interactionId),
  });
  machine.setConnected(true);

  const first = {
    interaction_id: '10', sender_agent_id: '2', receiver_agent_id: '3', event_type: 'wave', payload: {},
  };
  const second = {
    interaction_id: '11', sender_agent_id: '2', receiver_agent_id: '3', event_type: 'gift', payload: {},
  };
  assert.equal(machine.enqueue(first), true);
  assert.equal(machine.enqueue(first), false);
  assert.equal(machine.enqueue(second), true);
  assert.equal(states.at(-1), 'wave');

  tasks.shift()();
  assert.equal(states.at(-1), 'gift');
  assert.deepEqual(completed, ['10']);
  tasks.shift()();
  assert.equal(states.at(-1), 'idle');
  assert.deepEqual(completed, ['10', '11']);
});
