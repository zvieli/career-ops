import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatTelegramReviewMessage,
  computeSkillIntersection,
  deriveJobAttributes,
  deriveFitPresentation
} from '../../src/agent/infrastructure/communications/telegram-control-adapter.mjs';

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

test('UX Case 1: no absolute "full match" or "no gaps" wording without explicit proof', async () => {
  const task = baseTask('PRE_SUBMIT_REVIEW');
  const msg = await formatTelegramReviewMessage(task, {
    context: {
      fit_status: 'טובה מאוד',
      strengths: ['תפקיד בוגר תואם', 'ידע בפייתון'],
      url: 'https://job-boards.greenhouse.io/nextinsurance66/jobs/7979131003'
    }
  });

  // Must NOT contain absolute claims
  assert.doesNotMatch(msg.text, /התאמה מלאה לפרופיל/);
  assert.doesNotMatch(msg.text, /לא זוהו פערים מהותיים/);
  assert.ok(msg.text.includes('🎯 הזדמנות חדשה שנמצאה'));
  assert.ok(msg.text.includes('Next Insurance'));
  assert.ok(msg.text.includes('הערכת התאמה: טובה מאוד'));
});

test('UX Case 2: strong-fit jobs still show legitimate gaps and what to consider', async () => {
  const task = baseTask('PRE_SUBMIT_REVIEW');
  const msg = await formatTelegramReviewMessage(task, {
    context: {
      fit_status: 'טובה מאוד',
      professional_years: 0
    }
  });

  assert.ok(msg.text.includes('פערים ונקודות לבדיקה (מה לקחת בחשבון)'));
  assert.ok(msg.text.includes('0 שנות ניסיון מקצועי'));
  assert.ok(msg.text.includes('🧭 המלצה: שווה להמשיך'));
});

test('UX Case 3: candidate skill list is JD ∩ verified candidate skills (intersection)', async () => {
  const candidateSkills = ['Python', 'Docker', 'React', 'C++'];
  const jdText = 'We are looking for a Python engineer with Docker experience to build backend services.';

  const intersection = computeSkillIntersection({ candidateSkills, jdText });
  assert.deepEqual(intersection, ['Python', 'Docker']);

  const task = baseTask('PRE_SUBMIT_REVIEW');
  const msg = await formatTelegramReviewMessage(task, {
    context: {
      candidate_skills: candidateSkills,
      jd_text: jdText
    }
  });

  assert.ok(msg.text.includes('כישורים תואמים (חיתוך מאומת): Python, Docker'));
  assert.doesNotMatch(msg.text, /React|C\+\+/);
});

test('UX Case 4: unknown work model renders explicitly as unknown', async () => {
  const task = baseTask('PRE_SUBMIT_REVIEW');
  const msg = await formatTelegramReviewMessage(task, {
    context: { location: 'Kfar Saba, Israel' } // work_model omitted
  });

  assert.ok(msg.text.includes('מיקום: Kfar Saba, Israel'));
  assert.ok(msg.text.includes('מודל עבודה: לא צוין במקור'));
});

test('UX Case 5: inferred work model is explicitly labeled as inferred', async () => {
  const task = baseTask('PRE_SUBMIT_REVIEW');
  const msg = await formatTelegramReviewMessage(task, {
    context: {
      location: 'Tel Aviv',
      work_model: 'Hybrid',
      work_model_provenance: 'INFERRED'
    }
  });

  assert.ok(msg.text.includes('מודל עבודה: Hybrid (משוער)'));
});

test('UX Case 6: known direct work model is explicitly labeled as stated in source', async () => {
  const task = baseTask('PRE_SUBMIT_REVIEW');
  const msg = await formatTelegramReviewMessage(task, {
    context: {
      location: 'Tel Aviv',
      work_model: 'Hybrid',
      work_model_provenance: 'KNOWN'
    }
  });

  assert.ok(msg.text.includes('מודל עבודה: Hybrid (מופיע במודעת המקור)'));
});

