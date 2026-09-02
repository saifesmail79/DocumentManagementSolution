/**
 * The password refusals, in the language of the interface.
 *
 * The server describes each refusal twice: an English sentence (its logs, its
 * tests, its API) and a stable code with parameters. The screens used to show
 * the sentences — "Password must contain a digit." in the middle of an
 * all-Arabic form — because the sentence was all there was. The code is the
 * contract now; the sentence survives only as the fallback for a code this file
 * has never heard of, which beats showing nothing and lies less than guessing.
 */

const MESSAGES = {
  required: () => 'كلمة المرور مطلوبة.',
  too_short: ({ min }) => `يجب ألا تقل كلمة المرور عن ${min} من الحروف.`,
  too_long: ({ max }) => `يجب ألا تزيد كلمة المرور على ${max} من الحروف.`,
  predictable: () =>
    'كلمة المرور متوقعة — تجنّب تكرار الحرف الواحد والأرقام المتسلسلة والكلمات الشائعة.',
  contains_username: () => 'يجب ألا تحتوي كلمة المرور اسم المستخدم.',
  same_as_current: () => 'كلمة المرور الجديدة يجب أن تختلف عن الحالية.',
  needs_lowercase: () => 'يجب أن تحتوي حرفاً لاتينياً صغيراً (a-z).',
  needs_uppercase: () => 'يجب أن تحتوي حرفاً لاتينياً كبيراً (A-Z).',
  needs_digit: () => 'يجب أن تحتوي رقماً واحداً على الأقل — العربية (٣) واللاتينية (3) سواء.',
  needs_symbol: () => 'يجب أن تحتوي رمزاً واحداً على الأقل، مثل ! @ # %.',
};

/**
 * The refusals as the user should read them.
 *
 * Takes the whole error body so callers do not each re-implement the pairing:
 * `details` and `problems` are parallel arrays, and the sentence at an index is
 * the fallback for the code at the same index.
 *
 * @param {{details?: Array<{code: string}>, problems?: string[]}} body
 * @returns {string[]}
 */
export function passwordProblemMessages(body) {
  const details = Array.isArray(body?.details) ? body.details : [];
  const problems = Array.isArray(body?.problems) ? body.problems : [];

  const count = Math.max(details.length, problems.length);
  const messages = [];

  for (let index = 0; index < count; index += 1) {
    const detail = details[index];
    const translate = detail ? MESSAGES[detail.code] : null;
    messages.push(translate ? translate(detail) : problems[index] ?? 'كلمة المرور غير مقبولة.');
  }

  return messages;
}
