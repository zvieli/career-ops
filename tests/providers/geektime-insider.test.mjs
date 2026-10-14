// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import geektimeProvider, {
  normalizeHebrewLocation,
  classifyApplicationDestination,
  parseGeektimeJob
} from '../../providers/geektime-insider.mjs';

test('normalizeHebrewLocation maps common Israeli localities correctly', () => {
  assert.equal(normalizeHebrewLocation('תל אביב').normalized_location, 'Tel Aviv');
  assert.equal(normalizeHebrewLocation('רמת גן').normalized_location, 'Ramat Gan');
  assert.equal(normalizeHebrewLocation('כפר סבא').normalized_location, 'Kfar Saba');
  assert.equal(normalizeHebrewLocation('רעננה').normalized_location, 'Ra\'anana');
  assert.equal(normalizeHebrewLocation('רחובות').normalized_location, 'Rehovot');
  assert.equal(normalizeHebrewLocation('פתח תקוה').normalized_location, 'Petah Tikva');
  assert.equal(normalizeHebrewLocation('הרצליה').normalized_location, 'Herzliya');
  assert.equal(normalizeHebrewLocation('חיפה').normalized_location, 'Haifa');
  assert.equal(normalizeHebrewLocation('Unknown City').normalized_location, 'Unknown City');
});

test('classifyApplicationDestination correctly identifies link types', () => {
  assert.equal(
    classifyApplicationDestination('https://amat.wd1.myworkdayjobs.com/External/job/RehovotISR/123'),
    'ats'
  );
  assert.equal(
    classifyApplicationDestination('https://job-boards.greenhouse.io/wizinc/jobs/456'),
    'ats'
  );
  assert.equal(
    classifyApplicationDestination('arpeely.55.964@applynow.io'),
    'email'
  );
  assert.equal(
    classifyApplicationDestination('https://surecomp.com/careers/co/kfar-saba-israel/123'),
    'employer_careers'
  );
  assert.equal(classifyApplicationDestination(''), 'unknown');
});

test('parseGeektimeJob cleans Hebrew titles, formats descriptions and normalizes company', () => {
  const sample = {
    id: 101,
    title: 'Junior Fullstack Engineer',
    company_name: 'Surecomp‎ &#8211; שורקומפ',
    city: 'כפר סבא',
    job_description: '<p>Build web apps in React.</p>',
    job_requirements: '<p>Degree in CS required.</p>',
    link_to_form: 'https://surecomp.com/careers/job1',
    job_status: 'open'
  };

  const job = parseGeektimeJob(sample);
  assert.equal(job.title, 'Junior Fullstack Engineer');
  assert.equal(job.company, 'Surecomp');
  assert.equal(job.location, 'Kfar Saba');
  assert.equal(job.url, 'https://surecomp.com/careers/job1');
  assert.match(job.description || '', /Build web apps in React/);
  assert.match(job.description || '', /Degree in CS required/);
});

test('geektimeProvider detects its own feed and parses mock array', async () => {
  assert.ok(geektimeProvider.detect({ provider: 'geektime-insider' }));
  assert.ok(geektimeProvider.detect({ careers_url: 'https://insider.geektime.co.il/jobs/' }));

  const mockCtx = {
    fetchJson: async () => [
      {
        id: 1,
        title: 'Backend Engineer',
        company_name: 'TestCo',
        city: 'תל אביב',
        job_status: 'open',
        link_to_form: 'https://testco.com/careers/1'
      },
      {
        id: 2,
        title: 'Closed Role',
        company_name: 'TestCo',
        city: 'תל אביב',
        job_status: 'closed',
        link_to_form: 'https://testco.com/careers/2'
      }
    ]
  };

  const jobs = await geektimeProvider.fetch({ provider: 'geektime-insider' }, mockCtx);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].title, 'Backend Engineer');
  assert.equal(jobs[0].location, 'Tel Aviv');
});
