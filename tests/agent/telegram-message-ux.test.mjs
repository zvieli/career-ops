import test from 'node:test';
import assert from 'node:assert/strict';
import { formatTelegramReviewMessage } from '../../src/agent/infrastructure/communications/telegram-control-adapter.mjs';

function baseTask(review_type = 'PRE_SUBMIT_REVIEW') {
  return {
    review_task_id: 'rev-test-12345',
    application_id: 'app-f13376e586e76445236d9029',
    company: 'Next Insurance',
    role: 'Graduate Backend Software Engineer- UpNEXT Program',
    review_type,
    expected_state: 'CV_VALIDATED',
    evidence_hash: 'a'.repeat(64),
    allowed_decisions: ['PREPARE_APPLICATION', 'CONTINUE_MANUALLY', 'STOP']
  };
}

test('UX Case 1: strong-fit junior role renders Hebrew briefing with strengths', async () => {
  const task = baseTask('PRE_SUBMIT_REVIEW');
  const msg = await formatTelegramReviewMessage(task, {
    context: {
      fit_status: 'טובה מאוד',
      fit_reasons: ['התפקיד מיועד ל-Graduate / Junior', 'דרישת שפות תואמת לפרופיל'],
      url: 'https://job-boards.greenhouse.io/nextinsurance66/jobs/7979131003'
    }
  });

  assert.ok(msg.text.includes('🎯 הזדמנות חדשה שנמצאה'));
  assert.ok(msg.text.includes('Next Insurance'));
  assert.ok(msg.text.includes('התאמה: טובה מאוד'));
  assert.ok(msg.text.includes('התפקיד מיועד ל-Graduate / Junior'));
  assert.ok(msg.reply_markup.inline_keyboard[0][0].url === 'https://job-boards.greenhouse.io/nextinsurance66/jobs/7979131003');
  assert.ok(msg.reply_markup.inline_keyboard[1].some(b => b.text.includes('הכן הגשה')));
});

test('UX Case 2: stretch 1-3 YOE role highlights experience gap honestly', async () => {
  const task = baseTask('PRE_SUBMIT_REVIEW');
  const msg = await formatTelegramReviewMessage(task, {
    context: {
      fit_status: 'גבולית (Stretch)',
      gaps: ['מבקשים 1–2 שנות ניסיון; לך יש 0 שנות ניסיון מקצועי מאומת'],
      professional_years: 0
    }
  });

  assert.ok(msg.text.includes('פערים / נקודות לבדיקה'));
  assert.ok(msg.text.includes('0 שנות ניסיון מקצועי'));
});

test('UX Case 3: unknown location/work model displays explicit unknown (not guessed)', async () => {
  const task = baseTask('PRE_SUBMIT_REVIEW');
  const msg = await formatTelegramReviewMessage(task, {
    context: { location: 'לא צוין במקור' }
  });

  assert.ok(msg.text.includes('מיקום: לא צוין במקור'));
  assert.doesNotMatch(msg.text, /remote|hybrid|on-site/i);
});

test('UX Case 4: missing required candidate fact is flagged as requiring human review', async () => {
  const task = baseTask('ATS_PREPARATION_REVIEW');
  task.allowed_decisions = ['FILL_APPLICATION', 'CONTINUE_MANUALLY', 'STOP'];
  const msg = await formatTelegramReviewMessage(task, {
    context: {
      review_fields: ['העלאת גיליון ציונים (Transcript)']
    }
  });

  assert.ok(msg.text.includes('דורש ממך תשובה'));
  assert.ok(msg.text.includes('לא ניתן להסיק בבטחה — נדרשת תשובה שלך'));
});

test('UX Case 5: work authorization question is never guessed', async () => {
  const task = baseTask('ATS_PREPARATION_REVIEW');
  const msg = await formatTelegramReviewMessage(task, {
    context: {
      review_fields: ['אישור עבודה חוקי (Work Authorization)']
    }
  });

  assert.ok(msg.text.includes('אישור עבודה חוקי'));
  assert.ok(msg.text.includes('לא ניתן להסיק בבטחה — נדרשת תשובה שלך'));
});

test('UX Case 6: salary expectation question requires human decision', async () => {
  const task = baseTask('ATS_PREPARATION_REVIEW');
  const msg = await formatTelegramReviewMessage(task, {
    context: {
      review_fields: ['ציפיות שכר (Desired Salary)']
    }
  });

  assert.ok(msg.text.includes('ציפיות שכר'));
  assert.ok(msg.text.includes('לא ניתן להסיק בבטחה'));
});

test('UX Case 7: custom question is explicitly listed under questions needing review', async () => {
  const task = baseTask('ATS_PREPARATION_REVIEW');
  const msg = await formatTelegramReviewMessage(task, {
    context: {
      review_fields: ['איך שמעת עלינו? (How did you hear about us)']
    }
  });

  assert.ok(msg.text.includes('איך שמעת עלינו'));
});

test('UX Case 8: unsupported ATS field is counted under unsupported count', async () => {
  const task = baseTask('ATS_PREPARATION_REVIEW');
  const msg = await formatTelegramReviewMessage(task, {
    context: {
      unsupported_count: 2
    }
  });

  assert.ok(msg.text.includes('❌ לא נתמכים: 2'));
});

