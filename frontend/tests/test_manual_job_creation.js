const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const dom = new JSDOM(fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8'), {
    runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/#jobs',
});
const w = dom.window;
const addListener = w.document.addEventListener.bind(w.document);
w.document.addEventListener = (type, ...args) => {
    if (type !== 'DOMContentLoaded') addListener(type, ...args);
};
w.eval(['core.js', 'jobs-actions.js', 'job-actions.js', 'job-edit.js'].map(file =>
    fs.readFileSync(path.join(__dirname, '../js', file), 'utf8')).join('\n;\n'));
let saves = [];
let fail = false;
let releaseSave;
const refreshes = [];
w.api = async (url, options) => {
    assert.equal(url, '/api/jobs');
    assert.equal(options.method, 'POST');
    const details = JSON.parse(options.body);
    saves.push(details);
    if (releaseSave) await new Promise(resolve => { releaseSave = resolve; });
    if (fail) throw new Error('{"detail":"Could not create this entry"}');
    return { id: `j${saves.length}`, source: 'manual', ...details };
};
w.toast = () => {};
w.isBoardModeActive = () => true;
w.renderBoard = async () => { refreshes.push('board'); };
w.isInboxStageActive = () => true;
w.loadStage = async () => { refreshes.push('cards'); };
w.loadJobs = async () => { refreshes.push('list'); };
const flush = () => new Promise(resolve => setImmediate(resolve));
const form = () => w.document.getElementById('job-edit-form');
const set = (key, value) => { form().elements.namedItem(key).value = value; };
const submit = async () => {
    form().dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
};

(async () => {
    const inboxButton = w.document.querySelector('#jobs button[onclick="addJobManually()"]');
    inboxButton.focus();
    inboxButton.click();
    await flush();
    assert(form(), 'manual creation is reachable from Inbox');
    assert.equal(saves.length, 0, 'opening the form does not fetch a URL or existing job');
    assert.equal(form().elements.namedItem('job_state').value, 'discovered');
    assert.equal(w.document.activeElement, form().elements.namedItem('title'));
    assert.equal(form().elements.namedItem('url').required, false);
    await submit();
    assert.equal(saves.length, 0, 'a title is required');
    set('title', '  Senior Software Engineer  ');
    set('company', 'Mastercard');
    set('location', 'Arlington, VA');
    const message = 'Lainey Smith at Experis\nHybrid: 3 days onsite. CI/CD, IaC, developer tools. <script>message</script>';
    set('description', message);
    set('tags', 'LinkedIn message\nDevOps');
    releaseSave = true;
    await submit();
    await submit();
    assert.equal(saves.length, 1, 'duplicate submit while saving creates one entry');
    assert.equal(w.document.getElementById('job-edit-save').disabled, true);
    releaseSave();
    releaseSave = null;
    await flush();
    assert.equal(form(), null);
    assert.equal(w.document.activeElement, inboxButton, 'restore focus after saving');
    assert.equal(saves[0].url, '');
    assert.equal(saves[0].title, 'Senior Software Engineer');
    assert.equal(saves[0].description, message);
    assert.deepEqual(saves[0].tags, ['LinkedIn message', 'DevOps']);
    assert.deepEqual(refreshes, ['cards']);
    assert(!w.jobActionIds(w._currentJobs.j1, 'detail').includes('assist'), 'linkless jobs do not offer URL automation');
    assert(!w.jobActionIds(w._currentJobs.j1, 'detail').includes('open-url'));

    w.location.hash = 'review';
    w.document.querySelector('#review button[onclick="addJobManually(\'shortlisted\')"]').click();
    await flush();
    assert.equal(form().elements.namedItem('job_state').value, 'shortlisted');
    set('title', 'Engineer');
    set('job_state', 'manual');
    fail = true;
    await submit();
    assert(form(), 'failed creation preserves the form');
    assert.equal(form().elements.namedItem('title').value, 'Engineer');
    assert.equal(w.document.getElementById('job-edit-error').textContent, 'Could not create this entry');
    assert.equal(w.document.getElementById('job-edit-save').textContent, 'Add job');
    fail = false;
    await submit();
    assert.equal(saves.at(-1).status, 'manual');
    assert.deepEqual(refreshes, ['cards', 'board']);

    w.location.hash = 'jobs';
    w.isInboxStageActive = () => false;
    await w.addJobManually();
    set('title', 'Another role');
    set('url', 'https://example.com/role');
    set('salary_min', '200');
    set('salary_max', '100');
    await submit();
    assert.equal(saves.length, 3, 'invalid pay range is rejected before saving');
    set('salary_max', '300');
    await submit();
    assert.equal(saves.at(-1).url, 'https://example.com/role', 'an optional URL is stored without scraping');
    assert.deepEqual(refreshes, ['cards', 'board', 'list']);

    await w.addJobManually();
    const count = saves.length;
    form().dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flush();
    assert.equal(form(), null);
    assert.equal(saves.length, count, 'canceling creates no entry');
    console.log('PASS manual creation: Inbox/Pipeline entry points, optional URL, recruiter text, pipeline state, refresh, validation, retry, duplicate-submit protection, focus and cancel');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => dom.window.close());
