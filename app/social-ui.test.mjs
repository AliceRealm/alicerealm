import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('./app.js', import.meta.url), 'utf8');

test('App supports interactive private conversations and friend requests', () => {
  assert.match(source, /console\/pm\/conversations\/\$\{encodeURIComponent\(conversationID\)\}\/messages/);
  assert.match(source, /console\/bff\/pm\/send/);
  assert.match(source, /console\/bff\/relations\/handle/);
  assert.match(source, /data-request-action="1"/);
  assert.match(source, /data-request-action="2"/);
  assert.match(source, /console\/bff\/pm\/read/);
  assert.match(source, /console\/pm\/search/);
  assert.match(source, /anchor_message_id/);
  assert.match(source, /data-older-messages/);
});

test('App exposes owner-safe relationship management and full Agent Cards', () => {
  assert.match(source, /console\/bff\/agents\/\$\{encodeURIComponent\(agentID\)\}\/card/);
  assert.match(source, /console\/bff\/relations\/\$\{action\}/);
  for (const action of ['remark', 'unfriend', 'block', 'unblock']) {
    assert.match(source, new RegExp(`['"]${action}['"]`));
  }
  assert.match(source, /data-block-agent/);
  assert.match(source, /data-unblock-agent/);
});

test('App opens Attention and broadcast details with owner actions', () => {
  assert.match(source, /console\/attention-items\/\$\{encodeURIComponent\(attentionID\)\}\/respond/);
  assert.match(source, /console\/attention-items\/\$\{encodeURIComponent\(attentionID\)\}\/dismiss/);
  assert.match(source, /console\/bff\/items\/\$\{encodeURIComponent\(itemID\)\}/);
  assert.match(source, /console\/bff\/agents\/items\/\$\{encodeURIComponent\(itemID\)\}/);
  assert.match(source, /renderSourceSummary\(source\)/);
  assert.doesNotMatch(source, /JSON\.stringify\(source\.detail/);
  assert.match(source, /last_item_id=\$\{encodeURIComponent\(button\.dataset\.moreBroadcasts\)\}/);
  assert.match(source, /data-more-broadcasts/);
  assert.match(source, /broadcastTotals/);
});

test('App lets the owner edit the Agent Card and inspect activity', () => {
  assert.match(source, /console\/bff\/agents\/me\/card\/page/);
  assert.match(source, /console\/bff\/agents\/me\/profile\/fields/);
  assert.match(source, /expected_version/);
  assert.match(source, /console\/bff\/console\/activity-log/);
  assert.match(source, /console\/bff\/console\/activity-calendar/);
  assert.match(source, /offering: profileSingleValue/);
  assert.match(source, /working_languages: profileListValues\(form\.working_languages\.value, 10, 32\)/);
});

test('App provides a unified Console search surface', () => {
  assert.match(source, /console\/search\?q=\$\{encodeURIComponent\(query\)\}/);
  assert.match(source, /renderGlobalSearchGroups/);
  assert.match(source, /data-search-path/);
  assert.match(source, /type === 'message'/);
  assert.match(source, /type === 'friend'/);
  assert.match(source, /type === 'broadcast'/);
});

test('App edits the active control context using revision-safe writes', () => {
  assert.match(source, /agents\/me\/control-context/);
  assert.match(source, /agents\/me\/network-goal/);
  assert.match(source, /agents\/me\/intent-actions/);
  assert.match(source, /agents\/me\/security-boundary/);
  assert.match(source, /expected_context_revision/);
  assert.match(source, /idempotency_key/);
});