test('UX Case 9: CV factuality warning is clearly displayed when present', async () => {
  const task = baseTask('PRE_SUBMIT_REVIEW');
  const msg = await formatTelegramReviewMessage(task, {
    context: {
      cv_warning: 'נמצאו 2 כלים ללא אימות מפורש בפרופיל'
    }
  });

  assert.ok(msg.text.includes('⚠️ שים לב: נמצאו 2 כלים ללא אימות מפורש בפרופיל'));
});

test('UX Case 10: zero unresolved fields shows clear readiness', async () => {
  const task = baseTask('ATS_PREPARATION_REVIEW');
  const msg = await formatTelegramReviewMessage(task, {
    context: {
      field_count: 5,
      ready_count: 5,
      review_count: 0,
      review_fields: []
    }
  });

  assert.ok(msg.text.includes('✅ מוכנים למילוי: 5'));
  assert.ok(msg.text.includes('⚠️ דורשים החלטה שלך: 0'));
});

test('UX Case 11: mixed ready and review fields are partitioned cleanly', async () => {
  const task = baseTask('ATS_PREPARATION_REVIEW');
  const msg = await formatTelegramReviewMessage(task, {
    context: {
      field_count: 10,
      ready_count: 7,
      review_count: 3,
      review_fields: ['הצהרה משפטית', 'אישור ויזה', 'ציון סופי']
    }
  });

  assert.ok(msg.text.includes('✅ מוכנים למילוי: 7'));
  assert.ok(msg.text.includes('⚠️ דורשים החלטה שלך: 3'));
  assert.ok(msg.text.includes('שדות שמולאו/מופו בבטחה:'));
});

test('UX Case 12: long JD does not create oversized Telegram message', async () => {
  const task = baseTask('PRE_SUBMIT_REVIEW');
  const longText = 'A'.repeat(10000);
  const msg = await formatTelegramReviewMessage(task, {
    context: {
      fit_reasons: [longText],
      requirements: [longText]
    }
  });

  assert.ok(msg.text.length <= 4096, `Length must be <= 4096, got ${msg.text.length}`);
});

test('UX Case 13: Telegram message remains strictly within platform 4096 character limit', async () => {
  for (const type of ['PRE_SUBMIT_REVIEW', 'ATS_PREPARATION_REVIEW', 'FINAL_HUMAN_REVIEW']) {
    const task = baseTask(type);
    const msg = await formatTelegramReviewMessage(task, {
      context: {
        company: 'X'.repeat(500),
        role: 'Y'.repeat(500),
        review_fields: Array(50).fill('Field question '.repeat(10))
      }
    });
    assert.ok(msg.text.length <= 4096, `Length for ${type} must be <= 4096, got ${msg.text.length}`);
  }
});

test('UX Case 14: no raw secrets or tokens appear in rendered Telegram messages', async () => {
  const token = '123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ_12345678';
  const task = baseTask('PRE_SUBMIT_REVIEW');
  const msg = await formatTelegramReviewMessage(task, {
    context: {
      company: `SecretCorp ${token}`
    }
  });

  assert.doesNotMatch(msg.text, /123456789:ABCdef/);
});

test('UX Case 15: no invented facts: only provided candidate and job fields are rendered', async () => {
  const task = baseTask('PRE_SUBMIT_REVIEW');
  const msg = await formatTelegramReviewMessage(task, {
    context: {
      professional_years: 0,
      education: 'B.Sc. in Computer Science (85)'
    }
  });

  assert.ok(msg.text.includes('שנות ניסיון מקצועי מאומתות: 0'));
  assert.ok(msg.text.includes('B.Sc. in Computer Science (85)'));
  assert.doesNotMatch(msg.text, /שכר: 40,000|5 שנות ניסיון/);
});

test('UX Case 16: links correctly point to the same application/job posting URL', async () => {
  const task = baseTask('PRE_SUBMIT_REVIEW');
  const url = 'https://job-boards.greenhouse.io/nextinsurance66/jobs/7979131003';
  const msg = await formatTelegramReviewMessage(task, {
    context: { url }
  });

  const urlButton = msg.reply_markup.inline_keyboard[0][0];
  assert.equal(urlButton.url, url);
  assert.equal(urlButton.text, '🔎 פתח משרה');
});

test('UX Case 17: internal enum values are not used as primary human-facing text', async () => {
  const task = baseTask('PRE_SUBMIT_REVIEW');
  const msg = await formatTelegramReviewMessage(task);

  // Check main headers do not expose raw enums
  assert.ok(!msg.text.startsWith('PRE_SUBMIT_REVIEW'));
  assert.ok(msg.text.includes('🎯 הזדמנות חדשה שנמצאה'));
  // Button labels are in Hebrew
  const buttonLabels = msg.reply_markup.inline_keyboard.flat().map(b => b.text);
  assert.ok(buttonLabels.includes('📝 הכן הגשה'));
  assert.ok(buttonLabels.includes('✋ המשך ידנית'));
  assert.ok(buttonLabels.includes('🛑 עצור'));
});
