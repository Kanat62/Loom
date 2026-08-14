// tests/gateway.test.js - шлюз моделей через подставной claude (§13 гайда).
// Покрывает: конверт, usage, кэш, фолбэк-цепочка, два круга, кривой JSON, таймаут.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupTestEnv } from './harness/env.js';

// gateway.js читает ROLES/таймауты из config.js один раз при импорте, но config
// не кэширует env - импортируем после установки env переменных для чистоты пути,
// хотя ни одна константа здесь от LOOM_HOME не зависит.
const { chat, GatewayError } = await import('../core/gateway.js');

test('gateway: успешный вызов возвращает текст и пишет usage-событие', async () => {
  const env = setupTestEnv({ fakeClaudeMode: 'ok', fakeClaudeResult: 'OK' });
  try {
    const events = [];
    const res = await chat(
      'engineer',
      [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'ping' },
      ],
      { json: false, logEvent: (e) => events.push(e) }
    );
    assert.equal(res.text, 'OK');
    assert.equal(env.callCount(), 1);
    const usageEvents = events.filter((e) => e.type === 'usage');
    assert.equal(usageEvents.length, 1);
    assert.equal(usageEvents[0].tokens_in, 10);
    assert.equal(usageEvents[0].cost_usd, 0.001);
  } finally {
    env.cleanup();
  }
});

test('gateway: json:true парсит результат в объект', async () => {
  const env = setupTestEnv({ fakeClaudeMode: 'ok', fakeClaudeResult: '{"sum":5}' });
  try {
    const res = await chat(
      'coder',
      [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'compute' },
      ],
      { json: true }
    );
    assert.deepEqual(res.data, { sum: 5 });
  } finally {
    env.cleanup();
  }
});

test('gateway: system-промпт передаётся файлом, побайтовая идентичность имени по sha256', async () => {
  const env = setupTestEnv({ fakeClaudeMode: 'ok', fakeClaudeResult: 'OK' });
  try {
    const systemText = 'stable system prompt content';
    await chat('coder', [
      { role: 'system', content: systemText },
      { role: 'user', content: 'first' },
    ]);
    await chat('coder', [
      { role: 'system', content: systemText },
      { role: 'user', content: 'second' },
    ]);
    const log = env.readLog();
    assert.equal(log.length, 2);
    assert.equal(log[0].systemFile, log[1].systemFile, 'тот же контент -> тот же файл (sha256 имя)');
    assert.match(log[0].systemFile, /sys-[0-9a-f]{64}\.txt$/);
    assert.equal(log[0].stdin, 'first');
    assert.equal(log[1].stdin, 'second');
    assert.equal(log[0].tools, '', '--tools "" отключает инструменты');
    assert.equal(log[0].strictMcp, true);
  } finally {
    env.cleanup();
  }
});

test('gateway: техническая ошибка (exit1) на первом тире -> фолбэк на следующую модель в цепочке', async () => {
  const env = setupTestEnv({ fakeClaudeMode: 'sequence' });
  process.env.FAKE_CLAUDE_SEQUENCE = 'exit1,ok';
  process.env.FAKE_CLAUDE_SEQUENCE_RESULTS = '|recovered';
  try {
    const res = await chat('coder', [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'u' },
    ]);
    assert.equal(res.text, 'recovered');
    assert.equal(env.callCount(), 2, 'должно быть ровно 2 попытки - провал + следующая модель');
  } finally {
    env.cleanup();
  }
});

test('gateway: is_error в конверте (сбой по существу) -> следующая модель в цепочке', async () => {
  const env = setupTestEnv({ fakeClaudeMode: 'sequence' });
  process.env.FAKE_CLAUDE_SEQUENCE = 'is_error,ok';
  process.env.FAKE_CLAUDE_SEQUENCE_RESULTS = 'boom|recovered';
  try {
    const res = await chat('coder', [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'u' },
    ]);
    assert.equal(res.text, 'recovered');
    assert.equal(env.callCount(), 2);
  } finally {
    env.cleanup();
  }
});

test('gateway: кривой JSON -> ретрай той же модели с напоминанием, затем успех', async () => {
  const env = setupTestEnv({ fakeClaudeMode: 'sequence' });
  process.env.FAKE_CLAUDE_SEQUENCE = 'ok,ok';
  process.env.FAKE_CLAUDE_SEQUENCE_RESULTS = 'not valid json at all|{"ok":true}';
  try {
    const res = await chat(
      'coder',
      [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'u' },
      ],
      { json: true }
    );
    assert.deepEqual(res.data, { ok: true });
    const log = env.readLog();
    assert.equal(log.length, 2);
    assert.match(log[1].stdin, /\[ПОВТОР\]/, 'второй запрос должен содержать напоминание про валидный JSON');
  } finally {
    env.cleanup();
  }
});

test('gateway: все модели недоступны -> два круга, затем понятная ошибка', async () => {
  const env = setupTestEnv({ fakeClaudeMode: 'exit1' });
  try {
    await assert.rejects(
      () =>
        chat(
          'diagnostician', // цепочка длины 1 -> 2 круга = 2 попытки
          [
            { role: 'system', content: 'sys' },
            { role: 'user', content: 'u' },
          ],
          { roundPauseMs: 10 }
        ),
      (err) => {
        assert.ok(err instanceof GatewayError);
        return true;
      }
    );
    assert.equal(env.callCount(), 2, 'chain длины 1 x 2 круга = 2 вызова');
  } finally {
    env.cleanup();
  }
});

test('gateway: таймаут убивает зависший процесс и считается технической ошибкой', async () => {
  const env = setupTestEnv({ fakeClaudeMode: 'sequence' });
  process.env.FAKE_CLAUDE_SEQUENCE = 'hang,ok';
  process.env.FAKE_CLAUDE_SEQUENCE_RESULTS = '|recovered';
  try {
    const res = await chat(
      'coder',
      [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'u' },
      ],
      { timeoutMs: 500 }
    );
    assert.equal(res.text, 'recovered');
    assert.equal(env.callCount(), 2);
  } finally {
    env.cleanup();
  }
});

test('gateway: bad_envelope (не-JSON конверт целиком) -> фолбэк на следующую модель', async () => {
  const env = setupTestEnv({ fakeClaudeMode: 'sequence' });
  process.env.FAKE_CLAUDE_SEQUENCE = 'bad_envelope,ok';
  process.env.FAKE_CLAUDE_SEQUENCE_RESULTS = '|recovered';
  try {
    const res = await chat('coder', [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'u' },
    ]);
    assert.equal(res.text, 'recovered');
  } finally {
    env.cleanup();
  }
});
