const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<section id="review" class="view-board"></section>', {
    runScripts: 'dangerously', url: 'http://localhost/#review', pretendToBeVisual: true,
});
const w = dom.window;
const addListener = w.document.addEventListener.bind(w.document);
w.document.addEventListener = (type, ...args) => { if (type !== 'DOMContentLoaded') addListener(type, ...args); };
w.eval(['pipeline-stages.js', 'core.js', 'review.js', 'job-actions.js', 'jobs-actions.js', 'job-edit.js']
    .map(file => fs.readFileSync(path.join(__dirname, '../js', file), 'utf8')).join('\n;\n'));
let job = { id: 'j1', title: 'Engineer', company: 'Acme', tags: '[]', status: 'manual',
    application: { id: 'a1', status: 'applied', outcome: 'awaiting', resume_content: 'Saved resume', applied_at: '2026-10-01' } };
let failState = false;
let writes = [];
let refreshes = 0;
w.api = async (url, options) => {
    if (!options) return structuredClone(job);
    const body = JSON.parse(options.body);
    writes.push({ url, body });
    if (url === '/api/applications/a1/outcome') {
        if (failState) throw new Error('{"detail":"State update failed"}');
        job.application.outcome = body.outcome;
    } else if (url === '/api/jobs/j1/status') {
        job.status = body.status;
        job.application = { ...job.application, id: 'a1', status: 'applied', outcome: 'awaiting' };
    } else if (url === '/api/jobs/j1') job = { ...job, ...body };
    else throw new Error(`Unexpected endpoint ${url}`);
    return structuredClone(job);
};
w.toast = () => {};
w.isBoardModeActive = () => true;
w.renderBoard = async () => { refreshes++; };
const flush = () => new Promise(resolve => setImmediate(resolve));
const form = () => w.document.getElementById('job-edit-form');
const submit = async () => { form().dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })); await flush(); };
(async () => {
    await w.editJobDetails('j1');
    assert(form().elements.namedItem('job_state'), 'Edit job offers a job state field');
    assert.equal(form().elements.namedItem('job_state').value, 'awaiting');
    assert([...form().elements.namedItem('job_state').options].some(option => option.value === 'rejected'));
    form().elements.namedItem('job_state').value = 'rejected';
    await submit();
    assert.equal(form(), null);
    assert.deepEqual(writes, [{ url: '/api/applications/a1/outcome', body: { outcome: 'rejected' } }]);
    assert.equal(job.application.status, 'applied');
    assert.equal(job.application.resume_content, 'Saved resume');
    assert.equal(job.application.applied_at, '2026-10-01');
    assert.equal(refreshes, 1);
    assert(w.jobActionIds(job, 'peek').includes('update-state'), 'opened board card offers state changes');
    assert(!w.jobActionIds(job, 'peek').includes('mark-rejected'), 'already rejected card does not repeat rejection');
    await w.editJobDetails('j1', true);
    assert.equal(w.document.activeElement, form().elements.namedItem('job_state'));
    form().elements.namedItem('job_state').value = 'interview';
    form().elements.namedItem('company').value = 'Corrected company';
    failState = true;
    await submit();
    assert(form(), 'failed state change keeps the editor open');
    assert.equal(form().elements.namedItem('job_state').value, 'interview');
    assert.match(w.document.getElementById('job-edit-error').textContent, /State update failed/);
    assert.equal(job.company, 'Corrected company');
    const postingWrites = writes.filter(write => write.url === '/api/jobs/j1').length;
    failState = false;
    await submit();
    assert.equal(form(), null);
    assert.equal(writes.filter(write => write.url === '/api/jobs/j1').length, postingWrites, 'retry only writes the failed state change');
    assert(w.jobActionIds(job, 'peek').includes('mark-rejected'));
    await w.markJobRejected('j1');
    assert.equal(job.application.outcome, 'rejected');
    job = { id: 'j1', title: 'Engineer', company: 'Acme', tags: '[]', status: 'shortlisted', application: null };
    await w.editJobDetails('j1');
    assert.equal(form().elements.namedItem('job_state').value, 'shortlisted');
    assert(![...form().elements.namedItem('job_state').options].some(option => option.value === 'rejected'), 'unsent roles cannot record employer rejection');
    form().elements.namedItem('job_state').value = 'manual';
    await submit();
    assert.equal(job.application.status, 'applied');
    await w.editJobDetails('j1');
    assert([...form().elements.namedItem('job_state').options].some(option => option.value === 'rejected'));
    w.document.getElementById('job-edit-cancel').click();
    console.log('PASS editor and opened-card state controls, rejection, preservation, failure retry, and manual submission');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => w.close());
