/**
 * A directory read that lost a function must not lose the models it listed.
 *
 * `get_detail_param` is asked once per `llm_utils_chat` function, and the roster
 * is the union. One of those five timing out is ordinary - each has its own 30 s
 * deadline - but the union then comes back without the models only that function
 * lists. That read used to replace the cached roster wholesale and restart the
 * ten-minute clock, so for a full TTL the gateway answered
 *
 *   404 model not in the Trae directory
 *
 * for models the machine can still call. The merge below is what keeps a degraded
 * read from reading as a deleted model.
 */
const test = require('node:test')
const assert = require('node:assert/strict')

const { mergeTraeDirectory, collectTraeSoloModels } = require('../lib/trae-upstream')

function row(id, { dev, max, out = 32000 } = {}) {
  return {
    config_name: id,
    display_config: { display_name: id, multimodal: false },
    context_window_tokens: { dev, ...max === undefined ? {} : { max } },
    model_detail_list: [{ max_tokens: out, prompt_max_tokens: dev - out }],
  }
}

/** One directory answer, collected the way `fetchModels` collects them. */
function read(...answers) {
  const byId = new Map()
  for (const [directoryFunction, rows] of answers) collectTraeSoloModels(rows, directoryFunction, byId)
  return [...byId.values()]
}

test('a model only the failed function listed stays in the roster', () => {
  const earlier = read(
    ['solo_work_remote', [row('kept-model', { dev: 200000 })]],
    ['chat_v3', [row('only-in-chat-v3', { dev: 116000 })]],
  )
  // chat_v3 timed out this time, so its answer is simply absent.
  const later = read(['solo_work_remote', [row('kept-model', { dev: 200000 })]])

  const merged = mergeTraeDirectory(earlier, later)
  assert.deepEqual(merged.map((model) => model.id).sort(), ['kept-model', 'only-in-chat-v3'],
    'the model the failed function listed is still callable')
})

test('the surviving answer does not narrow a model the failed one described wider', () => {
  // Measured shape: solo_work_remote states the default window, solo_agent_remote
  // is the answer that states the Max tier.
  const earlier = read(
    ['solo_work_remote', [row('Doubao-Seed-2.1-Pro', { dev: 256000, out: 32000 })]],
    ['solo_agent_remote', [row('Doubao-Seed-2.1-Pro', { dev: 256000, max: 1000000, out: 16000 })]],
  )
  const later = read(['solo_work_remote', [row('Doubao-Seed-2.1-Pro', { dev: 256000, out: 32000 })]])

  const [model] = mergeTraeDirectory(earlier, later)
  assert.equal(model.maxContextWindow, 1000000,
    'the Max tier stated by the missing function survives the partial read')
  assert.equal(model.contextWindow, 256000, 'and the default window is unchanged')
  assert.equal(model.maxTokens, 32000, 'the default tier keeps the budget of the function that serves it')
  assert.equal(model.variants.length, 2, 'both answers are kept, so the next complete read can still pick')
})

test('the fresher answer wins for a model both reads describe', () => {
  const earlier = read(['solo_work_remote', [row('drifting', { dev: 200000, out: 32000 })]])
  const later = read(['solo_work_remote', [row('drifting', { dev: 272000, out: 64000 })]])

  const [model] = mergeTraeDirectory(earlier, later)
  assert.equal(model.contextWindow, 272000, 'the new window is the one in force')
  assert.equal(model.maxTokens, 64000, 'and so is its budget')
  assert.equal(model.variants.length, 1, 'the same function answered twice, so there is still one variant')
})

test('a complete read is not merged: what it dropped is gone', () => {
  // The other half of the rule. A read where every function answered is the
  // directory's current word, and a model it no longer lists is one the upstream
  // stopped offering - keeping it would serve 4001s forever.
  const earlier = read(
    ['solo_work_remote', [row('withdrawn', { dev: 200000 })]],
    ['chat_v3', [row('still-there', { dev: 116000 })]],
  )
  const complete = read(['solo_work_remote', [row('still-there', { dev: 116000 })]])

  assert.deepEqual(complete.map((model) => model.id), ['still-there'],
    'a full read is taken as written - the merge is only for the partial case')
})

/**
 * A 200 that carries no list is a failed answer, not an empty one.
 *
 * The upstream sends its own error envelope with a 200 often enough. Reading that
 * as "this function lists nothing" made the whole read look complete, which then
 * replaced the roster and dropped every model only that function lists - the same
 * 404 the partial flag exists to prevent, with a different trigger.
 */
test('a directory answer with no list counts as a failed function', async () => {
  const { TraeSoloUpstreamClient } = require('../lib/trae-upstream')
  const client = new TraeSoloUpstreamClient({
    credential: async () => ({ accessToken: 'fixture', edition: 'cn', host: '' }),
    identity: async () => ({ machineId: 'm', deviceId: 'd', platform: 'win32' }),
    fetchImpl: async (url, init) => {
      const target = String(url)
      const body = JSON.parse(String(init?.body ?? '{}'))
      if (target.includes('/model')) return new Response(JSON.stringify({ data: { list: [] } }))
      if (body.function === 'chat_v3') {
        // A 200 whose body is an error envelope - no `config_info_list` at all.
        return new Response(JSON.stringify({ code: 401, message: 'not authenticated' }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ config_info_list: [row('kept', { dev: 200000 })] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    },
  })
  const answer = await client.fetchModels()
  assert.equal(answer.partial, true, 'the function that answered with an envelope is a failure, not an empty roster')
  assert.deepEqual(answer.failedFunctions, ['chat_v3'])
  assert.deepEqual(answer.models.map((model) => model.id), ['kept'], 'and the models that did arrive are still published')
})
