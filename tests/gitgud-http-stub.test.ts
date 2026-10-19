import { expect, test } from 'claude-code/testing'

import type { Op, Outcome, Req } from '../hooks/panels/gitgud/providers/types'

// The wiring files drive an `Op` with a local runner. The test's `$` has no `http` noun (it can only call
// events, not effects), so `on('http.fetch')` is typed here and intercepts once a hook calls `$.http.fetch`.

function* userOp(): Op<string> {
  const outcome = yield { kind: 'http', method: 'GET', url: 'https://api.bitbucket.org/2.0/user', needsToken: false }
  const [first] = [outcome].flat()

  return first?.status === 200 ? { isOk: true, value: first.stdout } : { isOk: false, error: `status ${first?.status}` }
}

async function drive<T>(op: Op<T>, runReq: (req: Req) => Promise<Outcome>) {
  let step = op.next()
  while (!step.done) {
    const reqs = [step.value].flat()
    const outcomes = await Promise.all(reqs.map(runReq))
    step = op.next(Array.isArray(step.value) ? outcomes : (outcomes[0] as Outcome))
  }

  return step.value
}

test('an Op generator is driven by a runner that sends http as a stub would answer it', async ($, on) => {
  on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: 'ok' } }))
  const urls: string[] = []
  const fetch = async (req: Req): Promise<Outcome> => {
    if (req.kind === 'http') urls.push(req.url)

    return { exitCode: 0, stdout: '{"display_name":"Ada"}', stderr: '', status: 200 }
  }

  expect(await drive(userOp(), fetch)).toEqual({ isOk: true, value: '{"display_name":"Ada"}' })
  expect(urls).toEqual(['https://api.bitbucket.org/2.0/user'])
})
