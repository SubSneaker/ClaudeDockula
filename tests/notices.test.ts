import { expect, test } from 'claude-code/testing'

import { NOTICE_TTL_MS, dismissNotice, expireNotices, noticeRows, pushNotice, toggleNotice } from '../hooks/dock/notices'

test('notices: newest first, errors stay, the rest expire, a repeat or a newer one on the topic replaces', () => {
  const failed = pushNotice([], { tone: 'error', title: "Couldn't move ABC-101 → IN REVIEW", detail: 'atlassian: denied\nAllow it in /permissions', at: 0 })
  const both = pushNotice(failed, { tone: 'success', title: 'Types passed in 9s', topic: 'check-types', at: 1000 })

  expect(both.map(notice => notice.title)).toEqual(['Types passed in 9s', "Couldn't move ABC-101 → IN REVIEW"])
  expect(both[1]?.expiresAt).toBe(undefined)
  expect(both[0]?.expiresAt).toBe(1000 + NOTICE_TTL_MS)
  expect(expireNotices(both, 1000 + NOTICE_TTL_MS).map(notice => notice.tone)).toEqual(['error'])
  expect(expireNotices(both, 5000)).toBe(both)

  const rerun = pushNotice(both, { tone: 'error', title: 'Types failed: 3 errors', topic: 'check-types', at: 2000 })
  expect(rerun.map(notice => notice.title)).toEqual(['Types failed: 3 errors', "Couldn't move ABC-101 → IN REVIEW"])
  expect(pushNotice(rerun, { tone: 'error', title: "Couldn't move ABC-101 → IN REVIEW", detail: 'atlassian: denied\nAllow it in /permissions', at: 3000 })).toHaveLength(2)
  expect(dismissNotice(rerun, rerun[0]?.id ?? -1)).toHaveLength(1)

  // A notice posted after the newest was dismissed takes a new id, so a late ✕ on the old row misses it.
  const newestId = rerun[0]?.id ?? -1
  const after = pushNotice(dismissNotice(rerun, newestId), { tone: 'info', title: 'Reading ABC-1…', at: 2400 })
  expect(after[0]?.id).not.toBe(newestId)
  expect(dismissNotice(after, newestId)).toEqual(after)
})

test('a notice row: cut to the band, ▸ when it has more, opened it shows every line and stops expiring', () => {
  const list = pushNotice([], { tone: 'info', title: 'Reading ABC-101…', detail: 'atlassian: slow', at: 0 })
  const [row] = noticeRows(list, 30).rows

  expect(row?.label).toBe('ℹ Reading ABC-101…        ▸')
  expect(row?.lines).toEqual([])
  expect(row?.hasMore).toBe(true)
  expect(noticeRows(pushNotice([], { tone: 'info', title: 'Done', at: 0 }), 30).rows[0]?.hasMore).toBe(false)
  const opened = toggleNotice(list, list[0]?.id ?? -1)
  expect(opened[0]?.expiresAt).toBe(undefined)
  expect(noticeRows(opened, 30).rows[0]?.lines).toEqual(['atlassian: slow'])
  const many = [1, 2, 3, 4, 5].reduce((all, at) => pushNotice(all, { tone: 'error', title: `E${at}`, at }), list)
  expect(noticeRows(many, 30)).toMatchObject({ hidden: 3 })
})
