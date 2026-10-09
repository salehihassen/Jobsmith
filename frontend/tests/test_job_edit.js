const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<button id="opener">Edit job</button>', {
    runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/#review',
});
const w = dom.window;
const addListener = w.document.addEventListener.bind(w.document);
w.document.addEventListener = (type, ...args) => {
    if (type !== 'DOMContentLoaded') addListener(type, ...args);
};
w.eval(['core.js', 'review.js', 'job-actions.js', 'jobs-actions.js', 'job-edit.js'].map(file =>
    fs.readFileSync(path.join(__dirname, '../js', file), 'utf8')).join('\n;\n'));
const original = {
    id: 'j1', title: '<script>hostile title</script>', company: 'Incorrect company',
    url: 'https://example.com/wrong', salary_min: 100000, salary_max: 150000,
    tags: '["Python"]', description: 'A description', status: 'review',
    application: { id: 'a1', status: 'pending_review', resume_content: 'Saved resume' },
};
let job = { ...original };
let fail = false;
let saves = [];
let refreshes = 0;
w.api = async (url, options) => {
    assert.equal(url, '/api/jobs/j1');
    if (!options) return { ...job };
    assert.equal(options.method, 'PATCH');
    const changes = JSON.parse(options.body);
    saves.push(changes);
    if (fail) throw new Error('{"detail":"Server rejected this edit"}');
    job = { ...job, ...changes };
    return { ...job };
};
w.toast = () => {};
w.isBoardModeActive = () => true;
w.renderBoard = async () => { refreshes++; };
const flush = () => new Promise(resolve => setImmediate(resolve));
const form = () => w.document.getElementById('job-edit-form');
const set = (key, value) => { form().elements.namedItem(key).value = value; };
const submit = async () => {
    form().dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
};

(async () => {
    for (const context of ['detail', 'peek', 'kanban-menu', 'review-row', 'review-detail']) {
        assert(w.jobActionIds(job, context).includes('edit-job'), `editor reachable from ${context}`);
    }
    w.document.getElementById('opener').focus();
    await w.editJobDetails('j1');
    assert.equal(form().elements.namedItem('title').value, original.title);
    assert.equal(w.document.querySelector('#job-edit-overlay script'), null, 'posting text must be escaped');
    assert.equal(w.document.activeElement, form().elements.namedItem('title'));
    set('title', 'Senior Engineer');
    set('company', 'Acme');
    set('url', 'https://example.com/correct');
    set('salary_min', '120000');
    set('salary_max', '180000');
    await submit();
    assert.equal(form(), null, 'successful save closes the editor');
    assert.deepEqual(saves[0], {
        title: 'Senior Engineer', company: 'Acme', url: 'https://example.com/correct',
        salary_min: 120000, salary_max: 180000,
    }, 'send only edited fields');
    assert.equal(w._currentJobs.j1.application.resume_content, 'Saved resume');
    assert.equal(refreshes, 1, 'refresh the pipeline after saving');

    await w.editJobDetails('j1');
    set('salary_min', '200000');
    await submit();
    assert.equal(saves.length, 1, 'invalid pay range must not reach the server');
    assert.match(w.document.getElementById('job-edit-error').textContent, /Minimum pay/);
    set('salary_min', '');
    set('salary_max', '');
    fail = true;
    await submit();
    assert(form(), 'failed saves keep the form open');
    assert.equal(form().elements.namedItem('salary_min').value, '', 'failed saves preserve edits');
    assert.equal(w.document.getElementById('job-edit-error').textContent, 'Server rejected this edit');
    assert.equal(w.document.getElementById('job-edit-save').disabled, false, 'failed saves can be retried');
    fail = false;
    await submit();
    assert.equal(saves[2].salary_min, null, 'blank pay explicitly clears the old value');
    assert.equal(saves[2].salary_max, null);
    await w.editJobDetails('j1');
    set('company', 'Unsaved company');
    w.document.getElementById('job-edit-cancel').click();
    await flush();
    assert.equal(saves.length, 3, 'cancel must not write');
    assert.equal(job.company, 'Acme');
    console.log('PASS job editor accessibility, escaping, partial saves, pay validation, clearing, retry, and cancel');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => dom.window.close());