test('UX Case 7: unresolved ATS requirements influence review summary', async () => {
  const task = baseTask('ATS_PREPARATION_REVIEW');
  const msg = await formatTelegramReviewMessage(task, {
    context: {
      field_count: 11,
      ready_count: 5,
      review_count: 6,
      review_fields: [
        'אישור עבודה חוקי בארה"ב (Work Authorization)',
        'צירוף גיליון ציונים (Transcript)'
      ]
    }
  });

  assert.ok(msg.text.includes('סה״כ שדות: 11'));
  assert.ok(msg.text.includes('✅ מוכנים למילוי: 5'));
  assert.ok(msg.text.includes('⚠️ דורשים החלטה שלך: 6'));
  assert.ok(msg.text.includes('אישור עבודה חוקי'));
  assert.ok(msg.text.includes('לא ניתן להסיק בבטחה — נדרשת תשובה שלך'));
});

test('UX Case 8: recommendation remains concise, reasoned, and useful', async () => {
  const task = baseTask('PRE_SUBMIT_REVIEW');
  const msgGood = await formatTelegramReviewMessage(task, { context: { fit_status: 'טובה' } });
  assert.ok(msgGood.text.includes('🧭 המלצה: שווה להמשיך'));

  const msgStretch = await formatTelegramReviewMessage(task, { context: { fit_status: 'בינונית' } });
  assert.ok(msgStretch.text.includes('🧭 המלצה: אפשר לשקול'));

  const msgLow = await formatTelegramReviewMessage(task, { context: { fit_status: 'נמוכה' } });
  assert.ok(msgLow.text.includes('🧭 המלצה: כנראה לא מתאים'));
});

test('UX Case 9: no secret fragments appear in rendered Telegram messages', async () => {
  const token = '123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ_12345678';
  const task = baseTask('PRE_SUBMIT_REVIEW');
  const msg = await formatTelegramReviewMessage(task, {
    context: { company: `SecretCorp ${token}` }
  });

  assert.doesNotMatch(msg.text, /123456789:ABCdef/);
  assert.ok(msg.text.includes('<REDACTED_BOT_TOKEN>'));
});

test('UX Case 10: work authorization & visa questions are never guessed', async () => {
  const task = baseTask('ATS_PREPARATION_REVIEW');
  const msg = await formatTelegramReviewMessage(task, {
    context: {
      review_fields: ['ויזה / אישור עבודה (Visa Sponsorship)']
    }
  });

  assert.ok(msg.text.includes('ויזה / אישור עבודה'));
  assert.ok(msg.text.includes('לא ניתן להסיק בבטחה — נדרשת תשובה שלך'));
});

test('UX Case 11: salary expectation question requires human decision', async () => {
  const task = baseTask('ATS_PREPARATION_REVIEW');
  const msg = await formatTelegramReviewMessage(task, {
    context: {
      review_fields: ['ציפיות שכר']
    }
  });

  assert.ok(msg.text.includes('ציפיות שכר'));
  assert.ok(msg.text.includes('לא ניתן להסיק בבטחה'));
});

test('UX Case 12: unsupported ATS field is counted under unsupported count', async () => {
  const task = baseTask('ATS_PREPARATION_REVIEW');
  const msg = await formatTelegramReviewMessage(task, {
    context: { unsupported_count: 2 }
  });

  assert.ok(msg.text.includes('❌ לא נתמכים: 2'));
});

test('UX Case 13: CV factuality warning is clearly displayed when present', async () => {
  const task = baseTask('PRE_SUBMIT_REVIEW');
  const msg = await formatTelegramReviewMessage(task, {
    context: { cv_warning: 'נמצאו 2 כלים ללא אימות מפורש בפרופיל' }
  });

  assert.ok(msg.text.includes('⚠️ שים לב: נמצאו 2 כלים ללא אימות מפורש בפרופיל'));
});

