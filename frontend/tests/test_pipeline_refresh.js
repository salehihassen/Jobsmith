const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const dom = new JSDOM(`<section id="review" class="view-board">
    <div id="pipeline-funnel"></div><div id="pipeline-board"></div>
    <div id="submitted-list"></div><div id="pipeline-filter-chip" hidden></div></section>`,
    { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/#review' });
const w = dom.window;
// Exercise the real loaders without starting the application's startup timers.
const addListener = w.document.addEventListener.bind(w.document);
w.document.addEventListener = (type, ...args) => {
    if (type !== 'DOMContentLoaded') addListener(type, ...args);
};
w.eval(['pipeline-stages.js', 'core.js', 'review.js', 'jobs-actions.js', 'deck.js'].map(file =>
    fs.readFileSync(path.join(__dirname, '../js', file), 'utf8')).join('\n;\n'));
w.renderHeatChip = () => '';
let title = 'Engineer';
let fail = false;
let release;
let gate = Promise.resolve();
w.api = async url => {
    await gate;
    if (fail) throw new Error('offline');
    if (url.includes('status=shortlisted')) return { jobs: [{ id: 'j1', title, company: 'Acme' }] };
    if (url.includes('/api/jobs?')) return { jobs: [] };
    if (url.includes('/submitted')) return [{ id: 'a1', job_id: 'j1', title, status: 'manual', resume_content: 'Resume' }];
    if (url.endsWith('in-progress')) return { in_progress: [], needs_attention: [] };
    if (url.endsWith('/status')) return {};
    return [];
};

(async () => {
    await w.renderBoard();
    const host = w.document.getElementById('pipeline-board');
    const col = w.document.getElementById('kcards-shortlisted');
    const card = col.firstElementChild;
    col.scrollTop = 75;
    card.focus();
    gate = new Promise(resolve => { release = resolve; });
    const pending = w.refreshBoardLive();
    assert.equal(w.document.getElementById('kcards-shortlisted'), col,
        'polling must retain the column while requests are pending');
    assert.equal(host.textContent.includes('Loading'), false,
        'background polls must not flash loading placeholders');
    release();
    await pending;
    assert.equal(col.firstElementChild, card, 'unchanged cards must retain their DOM nodes');
    assert.equal(w.document.activeElement, card, 'polling must preserve keyboard focus');
    assert.equal(col.scrollTop, 75, 'polling must preserve column scroll');
    title = 'Senior Engineer';
    await w.refreshBoardLive();
    assert.match(col.textContent, /Senior Engineer/, 'changed jobs must still appear');
    const updated = col.firstElementChild;
    fail = true;
    await w.refreshBoardLive();
    assert.equal(col.firstElementChild, updated, 'failed polls must retain the last successful data');
    fail = false;
    await w.loadSubmittedApplications();
    const submitted = w.document.getElementById('submitted-a1');
    const content = w.document.getElementById('submitted-content-a1');
    content.textContent = 'An expanded cover letter';
    await w.loadSubmittedApplications();
    assert.equal(w.document.getElementById('submitted-a1'), submitted, 'unchanged tables must retain cards');
    assert.equal(content.textContent, 'An expanded cover letter', 'polling must retain the selected document');
    fail = true;
    await w.loadSubmittedApplications();
    assert.equal(w.document.getElementById('submitted-a1'), submitted, 'failed table polls must retain data');
    console.log('PASS pipeline polling preserves content, focus and scroll, updates changes, and tolerates failures');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => dom.window.close());
