/**
 * The sentences shown when an upload fails.
 *
 * ─── Why these are worth testing ────────────────────────────────────────────
 *
 * Three separate bugs in this area were all invisible rather than wrong. The
 * server refused a duplicate correctly, with HTTP 409 and the colliding
 * document attached, and the user saw an unchanged screen — because two of the
 * three upload paths caught the error with a bare `catch {}`, and because the
 * listing refresh that followed cleared the message before React painted it.
 *
 * The refresh ordering cannot be covered here: there is no browser in this
 * suite, and adding one for a single component is not a trade worth making. The
 * message itself is a pure function of the server's answer, so that much is
 * pinned — a failure must never reduce to a bare filename or an empty string.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { ApiError } from '../client/src/api.js';
import { describeUploadFailure } from '../client/src/uploadErrors.js';

describe('upload failure messages', () => {
  test('a blocked duplicate names the document it collided with', () => {
    const error = new ApiError(409, {
      error: 'duplicate',
      duplicates: [{ documentId: '4', title: 'دليل القبول المركزي', folderName: 'Finance' }],
    });

    const message = describeUploadFailure(error, 'guide.pdf');

    assert.ok(message.includes('guide.pdf'), 'the file the user chose should be named');
    assert.ok(message.includes('دليل القبول المركزي'), 'the colliding document should be named');
    // The rule is per folder, so the folder is always the one on screen. Naming
    // it would only tell the user where they already are.
    assert.ok(!message.includes('Finance'), 'the folder is redundant under a per-folder rule');
  });

  test('a duplicate with no detail still explains itself', () => {
    const message = describeUploadFailure(new ApiError(409, { error: 'duplicate' }), 'x.pdf');

    assert.ok(message.length > 20, 'a bare code is not an explanation');
    assert.ok(message.includes('x.pdf'));
  });

  test('every mapped failure produces a sentence, not a code', () => {
    const codes = [
      'too_large',
      'required_field',
      'invalid_title',
      'empty_file',
      'no_file',
      'forbidden',
      'not_found',
      'storage_failed',
    ];

    for (const code of codes) {
      const message = describeUploadFailure(new ApiError(400, { error: code }), 'f.pdf');

      assert.ok(message.includes('f.pdf'), `${code}: the filename was dropped`);
      assert.ok(
        !message.includes(code),
        `${code}: the raw code was shown instead of an explanation`,
      );
      // Arabic, because the interface is Arabic. A message in English here is a
      // message the people using this system cannot read.
      assert.match(message, /[؀-ۿ]/, `${code}: no Arabic in the message`);
    }
  });

  test('an unmapped code still says something searchable rather than nothing', () => {
    const message = describeUploadFailure(new ApiError(400, { error: 'some_new_reason' }), 'f.pdf');

    // Deliberately shows the raw code: it is not friendly, but it gives an
    // administrator something to grep the logs for, which silence does not.
    assert.ok(message.includes('some_new_reason'));
  });

  test('a network failure is not dressed up as a server answer', () => {
    const message = describeUploadFailure(new TypeError('Failed to fetch'), 'f.pdf');

    assert.ok(message.includes('f.pdf'));
    assert.match(message, /[؀-ۿ]/);
  });

  test('a failure with no filename is still a sentence', () => {
    // The scanner panel has no filename to report — the document has not been
    // named yet.
    const message = describeUploadFailure(new ApiError(409, { error: 'duplicate' }));

    assert.ok(message.length > 10);
    assert.ok(!message.startsWith(':'), 'an absent filename left a dangling separator');
  });
});