test('UX Case 14: long JD does not create oversized Telegram message (<= 4096 chars)', async () => {
  const task = baseTask('PRE_SUBMIT_REVIEW');
  const longText = 'A'.repeat(10000);
  const msg = await formatTelegramReviewMessage(task, {
    context: {
      strengths: [longText],
      requirements: [longText]
    }
  });

  assert.ok(msg.text.length <= 4096);
});

test('UX Case 15: no invented facts: candidate details come strictly from verified input', async () => {
  const task = baseTask('PRE_SUBMIT_REVIEW');
  const msg = await formatTelegramReviewMessage(task, {
    context: {
      professional_years: 0,
      education: 'B.Sc. in Computer Science (85)'
    }
  });

  assert.ok(msg.text.includes('שנות ניסיון מקצועי מאומתות: 0'));
  assert.ok(msg.text.includes('B.Sc. in Computer Science (85)'));
  assert.doesNotMatch(msg.text, /שכר: 50,000|5 שנות ניסיון/);
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

  assert.ok(!msg.text.startsWith('PRE_SUBMIT_REVIEW'));
  assert.ok(msg.text.includes('🎯 הזדמנות חדשה שנמצאה'));
  const buttonLabels = msg.reply_markup.inline_keyboard.flat().map(b => b.text);
  assert.ok(buttonLabels.includes('📝 הכן הגשה'));
  assert.ok(buttonLabels.includes('✋ המשך ידנית'));
  assert.ok(buttonLabels.includes('🛑 עצור'));
});

test('UX Case 18: computeSkillIntersection returns empty array when candidate skills missing or empty', () => {
  assert.deepEqual(computeSkillIntersection({ candidateSkills: [], jdText: 'Requires Python' }), []);
  assert.deepEqual(computeSkillIntersection({ candidateSkills: null, jdText: 'Requires Python' }), []);
  assert.deepEqual(computeSkillIntersection({ candidateSkills: undefined, jdText: 'Requires Python' }), []);
});

test('UX Case 19: computeSkillIntersection returns empty array when JD text missing or empty', () => {
  assert.deepEqual(computeSkillIntersection({ candidateSkills: ['Python'], jdText: '' }), []);
  assert.deepEqual(computeSkillIntersection({ candidateSkills: ['Python'], jdText: null }), []);
  assert.deepEqual(computeSkillIntersection({ candidateSkills: ['Python'], jdText: undefined }), []);
});

test('UX Case 20: providedMatched contains skill absent from candidate facts -> strictly excluded', () => {
  const candidateSkills = ['Python', 'Docker'];
  const jdText = 'We need Python, Docker, and Kubernetes experts.';
  const providedMatched = ['Python', 'Kubernetes']; // Kubernetes not in verified candidate skills!

  const res = computeSkillIntersection({ candidateSkills, jdText, providedMatched });
  assert.deepEqual(res, ['Python'], 'Kubernetes must be excluded as it is absent from verified candidate facts');
});

test('UX Case 21: providedMatched contains skill absent from JD -> strictly excluded', () => {
  const candidateSkills = ['Python', 'Docker', 'React'];
  const jdText = 'We need Python and Docker developers for backend.';
  const providedMatched = ['Python', 'React']; // React not in JD!

  const res = computeSkillIntersection({ candidateSkills, jdText, providedMatched });
  assert.deepEqual(res, ['Python'], 'React must be excluded as it is absent from JD');
});

test('UX Case 22: valid candidate ∩ JD is accurately included', () => {
  const candidateSkills = ['Python', 'TypeScript', 'Docker', 'PostgreSQL'];
  const jdText = 'Looking for Python and PostgreSQL specialists. Experience with AWS is a plus.';

  const res = computeSkillIntersection({ candidateSkills, jdText });
  assert.deepEqual(res.sort(), ['PostgreSQL', 'Python'].sort());
});

test('UX Case 23: similar substrings (Java vs JavaScript, Go vs Google) do not produce false matches', () => {
  const candidateSkills = ['Java', 'Go', 'C'];
  const jdText = 'We develop web frontends in JavaScript and use Google Cloud Platform for deployment.';

  const res = computeSkillIntersection({ candidateSkills, jdText });
  assert.deepEqual(res, [], 'Java must not match JavaScript, Go must not match Google, C must not match Cloud');
});

test('UX Case 24: supplied matched_skills cannot bypass verification', () => {
  const candidateSkills = ['Python'];
  const jdText = 'We need Python backend engineers.';
  // Attacker or unverified caller tries to inject fake claims
  const bypassed = computeSkillIntersection({
    candidateSkills,
    jdText,
    providedMatched: ['Executive Leadership', 'C++', 'System Architecture', 'Python']
  });

  assert.deepEqual(bypassed, ['Python'], 'Only verified intersection skills may survive');
});

test('UX Case 25: deriveJobAttributes reflects changes in source data and tracks provenance', () => {
  // Case A: Directly stated Hybrid in text
  const a = deriveJobAttributes({
    job: { location: 'Kfar Saba, Israel' },
    jdText: 'Location: Kfar Saba, IL (hybrid)\nRole details here...'
  });
  assert.equal(a.location.value, 'Kfar Saba, Israel');
  assert.equal(a.location.provenance, 'KNOWN');
  assert.equal(a.workModel.value, 'Hybrid');
  assert.equal(a.workModel.provenance, 'KNOWN');

  // Case B: Missing work model becomes UNKNOWN ("לא צוין במקור")
  const b = deriveJobAttributes({
    job: { location: 'Tel Aviv' },
    jdText: 'Backend role at our office.'
  });
  assert.equal(b.workModel.value, 'לא צוין במקור');
  assert.equal(b.workModel.provenance, 'UNKNOWN');
});

test('UX Case 26: deriveFitPresentation changes dynamically with fit evaluation and does not default to good', () => {
  // STRONG fit
  const fStrong = deriveFitPresentation({
    fit: { status: 'STRONG', reasons: ['Early-career role', 'Python match'] }
  });
  assert.equal(fStrong.fitStatus, 'טובה מאוד');
  assert.equal(fStrong.recommendation, 'שווה להמשיך');

  // STRETCH fit
  const fStretch = deriveFitPresentation({
    fit: { status: 'STRETCH', reasons: ['Requires 2 YOE'] }
  });
  assert.equal(fStretch.fitStatus, 'בינונית / גבולית');
  assert.equal(fStretch.recommendation, 'אפשר לשקול');

  // REJECT fit
  const fReject = deriveFitPresentation({
    fit: { status: 'REJECT', reasons: ['Hard requirement mismatch'] }
  });
  assert.equal(fReject.fitStatus, 'נמוכה');
  assert.equal(fReject.recommendation, 'כנראה לא מתאים');
});

test('UX Case 27: ATS unresolved fields appear separately from job-fit gaps', async () => {
  const task = baseTask('PRE_SUBMIT_REVIEW');
  const msg = await formatTelegramReviewMessage(task, {
    context: {
      fit_status: 'טובה',
      gaps: ['0 שנות ניסיון מקצועי מאומת'],
      ats_unresolved_questions: [
        'שאלת חסות ויזה / אישור עבודה בארה"ב',
        'העלאת גיליון ציונים אקדמי'
      ]
    }
  });

  // Verify separation
  assert.ok(msg.text.includes('⚠️ פערים ונקודות לבדיקה (מה לקחת בחשבון):'));
  assert.ok(msg.text.includes('0 שנות ניסיון מקצועי מאומת'));
  assert.ok(msg.text.includes('⚠️ דרישות בטופס שעדיין דורשות אותך (אינן פער מקצועי):'));
  assert.ok(msg.text.includes('שאלת חסות ויזה / אישור עבודה בארה"ב'));
});
